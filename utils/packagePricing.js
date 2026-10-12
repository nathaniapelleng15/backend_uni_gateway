const { resolvePrice } = require('./price');

const PACKAGE_TYPES = ['digital', 'digital_print'];
const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });

function parsePackageType(value) {
  // Older clients bought the combined package before this field existed.
  if (value === undefined) return 'digital_print';
  if (!PACKAGE_TYPES.includes(value)) throw badRequest('package_type harus digital atau digital_print.');
  return value;
}

function validatePackagePrices(body, requireBoth = false) {
  const prices = {};
  for (const field of ['digital_price', 'digital_print_price']) {
    if (body[field] === undefined && !requireBoth) continue;
    const value = body[field];
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
      throw badRequest(`${field} wajib berupa nominal Rupiah bulat positif.`);
    }
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9999999999) {
      throw badRequest(`${field} wajib berupa nominal Rupiah bulat positif, maksimal Rp9.999.999.999.`);
    }
    prices[field] = amount;
  }
  return prices;
}

function resolvePackagePrices(template, kioskBasePrice) {
  const legacy = resolvePrice({ templatePrice: template.price, layoutConfig: template.layout_config, kioskBasePrice });
  const read = field => {
    if (template[field] === null || template[field] === undefined) return legacy;
    const amount = Number(template[field]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9999999999) {
      throw Object.assign(new Error('Harga paket pada template tidak valid. Periksa konfigurasi Admin.'), { statusCode: 503 });
    }
    return amount;
  };
  return { digital_price: read('digital_price'), digital_print_price: read('digital_print_price') };
}

module.exports = { parsePackageType, validatePackagePrices, resolvePackagePrices };
