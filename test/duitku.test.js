const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const client = require('../services/duitkuClient');
const pool = require('../config/db');
const { callback } = require('../controllers/duitkuController');
const settings = {
  merchantCode: 'DTEST', apiKey: 'test-only-secret', baseUrl: 'https://sandbox.duitku.com',
  email: 'sandbox@example.com', paymentMethod: 'NQ', callbackUrl: 'https://api.example.com/callback',
  returnUrl: 'https://example.com', expiryMinutes: 10,
};
const hmac = value => crypto.createHmac('sha256', settings.apiKey).update(value).digest('hex');
const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });

test('inquiry signs server price and requests dynamic QRIS in sandbox', async () => {
  let captured;
  const invoice = await client.createInvoice({ orderId: 'order-1', amount: 15000 }, settings, async (url, opts) => {
    assert.equal(url, settings.baseUrl + '/webapi/api/merchant/v2/inquiry');
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ statusCode: '00', reference: 'ref-1', qrString: 'dynamic-qr', paymentUrl: 'https://sandbox.duitku.com/checkout' }) };
  });
  assert.equal(captured.signature, hmac('DTESTorder-115000'));
  assert.equal(captured.paymentAmount, 15000);
  assert.equal(captured.itemDetails[0].price, 15000);
  assert.equal(captured.paymentMethod, 'NQ');
  assert.equal(invoice.qrString, 'dynamic-qr');
  assert.equal(JSON.stringify(captured).includes(settings.apiKey), false);
});

test('reject provider response without QRIS and do not expose provider secrets', async () => {
  const missingQr = async () => ({ ok: true, json: async () => ({ statusCode: '00', reference: 'r', paymentUrl: 'https://sandbox.duitku.com' }) });
  await assert.rejects(client.createInvoice({ orderId: 'o', amount: 10000 }, settings, missingQr), /QRIS dinamis/);
  await assert.rejects(client.createInvoice({ orderId: 'o', amount: 10000 }, settings, async () => { throw new Error(settings.apiKey); }), error => !error.message.includes(settings.apiKey));
});

test('callback rejects wrong merchant, changed amount and invalid signatures', () => {
  const body = { merchantCode: 'DTEST', amount: '15000', merchantOrderId: 'order-1', signature: hmac('DTEST15000order-1') };
  assert.equal(client.validCallback(body, settings), true);
  for (const change of [{ merchantCode: 'OTHER' }, { amount: '15001' }, { signature: '00' }, { signature: null }]) {
    assert.equal(client.validCallback({ ...body, ...change }, settings), false);
  }
});

test('status request uses order signature', async () => {
  await client.checkTransaction('order-1', settings, async (url, opts) => {
    assert.match(url, /transactionStatus$/);
    assert.equal(JSON.parse(opts.body).signature, hmac('DTESTorder-1'));
    return { ok: true, json: async () => ({ statusCode: '01' }) };
  });
});

test('callback validates provider, is idempotent, and rolls back failed fulfillment', async t => {
  const original = { config: client.config, check: client.checkTransaction, query: pool.query, connect: pool.getConnection };
  t.after(() => { client.config = original.config; client.checkTransaction = original.check; pool.query = original.query; pool.getConnection = original.connect; });
  client.config = () => settings;
  const invoice = { merchant_order_id: 'order-1', session_code: 'session-1', merchant_code: 'DTEST', amount: 15000, reference: 'ref-1', status: 'pending' };
  const session = { payment_provider: 'duitku', payment_required_amount: 15000 };
  const body = { merchantCode: 'DTEST', merchantOrderId: 'order-1', amount: '15000', reference: 'ref-1', resultCode: '00', signature: hmac('DTEST15000order-1') };
  let status = '00', inserts = 0, commits = 0, rollbacks = 0, fail = false, providerChecks = 0;
  pool.query = async () => [[{ ...invoice }]];
  client.checkTransaction = async () => { providerChecks++; return { merchantOrderId: 'order-1', reference: 'ref-1', amount: 15000, statusCode: status }; };
  pool.getConnection = async () => ({
    async query(sql) {
      if (sql.startsWith('SELECT * FROM duitku')) return [[{ ...invoice }]];
      if (sql.startsWith('SELECT * FROM sessions')) return [[session]];
      if (sql.includes('INSERT INTO transactions')) { if (fail) throw new Error('test failure'); inserts++; }
      if (sql.includes("SET status = 'paid'")) invoice.status = 'paid';
      return [{ affectedRows: 1 }];
    }, async beginTransaction() {}, async commit() { commits++; }, async rollback() { rollbacks++; }, release() {},
  });
  let res = response();
  await callback({ body: { ...body, signature: '0'.repeat(64) } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(providerChecks, 0);
  res = response();
  await callback({ body: { ...body, reference: 'wrong' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(inserts, 0);
  status = '01'; res = response(); await callback({ body }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(inserts, 0); // signed success code is insufficient without provider confirmation
  status = '00'; fail = true; res = response(); await callback({ body }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(rollbacks, 1);
  fail = false; res = response(); await callback({ body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(inserts, 1);
  assert.equal(commits, 1);
  res = response(); await callback({ body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(inserts, 1);
  invoice.status = 'pending'; status = '02'; res = response(); await callback({ body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(inserts, 1);
});

test('sandbox verification checks the provider and fulfills only a matching paid invoice', async t => {
  const { verifySandboxPayment } = require('../controllers/duitkuController');
  const original = { config: client.config, enabled: client.enabled, check: client.checkTransaction, query: pool.query, connect: pool.getConnection };
  t.after(() => { client.config = original.config; client.enabled = original.enabled; client.checkTransaction = original.check; pool.query = original.query; pool.getConnection = original.connect; });
  client.enabled = () => true;
  client.config = () => ({ ...settings, environment: 'sandbox' });
  const invoice = { merchant_order_id: 'order-verify', session_code: 'session-verify', merchant_code: 'DTEST', amount: 15000, reference: 'ref-verify', status: 'pending' };
  const session = { session_code: 'session-verify', kiosk_id: 'kiosk-1', payment_provider: 'duitku', payment_required_amount: 15000, payment_status: 'pending' };
  let statusCode = '01', providerCalls = 0, inserts = 0, commits = 0;
  pool.query = async sql => sql.includes('FROM sessions') ? [[{ ...session }]] : [[{ ...invoice }]];
  client.checkTransaction = async orderId => { providerCalls++; assert.equal(orderId, invoice.merchant_order_id); return { merchantOrderId: orderId, reference: invoice.reference, amount: invoice.amount, statusCode }; };
  pool.getConnection = async () => ({
    async query(sql) {
      if (sql.includes('FROM duitku_invoices')) return [[{ ...invoice }]];
      if (sql.includes('FROM sessions')) return [[{ ...session }]];
      if (sql.includes('INSERT INTO transactions')) inserts++;
      if (sql.includes("SET status = 'paid'")) invoice.status = 'paid';
      if (sql.includes("SET payment_status = 'verified'")) session.payment_status = 'verified';
      return [{ affectedRows: 1 }];
    }, async beginTransaction() {}, async commit() { commits++; }, async rollback() {}, release() {},
  });
  const req = { params: { session_code: session.session_code }, kiosk: { id: 'kiosk-1' } };
  let res = response(); await verifySandboxPayment(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.payment_status, 'pending'); assert.equal(inserts, 0);
  statusCode = '00'; res = response(); await verifySandboxPayment(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.payment_status, 'verified'); assert.equal(inserts, 1); assert.equal(commits, 1);
  res = response(); await verifySandboxPayment(req, res);
  assert.equal(res.body.data.payment_status, 'verified'); assert.equal(inserts, 1);
  assert.equal(providerCalls, 2);
});

test('sandbox verification rejects production configuration and invoice mismatches', async t => {
  const { verifySandboxPayment } = require('../controllers/duitkuController');
  const original = { config: client.config, enabled: client.enabled, query: pool.query, connect: pool.getConnection };
  t.after(() => { client.config = original.config; client.enabled = original.enabled; pool.query = original.query; pool.getConnection = original.connect; });
  client.enabled = () => true;
  client.config = () => ({ ...settings, environment: 'production' });
  let reads = 0; pool.query = async () => { reads++; return [[]]; };
  let res = response(); await verifySandboxPayment({ params: { session_code: 's' }, kiosk: { id: 'k' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(reads, 0);
  client.config = () => settings;
  pool.query = async sql => sql.includes('FROM sessions') ? [[{ session_code: 's', kiosk_id: 'k', payment_provider: 'legacy_cv' }]] : [[]];
  res = response(); await verifySandboxPayment({ params: { session_code: 's' }, kiosk: { id: 'k' } }, res);
  assert.equal(res.statusCode, 403);
});

test('session returns dynamic QR at server price without unique suffix and fails closed', async t => {
  const { startSession } = require('../controllers/sessionController');
  const original = { query: pool.query, connect: pool.getConnection, config: client.config, create: client.createInvoice, provider: process.env.PAYMENT_PROVIDER };
  t.after(() => {
    pool.query = original.query; pool.getConnection = original.connect; client.config = original.config; client.createInvoice = original.create;
    if (original.provider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = original.provider;
  });
  process.env.PAYMENT_PROVIDER = 'duitku';
  client.config = () => ({ ...settings, environment: 'sandbox' });
  let required = true, fail = false, expired = 0;
  pool.query = async sql => {
    if (sql.includes('FROM frame_templates')) return [[{ price: 15000, layout_config: {} }]];
    if (sql.includes('FROM payment_profiles')) return [[{ payment_data: { payment_required: required, unique_amount_enabled: true } }]];
    if (sql.includes("payment_status = 'expired'")) expired++;
    return [{ affectedRows: 1 }];
  };
  pool.getConnection = async () => ({
    async query(sql) {
      if (sql.includes('SELECT DISTINCT')) return [[{ payment_required_amount: 15000 }]];
      return [{ affectedRows: 1 }];
    }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  });
  let invoices = 0;
  client.createInvoice = async order => {
    invoices++; assert.equal(order.amount, 15000); assert.match(order.orderId, /^US-/);
    if (fail) throw Object.assign(new Error('Provider failed'), { statusCode: 502 });
    return { reference: 'ref-1', qrString: '000201010212-test', paymentUrl: 'https://sandbox.duitku.com/checkout' };
  };
  const req = { kiosk: { id: 'kiosk-1', user_id: 1, base_price: 10000 }, body: { frame_template_id: 1, amount: 1 } };
  let res = response(); await startSession(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.amount, 15000);
  assert.equal(res.body.data.unique_code, null);
  assert.equal(res.body.data.payment_method, 'duitku_qris');
  assert.match(res.body.data.qris_image_url, /^data:image\/png;base64,/);
  assert.equal(res.body.data.payment_environment, 'sandbox');
  fail = true; res = response(); await startSession(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(expired, 1);
  required = false; res = response(); await startSession(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.payment_required, false);
  assert.equal(invoices, 2);
});

test('Duitku selection disables GoPay poller even with legacy flag enabled', t => {
  const poller = require('../services/gopayMerchantPoller');
  const feed = require('../services/gopayMerchantFeed');
  const saved = { provider: process.env.PAYMENT_PROVIDER, flag: process.env.GOPAY_MERCHANT_ENABLED, config: feed.readConfig };
  t.after(() => {
    for (const [key, value] of [['PAYMENT_PROVIDER', saved.provider], ['GOPAY_MERCHANT_ENABLED', saved.flag]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    feed.readConfig = saved.config;
  });
  process.env.PAYMENT_PROVIDER = ' Duitku ';
  process.env.GOPAY_MERCHANT_ENABLED = 'true';
  feed.readConfig = () => { throw new Error('GoPay config must not be read'); };
  assert.equal(poller.start(), false);
  assert.equal(client.enabled(), true);
});

test('Duitku errors distinguish rejected requests, network and timeout without exposing secrets', async () => {
  const order = { orderId: 'o', amount: 10000 };
  await assert.rejects(client.createInvoice(order, settings, async () => ({ ok: false, status: 400, json: async () => ({ Message: settings.apiKey }) })), /HTTP 400/);
  await assert.rejects(client.createInvoice(order, settings, async () => { throw Object.assign(new Error(settings.apiKey), { name: 'TimeoutError' }); }), /15 detik/);
  await assert.rejects(client.createInvoice(order, settings, async () => { throw new TypeError(settings.apiKey); }), /koneksi internet\/DNS/);
});


test('Cloudflare HTML 403 is distinguished from merchant API rejection', async () => {
  const headers = new Map([
    ['server', 'cloudflare'], ['content-type', 'text/html; charset=UTF-8'],
    ['cf-ray', 'a4721cfb4d55ce36-SIN'],
  ]);
  await assert.rejects(client.createInvoice({ orderId: 'order-edge', amount: 1000 }, settings, async () => ({
    ok: false, status: 403, headers,
    async json() { throw new Error('HTML must not be parsed as JSON'); },
  })), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'DUITKU_EDGE_BLOCKED');
    assert.match(error.message, /Cloudflare Duitku/);
    assert.match(error.message, /a4721cfb4d55ce36-SIN/);
    assert.equal(error.message.includes(settings.apiKey), false);
    return true;
  });
  await assert.rejects(client.createInvoice({ orderId: 'order-auth', amount: 1000 }, settings, async () => ({
    ok: false, status: 403, headers: new Map([['server', 'cloudflare'], ['content-type', 'application/json']]),
    async json() { return { Message: 'Invalid signature' }; },
  })), error => error.code !== 'DUITKU_EDGE_BLOCKED' && /HTTP 403/.test(error.message));
});
