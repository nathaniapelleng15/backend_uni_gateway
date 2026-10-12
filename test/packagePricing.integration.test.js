const { test } = require('node:test');
test('package prices persist through checkout, repricing and duplicate callbacks (local DB)', { skip: process.env.PACKAGE_PRICING_INTEGRATION !== 'true' }, async () => {
const path = require('path');
const root = path.resolve(__dirname, '..');
require(path.join(root, 'node_modules/dotenv')).config({ path: path.join(root, '.env') });
const assert = require('node:assert/strict');
const crypto = require('crypto');
const pool = require(path.join(root, 'config/db'));
const frames = require(path.join(root, 'controllers/frameTemplateController'));
const sessions = require(path.join(root, 'controllers/sessionController'));
const client = require(path.join(root, 'services/duitkuClient'));
const callbacks = require(path.join(root, 'controllers/duitkuController'));
const { createPrintJobController } = require(path.join(root, 'controllers/printJobController'));
const res = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const layoutId = 'P' + crypto.randomBytes(2).toString('hex');
const sessionCodes = [];
const orderIds = [];
const originals = { create: client.createInvoice, check: client.checkTransaction };
let user;

  try {
    const [kiosks] = await pool.query('SELECT * FROM kiosks WHERE id = ?', ['K-001']);
    const kiosk = kiosks[0]; assert.ok(kiosk);
    user = { id: kiosk.user_id, role: 'Admin' };
    for (let i = 0; i < 2; i++) {
      const result = res();
      await frames.generateTemplate({ user, body: { name: layoutId + '-' + i, layout_id: layoutId, slot_count: 1, digital_price: 1500, digital_print_price: 2500, frame_type: 'color', layout_config: {} } }, result);
      assert.equal(result.statusCode, 201, JSON.stringify(result.body));
    }
    const [templates] = await pool.query('SELECT id FROM frame_templates WHERE layout_id = ? AND user_id = ?', [layoutId, user.id]);
    assert.equal(templates.length, 2);
    const setPrices = async (digital, print) => {
      const result = res();
      await frames.updateLayoutPackagePrices({ user, params: { layout_id: layoutId }, body: { digital_price: digital, digital_print_price: print } }, result);
      assert.equal(result.statusCode, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.updated_frames, 2);
    };
    await setPrices(2000, 5000);
    const adminResult = res();
    await frames.getTemplates({ user }, adminResult);
    assert.equal(adminResult.statusCode, 200);
    const adminFrames = adminResult.body.data.filter(frame => frame.layout_id === layoutId);
    assert.equal(adminFrames.length, 2);
    assert.ok(adminFrames.every(frame => frame.digital_price === 2000 && frame.digital_print_price === 5000));
    const kioskResult = res();
    await require(path.join(root, 'controllers/kioskController')).getKioskTemplates({ kiosk, protocol: 'http', get: () => '127.0.0.1:8000' }, kioskResult);
    assert.equal(kioskResult.statusCode, 200, JSON.stringify(kioskResult.body));
    const kioskLayout = kioskResult.body.data.find(layout => layout.id === layoutId);
    assert.equal(kioskLayout.styles.length, 2);
    assert.ok(kioskLayout.styles.every(style => style.digital_price === 2000 && style.digital_print_price === 5000));
    const issued = new Map();
    client.createInvoice = async order => {
      const reference = 'PKG-TEST-' + crypto.randomUUID();
      issued.set(order.orderId, { reference, amount: order.amount });
      return { reference, qrString: 'sandbox-test-only', paymentUrl: 'https://sandbox.duitku.com' };
    };
    client.checkTransaction = async id => ({ merchantOrderId: id, ...issued.get(id), statusCode: '00' });
    for (const [type, amount] of [['digital', 2000], ['digital_print', 5000]]) {
      const result = res();
      await sessions.startSession({ kiosk, body: { frame_template_id: templates[0].id, package_type: type, amount: 1 } }, result);
      assert.equal(result.statusCode, 201, JSON.stringify(result.body));
      const data = result.body.data;
      sessionCodes.push(data.session_code); orderIds.push(data.merchant_order_id);
      assert.equal(result.body.amount, amount); assert.equal(data.package_type, type);
      const settings = client.config();
      const body = { merchantCode: settings.merchantCode, merchantOrderId: data.merchant_order_id, reference: data.payment_reference, amount: String(amount), resultCode: '00' };
      body.signature = client.sign(body.merchantCode + body.amount + body.merchantOrderId, settings.apiKey);
      for (let repeat = 0; repeat < 2; repeat++) {
        const confirmation = res(); await callbacks.callback({ body }, confirmation);
        assert.equal(confirmation.statusCode, 200, JSON.stringify(confirmation.body));
      }
      const [payments] = await pool.query('SELECT amount FROM transactions WHERE session_id = ?', [data.session_code]);
      assert.equal(payments.length, 1); assert.equal(Number(payments[0].amount), amount);
    }
    await setPrices(3000, 7000);
    const [snapshots] = await pool.query('SELECT package_type, package_base_amount, payment_required_amount, payment_status FROM sessions WHERE session_code IN (?, ?) ORDER BY package_type', sessionCodes);
    assert.deepEqual(snapshots.map(row => [row.package_type, Number(row.package_base_amount), Number(row.payment_required_amount), row.payment_status]), [['digital', 2000, 2000, 'verified'], ['digital_print', 5000, 5000, 'verified']]);
    const printResult = res();
    await createPrintJobController().createPrintJob({ kiosk, params: { session_code: sessionCodes[0] }, body: { image_url: '/uploads/test.png', copies: 1 } }, printResult, error => { throw error; });
    assert.equal(printResult.statusCode, 403); assert.equal(printResult.body.error_code, 'PRINT_NOT_INCLUDED');
    console.log({ passed: true, database: 'local', framesUpdatedAtomically: 2, digitalAmount: 2000, digitalPrintAmount: 5000, callbackDuplicates: 'one transaction each', oldSessionPrices: 'unchanged after Admin repricing', digitalPrintAccess: '403 blocked', provider: 'mocked; no real payments or printing' });
  } finally {
    client.createInvoice = originals.create; client.checkTransaction = originals.check;
    for (const code of sessionCodes) {
      await pool.query('DELETE FROM transactions WHERE session_id = ?', [code]);
      await pool.query('DELETE FROM duitku_invoices WHERE session_code = ?', [code]);
      await pool.query('DELETE FROM sessions WHERE session_code = ?', [code]);
    }
    if (user) await pool.query('DELETE FROM frame_templates WHERE layout_id = ? AND user_id = ?', [layoutId, user.id]);
    await pool.end();
  }

});
