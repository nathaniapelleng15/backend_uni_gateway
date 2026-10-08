'use strict';

const FIELDS = ['show_digital_package', 'show_print_package'];
const CONTROL_FIELDS = ['show_cursor_lock_icon', 'show_calibration_icon'];

const parsePaymentData = value => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
};

const readPackageVisibility = paymentData => {
  const data = parsePaymentData(paymentData);
  return {
    // Backward-compatible default: older profiles keep both options visible.
    show_digital_package: data.show_digital_package !== false,
    show_print_package: data.show_print_package !== false,
  };
};

const mergePackageVisibility = (existingPaymentData, updates) => {
  const previous = readPackageVisibility(existingPaymentData);
  const next = { ...previous };

  for (const field of FIELDS) {
    if (updates[field] === undefined) continue;
    if (typeof updates[field] !== 'boolean') {
      throw new TypeError(`${field} harus berupa boolean.`);
    }
    next[field] = updates[field];
  }

  if (!next.show_digital_package && !next.show_print_package) {
    const error = new Error('Minimal satu paket (Digital atau Print) harus aktif.');
    error.statusCode = 400;
    throw error;
  }

  return next;
};

const readPhotoboothControlVisibility = paymentData => {
  const data = parsePaymentData(paymentData);
  return {
    // Old profiles keep the icons visible, preserving the current kiosk behavior.
    show_cursor_lock_icon: data.show_cursor_lock_icon !== false,
    show_calibration_icon: data.show_calibration_icon !== false,
  };
};

const mergePhotoboothControlVisibility = (existingPaymentData, updates) => {
  const previous = readPhotoboothControlVisibility(existingPaymentData);
  const next = { ...previous };

  for (const field of CONTROL_FIELDS) {
    if (updates[field] === undefined) continue;
    if (typeof updates[field] !== 'boolean') {
      throw new TypeError(`${field} harus berupa boolean.`);
    }
    next[field] = updates[field];
  }

  return next;
};

module.exports = {
  parsePaymentData,
  readPackageVisibility,
  mergePackageVisibility,
  readPhotoboothControlVisibility,
  mergePhotoboothControlVisibility,
};
