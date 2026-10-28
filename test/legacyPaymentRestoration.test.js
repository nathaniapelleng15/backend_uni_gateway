const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../config/db');
const { startSession, verifyPayment, completeSession } = require('../controllers/sessionController');
const Session = require('../models/sessionModel');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('retained gateway env cannot trigger invoices; legacy sessions keep Admin payment policy', async t => {
  const keys = ['PAYMENT_PROVIDER', 'GOPAY_MERCHANT_ENABLED', 'DUITKU_MERCHANT_CODE', 'DUITKU_API_KEY'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const saved = { query: pool.query, connect: pool.getConnection, fetch: global.fetch };
  t.after(() => {
    pool.query = saved.query; pool.getConnection = saved.connect; global.fetch = saved.fetch;
    for (const key of keys) if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  });
  process.env.PAYMENT_PROVIDER = 'duitku'; // Deliberately retained obsolete config.
  process.env.GOPAY_MERCHANT_ENABLED = 'false';
  process.env.DUITKU_MERCHANT_CODE = ''; process.env.DUITKU_API_KEY = '';
  global.fetch = async () => { assert.fail('session creation must not call a payment gateway'); };
  let paymentRequired = true, legacySchema = false;
  const writes = [];
  pool.query = async sql => {
    if (sql.includes('FROM frame_templates')) return [[{ price: 10000, digital_price: 10000, digital_print_price: 20000 }]];
    if (sql.includes('FROM payment_profiles')) return [[{ payment_data: { payment_required: paymentRequired, unique_amount_enabled: true } }]];
    throw new Error('Unexpected pool query: ' + sql);
  };
  pool.getConnection = async () => ({
    async query(sql, params) {
      assert.doesNotMatch(sql, /duitku_invoices/i, 'obsolete invoice tables must not be needed');
      if (legacySchema && sql.includes('payment_provider =')) {
        throw Object.assign(new Error("Unknown column 'payment_provider' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
      }
      if (sql.includes('SELECT DISTINCT')) return [[]];
      if (sql.includes('payment_status = ?')) writes.push(params);
      return [{ affectedRows: 1 }];
    }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  });
  for (const [required, missingProvider] of [[true, false], [false, false], [true, true]]) {
    paymentRequired = required;
    legacySchema = missingProvider;
    const res = response();
    await startSession({ kiosk: { id: 'fixture', user_id: 1 }, body: { frame_template_id: 1, package_type: 'digital_print' } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.payment_method, 'qris_visual_proof');
    assert.equal(res.body.data.payment_required, required);
    assert.ok(res.body.data.unique_code >= 1 && res.body.data.unique_code <= 99);
    assert.equal(res.body.amount, 20000 + res.body.data.unique_code);
    assert.equal(writes.at(-1)[0], required ? 'pending' : 'verified');
    assert.equal(writes.at(-1)[3], missingProvider ? 'digital_print' : 'legacy_cv');
    assert.equal(res.body.data.qris_image_url, undefined);
    assert.equal(res.body.data.merchant_order_id, undefined);
  }
});

test('restored legacy flow does not allow manual success or completing unpaid sessions', async t => {
  const bypass = response(); await verifyPayment({}, bypass); assert.equal(bypass.statusCode, 403);
  const original = Session.findByCodeAndKiosk;
  t.after(() => { Session.findByCodeAndKiosk = original; });
  Session.findByCodeAndKiosk = async () => ({ payment_status: 'pending' });
  const completion = response();
  await completeSession({ params: { session_code: 'fixture' }, kiosk: { id: 'fixture' } }, completion);
  assert.equal(completion.statusCode, 403);
});

test('historical unsupported gateway sessions cannot be paid via visual-proof fallback', async t => {
  const { PaymentVerificationController } = require('../controllers/paymentVerificationController');
  const original = pool.query;
  t.after(() => { pool.query = original; });
  for (const provider of ['duitku', 'removed_gateway']) {
    pool.query = async sql => {
      assert.match(sql, /SELECT s\.\*, s.session_code/);
      return [[{ session_id: 'historical', payment_provider: provider, payment_status: 'pending' }]];
    };
    const res = response();
    await PaymentVerificationController.submitEvidence({ params: { session_code: 'historical' }, body: {}, kiosk: { id: 'fixture' }, files: [{}] }, res);
    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  }
});

test('server and kiosk router no longer register external gateway callbacks or checks', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['server.js', 'routes/v1/kioskRoutes.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /duitku|payment-verification\/check/i);
  }
});
