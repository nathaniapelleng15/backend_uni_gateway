const pool = require('../config/db');
const duitku = require('../services/duitkuClient');

function matchesInvoice(invoice, data) {
  return data.merchantOrderId === invoice.merchant_order_id
    && data.reference === invoice.reference
    && Number(data.amount) === Number(invoice.amount);
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

module.exports = { callback, matchesInvoice };
