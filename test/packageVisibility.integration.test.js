const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const controller = read('unismiles-backend/controllers/paymentController.js');
const admin = read('unismiles-admin/src/pages/Settings.tsx');
const api = read('unismiles-photobooth/services/apiService.ts');
const booth = read('unismiles-photobooth/components/PhotoBooth.tsx');

test('kiosk payment response carries the saved package switches with enabled defaults', () => {
  assert.match(controller, /package_visibility:\s*readPackageVisibility/);
  assert.match(controller, /findDefaultForKiosk\(user_id\)/);
});

test('Admin payment settings load and persist both independent package switches', () => {
  assert.match(admin, /show_digital_package/);
  assert.match(admin, /show_print_package/);
  assert.match(admin, /setShowDigitalPackage\(paymentData\.show_digital_package !== false\)/);
  assert.match(admin, /setShowPrintPackage\(paymentData\.show_print_package !== false\)/);
  assert.match(admin, /id: 'toggle-package-digital'/);
  assert.match(admin, /id: 'toggle-package-print'/);
});

test('photobooth reads the server package_visibility, without mistaking missing values for false', () => {
  assert.match(api, /fetchPackageVisibility/);
  assert.match(api, /package_visibility/);
});

test('photobooth renders only enabled options and refuses disabled selections', () => {
  assert.match(booth, /packageVisibility\.print &&/);
  assert.match(booth, /packageVisibility\.digital &&/);
  assert.match(booth, /!packageVisibility\[pkg\]/);
});

test('Admin persists independent cursor lock and calibration icon toggles', () => {
  assert.match(admin, /setShowCursorLockIcon\(paymentData\.show_cursor_lock_icon !== false\)/);
  assert.match(admin, /setShowCalibrationIcon\(paymentData\.show_calibration_icon !== false\)/);
  assert.match(admin, /show_cursor_lock_icon: showCursorLockIcon/);
  assert.match(admin, /show_calibration_icon: showCalibrationIcon/);
  assert.match(admin, /toggle-cursor-lock-icon/);
  assert.match(admin, /toggle-calibration-icon/);
});

test('kiosk endpoint exposes control icon settings from the Admin payment profile', () => {
  assert.match(controller, /control_visibility:\s*readPhotoboothControlVisibility/);
  assert.match(controller, /mergePhotoboothControlVisibility\(paymentData/);
  assert.match(api, /fetchPhotoboothControlVisibility/);
  assert.match(api, /control_visibility/);
});

test('photobooth keeps lock and calibration actions but hides them when Admin disables them', () => {
  assert.match(booth, /showCursorLockIcon && <button id="btn-toggle-cursor-lock-landing"/);
  assert.match(booth, /showCalibrationIcon && <button id="btn-calibrate-landing"/);
  assert.match(booth, /onToggleLock && showLockButton/);
  assert.match(booth, /showCursorLockIcon && <button id="btn-toggle-cursor-lock-capture"/);
  assert.match(booth, /if \(!showCursorLockIcon\) setIsCursorLocked\(false\)/);
});

test('package settings fail closed until server config is loaded', () => {
  assert.match(booth, /packageVisibilityStatus === 'loading'/);
  assert.match(booth, /packageVisibilityStatus === 'error'/);
});
