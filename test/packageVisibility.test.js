const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mergePackageVisibility, readPackageVisibility } = require('../utils/packageVisibility');

test('existing payment profile defaults both output packages to enabled', () => {
  assert.deepEqual(readPackageVisibility({}), {
    show_digital_package: true,
    show_print_package: true,
  });
});

test('Admin can enable Digital only without changing Print code or settings', () => {
  assert.deepEqual(mergePackageVisibility({}, {
    show_digital_package: true,
    show_print_package: false,
  }), {
    show_digital_package: true,
    show_print_package: false,
  });
});

test('Admin can enable Print only without changing Digital code or settings', () => {
  assert.deepEqual(mergePackageVisibility({}, {
    show_digital_package: false,
    show_print_package: true,
  }), {
    show_digital_package: false,
    show_print_package: true,
  });
});

test('omitted values preserve their previously saved state', () => {
  assert.deepEqual(mergePackageVisibility({
    show_digital_package: false,
    show_print_package: true,
  }, {}), {
    show_digital_package: false,
    show_print_package: true,
  });
});

test('invalid request values and disabling both packages are rejected', () => {
  assert.throws(() => mergePackageVisibility({}, { show_digital_package: 'false' }), /boolean/);
  assert.throws(() => mergePackageVisibility({}, {
    show_digital_package: false,
    show_print_package: false,
  }), /Minimal satu paket/);
});

test('payment_data may arrive as JSON text from MySQL', () => {
  assert.deepEqual(readPackageVisibility('{"show_digital_package":false,"show_print_package":true}'), {
    show_digital_package: false,
    show_print_package: true,
  });
});
