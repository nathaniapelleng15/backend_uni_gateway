const assert = require('node:assert/strict');
const { test } = require('node:test');
const PaymentProfile = require('../models/paymentProfileModel');
const pool = require('../config/db');
const { getKioskPaymentMethods, updateAdminPaymentProfile } = require('../controllers/paymentController');

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const runSave = async body => {
  const response = makeResponse();
  await updateAdminPaymentProfile({ user: { id: 77 }, body }, response);
  return response;
};

test('Admin saves each package switch and kiosk receives the exact persisted values', async t => {
  const originals = {
    findDefault: PaymentProfile.findDefaultForKiosk,
    findByUser: PaymentProfile.findByUserId,
    query: pool.query,
  };
  let stored = { show_digital_package: true, show_print_package: true };
  let lastUpdate = null;

  PaymentProfile.findDefaultForKiosk = async () => ({ id: 9, payment_data: JSON.stringify(stored) });
  PaymentProfile.findByUserId = async () => [{ payment_data: JSON.stringify(stored) }];
  pool.query = async (sql, params) => {
    assert.match(sql, /UPDATE payment_profiles/);
    lastUpdate = JSON.parse(params[2]);
    stored = lastUpdate;
    return [{ affectedRows: 1 }];
  };
  t.after(() => {
    PaymentProfile.findDefaultForKiosk = originals.findDefault;
    PaymentProfile.findByUserId = originals.findByUser;
    pool.query = originals.query;
  });

  const shared = {
    merchant_name: 'UNI SMILE',
    display_name: 'UNI SMILE',
    unique_amount_enabled: false,
    session_ttl_minutes: 5,
    verification_mode: 'assisted',
    merchant_aliases: [],
    active_providers: [],
    payment_required: true,
  };

  let response = await runSave({ ...shared, show_digital_package: true, show_print_package: false });
  assert.equal(response.statusCode, 200);
  assert.equal(lastUpdate.show_digital_package, true);
  assert.equal(lastUpdate.show_print_package, false);

  let kioskResponse = makeResponse();
  await getKioskPaymentMethods({ kiosk: { user_id: 77 } }, kioskResponse);
  assert.deepEqual(kioskResponse.body.package_visibility, {
    show_digital_package: true,
    show_print_package: false,
  });

  response = await runSave({ ...shared, show_digital_package: false, show_print_package: true });
  assert.equal(response.statusCode, 200);
  assert.equal(lastUpdate.show_digital_package, false);
  assert.equal(lastUpdate.show_print_package, true);

  kioskResponse = makeResponse();
  await getKioskPaymentMethods({ kiosk: { user_id: 77 } }, kioskResponse);
  assert.deepEqual(kioskResponse.body.package_visibility, {
    show_digital_package: false,
    show_print_package: true,
  });

  response = await runSave({ ...shared, show_digital_package: false, show_print_package: false });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /Minimal satu paket/);
  assert.equal(stored.show_print_package, true, 'invalid request must not persist');
});
