const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePrintingConfig } = require('../utils/printingConfigValidation');
const agentPaper = require('../../kiosk-agent/src/paperSizes');
const backendPaper = require('../utils/paperSizes');

test('legacy 4R config from getOrCreate can be saved unchanged without custom-size errors', () => {
  const existing = { printing_enabled: 0, adapter: 'disabled', paper_size: '4R',
    print_margin_top_px: 0, print_margin_right_px: 0, print_margin_left_px: 0, print_margin_bottom_px: 0 };
  const normalized = validatePrintingConfig({ paper_size: '4R' }, existing);
  assert.equal(normalized.paper_size, '4R');
  for (const field of ['print_margin_top_px','print_margin_right_px','print_margin_left_px','print_margin_bottom_px']) {
    assert.equal(normalized[field], existing[field], 'legacy acceptance must not replace geometry');
  }
});

test('backend accepts the same legacy paper identifiers already supported by the kiosk agent', () => {
  for (const value of agentPaper.LEGACY_VALUES) {
    assert.equal(backendPaper.isKnownPaperSize(value), true, value);
    assert.equal(validatePrintingConfig({ paper_size: value }).paper_size, value);
  }
});

test('unknown preset errors do not misleadingly claim a custom-size format problem', () => {
  assert.throws(() => validatePrintingConfig({paper_size:'NOT-A-PAPER'}), /Ukuran kertas.*tidak dikenali/);
});

test('custom format and physical limits remain enforced independently of legacy compatibility', () => {
  assert.equal(validatePrintingConfig({paper_size:'CUSTOM 48X150 MM'}).paper_size, 'CUSTOM 48X150 MM');
  assert.throws(() => validatePrintingConfig({paper_size:'CUSTOM 48X150'}), /Ukuran kustom harus berformat/);
  assert.throws(() => validatePrintingConfig({paper_size:'CUSTOM 540X150 MM'}), /lebar kertas maksimum/i);
});

test('Admin renders legacy sizes as real options so existing 4R does not display a different preset', () => {
  const form = fs.readFileSync(path.join(__dirname, '../../unismiles-admin/src/components/PrinterConfiguration.tsx'), 'utf8');
  const declaration = form.match(/const LEGACY_PAPER_SIZES = \[([\s\S]*?)\]/);
  assert.ok(declaration, 'Admin needs an explicit legacy paper option list');
  const options = Array.from(declaration[1].matchAll(/'([^']+)'/g), m => m[1]);
  assert.deepEqual(options, agentPaper.LEGACY_VALUES);
  assert.match(form, /LEGACY_PAPER_SIZES\.map\(size => <option key=\{size\} value=\{size\}>/);
});
