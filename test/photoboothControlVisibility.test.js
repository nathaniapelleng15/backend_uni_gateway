const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  readPhotoboothControlVisibility,
  mergePhotoboothControlVisibility,
} = require('../utils/packageVisibility');

test('legacy payment profiles keep both lock and calibration icons enabled', () => {
  assert.deepEqual(readPhotoboothControlVisibility({ payment_required: true }), {
    show_cursor_lock_icon: true,
    show_calibration_icon: true,
  });
});

test('lock and calibration icon visibility can be disabled independently', () => {
  assert.deepEqual(mergePhotoboothControlVisibility({
    show_cursor_lock_icon: true,
    show_calibration_icon: true,
  }, {
    show_cursor_lock_icon: false,
    show_calibration_icon: true,
  }), {
    show_cursor_lock_icon: false,
    show_calibration_icon: true,
  });
  assert.deepEqual(mergePhotoboothControlVisibility({
    show_cursor_lock_icon: false,
    show_calibration_icon: true,
  }, {
    show_cursor_lock_icon: false,
    show_calibration_icon: false,
  }), {
    show_cursor_lock_icon: false,
    show_calibration_icon: false,
  });
});

test('omitted control settings preserve saved values and reject non-booleans', () => {
  const saved = { show_cursor_lock_icon: false, show_calibration_icon: true };
  assert.deepEqual(mergePhotoboothControlVisibility(saved, {}), saved);
  assert.throws(
    () => mergePhotoboothControlVisibility(saved, { show_calibration_icon: 'false' }),
    /show_calibration_icon harus berupa boolean/
  );
});
