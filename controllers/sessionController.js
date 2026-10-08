const crypto = require('crypto');
const duitku = require('../services/duitkuClient');
const QRCode = require('qrcode');
const pool = require('../config/db');
const Session = require('../models/sessionModel');
const Transaction = require('../models/transactionModel');
const { resolvePrice, buildUniqueAmount } = require('../utils/price');
const { publicBaseUrl, isValidEmail, escapeHtml } = require('../utils/security');

const isPlaceholder = value => {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || /replace-with|your[-_]?|change[-_]?me|example\.com|noreply@unismile\.local/.test(normalized);
};

const startSession = async (req, res) => {
  try {
    const kiosk_id = req.kiosk.id;
    const { frame_template_id } = req.body;
    if (!frame_template_id) {
      return res.status(400).json({ success: false, message: 'frame_template_id wajib diisi' });
    }

    const [templates] = await pool.query(
      `SELECT ft.price, ft.layout_config
       FROM frame_templates ft
       WHERE ft.id = ? AND ft.is_active = 1 AND ft.deleted_at IS NULL
         AND (ft.user_id IS NULL OR ft.user_id = ?)
       LIMIT 1`,
      [frame_template_id, req.kiosk.user_id]
    );
    if (!templates.length) {
      return res.status(404).json({ success: false, message: 'Template frame tidak ditemukan atau tidak aktif' });
    }

    const amount = resolvePrice({
      templatePrice: templates[0].price,
      layoutConfig: templates[0].layout_config,
      kioskBasePrice: req.kiosk.base_price,
    });
    const session_code = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Check payment profile config
    const [profiles] = await pool.query(
      'SELECT payment_data FROM payment_profiles WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1',
      [req.kiosk.user_id]
    );
    
    // Unique suffixes are enabled by default so each payment can be matched,
    // while the Admin frame price remains the base amount.
    let uniqueAmountEnabled = true;
    let sessionTtlMins = 5;
    // Jalur uji tanpa pembayaran.
    //
    // Dipakai saat mencetak/menguji kiosk tanpa harus membayar QRIS lebih dulu.
    // DIBACA DARI DATA YANG SUDAH ADA (payment_profiles.payment_data), jadi tidak
    // ada tabel atau kolom baru — dan menyalakannya kembali cukup dengan satu
    // UPDATE: set payment_required = true.
    //
    // Bukan bypass UI: sesinya memang ditandai 'verified' di database, sehingga
    // penjagaan pembayaran di endpoint upload dan cetak tetap berlaku apa adanya.
    let paymentRequired = true;
    if (profiles.length) {
      try {
        const pData = typeof profiles[0].payment_data === 'string'
          ? JSON.parse(profiles[0].payment_data)
          : profiles[0].payment_data || {};
        uniqueAmountEnabled = pData.unique_amount_enabled !== false;
        sessionTtlMins = Number(pData.session_ttl_minutes) || 5;
        paymentRequired = pData.payment_required !== false;
      } catch (e) {}
    }

    // Set payment columns on the session.
    //
    // Kalau pembayaran dimatikan untuk uji, sesi langsung ditandai 'verified' —
    // dan pemanggil diberi tahu lewat flag di respons supaya photobooth bisa
    // MELEWATI layar bayar, bukan menampilkannya lalu menggantung.
    const challengeId = crypto.randomUUID();
    const duitkuEnabled = paymentRequired && duitku.enabled();
    const duitkuSettings = duitkuEnabled ? duitku.config() : null;
    const merchantOrderId = duitkuEnabled ? `US-${crypto.randomUUID()}` : null;
    const goPayMerchantEnabled = paymentRequired && !duitkuEnabled
      && String(process.env.GOPAY_MERCHANT_ENABLED || '').toLowerCase() === 'true';
    const goPayMerchantId = String(process.env.GOPAY_MERCHANT_ID || '').trim();
    if (goPayMerchantEnabled && !goPayMerchantId) {
      return res.status(503).json({ success: false, message: 'GoPay Merchant belum dikonfigurasi.' });
    }
    // Automatic payment sessions start before capture/edit; keep their amount
    // reservation alive long enough to reach the QRIS screen.
    const effectiveTtlMinutes = duitkuEnabled ? duitkuSettings.expiryMinutes : goPayMerchantEnabled ? Math.max(30, sessionTtlMins) : sessionTtlMins;
    const expiresAt = new Date(Date.now() + effectiveTtlMinutes * 60 * 1000);

    const connection = await pool.getConnection();
    let finalAmount = amount;
    let finalUniqueCode = null;
    const paymentProvider = duitkuEnabled ? 'duitku' : goPayMerchantEnabled ? 'gopay_merchant' : 'legacy_cv';
    try {
      await connection.query("SET time_zone = '+00:00'");
      await connection.beginTransaction();

      // Sesi kedaluwarsa tidak boleh memblokir kode unik baru.
      await connection.query(
        `UPDATE sessions SET payment_status = 'expired'
         WHERE kiosk_id = ? AND payment_status = 'pending'
           AND payment_expires_at IS NOT NULL AND payment_expires_at < NOW()`,
        [kiosk_id]
      );

      let pendingAmounts;
      if (goPayMerchantEnabled) {
        await connection.query(
          `UPDATE payment_amount_reservations SET status = 'expired'
           WHERE merchant_id = ? AND status = 'reserved' AND expires_at <= NOW(3)`,
          [goPayMerchantId]
        );
        const [reservations] = await connection.query(
          `SELECT expected_amount FROM payment_amount_reservations
           WHERE merchant_id = ? AND status = 'reserved' AND expires_at > NOW(3)
           FOR UPDATE`,
          [goPayMerchantId]
        );
        pendingAmounts = reservations.map(row => row.expected_amount);
      } else {
        const [pending] = await connection.query(
          `SELECT DISTINCT payment_required_amount FROM sessions
           WHERE ((kiosk_id = ?) OR (kiosk_id IN (SELECT id FROM kiosks WHERE user_id = ?)))
             AND payment_status = 'pending'
             AND payment_required_amount IS NOT NULL`,
          [kiosk_id, req.kiosk.user_id]
        );
        pendingAmounts = pending.map(row => row.payment_required_amount);
      }

      // Automatic matching requires unique active amounts even if an old
      // payment profile disabled visual-proof suffixes.
      const useUniqueAmount = !duitkuEnabled && (goPayMerchantEnabled || uniqueAmountEnabled);
      const initial = buildUniqueAmount(amount, pendingAmounts);
      finalAmount = useUniqueAmount ? initial.total : amount;
      finalUniqueCode = useUniqueAmount ? initial.uniqueCode : null;

      await Session.create({ session_code, kiosk_id, frame_template_id }, connection);
      await connection.query(
        `UPDATE sessions SET
           payment_status = ?,
           payment_required_amount = ?,
           payment_expires_at = ?,
           payment_provider = ?
         WHERE session_code = ?`,
        [paymentRequired ? 'pending' : 'verified', finalAmount, expiresAt, paymentProvider, session_code]
      );

      if (goPayMerchantEnabled) {
        let reserved = false;
        const takenAmounts = [...pendingAmounts];
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const candidate = buildUniqueAmount(amount, takenAmounts);
          if (takenAmounts.some(value => Number(value) === Number(candidate.total))) break;

          const [existingRows] = await connection.query(
            `SELECT session_id, status, expires_at FROM payment_amount_reservations
             WHERE merchant_id = ? AND expected_amount = ? FOR UPDATE`,
            [goPayMerchantId, candidate.total]
          );
          const existing = existingRows[0];
          if (existing && existing.status === 'reserved' && new Date(existing.expires_at).getTime() > Date.now()) {
            takenAmounts.push(candidate.total);
            continue;
          }

          if (existing) {
            await connection.query(
              `UPDATE payment_amount_reservations
               SET session_id = ?, status = 'reserved', expires_at = ?
               WHERE merchant_id = ? AND expected_amount = ?`,
              [session_code, expiresAt, goPayMerchantId, candidate.total]
            );
          } else {
            try {
              await connection.query(
                `INSERT INTO payment_amount_reservations
                   (merchant_id, expected_amount, session_id, status, expires_at)
                 VALUES (?, ?, ?, 'reserved', ?)`,
                [goPayMerchantId, candidate.total, session_code, expiresAt]
              );
            } catch (error) {
              if (error.code !== 'ER_DUP_ENTRY') throw error;
              takenAmounts.push(candidate.total);
              continue;
            }
          }

          finalAmount = candidate.total;
          finalUniqueCode = candidate.uniqueCode;
          reserved = true;
          break;
        }

        if (!reserved) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: 'Nominal pembayaran QRIS sedang dipakai sesi lain. Silakan mulai sesi baru sebentar lagi.'
          });
        }

        await connection.query(
          'UPDATE sessions SET payment_required_amount = ? WHERE session_code = ?',
          [finalAmount, session_code]
        );
      }

      if (duitkuEnabled) {
        await connection.query(
          'INSERT INTO duitku_invoices (merchant_order_id, session_code, merchant_code, amount, expires_at) VALUES (?, ?, ?, ?, ?)',
          [merchantOrderId, session_code, duitkuSettings.merchantCode, finalAmount, expiresAt]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }

    let dynamicPayment = {};
    if (duitkuEnabled) {
      try {
        const invoice = await duitku.createInvoice({ orderId: merchantOrderId, amount: finalAmount }, duitkuSettings);
        await pool.query('UPDATE duitku_invoices SET reference = ? WHERE merchant_order_id = ?', [invoice.reference, merchantOrderId]);
        const qrImage = await QRCode.toDataURL(invoice.qrString, { width: 500, margin: 4, errorCorrectionLevel: 'M' });
        dynamicPayment = { merchant_order_id: merchantOrderId, payment_reference: invoice.reference, payment_url: invoice.paymentUrl, qris_image_url: qrImage, payment_environment: duitkuSettings.environment };
      } catch (error) {
        await pool.query("UPDATE sessions SET payment_status = 'expired' WHERE session_code = ? AND payment_status = 'pending'", [session_code]);
        throw error;
      }
    }
    return res.status(201).json({
      success: true,
      session_code,
      amount: finalAmount,
      data: {
        session_code,
        expected_amount: finalAmount,
        base_amount: amount,
        unique_code: finalUniqueCode,
        payment_expires_at: expiresAt.toISOString(),
        verification_challenge_id: challengeId,
        payment_method: duitkuEnabled ? 'duitku_qris' : goPayMerchantEnabled ? 'gopay_merchant_polling' : 'qris_visual_proof',
        ...dynamicPayment,
        // false = pembayaran sedang dimatikan lewat payment_profiles; layar uji
        // memakainya untuk melompat langsung ke pengambilan foto.
        payment_required: paymentRequired
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const verifyPayment = async (req, res) => {
  // Opsi pertama dari brief: Hapus behavior mvp yang langsung sukses
  return res.status(403).json({
    success: false,
    message: 'Manual success payment bypass is deprecated. Please use visual verification endpoint.'
  });
};

const getPaymentStatus = async (req, res) => {
  let connection;
  try {
    const { session_code } = req.params;
    connection = await pool.getConnection();
    await connection.query("SET time_zone = '+00:00'");
    const session = await Session.findByCodeAndKiosk(session_code, req.kiosk.id, connection);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Sesi tidak ditemukan.' });
    }

    const expiryDate = session.payment_expires_at ? new Date(session.payment_expires_at) : null;
    const paymentStatus = session.payment_status === 'pending'
      && expiryDate
      && Number.isFinite(expiryDate.getTime())
      && expiryDate.getTime() < Date.now()
      ? 'expired'
      : session.payment_status;

    return res.status(200).json({
      success: true,
      data: {
        session_code,
        payment_status: paymentStatus,
        payment_required_amount: Number(session.payment_required_amount) || null,
        payment_expires_at: session.payment_expires_at,
        payment_provider: session.payment_provider || 'legacy_cv',
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    connection?.release();
  }
};

const completeSession = async (req, res) => {
  try {
    const { session_code } = req.params;

    const session = await Session.findByCodeAndKiosk(session_code, req.kiosk.id);
    if (!session) return res.status(404).json({ success: false, message: 'Sesi tidak ditemukan' });

    // Enforce payment verification check
    if (session.payment_status !== 'verified') {
      return res.status(403).json({ success: false, message: 'Sesi belum dibayar atau pembayaran belum diverifikasi.' });
    }

    await Session.updateStatus(session_code, 'completed');
    const download_url = `${publicBaseUrl(req)}/download/${encodeURIComponent(session_code)}`;

    return res.status(200).json({
      success: true,
      data: { session_code, download_url },
      download_url,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAdminSessions = async (req, res) => {
  try {
    const user_id = req.user.id;
    const user_role = req.user.role;

    const querySessions = async (sessionKey) => {
      const sessionId = `s.${sessionKey}`;
      let query = `
        SELECT
          ${sessionId} AS session_code,
          s.kiosk_id,
          COALESCE(k.name, s.kiosk_id, 'Unknown Kiosk') AS kiosk_name,
          s.started_at AS timestamp,
          COALESCE(ft.name, 'Default Template') AS template,
          s.status,
          COALESCE(
            MAX(t.amount),
            MAX(s.payment_required_amount),
            MAX(NULLIF(ft.price, 0)),
            MAX(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ft.layout_config, '$.layout_price')), 0)),
            0
          ) AS amount,
          (
            SELECT GROUP_CONCAT(p.url)
            FROM photos p
            WHERE p.session_id = ${sessionId}
          ) AS photos
         FROM sessions s
         LEFT JOIN kiosks k ON s.kiosk_id = k.id
         LEFT JOIN frame_templates ft ON s.frame_template_id = ft.id
         LEFT JOIN transactions t ON t.session_id = ${sessionId}
      `;

      const params = [];
      if (user_role !== 'Super Admin') {
        query += ' WHERE k.user_id = ?';
        params.push(user_id);
      }
      // only_full_group_by aktif di server live: kolom non-agregat harus ikut di GROUP BY.
      query += ` GROUP BY ${sessionId}, s.kiosk_id, k.name, s.started_at, ft.name, s.status ORDER BY s.started_at DESC`;
      return pool.query(query, params);
    };

    let rows;
    try {
      [rows] = await querySessions('session_code');
    } catch (error) {
      if (error.code !== 'ER_BAD_FIELD_ERROR') throw error;
      // Older SQL dumps use sessions.id instead of sessions.session_code.
      [rows] = await querySessions('id');
    }

    const formattedSessions = rows.map(r => {
      let photosArr = [];
      if (r.photos) {
        if (typeof r.photos === 'string') {
          if (r.photos.startsWith('[')) {
            try {
              photosArr = JSON.parse(r.photos);
            } catch (e) {
              photosArr = [];
            }
          } else {
            photosArr = r.photos.split(',').filter(Boolean);
          }
        } else if (Array.isArray(r.photos)) {
          photosArr = r.photos;
        }
      }
      return {
        id: String(r.session_code).startsWith('#') ? String(r.session_code) : `#US-${r.session_code}`,
        kiosk_id: r.kiosk_id || '',
        kiosk_name: r.kiosk_name || r.kiosk_id || 'Unknown Kiosk',
        timestamp: r.timestamp,
        template: r.template,
        photos: photosArr,
        amount: Number(r.amount) || 0,
        status: r.status === 'completed' ? 'Success' : (r.status === 'failed' ? 'Failed (Paper Jam)' : r.status)
      };
    });

    return res.status(200).json({ success: true, data: formattedSessions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const sendDigitalCopy = async (req, res) => {
  try {
    const session_code = req.params.session_code || req.params.id;
    const { email } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Email target tidak valid.' });
    }

    const session = await Session.findByCodeAndKiosk(session_code, req.kiosk.id);
    if (!session) return res.status(404).json({ success: false, message: 'Sesi tidak ditemukan' });

    const [photos] = await pool.query(
      'SELECT url FROM photos WHERE session_id = ? ORDER BY id ASC',
      [session_code]
    );

    const photoUrls = photos.map(p => p.url);

    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, RESEND_API_KEY } = process.env;
    const smtpHost = String(SMTP_HOST || 'smtp.gmail.com').trim();
    const smtpPort = Number(SMTP_PORT) || 587;
    const smtpUser = String(SMTP_USER || '').trim();
    const smtpPass = String(SMTP_PASS || '').replace(/\s+/g, '');
    const smtpFrom = isPlaceholder(SMTP_FROM)
      ? `"Uni-Smiles Photobooth" <${smtpUser}>`
      : String(SMTP_FROM).trim();
    const smtpConfigured = !isPlaceholder(smtpUser) && !isPlaceholder(smtpPass);

    const baseUrl = publicBaseUrl(req);
    const absolutePhotoUrls = photoUrls.map(photoUrl => {
      const normalizedUrl = String(photoUrl || '').trim();
      if (!normalizedUrl) return '';
      try {
        const parsedUrl = new URL(normalizedUrl, baseUrl);
        if (parsedUrl.pathname.startsWith('/uploads/')) {
          return `${baseUrl}${parsedUrl.pathname}${parsedUrl.search}`;
        }
        return parsedUrl.toString();
      } catch (_) {
        return '';
      }
    }).filter(Boolean);
    const directPhotoLinks = absolutePhotoUrls.map((photoUrl, index) => `
      <li style="margin: 8px 0;"><a href="${escapeHtml(photoUrl)}" style="color: #818cf8;">Download Foto ${index + 1}</a></li>
    `).join('');
    const downloadPageUrl = `${baseUrl}/download/${encodeURIComponent(session_code)}`;
    const safeSessionCode = escapeHtml(session_code);

    const html = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background-color: #0c1633; border-radius: 20px; color: #f1f5f9; text-align: center; border: 1px solid rgba(255, 255, 255, 0.08);">
        <div style="margin-bottom: 25px;">
          <h1 style="color: #ffffff; font-size: 28px; font-weight: 800; margin-top: 15px; margin-bottom: 5px; letter-spacing: -0.025em; text-transform: uppercase;">Uni-Smiles</h1>
          <p style="color: #6366f1; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.2em; margin: 0;">Digital Copy Center</p>
        </div>

        <div style="background-color: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 25px; border-radius: 16px; margin-bottom: 30px; text-align: left;">
          <h3 style="color: #ffffff; font-size: 18px; margin-top: 0; font-weight: 700;">Terima Kasih Telah Menggunakan Uni-Smiles!</h3>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">Halo,</p>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 25px;">Foto hasil jepretan Anda untuk kode sesi <strong>#${safeSessionCode}</strong> telah siap! Silakan klik tombol di bawah ini untuk melihat dan mengunduh seluruh foto Anda (baik foto satuan maupun foto hasil frame akhir).</p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${downloadPageUrl}" target="_blank" style="display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 15px 35px; font-weight: bold; border-radius: 12px; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(79, 70, 229, 0.4);">
              📥 Lihat & Download Foto Anda
            </a>
          </div>
          ${directPhotoLinks ? `
          <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.08);">
            <p style="color: #94a3b8; font-size: 13px; margin: 0 0 8px;">Link foto langsung:</p>
            <ul style="margin: 0; padding-left: 20px;">${directPhotoLinks}</ul>
          </div>
          ` : ''}
        </div>

        <p style="color: #64748b; font-size: 12px; margin-top: 30px;">
          Semoga harimu menyenangkan!<br/>
          <strong>Tim Uni-Smiles Photobooth</strong>
        </p>
      </div>
    `;

    const trySendViaResend = async () => {
      if (!RESEND_API_KEY) return false;
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: smtpFrom,
          to: email,
          subject: `📸 Salinan Digital Foto Uni-Smiles - Sesi #${session_code}`,
          html,
        }),
      });

      if (!resendRes.ok) {
        const text = await resendRes.text();
        throw new Error(`Resend API error ${resendRes.status}: ${text}`);
      }

      return true;
    };

    const trySendViaSMTP = async () => {
      if (!smtpConfigured) {
        return false;
      }

      const nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        requireTLS: smtpPort === 587,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        auth: { user: smtpUser, pass: smtpPass },
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: `📸 Salinan Digital Foto Uni-Smiles - Sesi #${session_code}`,
        html,
      });

      return true;
    };

    let sent = false;

    if (RESEND_API_KEY) {
      try {
        sent = await trySendViaResend();
      } catch (apiError) {
        console.error('⚠️ Resend API gagal:', apiError.message);
      }
    }

    if (!sent) {
      try {
        sent = await trySendViaSMTP();
      } catch (smtpError) {
        const errorText = `${smtpError.code || ''} ${smtpError.message || ''} ${smtpError.response || ''}`.toLowerCase();
        const isConnectionError = smtpError.code === 'ECONNECTION' ||
                                   smtpError.code === 'ESOCKET' ||
                                   smtpError.code === 'ECONNRESET' ||
                                   smtpError.code === 'ETIMEDOUT' ||
                                   smtpError.code === 'ECONNREFUSED' ||
                                   smtpError.code === 'EHOSTUNREACH' ||
                                   (smtpError.message && (
                                     smtpError.message.includes('connect') ||
                                     smtpError.message.includes('ECONNREFUSED') ||
                                     smtpError.message.includes('EHOSTUNREACH') ||
                                     smtpError.message.includes('ETIMEDOUT')
                                   ));
        const isAuthError = smtpError.code === 'EAUTH' ||
                            smtpError.responseCode === 535 ||
                            /authentication|invalid login|username and password not accepted|5\.7\./.test(errorText);

        let userMessage = 'Email gagal dikirim.';
        if (isConnectionError) {
          userMessage = 'Koneksi ke server SMTP ditolak atau tidak dapat dijangkau. Kemungkinan firewall atau jaringan memblokir port SMTP (587/465). Periksa pengaturan firewall atau coba jaringan lain.';
        } else if (isAuthError) {
          userMessage = 'Autentikasi Gmail gagal. SMTP_USER harus akun Gmail pengirim dan SMTP_PASS harus App Password Gmail yang aktif.';
        } else {
          userMessage = 'Email gagal dikirim. Periksa SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, dan SMTP_FROM.';
        }

        console.error(`⚠️ Pengiriman SMTP ke ${smtpHost} gagal (${smtpError.code || smtpError.message}).`);
        return res.status(502).json({
          success: false,
          message: userMessage,
          code: smtpError.code || 'SMTP_ERROR',
          details: isConnectionError ? 'CONNECTION_BLOCKED' : (isAuthError ? 'AUTH_ERROR' : 'SMTP_ERROR')
        });
      }
    }

    if (!sent) {
      if (!smtpConfigured) {
        return res.status(503).json({
          success: false,
          message: 'SMTP belum dikonfigurasi. Isi SMTP_USER dengan akun Gmail dan SMTP_PASS dengan App Password Gmail di .env.',
          code: 'EMAIL_NOT_CONFIGURED',
        });
      }

      return res.status(503).json({
        success: false,
        message: 'Layanan email belum dikonfigurasi.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    console.log(`📧 Email salinan digital berhasil dikirim ke ${email}`);
    return res.status(200).json({
      success: true,
      message: 'Email berhasil dikirim!',
      data: { session_code, download_url: downloadPageUrl },
      download_url: downloadPageUrl,
    });
  } catch (error) {
    console.error('Error saat pengiriman email:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengirim email.' });
  }
};

module.exports = { startSession, verifyPayment, getPaymentStatus, completeSession, getAdminSessions, sendDigitalCopy };
