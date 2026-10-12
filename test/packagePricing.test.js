const { test } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const duitku = require('../services/duitkuClient');
const { resolvePackagePrices, parsePackageType, validatePackagePrices } = require('../utils/packagePricing');
const { startSession } = require('../controllers/sessionController');
const { updateLayoutPackagePrices } = require('../controllers/frameTemplateController');
const { createPrintJobController } = require('../controllers/printJobController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('package price validation rejects malformed, negative, fractional, missing and oversized values', () => {
  for (const value of [null, '', ' ', true, [], {}, -1, 0, 1.5, Infinity, 10000000000]) {
    assert.throws(() => validatePackagePrices({ digital_price: value }), { statusCode: 400 });
  }
  assert.throws(() => validatePackagePrices({ digital_price: 10000 }, true), { statusCode: 400 });
  assert.deepEqual(validatePackagePrices({ digital_price: '10000', digital_print_price: 20000 }, true), { digital_price: 10000, digital_print_price: 20000 });
  assert.deepEqual(validatePackagePrices({ name: 'Only changing name' }), {});
  assert.throws(() => parsePackageType('print'), { statusCode: 400 });
  assert.equal(parsePackageType(undefined), 'digital_print');
});

test('separate package prices win and legacy template/kiosk fallbacks remain available', () => {
  assert.deepEqual(resolvePackagePrices({ price: 1000, digital_price: '10000', digital_print_price: '20000' }, 500), { digital_price: 10000, digital_print_price: 20000 });
  assert.deepEqual(resolvePackagePrices({ price: 1000 }, 500), { digital_price: 1000, digital_print_price: 1000 });
  assert.deepEqual(resolvePackagePrices({ price: null }, 12000), { digital_price: 12000, digital_print_price: 12000 });
  assert.throws(() => resolvePackagePrices({ digital_price: -10, price: 1000 }), { statusCode: 503 });
});

test('session invoices use chosen package server price and persist an immutable price snapshot', async t => {
  const originals = { query: pool.query, connect: pool.getConnection, config: duitku.config, create: duitku.createInvoice, provider: process.env.PAYMENT_PROVIDER };
  t.after(() => {
    pool.query = originals.query; pool.getConnection = originals.connect; duitku.config = originals.config; duitku.createInvoice = originals.create;
    if (originals.provider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = originals.provider;
  });
  process.env.PAYMENT_PROVIDER = 'duitku';
  let digital = 10000, print = 20000, visibility = {}, invoices = [], snapshots = [];
  duitku.config = () => ({ merchantCode: 'DTEST', expiryMinutes: 10, environment: 'sandbox' });
  duitku.createInvoice = async order => { invoices.push(order.amount); return { reference: 'ref-' + invoices.length, qrString: 'test-qris', paymentUrl: 'https://sandbox.duitku.com' }; };
  pool.query = async sql => {
    if (sql.includes('FROM frame_templates')) return [[{ price: 1, digital_price: digital, digital_print_price: print }]];
    if (sql.includes('FROM payment_profiles')) return [[{ payment_data: { ...visibility, unique_amount_enabled: true } }]];
    return [{ affectedRows: 1 }];
  };
  pool.getConnection = async () => ({
    async query(sql, params) {
      if (sql.includes('SELECT DISTINCT')) return [[]];
      if (sql.includes('package_base_amount =')) snapshots.push({ package: params[4], base: params[5], total: params[1] });
      return [{ affectedRows: 1 }];
    }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  });
  const req = packageType => ({ kiosk: { id: 'K', user_id: 1, base_price: 1 }, body: { frame_template_id: 1, package_type: packageType, amount: 1, digital_price: 1 } });
  for (const [type, amount] of [['digital', 10000], ['digital_print', 20000]]) {
    const res = response(); await startSession(req(type), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.amount, amount);
    assert.equal(res.body.data.package_type, type);
    assert.equal(res.body.data.unique_code, null);
  }
  digital = 15000;
  assert.deepEqual(snapshots, [{ package: 'digital', base: 10000, total: 10000 }, { package: 'digital_print', base: 20000, total: 20000 }]);
  let res = response(); await startSession(req('unknown'), res); assert.equal(res.statusCode, 400);
  visibility = { show_digital_package: false };
  res = response(); await startSession(req('digital'), res); assert.equal(res.statusCode, 400);
  assert.deepEqual(invoices, [10000, 20000]);
});

test('layout prices are owner scoped, committed together, and rolled back on write failure', async t => {
  const original = pool.getConnection;
  t.after(() => { pool.getConnection = original; });
  let fail = false, commits = 0, rollbacks = 0;
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() { commits++; }, async rollback() { rollbacks++; }, release() {},
    async query(sql, params) {
      assert.match(sql, /user_id = \?/);
      assert.equal(params.at(-1), 7);
      if (sql.startsWith('SELECT')) return [[{ id: 1 }, { id: 2 }]];
      assert.deepEqual(params, [10000, 10000, 20000, '1x1', 7]);
      if (fail) throw new Error('Write failed');
      return [{ affectedRows: 2 }];
    },
  });
  const req = { user: { id: 7, role: 'Admin' }, params: { layout_id: '1x1' }, body: { digital_price: 10000, digital_print_price: 20000 } };
  let res = response(); await updateLayoutPackagePrices(req, res);
  assert.equal(res.statusCode, 200); assert.equal(commits, 1); assert.equal(res.body.data.updated_frames, 2);
  fail = true; res = response(); await updateLayoutPackagePrices(req, res);
  assert.equal(res.statusCode, 500); assert.equal(commits, 1); assert.equal(rollbacks, 1);
});

test('verified Digital sessions cannot dispatch print jobs', async () => {
  let dispatched = false;
  const controller = createPrintJobController({
    sessionModel: { findByCodeAndKiosk: async () => ({ package_type: 'digital', payment_status: 'verified' }) },
    isKioskConnected: () => true,
    sendKioskCommand: () => { dispatched = true; },
  });
  const res = response();
  await controller.createPrintJob({ params: { session_code: 'S' }, kiosk: { id: 'K' }, body: { image_url: '/uploads/photo.png', copies: 1 } }, res, error => { throw error; });
  assert.equal(res.statusCode, 403); assert.equal(res.body.error_code, 'PRINT_NOT_INCLUDED'); assert.equal(dispatched, false);
});
