const pool = require('../config/db');
const duitku = require('../services/duitkuClient');

function matchesInvoice(invoice, data) {
  return data.merchantOrderId === invoice.merchant_order_id
    && data.reference === invoice.reference
    && Number(data.amount) === Number(invoice.amount);
}

async function verifySandboxPayment(req, res) {
  let connection;
  try {
    if (!duitku.enabled()) return res.status(403).json({ success: false, message: 'Pembayaran Duitku tidak aktif.' });
    const settings = duitku.config();
    if (settings.environment !== 'sandbox') {
      return res.status(403).json({ success: false, message: 'Verifikasi manual hanya tersedia untuk pembayaran Duitku Sandbox.' });
    }

    const { session_code } = req.params;
    const [sessions] = await pool.query(
      'SELECT * FROM sessions WHERE session_code = ? AND kiosk_id = ? LIMIT 1',
      [session_code, req.kiosk.id]
    );
    const session = sessions[0];
    if (!session) return res.status(404).json({ success: false, message: 'Sesi pembayaran tidak ditemukan.' });
    if (session.payment_provider !== 'duitku') {
      return res.status(403).json({ success: false, message: 'Verifikasi ini hanya berlaku untuk invoice Duitku.' });
    }
    if (session.payment_status === 'verified') {
      return res.status(200).json({ success: true, data: { payment_status: 'verified' } });
    }

    const [invoices] = await pool.query('SELECT * FROM duitku_invoices WHERE session_code = ? LIMIT 1', [session_code]);
    const invoice = invoices[0];
    if (!invoice || invoice.merchant_code !== settings.merchantCode
      || Number(session.payment_required_amount) !== Number(invoice.amount)) {
      return res.status(409).json({ success: false, message: 'Invoice tidak cocok dengan sesi pembayaran.' });
    }
    if (invoice.status === 'paid') {
      return res.status(200).json({ success: true, data: { payment_status: 'verified' } });
    }
    if (!invoice.reference) return res.status(409).json({ success: false, message: 'Invoice Duitku belum siap diverifikasi.' });

    const provider = await duitku.checkTransaction(invoice.merchant_order_id, settings);
    if (!matchesInvoice(invoice, provider)) {
      return res.status(502).json({ success: false, message: 'Data status Duitku tidak cocok dengan invoice pembayaran.' });
    }
    if (provider.statusCode === '01') {
      return res.status(200).json({ success: true, data: { payment_status: 'pending' } });
    }
    if (!['00', '02'].includes(provider.statusCode)) {
      return res.status(502).json({ success: false, message: 'Duitku mengembalikan status transaksi yang tidak dikenali.' });
    }

    connection = await pool.getConnection();
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    const [lockedInvoices] = await connection.query('SELECT * FROM duitku_invoices WHERE merchant_order_id = ? FOR UPDATE', [invoice.merchant_order_id]);
    const [lockedSessions] = await connection.query('SELECT * FROM sessions WHERE session_code = ? FOR UPDATE', [session_code]);
    const lockedInvoice = lockedInvoices[0];
    const lockedSession = lockedSessions[0];
    if (!lockedInvoice || !lockedSession || !matchesInvoice(lockedInvoice, provider)
      || lockedSession.payment_provider !== 'duitku'
      || Number(lockedSession.payment_required_amount) !== Number(lockedInvoice.amount)) {
      throw Object.assign(new Error('Sesi pembayaran berubah saat verifikasi.'), { statusCode: 409 });
    }
    if (lockedInvoice.status === 'paid' || lockedSession.payment_status === 'verified') {
      await connection.commit();
      return res.status(200).json({ success: true, data: { payment_status: 'verified' } });
    }

    if (provider.statusCode === '00') {
      await connection.query(
        `INSERT INTO transactions (session_id, transaction_code, amount, payment_method, status, verification_method, paid_at, verified_at)
         VALUES (?, ?, ?, 'QRIS', 'success', 'duitku_sandbox_manual_check', NOW(), NOW())`,
        [session_code, invoice.merchant_order_id, invoice.amount]
      );
      await connection.query(
        `UPDATE sessions SET payment_status = 'verified', payment_verified_at = NOW(), payment_verification_method = 'duitku_sandbox_manual_check'
         WHERE session_code = ?`, [session_code]
      );
      await connection.query("UPDATE duitku_invoices SET status = 'paid', paid_at = NOW() WHERE merchant_order_id = ?", [invoice.merchant_order_id]);
      await connection.commit();
      return res.status(200).json({ success: true, data: { payment_status: 'verified' } });
    }

    await connection.query("UPDATE duitku_invoices SET status = 'expired' WHERE merchant_order_id = ?", [invoice.merchant_order_id]);
    await connection.query("UPDATE sessions SET payment_status = 'expired' WHERE session_code = ? AND payment_status <> 'verified'", [session_code]);
    await connection.commit();
    return res.status(200).json({ success: true, data: { payment_status: 'expired' } });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Verifikasi pembayaran Sandbox gagal.' });
  } finally {
    connection?.release();
  }
}

// Callback is public; signature and a server-to-server status check authenticate it.
async function callback(req, res) {
  let connection;
  try {
    const settings = duitku.config();
    const body = req.body || {};
    if (!duitku.validCallback(body, settings)) return res.status(401).json({ success: false, message: 'Signature tidak valid.' });
    const [rows] = await pool.query('SELECT * FROM duitku_invoices WHERE merchant_order_id = ?', [body.merchantOrderId]);
    const invoice = rows[0];
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan.' });
    // An early callback may arrive while inquiry response is being persisted. Retry later.
    if (!invoice.reference) return res.status(503).json({ success: false, message: 'Invoice sedang dibuat.' });
    if (invoice.merchant_code !== body.merchantCode || !matchesInvoice(invoice, body)) {
      return res.status(400).json({ success: false, message: 'Referensi/nominal tidak sesuai invoice.' });
    }
    if (invoice.status === 'paid') return res.status(200).json({ success: true });
    const payment = await duitku.checkTransaction(invoice.merchant_order_id, settings);
    if (!matchesInvoice(invoice, payment) || !['00', '01', '02'].includes(payment.statusCode)) {
      return res.status(400).json({ success: false, message: 'Status provider tidak sesuai invoice.' });
    }
    if (payment.statusCode === '01') return res.status(503).json({ success: false, message: 'Konfirmasi provider masih pending.' });

    connection = await pool.getConnection();
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    const [locked] = await connection.query('SELECT * FROM duitku_invoices WHERE merchant_order_id = ? FOR UPDATE', [invoice.merchant_order_id]);
    const [sessions] = await connection.query('SELECT * FROM sessions WHERE session_code = ? FOR UPDATE', [invoice.session_code]);
    const session = sessions[0];
    if (!session || session.payment_provider !== 'duitku' || Number(session.payment_required_amount) !== Number(invoice.amount)) {
      throw new Error('Session does not match invoice');
    }
    if (locked[0].status !== 'paid') {
      if (payment.statusCode === '00') {
        await connection.query(
          `INSERT INTO transactions (session_id, transaction_code, amount, payment_method, status, verification_method, paid_at, verified_at)
           VALUES (?, ?, ?, 'QRIS', 'success', 'duitku_callback', NOW(), NOW())`,
          [invoice.session_code, invoice.merchant_order_id, invoice.amount]
        );
        await connection.query(
          `UPDATE sessions SET payment_status = 'verified', payment_verified_at = NOW(), payment_verification_method = 'duitku_callback'
           WHERE session_code = ?`, [invoice.session_code]
        );
        await connection.query("UPDATE duitku_invoices SET status = 'paid', paid_at = NOW() WHERE merchant_order_id = ?", [invoice.merchant_order_id]);
      } else {
        await connection.query("UPDATE duitku_invoices SET status = 'expired' WHERE merchant_order_id = ?", [invoice.merchant_order_id]);
        await connection.query("UPDATE sessions SET payment_status = 'expired' WHERE session_code = ? AND payment_status <> 'verified'", [invoice.session_code]);
      }
    }
    await connection.commit();
    return res.status(200).json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return res.status(error.statusCode || 500).json({ success: false, message: 'Konfirmasi Duitku belum dapat diproses. Callback dapat dicoba ulang.' });
  } finally {
    connection?.release();
  }
}

module.exports = { callback, matchesInvoice, verifySandboxPayment };
