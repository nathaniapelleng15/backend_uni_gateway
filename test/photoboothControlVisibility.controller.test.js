const assert = require('node:assert/strict');
const { test } = require('node:test');
const PaymentProfile = require('../models/paymentProfileModel');
const pool = require('../config/db');
const { getKioskPaymentMethods, updateAdminPaymentProfile } = require('../controllers/paymentController');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const baseBody = {
  merchant_name: 'UNI SMILE', display_name: 'UNI SMILE', unique_amount_enabled: false,
  session_ttl_minutes: 5, verification_mode: 'assisted', merchant_aliases: [],
  active_providers: [], payment_required: true,
};

test('Admin persists independent lock/calibration icon switches and kiosk receives them', async t => {
  const originals = {
    findDefault: PaymentProfile.findDefaultForKiosk,
    findByUser: PaymentProfile.findByUserId,
    query: pool.query,
  };
  let stored = { show_digital_package: true, show_print_package: true, show_cursor_lock_icon: true, show_calibration_icon: true };
  PaymentProfile.findDefaultForKiosk = async () => ({ id: 91, payment_data: JSON.stringify(stored) });
  PaymentProfile.findByUserId = async () => [{ payment_data: JSON.stringify(stored) }];
  pool.query = async (sql, params) => {
    assert.match(sql, /UPDATE payment_profiles/);
    stored = JSON.parse(params[2]);
    return [{ affectedRows: 1 }];
  };
  t.after(() => {
    PaymentProfile.findDefaultForKiosk = originals.findDefault;
    PaymentProfile.findByUserId = originals.findByUser;
    pool.query = originals.query;
  });

  for (const expected of [
    { show_cursor_lock_icon: false, show_calibration_icon: true },
    { show_cursor_lock_icon: true, show_calibration_icon: false },
  ]) {
    const saved = response();
    await updateAdminPaymentProfile({ user: { id: 91 }, body: { ...baseBody, ...expected } }, saved);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual({
      show_cursor_lock_icon: stored.show_cursor_lock_icon,
      show_calibration_icon: stored.show_calibration_icon,
    }, expected);

    const kiosk = response();
    await getKioskPaymentMethods({ kiosk: { user_id: 91 } }, kiosk);
    assert.deepEqual(kiosk.body.control_visibility, expected);
  }

  const previous = { ...stored };
  const invalid = response();
  await updateAdminPaymentProfile({
    user: { id: 91 },
    body: { ...baseBody, show_cursor_lock_icon: 'false', show_calibration_icon: true },
  }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(stored, previous, 'invalid values must not be persisted');
});
