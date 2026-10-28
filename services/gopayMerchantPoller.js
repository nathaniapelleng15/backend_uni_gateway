const crypto = require('crypto');
const pool = require('../config/db');
const feedAdapter = require('./gopayMerchantFeed');

const PROVIDER = 'gopay_merchant';
const SETTLED_STATUSES = new Set(['SETTLEMENT', 'CAPTURE']);
let timer = null;
let activePoll = false;
let lockConnection = null;
let lockName = null;
let loggedLockOwner = false;

const toUtcDateTime = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 23).replace('T', ' ');
};

const normalizeTransaction = (item, observedAt) => {
  if (!item || typeof item !== 'object') return null;
  const transactionId = String(item.transaction_id || '').trim();
  const amount = Number(item.amount_rupiah);
  const transactionTimeDate = new Date(item.transaction_time);
  const transactionTime = toUtcDateTime(transactionTimeDate);
  if (!transactionId || transactionId.length > 150) return null;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  if (!transactionTime) return null;

  return {
    transactionId,
    amount,
    status: String(item.transaction_status || '').trim().toUpperCase().slice(0, 40),
    paymentType: String(item.payment_type || '').trim().toUpperCase().slice(0, 40),
    channelType: String(item.channel_type || '').trim().slice(0, 40) || null,
    transactionTime,
    transactionTimeDate,
    observedAt,
  };
};

const sessionTimestamp = value => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};

const transactionCodeFor = (merchantId, transactionId) => {
  const digest = crypto.createHash('sha256').update(`${merchantId}:${transactionId}`).digest('hex');
  return `GP-${digest}`;
};

const ensurePollerLock = async merchantId => {
  if (!lockName) {
    const suffix = crypto.createHash('sha256').update(merchantId).digest('hex').slice(0, 48);
    lockName = `gopay-merchant:${suffix}`;
  }

  if (lockConnection) {
    try {
      const [rows] = await lockConnection.query('SELECT IS_USED_LOCK(?) AS owner_id', [lockName]);
      if (String(rows[0]?.owner_id) === String(lockConnection.threadId)) return true;
      lockConnection.release();
      lockConnection = null;
    } catch (_) {
      lockConnection.release();
      lockConnection = null;
    }
  }

  const candidate = await pool.getConnection();
  try {
    await candidate.query("SET time_zone = '+00:00'");
    const [rows] = await candidate.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(rows[0]?.acquired) !== 1) {
      candidate.release();
      if (!loggedLockOwner) {
        console.log('[GoPay Merchant poller] Another backend instance owns this merchant poller.');
        loggedLockOwner = true;
      }
      return false;
    }
    lockConnection = candidate;
    loggedLockOwner = false;
    return true;
  } catch (error) {
    candidate.release();
    throw error;
  }
};

const storeAndMatch = async (merchantId, transaction) => {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    const [providerRows] = await connection.query(
      `SELECT id, match_status, transaction_status FROM provider_transactions
       WHERE provider = ? AND merchant_id = ? AND provider_transaction_id = ?
       LIMIT 1 FOR UPDATE`,
      [PROVIDER, merchantId, transaction.transactionId]
    );
    let providerRow = providerRows[0];
    if (providerRow && providerRow.match_status !== 'unmatched') {
      await connection.commit();
      return false;
    }

    if (providerRow) {
      if (providerRow.transaction_status === transaction.status) {
        await connection.commit();
        return false;
      }
      await connection.query(
        `UPDATE provider_transactions SET transaction_status = ?, payment_type = ?,
           channel_type = ?, last_observed_at = ? WHERE id = ?`,
        [transaction.status, transaction.paymentType, transaction.channelType, transaction.observedAt, providerRow.id]
      );
    } else {
      const [insertResult] = await connection.query(
        `INSERT INTO provider_transactions
           (provider, merchant_id, provider_transaction_id, amount, currency,
            transaction_status, payment_type, channel_type, provider_transaction_time,
            first_observed_at, last_observed_at, match_status)
         VALUES (?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?, ?, 'unmatched')`,
        [
          PROVIDER,
          merchantId,
          transaction.transactionId,
          transaction.amount,
          transaction.status,
          transaction.paymentType,
          transaction.channelType,
          transaction.transactionTime,
          transaction.observedAt,
          transaction.observedAt,
        ]
      );
      providerRow = { id: insertResult.insertId, match_status: 'unmatched' };
    }

    if (!SETTLED_STATUSES.has(transaction.status) || transaction.paymentType !== 'QRIS') {
      await connection.commit();
      return false;
    }

    const [reservationRows] = await connection.query(
      `SELECT r.session_id, r.expires_at, s.started_at, s.payment_expires_at,
              s.payment_status, s.payment_provider, s.payment_required_amount
       FROM payment_amount_reservations r
       JOIN sessions s ON s.id = r.session_id
       WHERE r.merchant_id = ? AND r.expected_amount = ?
         AND r.status = 'reserved' AND r.expires_at > NOW(3)
         AND s.payment_status = 'pending' AND s.payment_provider = ?
       LIMIT 2 FOR UPDATE`,
      [merchantId, transaction.amount, PROVIDER]
    );

    const paidAtMs = transaction.transactionTimeDate.getTime();
    const matches = reservationRows.filter(row => {
      const startedAt = sessionTimestamp(row.started_at);
      const sessionExpiresAt = sessionTimestamp(row.payment_expires_at);
      const reservationExpiresAt = sessionTimestamp(row.expires_at);
      return Number.isFinite(paidAtMs)
        && startedAt !== null
        && paidAtMs >= startedAt
        && (sessionExpiresAt === null || paidAtMs <= sessionExpiresAt)
        && reservationExpiresAt !== null
        && Date.now() <= reservationExpiresAt;
    });

    if (matches.length > 1) {
      await connection.query(
        `UPDATE provider_transactions SET match_status = 'ambiguous'
         WHERE id = ? AND match_status = 'unmatched'`,
        [providerRow.id]
      );
      await connection.commit();
      return false;
    }
    if (matches.length !== 1) {
      await connection.commit();
      return false;
    }

    const sessionCode = matches[0].session_id;
    const transactionCode = transactionCodeFor(merchantId, transaction.transactionId);
    await connection.query(
      `INSERT INTO transactions
         (session_id, transaction_code, amount, payment_method, status,
          verification_method, provider_detected, paid_at, verified_at)
       VALUES (?, ?, ?, 'QRIS', 'success', 'gopay_merchant_polling', ?, ?, CURRENT_TIMESTAMP)`,
      [sessionCode, transactionCode, transaction.amount, PROVIDER, transaction.transactionTimeDate]
    );

    const [sessionUpdate] = await connection.query(
      `UPDATE sessions SET
         payment_status = 'verified',
         payment_verified_at = CURRENT_TIMESTAMP,
         payment_verification_method = 'gopay_merchant_polling'
       WHERE id = ? AND payment_status = 'pending' AND payment_provider = ?`,
      [sessionCode, PROVIDER]
    );
    if (sessionUpdate.affectedRows !== 1) {
      throw new Error('GoPay Merchant session changed while transaction was being claimed.');
    }

    await connection.query(
      `UPDATE payment_amount_reservations SET status = 'matched'
       WHERE merchant_id = ? AND expected_amount = ? AND session_id = ? AND status = 'reserved'`,
      [merchantId, transaction.amount, sessionCode]
    );
    await connection.query(
      `UPDATE provider_transactions SET
         match_status = 'matched', session_id = ?, matched_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND match_status = 'unmatched'`,
      [sessionCode, providerRow.id]
    );

    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
};

const expireReservations = async merchantId => {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    await connection.query(
      `UPDATE sessions s
       JOIN payment_amount_reservations r ON r.session_id = s.id
       SET s.payment_status = 'expired'
       WHERE r.merchant_id = ? AND r.status = 'reserved' AND r.expires_at <= NOW(3)
         AND s.payment_status = 'pending' AND s.payment_provider = ?`,
      [merchantId, PROVIDER]
    );
    await connection.query(
      `UPDATE payment_amount_reservations SET status = 'expired'
       WHERE merchant_id = ? AND status = 'reserved' AND expires_at <= NOW(3)`,
      [merchantId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
};

const pollOnce = async (config = feedAdapter.readConfig()) => {
  if (!config.enabled || activePoll) return { observed: 0, matched: 0 };
  activePoll = true;
  try {
    await expireReservations(config.merchantId);
    const feed = await feedAdapter.fetchTransactions(config);
    const observedAt = toUtcDateTime(new Date());
    let observed = 0;
    let matched = 0;
    for (const item of feed.transactions) {
      const normalized = normalizeTransaction(item, observedAt);
      if (!normalized) continue;
      observed += 1;
      if (await storeAndMatch(config.merchantId, normalized)) matched += 1;
    }
    return { observed, matched };
  } finally {
    activePoll = false;
  }
};

const start = () => {
  // Merchant polling remains opt-in through its own configuration.

  const config = feedAdapter.readConfig();
  if (!config.enabled || timer) return false;

  console.log(`[GoPay Merchant poller] Enabled; interval ${config.intervalMs} ms.`);
  const run = async () => {
    try {
      if (!await ensurePollerLock(config.merchantId)) return;
      const result = await pollOnce(config);
      if (result.matched > 0) {
        console.log(`[GoPay Merchant poller] ${result.matched} payment session(s) verified.`);
      }
    } catch (error) {
      const code = error.code || error.name || 'poll_error';
      console.error(`[GoPay Merchant poller] Poll failed (${String(code).slice(0, 40)}).`);
    }
  };

  void run();
  timer = setInterval(run, config.intervalMs);
  return true;
};

const stop = () => {
  const wasRunning = Boolean(timer);
  if (timer) clearInterval(timer);
  timer = null;
  if (lockConnection) {
    const connection = lockConnection;
    lockConnection = null;
    void connection.query('SELECT RELEASE_LOCK(?)', [lockName])
      .catch(() => {})
      .finally(() => connection.release());
  }
  return wasRunning;
};

module.exports = { start, stop, pollOnce };
