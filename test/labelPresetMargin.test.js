const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePrintingConfig } = require('../utils/printingConfigValidation');
const { findLabelPreset, LABEL_PRESETS } = require('../utils/paperSizes');

/**
 * Margin cetak label Polaroid 54 x 67 mm DIKUNCI di preset, bukan di form Admin.
 *
 * Alasan: kotak putih labelnya sesuai target kertas (555 x 567 px di x=0 y=59)
 * sesuai ukuran yang diminta; hasil fisik perlu diverifikasi. Kalau angka ini bisa diubah dari panel — atau
 * hilang karena form mengirim 0 — foto keluar dari bingkai lagi. Test ini
 * menahan angka itu supaya perubahan apa pun harus disengaja.
 */
const PRESET = 'nimbotpaper-polaroid';
const KOTAK = { top: 59, right: 83, left: 0, bottom: 165 };

// Lebar kanvas = 54 mm, tinggi = 67 mm pada 300 dpi.
const KANVAS = { W: 638, H: 791 };
const KEPALA_CETAK = 576;

function margin(row) {
  const r = validatePrintingConfig({ paper_size: PRESET }, row);
  return {
    top: r.print_margin_top_px,
    right: r.print_margin_right_px,
    left: r.print_margin_left_px,
    bottom: r.print_margin_bottom_px,
  };
}

const BARIS = {
  printing_enabled: 1, adapter: 'windows', printer_name: 'B1 Pro',
  orientation: 'portrait', copies_limit: 1, timeout_ms: 60000, retry_count: 2,
  allowed_layouts: [], photo_brightness: 120, photo_contrast: 100, photo_saturation: 100,
  thermal_density: 2, thermal_offset_y_px: 0, thermal_offset_x_px: 0,
  photo_fit_mode: 'cover',
  ...{ print_margin_top_px: 59, print_margin_right_px: 83, print_margin_left_px: 0, print_margin_bottom_px: 165 },
};

test('preset label membawa kotak cetak yang sesuai target kertas', () => {
  const preset = findLabelPreset(PRESET);
  assert.ok(preset, 'preset harus ada');
  const px = (mm) => Math.round((mm / 25.4) * 300);
  assert.strictEqual(px(preset.marginTopMm), KOTAK.top, 'atas 59 px');
  assert.strictEqual(px(preset.marginRightMm), KOTAK.right, 'kanan 83 px');
  assert.strictEqual(px(preset.marginLeftMm), KOTAK.left, 'kiri 0 px');
  assert.strictEqual(px(preset.marginBottomMm), KOTAK.bottom, 'bawah 165 px');
});

test('kotak selalu pas di kertas dan di kepala cetak', () => {
  const w = KANVAS.W - KOTAK.left - KOTAK.right;
  const h = KANVAS.H - KOTAK.top - KOTAK.bottom;
  assert.strictEqual(w, 555, 'lebar kotak 46,99 mm');
  assert.strictEqual(h, 567, 'tinggi kotak 48,01 mm');
  // Keempat sisi harus menghabiskan kertas tepat: tidak ada piksel yang hilang
  // diam-diam di luar kanvas.
  assert.strictEqual(KOTAK.left + w + KOTAK.right, KANVAS.W, 'mendatar: 0 + 555 + 83 = 638');
  assert.strictEqual(KOTAK.top + h + KOTAK.bottom, KANVAS.H, 'tegak: 59 + 567 + 165 = 791');
  // Tepi kanan kotak masih di bawah jangkauan kepala cetak.
  assert.ok(KOTAK.left + w <= KEPALA_CETAK,
    `tepi kanan kotak ${KOTAK.left + w} harus <= kepala cetak ${KEPALA_CETAK}`);
});

// Ini yang diminta: menyimpan dari Admin TIDAK BOLEH menggeser ukuran.
test('simpan dari Admin tidak bisa mengubah margin preset', () => {
  const kasus = [
    ['tanpa margin sama sekali', { photo_brightness: 120 }],
    ['form mengirim semua nol', { print_margin_top_px: 0, print_margin_right_px: 0, print_margin_left_px: 0, print_margin_bottom_px: 0 }],
    ['angka ngawur dari form', { print_margin_top_px: 300, print_margin_bottom_px: 300 }],
    ['angka lain yang kelihatan masuk akal', { print_margin_top_px: 59, print_margin_bottom_px: 189 }],
  ];
  for (const [nama, input] of kasus) {
    assert.deepEqual(margin({ ...BARIS, ...input }), KOTAK, `${nama}: margin harus tetap 59/83/0/165`);
  }
});

test('baris DB yang masih nol pun tidak mengosongkan kotak', () => {
  // Kiosk baru atau baris lama: kolom margin 0. Preset harus mengisinya, bukan
  // meneruskan 0 — margin 0 berarti "pakai seluruh area cetak" dan foto akan
  // menimpa bingkai yang sudah tercetak.
  assert.deepEqual(margin({ ...BARIS, print_margin_top_px: 0, print_margin_right_px: 0, print_margin_left_px: 0, print_margin_bottom_px: 0 }), KOTAK);
});

test('preset hanya berlaku untuk kertasnya sendiri', () => {
  // Kertas kosong tidak punya bingkai: margin tidak boleh dipaksakan.
  assert.strictEqual(findLabelPreset('CUSTOM 48X61 MM'), null, 'kertas generik bukan preset label');
  // Baris DB kertas generik: margin memang 0 (tidak ada bingkai tercetak).
  const barisGenerik = {
    ...BARIS, paper_size: 'CUSTOM 48X61 MM',
    print_margin_top_px: 0, print_margin_right_px: 0, print_margin_left_px: 0, print_margin_bottom_px: 0,
  };
  const generik = validatePrintingConfig({ paper_size: 'CUSTOM 48X61 MM' }, barisGenerik);
  assert.strictEqual(generik.print_margin_top_px, 0, 'kertas generik tidak dipaksa punya margin');
  assert.ok(LABEL_PRESETS.length >= 1, 'preset label harus terdaftar');
});

test('mode cover ikut terkunci pada preset label', () => {
  const preset = findLabelPreset(PRESET);
  assert.strictEqual(preset.offsetXMm, 0, 'offset X awal 0');
  assert.strictEqual(preset.offsetYMm, 0, 'offset Y awal 0');
  const r = validatePrintingConfig({ paper_size: PRESET, photo_fit_mode: 'cover' }, BARIS);
  assert.strictEqual(r.photo_fit_mode, 'cover', 'cover harus tersimpan apa adanya');
});
