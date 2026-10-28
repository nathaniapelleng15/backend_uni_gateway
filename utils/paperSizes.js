/**
 * Ukuran kertas cetak — SATU SUMBER KEBENARAN.
 *
 * Sebelumnya daftar ini disalin di tiga tempat: validasi backend, dan dua tempat
 * di kiosk-agent (saat menerima job dan saat menerapkan konfigurasi). Tiga salinan
 * yang harus sama selalu berakhir berbeda — pola bug yang sudah terbukti berulang
 * di proyek ini. Sekarang backend memakai modul ini, dan agent memakai pola yang
 * sama untuk ukuran kustom.
 *
 * Dua keluarga kertas:
 *   foto    — printer foto tinta (Instax, 4R, 2R, strip). Lebar 54-152 mm.
 *   termal  — printer label termal (mis. NIIMBOT B1 Pro). Lebar kertas maks 50 mm,
 *             lebar cetak efektif 48 mm, tinggi 8-350 mm.
 */

/**
 * Batas fisik printer label termal yang dipakai (NIIMBOT B1 Pro).
 *
 * DUA ANGKA YANG BERBEDA — jangan disamakan:
 *
 *   maxPrintWidthMm = 48,77 mm  -> LEBAR KEPALA CETAK. Ini yang menentukan
 *       berapa banyak yang benar-benar tercetak. Diukur di perangkat nyata:
 *       kepala B1 Pro melaporkan 576 px @300 dpi, dan pengujian di kertas
 *       menunjukkan kolom 0-575 keluar sedangkan kolom 576 dst tidak keluar
 *       (tanpa pesan error apa pun). Jadi gambar WAJIB dikunci ke angka ini.
 *
 *   maxPaperWidthMm = 60 mm  -> LEBAR KERTAS yang masih wajar. Kertas boleh
 *       LEBIH LEBAR dari kepala cetak; bagian yang berlebih memang tidak
 *       tercetak. Label 54 mm yang dipakai UniSmiles justru begini: 5,25 mm
 *       sisi kanannya tidak tercetak. Menolak 54 mm akan salah — kertasnya
 *       nyata dan bisa dipakai.
 *
 * Angka 60 mm semata-mata penjaga salah ketik (mis. 540 mm), bukan batas
 * kemampuan printer.
 */
const THERMAL_LIMITS = {
  /** Lebar kertas label maksimum yang masih wajar (mm). */
  maxPaperWidthMm: 60,
  /** Lebar area cetak efektif = lebar kepala cetak (mm). Ini yang mengunci gambar. */
  maxPrintWidthMm: 48.77,
  /** Tinggi cetak minimum (mm). */
  minHeightMm: 8,
  /** Tinggi cetak maksimum (mm). */
  maxHeightMm: 350,
  /** Resolusi cetak (titik per inci). */
  dpi: 300,
};

/** Ukuran foto lama, dipertahankan supaya konfigurasi yang ada tidak rusak. */
const PHOTO_PRESETS = [
  'Instax Mini (54 × 86 mm)',
  'Polaroid 6 × 9 cm (2R)',
  '2 Strip 5 × 15 cm',
  '3 Strip 5 × 15 cm',
  '4 Strip 5 × 15 cm',
  '2×2 Grid 10 × 10 cm',
  '2×3 Grid 10 × 15 cm',
];

/**
 * Preset termal. Semua lebarnya <= 48 mm (lebar cetak efektif), jadi tidak ada
 * yang akan terpotong oleh printer label.
 */
const THERMAL_PRESETS = [
  'Termal 40 × 60 mm (2 foto)',
  'Termal 40 × 90 mm (3 foto)',
  'Termal 40 × 120 mm (4 foto)',
  'Termal 48 × 150 mm (strip panjang)',
  'Termal 30 × 40 mm (label kecil)',
];

/**
 * Preset label dengan AREA CETAK yang sudah ditentukan pabrik.
 *
 * Label Polaroid NIIMBOT 54 x 67 mm bukan kertas kosong: ia sudah punya bingkai
 * tercetak, dan hanya kotak putih di tengahnya yang boleh diisi. Karena itu
 * ukuran kertas saja tidak cukup — margin empat sisinya ikut disimpan, kalau
 * tidak fotonya akan melimpah ke bingkai yang sudah tercetak.
 *
 * Angka-angka ini datang dari pengukuran label yang dipakai UniSmiles:
 *   atas 5,93 mm, kiri 0 mm, kanan 7,03 mm, bawah 13,04 mm  ->  46,99 x 48,01 mm
 *   5,93 + 48,04 + 13,04 = 67 mm, dan 0 + 46,97 + 7,03 = 54 mm. Keduanya pas,
 *   jadi tidak ada sisi yang perlu menyerap selisih.
 */
const LABEL_PRESETS = [
  {
    name: 'nimbotpaper-polaroid',
    paperWidthMm: 54,
    paperHeightMm: 67,
    /**
     * Target 555 x 567 px di x=0 y=59 pada 300 dpi.
     * Turun 24 px (0,2 cm dibulatkan) dari acuan y=35, tanpa resize.
     * 0+555+83=638; 59+567+165=791. Perlu verifikasi cetak fisik.
     */
    marginTopMm: 59 / (300 / 25.4),
    marginLeftMm: 0 / (300 / 25.4),
    marginRightMm: 83 / (300 / 25.4),
    marginBottomMm: 165 / (300 / 25.4),
    /**
     * Kalibrasi posisi fisik, dalam PERSEN MILIMETER (10 = 0,1 mm).
     *
     * Dipakai karena kertas label tidak selalu duduk persis di posisi yang sama
     * di dalam printer. Perhitungan piksel tidak bisa mengetahuinya — hanya
     * hasil cetak nyata yang bisa. Nilai di sini hanya NILAI AWAL; angka yang
     * disimpan dari Admin selalu menang, supaya kalibrasi operator tidak
     * tertimpa saat preset dipilih ulang.
     */
    offsetXMm: 0,
    offsetYMm: 0,
  },
];

const LABEL_PRESET_NAMES = LABEL_PRESETS.map(p => p.name);

/** Legacy identifiers emitted by getOrCreate/defaults and already accepted by kiosk-agent. */
const LEGACY_VALUES = [
  '2R', '3R', '4R', 'STRIP', '6R',
  'POLAROID', 'STRIP 2', 'STRIP 3', 'STRIP 4',
  'GRID', 'GRID 2X2', 'GRID 2X3', 'GRID 3X3',
];

const PAPER_SIZES = [...PHOTO_PRESETS, ...THERMAL_PRESETS, ...LABEL_PRESET_NAMES, ...LEGACY_VALUES];

/**
 * Pola ukuran kustom: "CUSTOM 48X150 MM" atau "CUSTOM 40x60mm".
 * Dipakai supaya ukuran bisa dinamis tanpa mengunci daftar.
 */
const CUSTOM_PATTERN = /^CUSTOM\s+(\d{1,3})\s*[X×]\s*(\d{1,3})\s*MM$/i;

/** Apakah nilai ini ukuran kustom yang sah? */
function parseCustomSize(value) {
  const match = String(value || '').trim().match(CUSTOM_PATTERN);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { widthMm: width, heightMm: height };
}

/**
 * Validasi ukuran kustom terhadap batas printer termal.
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function validateCustomSize(value, limits = THERMAL_LIMITS) {
  const parsed = parseCustomSize(value);
  if (!parsed) {
    return { ok: false, message: `Ukuran kustom harus berformat "CUSTOM <lebar>X<tinggi> MM", contoh CUSTOM 48X150 MM.` };
  }
  const { widthMm, heightMm } = parsed;
  // Lebar kertas boleh melebihi kepala cetak — bagian berlebih tidak tercetak,
  // dan itu keadaan normal untuk label 54 mm. Yang ditolak hanya ukuran yang
  // jelas salah ketik.
  if (widthMm > limits.maxPaperWidthMm) {
    return {
      ok: false,
      message: `Lebar ${widthMm} mm melebihi lebar kertas maksimum (${limits.maxPaperWidthMm} mm).`,
    };
  }
  if (heightMm < limits.minHeightMm || heightMm > limits.maxHeightMm) {
    return {
      ok: false,
      message: `Tinggi ${heightMm} mm di luar rentang printer termal (${limits.minHeightMm}-${limits.maxHeightMm} mm).`,
    };
  }
  return { ok: true };
}

/** Ukuran ini termasuk keluarga termal? (preset termal atau kustom) */
function isThermalSize(value) {
  const text = String(value || '').trim();
  return THERMAL_PRESETS.includes(text) || Boolean(parseCustomSize(text));
}

/** Preset label berdasarkan namanya (mis. 'nimbotpaper-polaroid'). */
function findLabelPreset(value) {
  const text = String(value || '').trim().toLowerCase();
  return LABEL_PRESETS.find(p => p.name.toLowerCase() === text) || null;
}

/** Apakah nilai ini ukuran kertas yang diterima? */
function isKnownPaperSize(value) {
  const text = String(value || '').trim();
  if (PAPER_SIZES.includes(text) || LEGACY_VALUES.includes(text.toUpperCase())) return true;
  if (findLabelPreset(text)) return true;
  const custom = parseCustomSize(text);
  if (!custom) return false;
  return validateCustomSize(text).ok;
}

/**
 * Ukuran gambar dalam piksel untuk 300 dpi.
 *
 * Dipakai supaya gambar yang dikirim ke printer tidak buram (kurang piksel) dan
 * tidak boros (jauh lebih besar dari kemampuan printer).
 */
/** Ukuran area cetak (px) untuk sebuah preset label, pada 300 dpi. */
function labelPresetPixels(preset) {
  if (!preset) return null;
  const dpi = THERMAL_LIMITS.dpi;
  const px = (mm) => Math.max(1, Math.round((mm / 25.4) * dpi));
  return {
    widthPx: px(preset.paperWidthMm - preset.marginLeftMm - preset.marginRightMm),
    heightPx: px(preset.paperHeightMm - preset.marginTopMm - preset.marginBottomMm),
    dpi,
  };
}

function pixelSize(value) {
  const dpi = THERMAL_LIMITS.dpi;
  const px = (mm) => Math.max(1, Math.round((mm / 25.4) * dpi));

  const preset = THERMAL_PRESETS.find(p => p === String(value || '').trim());
  if (preset) {
    const [, w, h] = preset.match(/(\d+)\s*[×x]\s*(\d+)/i) || [];
    if (w && h) return { widthPx: px(Number(w)), heightPx: px(Number(h)), dpi };
  }
  const custom = parseCustomSize(value);
  if (custom) return { widthPx: px(custom.widthMm), heightPx: px(custom.heightMm), dpi };
  return null;
}

module.exports = {
  THERMAL_LIMITS,
  PHOTO_PRESETS,
  THERMAL_PRESETS,
  LABEL_PRESETS,
  LABEL_PRESET_NAMES,
  LEGACY_VALUES,
  findLabelPreset,
  PAPER_SIZES,
  parseCustomSize,
  validateCustomSize,
  isThermalSize,
  isKnownPaperSize,
  pixelSize,
};
