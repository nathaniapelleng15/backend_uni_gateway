const { PAPER_SIZES, isKnownPaperSize, validateCustomSize, isThermalSize, findLabelPreset } = require('./paperSizes');

/**
 * Adapter yang dikenal.
 *
 * `thermal` ditambahkan untuk printer label termal (mis. NIIMBOT B1 Pro). Di
 * sistem operasi, printer itu tetap terpasang sebagai printer biasa (CUPS di
 * macOS, spooler di Windows), jadi adapter thermal melakukan hal yang sama
 * seperti adapter OS — bedanya ukuran kertas dan orientasinya mengikuti batas
 * printer label, bukan ukuran foto.
 */
const ADAPTERS = ['disabled', 'cups', 'windows', 'mock', 'thermal'];
const ORIENTATIONS = ['portrait', 'landscape'];

/**
 * Penyesuaian tampilan foto hasil cetak + kalibrasi termal.
 *
 * Satu sumber kebenaran untuk batas nilai, dipakai backend DAN dicerminkan di
 * Admin. Sebelumnya nilai-nilai ini hanya hidup di halaman uji localhost
 * (kertas, kepekatan, geser vertikal) atau ter-hardcode di Photobooth
 * (brightness/contrast/saturasi).
 *
 * PENTING — batas berikut adalah pengaman, bukan hiasan:
 *  - brightness/contrast di luar 50-150 akan merusak foto (putih total atau
 *    hitam total), dan pada printer termal 1-bit hasilnya hilang sama sekali.
 *  - saturation 0 memang sah (hitam putih).
 *  - density di luar 1-5 tidak dikenal driver Niimbot.
 *  - offset di luar ±200 px hanya menggeser gambar keluar dari kertas.
 */
const PHOTO_ADJUST_LIMITS = {
  photo_brightness: { min: 50, max: 150, fallback: 100 },
  photo_contrast: { min: 50, max: 150, fallback: 100 },
  photo_saturation: { min: 0, max: 150, fallback: 100 },
  thermal_density: { min: 1, max: 5, fallback: 3 },
  thermal_offset_y_px: { min: -200, max: 200, fallback: 0 },
  // Geser mendatar. Tanpa ini, gambar yang tidak sejajar MENDATAR dengan
  // desain tercetak di kertas label tidak bisa dikalibrasi dari Admin sama
  // sekali — harus menyentuh kode dan deploy ulang.
  thermal_offset_x_px: { min: -200, max: 200, fallback: 0 },
  // Margin kosong dari tepi label. Dipakai saat foto harus MULAI mencetak
  // setelah sekian piksel dari tepi — menggeser gambar tidak bisa membuat
  // ruang kosong, karena gambarnya selalu menutupi seluruh kanvas.
  print_margin_top_px: { min: 0, max: 300, fallback: 0 },
  print_margin_right_px: { min: 0, max: 300, fallback: 0 },
  print_margin_left_px: { min: 0, max: 300, fallback: 0 },
  print_margin_bottom_px: { min: 0, max: 300, fallback: 0 },
  // Penajaman (unsharp mask) 0..100, dikenakan pada abu-abu SEBELUM dither.
  // 0 = perilaku lama (tidak menajamkan), jadi kiosk yang belum diubah tidak
  // berubah hasil cetaknya.
  print_sharpen: { min: 0, max: 100, fallback: 0 },
};
const PHOTO_FIT_MODES = ['fit', 'cover', 'stretch'];

/**
 * Tombol layar akhir yang bisa dinyalakan/dimatikan dari Admin.
 *
 * Nilainya adalah NAMA KOLOM di DB, dan dipakai sebagai daftar tunggal oleh
 * validasi, model, dan controller — supaya menambah tombol baru tidak perlu
 * menyunting tiga tempat yang bisa berbeda.
 *
 * Semuanya BOOLEAN dan bawaannya TRUE (aktif). Bawaan harus aktif, karena itu
 * perilaku yang sudah berjalan: kiosk yang sudah dipakai tidak boleh berubah
 * hanya karena fitur ini ditambahkan.
 *
 * Kodenya TIDAK dihapus saat dimatikan — hanya tidak ditampilkan. Jadi
 * menyalakannya kembali tidak perlu build ulang kode, dan tidak ada fitur yang
 * hilang dari repo.
 */
const TOMBOL_FIELDS = ['show_email_button', 'show_retake_button', 'show_print_button'];

/**
 * Algoritma konversi abu-abu yang dikenal jalur cetak kiosk.
 *
 * Daftarnya HARUS sama dengan GRAYSCALE_OPTIONS di
 * `unismiles-photobooth/services/oneBitImage.ts`. Nilai di sini adalah nama
 * yang dikirim ke kiosk, bukan bobotnya — bobotnya hanya ada di satu tempat,
 * yaitu fungsi grayscaleValue() di kiosk, supaya tidak ada dua daftar bobot
 * yang bisa berbeda.
 */
const GRAYSCALE_ALGORITHMS = [
  'rec601', 'rec709', 'average', 'luma-sqrt',
  'green', 'red', 'blue', 'max', 'min',
];
const DEFAULT_GRAYSCALE_ALGORITHM = 'rec601';

const FORBIDDEN_FIELDS = new Set(['command', 'shell_command', 'executable_path', 'script', 'driver_command']);
const ALLOWED_FIELDS = new Set([
  'printing_enabled', 'adapter', 'printer_name', 'paper_size', 'orientation',
  'copies_limit', 'timeout_ms', 'retry_count', 'allowed_layouts',
  ...Object.keys(PHOTO_ADJUST_LIMITS), 'photo_fit_mode', 'grayscale_algorithm',
  ...TOMBOL_FIELDS,
]);

/**
 * Baca nilai boolean dari bentuk apa pun yang mungkin datang.
 *
 * Kenapa tidak Boolean() saja: Boolean('0') dan Boolean('false') keduanya
 * TRUE. Nilai dari DB (TINYINT) dan dari form Admin (bisa string) keduanya
 * melewati fungsi ini, dan tombol yang dimatikan TIDAK boleh muncul kembali
 * hanya karena nilainya berbentuk string.
 */
function bacaBoolean(nilai, bawaan) {
  if (nilai === undefined || nilai === null || nilai === '') return bawaan;
  if (typeof nilai === 'boolean') return nilai;
  if (typeof nilai === 'number') return nilai !== 0;
  const teks = String(nilai).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'ya'].includes(teks)) return true;
  if (['false', '0', 'no', 'off', 'tidak'].includes(teks)) return false;
  return bawaan;
}

class PrintingConfigValidationError extends Error {
  constructor(message, code = 'INVALID_PRINTING_CONFIG') {
    super(message);
    this.name = 'PrintingConfigValidationError';
    this.statusCode = 400;
    this.code = code;
  }
}

function integerField(value, name, min, max) {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new PrintingConfigValidationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return numeric;
}

function validatePrinterName(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 255 || !/^[\p{L}\p{N} ._()\-/#:+@]+$/u.test(value)) {
    throw new PrintingConfigValidationError('printer_name contains unsupported characters.');
  }
  return value.trim() || null;
}

function validatePrintingConfig(input = {}, existing = {}, reported = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PrintingConfigValidationError('Printing configuration must be an object.');
  }

  for (const key of Object.keys(input)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new PrintingConfigValidationError(`${key} is not accepted.`, 'FORBIDDEN_FIELD');
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw new PrintingConfigValidationError(`Unknown printing configuration field: ${key}.`, 'UNKNOWN_FIELD');
    }
  }

  const merged = {
    printing_enabled: existing.printing_enabled ?? false,
    adapter: existing.adapter || 'disabled',
    printer_name: existing.printer_name ?? null,
    paper_size: existing.paper_size || 'Instax Mini (54 × 86 mm)',
    orientation: existing.orientation || 'portrait',
    copies_limit: Number(existing.copies_limit ?? 1),
    timeout_ms: Number(existing.timeout_ms ?? 60000),
    retry_count: Number(existing.retry_count ?? 2),
    allowed_layouts: existing.allowed_layouts || [],
    // Tambahan kalibrasi + penyesuaian tampilan. Nilai lama dipakai kalau kolom
    // belum ada, supaya konfigurasi yang sudah tersimpan tidak rusak.
    photo_brightness: Number(existing.photo_brightness ?? PHOTO_ADJUST_LIMITS.photo_brightness.fallback),
    photo_contrast: Number(existing.photo_contrast ?? PHOTO_ADJUST_LIMITS.photo_contrast.fallback),
    photo_saturation: Number(existing.photo_saturation ?? PHOTO_ADJUST_LIMITS.photo_saturation.fallback),
    thermal_density: Number(existing.thermal_density ?? PHOTO_ADJUST_LIMITS.thermal_density.fallback),
    thermal_offset_y_px: Number(existing.thermal_offset_y_px ?? PHOTO_ADJUST_LIMITS.thermal_offset_y_px.fallback),
    thermal_offset_x_px: Number(existing.thermal_offset_x_px ?? PHOTO_ADJUST_LIMITS.thermal_offset_x_px.fallback),
    print_margin_top_px: Number(existing.print_margin_top_px ?? PHOTO_ADJUST_LIMITS.print_margin_top_px.fallback),
    print_margin_right_px: Number(existing.print_margin_right_px ?? PHOTO_ADJUST_LIMITS.print_margin_right_px.fallback),
    print_margin_left_px: Number(existing.print_margin_left_px ?? PHOTO_ADJUST_LIMITS.print_margin_left_px.fallback),
    print_margin_bottom_px: Number(existing.print_margin_bottom_px ?? PHOTO_ADJUST_LIMITS.print_margin_bottom_px.fallback),
    print_sharpen: Number(existing.print_sharpen ?? PHOTO_ADJUST_LIMITS.print_sharpen.fallback),
    photo_fit_mode: existing.photo_fit_mode || 'fit',
    // Algoritma abu-abu: nilai lama atau bawaan, supaya konfigurasi yang belum
    // punya kolom ini tetap mencetak dengan bobot Rec.601 seperti sebelumnya.
    grayscale_algorithm: existing.grayscale_algorithm || DEFAULT_GRAYSCALE_ALGORITHM,
    // Tombol layar: bawaannya AKTIF (lihat TOMBOL_FIELDS). Memakai ?? supaya
    // nilai 0/false yang sudah tersimpan tidak tertukar dengan "belum diisi".
    ...Object.fromEntries(TOMBOL_FIELDS.map(f => [f, existing[f] ?? true])),
    ...input,
  };

  const enabled = Boolean(merged.printing_enabled);
  const adapter = typeof merged.adapter === 'string' ? merged.adapter.toLowerCase() : '';
  if (!ADAPTERS.includes(adapter)) {
    throw new PrintingConfigValidationError(`adapter must be one of: ${ADAPTERS.join(', ')}.`);
  }
  // Ukuran kertas: preset foto, preset termal, atau ukuran kustom "CUSTOM LxT MM".
  // Ukuran kustom divalidasi terhadap batas fisik printer termal supaya tidak ada
  // ukuran yang diterima sistem tetapi pasti terpotong di printer.
  if (!isKnownPaperSize(merged.paper_size)) {
    const message = /^CUSTOM\b/i.test(String(merged.paper_size || '').trim())
      ? validateCustomSize(merged.paper_size).message
      : `Ukuran kertas "${merged.paper_size}" tidak dikenali. Pilih preset yang tersedia atau gunakan CUSTOM <lebar>X<tinggi> MM.`;
    throw new PrintingConfigValidationError(message);
  }
  if (!ORIENTATIONS.includes(merged.orientation)) {
    throw new PrintingConfigValidationError('orientation must be portrait or landscape.');
  }

  const normalized = {
    printing_enabled: enabled,
    adapter,
    printer_name: validatePrinterName(merged.printer_name),
    paper_size: merged.paper_size,
    orientation: merged.orientation,
    copies_limit: integerField(merged.copies_limit, 'copies_limit', 1, 10),
    timeout_ms: integerField(merged.timeout_ms, 'timeout_ms', 5000, 300000),
    retry_count: integerField(merged.retry_count, 'retry_count', 0, 3),
    allowed_layouts: Array.isArray(merged.allowed_layouts) ? merged.allowed_layouts.map(String) : [],
  };

  // Penyesuaian tampilan + kalibrasi termal. Divalidasi dengan batas fisiknya
  // sendiri supaya tidak ada nilai yang tersimpan tetapi pasti merusak hasil
  // cetak (mis. brightness 400 membuat foto putih total).
  for (const [field, limit] of Object.entries(PHOTO_ADJUST_LIMITS)) {
    normalized[field] = integerField(merged[field], field, limit.min, limit.max);
  }
  const fitMode = String(merged.photo_fit_mode || 'fit').toLowerCase();
  if (!PHOTO_FIT_MODES.includes(fitMode)) {
    throw new PrintingConfigValidationError(`photo_fit_mode must be one of: ${PHOTO_FIT_MODES.join(', ')}.`);
  }
  normalized.photo_fit_mode = fitMode;

  // Algoritma abu-abu. DITOLAK kalau tidak dikenal, bukan diam-diam diganti:
  // kalau diganti diam-diam, operator memilih satu algoritma di panel dan
  // kertasnya keluar memakai algoritma lain tanpa ada yang memberi tahu.
  const alg = String(merged.grayscale_algorithm || DEFAULT_GRAYSCALE_ALGORITHM).toLowerCase();
  if (!GRAYSCALE_ALGORITHMS.includes(alg)) {
    throw new PrintingConfigValidationError(`grayscale_algorithm must be one of: ${GRAYSCALE_ALGORITHMS.join(', ')}.`);
  }
  normalized.grayscale_algorithm = alg;

  // Tombol layar: dipaksa jadi boolean sejati. Panel mengirim 0/1 atau
  // true/false tergantung bentuk request, dan kalau nilainya string '0' ia akan
  // dianggap AKTIF oleh Boolean() — jadi tombol yang dimatikan tetap muncul.
  for (const field of TOMBOL_FIELDS) {
    normalized[field] = bacaBoolean(merged[field], true);
  }

  // Preset label membawa marginnya sendiri. Kalau nilainya preset, margin
  // DITIMPA dari preset — supaya memilih template di Admin tidak perlu diikuti
  // mengetik empat angka margin secara manual, dan tidak bisa setengah-setengah.
  const labelPreset = findLabelPreset(merged.paper_size);
  if (labelPreset) {
    const px = (mm) => Math.max(0, Math.round((mm / 25.4) * 300));
    normalized.print_margin_top_px = px(labelPreset.marginTopMm);
    normalized.print_margin_right_px = px(labelPreset.marginRightMm);
    normalized.print_margin_left_px = px(labelPreset.marginLeftMm);
    normalized.print_margin_bottom_px = px(labelPreset.marginBottomMm);

    // Kalibrasi: preset hanya sebagai NILAI AWAL. Kalau Admin sudah pernah
    // menyimpan angka, angka itu yang dipakai — kalibrasi operator datang dari
    // hasil cetak nyata dan tidak boleh tertimpa hanya karena preset dipilih.
    const belumPernah = input.thermal_offset_x_px === undefined && existing.thermal_offset_x_px === undefined;
    if (belumPernah && labelPreset.offsetXMm !== undefined) {
      normalized.thermal_offset_x_px = Math.round(labelPreset.offsetXMm * 300 / 25.4);
    }
    const belumY = input.thermal_offset_y_px === undefined && existing.thermal_offset_y_px === undefined;
    if (belumY && labelPreset.offsetYMm !== undefined) {
      normalized.thermal_offset_y_px = Math.round(labelPreset.offsetYMm * 300 / 25.4);
    }
  }

  if (!enabled) {
    normalized.adapter = 'disabled';
    normalized.printer_name = null;
  } else if (normalized.adapter !== 'disabled') {
    // disabled applies only to agent/system printing. Direct Bluetooth is
    // owned by the photobooth and needs no OS printer or agent adapter.
    if (!normalized.printer_name) {
      throw new PrintingConfigValidationError('printer_name is required when printing is enabled.');
    }
    // Daftar kosong berarti agent BELUM melaporkan apa pun, bukan "tidak
    // mendukung apa-apa". Tanpa pembedaan ini, kiosk yang belum pernah
    // terhubung membuat Admin tidak bisa menyimpan adapter apa pun — panel
    // memblokir pengaturan yang sah karena laporan yang memang belum ada.
    //
    // Pemeriksaan printer tepat di bawah sudah memakai pola yang benar
    // (`available.length > 0`); yang ini disamakan.
    const reportedAdapters = Array.isArray(reported?.supported_adapters) ? reported.supported_adapters : [];
    if (reportedAdapters.length > 0 && !reportedAdapters.includes(normalized.adapter)) {
      throw new PrintingConfigValidationError('The selected adapter is not supported by this Kiosk Agent.', 'UNSUPPORTED_ADAPTER');
    }
    const available = Array.isArray(reported?.available_printers) ? reported.available_printers : null;
    if (available && available.length > 0 && !available.some(printer => printer && printer.name === normalized.printer_name)) {
      throw new PrintingConfigValidationError('The selected printer was not reported by this Kiosk Agent.', 'PRINTER_NOT_AVAILABLE');
    }
  }

  return normalized;
}

function toSocketPrintingConfig(row) {
  return {
    enabled: Boolean(row.printing_enabled),
    adapter: row.adapter,
    printer_name: row.printer_name || null,
    paper_size: row.paper_size,
    orientation: row.orientation,
    copies_limit: Number(row.copies_limit),
    timeout_ms: Number(row.timeout_ms),
    retry_count: Number(row.retry_count),
    config_version: Number(row.config_version),
    allowed_layouts: (() => {
      try {
        return typeof row.allowed_layouts === 'string' ? JSON.parse(row.allowed_layouts) : (row.allowed_layouts || []);
      } catch (e) {
        return [];
      }
    })(),
    // Penyesuaian tampilan + kalibrasi ikut dikirim ke kiosk-agent, yang
    // meneruskannya ke photobooth lewat local bridge. Tanpa ini, nilai yang
    // disimpan Admin tidak akan pernah sampai ke tempat yang mencetak.
    photo_brightness: Number(row.photo_brightness ?? PHOTO_ADJUST_LIMITS.photo_brightness.fallback),
    photo_contrast: Number(row.photo_contrast ?? PHOTO_ADJUST_LIMITS.photo_contrast.fallback),
    photo_saturation: Number(row.photo_saturation ?? PHOTO_ADJUST_LIMITS.photo_saturation.fallback),
    thermal_density: Number(row.thermal_density ?? PHOTO_ADJUST_LIMITS.thermal_density.fallback),
    thermal_offset_y_px: Number(row.thermal_offset_y_px ?? PHOTO_ADJUST_LIMITS.thermal_offset_y_px.fallback),
    thermal_offset_x_px: Number(row.thermal_offset_x_px ?? PHOTO_ADJUST_LIMITS.thermal_offset_x_px.fallback),
    print_margin_top_px: Number(row.print_margin_top_px ?? PHOTO_ADJUST_LIMITS.print_margin_top_px.fallback),
    print_margin_right_px: Number(row.print_margin_right_px ?? PHOTO_ADJUST_LIMITS.print_margin_right_px.fallback),
    print_margin_left_px: Number(row.print_margin_left_px ?? PHOTO_ADJUST_LIMITS.print_margin_left_px.fallback),
    print_margin_bottom_px: Number(row.print_margin_bottom_px ?? PHOTO_ADJUST_LIMITS.print_margin_bottom_px.fallback),
    print_sharpen: Number(row.print_sharpen ?? PHOTO_ADJUST_LIMITS.print_sharpen.fallback),
    photo_fit_mode: row.photo_fit_mode || 'fit',
    grayscale_algorithm: row.grayscale_algorithm || DEFAULT_GRAYSCALE_ALGORITHM,
    // Tombol layar. TINYINT dari DB datang sebagai 0/1, jadi dibaca sebagai
    // boolean lewat helper yang sama — supaya '0' tidak dianggap aktif.
    ...Object.fromEntries(TOMBOL_FIELDS.map(f => [f, bacaBoolean(row[f], true)])),
  };
}

module.exports = {
  TOMBOL_FIELDS,
  bacaBoolean,
  ADAPTERS,
  PAPER_SIZES,
  ORIENTATIONS,
  ALLOWED_FIELDS,
  FORBIDDEN_FIELDS,
  PHOTO_ADJUST_LIMITS,
  PHOTO_FIT_MODES,
  PrintingConfigValidationError,
  validatePrintingConfig,
  toSocketPrintingConfig,
};
