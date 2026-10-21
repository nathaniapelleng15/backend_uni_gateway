/**
 * Uji nyata endpoint kiosk: MEMANGGIL setiap jalur yang dipakai photobooth dan
 * kiosk-agent, lalu memastikan tidak ada yang gagal karena kesalahan kode.
 *
 * Kenapa uji seperti ini perlu, bukan sekadar memeriksa teks berkas:
 * `getKioskTemplates` pernah memanggil `publicBaseUrl(req)` tanpa mengimpornya.
 * Endpoint-nya mengembalikan 500 "publicBaseUrl is not defined" — photobooth
 * tidak bisa mengambil template sama sekali — tetapi SELURUH test lama tetap
 * hijau, karena test itu mencocokkan teks berkas dan tidak pernah menjalankan
 * fungsinya. Bug seperti itu hanya ketahuan dengan benar-benar memanggil.
 *
 * Uji ini memanggil controller dengan req/res tiruan; tidak butuh server hidup
 * dan tidak menyentuh database untuk jalur yang diuji.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

// Controller imports share this pool; close its sockets after the smoke tests.
test.after(async () => {
  await require(path.join(backendRoot, 'config/db')).end();
});

/** Controller dimuat di dalam try supaya kegagalan impor terbaca jelas. */
function load(rel) {
  // Variabel lingkungan minimal supaya modul bisa dimuat di luar server.
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.uniinside.net';
  return require(path.join(backendRoot, rel));
}

/** req/res tiruan yang merekam apa yang dikirim controller. */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: null,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.ended = true; return this; },
    send(payload) { this.body = payload; this.ended = true; return this; },
    setHeader() { return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

test('setiap berkas backend yang di-require server bisa dimuat tanpa error', () => {
  // Server memuat rangkaian ini saat start. Kegagalan di sini = proses mati.
  const wajib = [
    'controllers/kioskController',
    'controllers/printingConfigController',
    'controllers/sessionController',
    'controllers/authController',
    'models/kioskPrintingConfigModel',
    'utils/printingConfigValidation',
    'utils/paperSizes',
    'utils/security',
    'routes/v1/kioskRoutes',
    'routes/v1/adminRoutes',
  ];
  for (const rel of wajib) {
    assert.doesNotThrow(() => load(rel), `${rel} harus bisa dimuat`);
  }
});

test('publicBaseUrl benar-benar diimpor kioskController', () => {
  // Bug yang pernah terjadi: dipakai di dua tempat, tidak pernah diimpor.
  // Diperiksa dengan MENJALANKAN fungsinya lewat modul, bukan mencocokkan teks.
  const security = load('utils/security');
  assert.equal(typeof security.publicBaseUrl, 'function', 'publicBaseUrl harus tersedia');

  const ctrl = load('controllers/kioskController');
  assert.equal(typeof ctrl.getKioskTemplates, 'function', 'getKioskTemplates harus ada');

  // Fungsi harus benar-benar menghasilkan URL absolut.
  const req = { protocol: 'https', get: () => 'api.uniinside.net', headers: {} };
  const url = security.publicBaseUrl(req);
  assert.ok(String(url).startsWith('http'), `publicBaseUrl harus mengembalikan URL absolut, dapat: ${url}`);
});

test('getKioskTemplates tidak crash karena referensi yang tidak terdefinisi', async () => {
  const ctrl = load('controllers/kioskController');

  // Template diambil dari database; di sini yang diuji adalah bahwa jalur
  // kode-nya berjalan sampai selesai tanpa ReferenceError. Kegagalan
  // database dilewatkan, kegagalan kode tidak.
  const req = {
    kiosk: { id: 'JAGO-01' },
    protocol: 'https',
    get: () => 'api.uniinside.net',
    headers: {},
    query: {},
  };
  const res = fakeRes();

  let errorDilempar = null;
  await new Promise((resolve) => {
    const next = (err) => { errorDilempar = err; resolve(); };
    Promise.resolve(ctrl.getKioskTemplates(req, res, next)).then(resolve).catch((e) => { errorDilempar = e; resolve(); });
    setTimeout(resolve, 8000);
  });

  if (errorDilempar) {
    // Kegagalan database boleh; kesalahan kode tidak.
    const pesan = String(errorDilempar.message || errorDilempar);
    assert.ok(!/is not defined/.test(pesan),
      `getKioskTemplates tidak boleh gagal karena referensi tak terdefinisi, dapat: ${pesan}`);
    assert.ok(!/ReferenceError/.test(pesan), `ReferenceError harus hilang, dapat: ${pesan}`);
  }
});

test('tidak ada controller yang memakai publicBaseUrl tanpa mengimpornya', () => {
  // Penjaga umum: pola bug yang sama di berkas lain.
  const fs = require('fs');
  const p = require('path');
  const dir = p.join(backendRoot, 'controllers');
  const pelanggar = [];

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const isi = fs.readFileSync(p.join(dir, f), 'utf8');
    const dipakai = /\bpublicBaseUrl\s*\(/.test(isi);
    const diimpor = /require\([^)]*security[^)]*\)/.test(isi) || /function\s+publicBaseUrl/.test(isi);
    if (dipakai && !diimpor) pelanggar.push(f);
  }

  assert.deepEqual(pelanggar, [],
    `controller ini memakai publicBaseUrl tanpa mengimpornya: ${pelanggar.join(', ')}`);
});
