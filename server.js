const path = require('path');
const dotenv = require('dotenv');
// KroomBox runs this app from the monorepo root while server.js lives in
// unismiles-backend/. Load the site-level .env explicitly before importing
// clients that read PAYMENT_VISION_SERVICE_URL at module initialization.
const siteEnv = dotenv.config({ path: path.resolve(__dirname, '../.env') });
const appEnv = dotenv.config({ path: path.resolve(__dirname, '.env'), override: false });

// Some hosting panels export known variables as empty strings. dotenv treats
// those as already defined, so the local .env never fills them and mysql2
// connects without a default database. Keep real panel values authoritative,
// but fall back to the parsed files for empty DB settings.
const dbEnvKeys = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'DB_DATABASE', 'DB_USERNAME', 'DB_PASS',
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD',
];
for (const key of dbEnvKeys) {
  if (process.env[key]?.trim()) continue;
  const fileValue = [siteEnv.parsed?.[key], appEnv.parsed?.[key]]
    .find((value) => value?.trim());
  if (fileValue) process.env[key] = fileValue;
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }
  if (!process.env.PUBLIC_BASE_URL || !/^https:\/\//i.test(process.env.PUBLIC_BASE_URL)) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS URL in production.');
  }
  if (!process.env.CORS_ORIGINS || process.env.CORS_ORIGINS.includes('*')) {
    throw new Error('CORS_ORIGINS must explicitly list trusted HTTPS origins in production.');
  }
}

const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const express = require('express');
const http = require('http');
const cors = require('cors');
const { initSocketServer } = require('./utils/socketServer');
const { corsOrigin, requestId, createRateLimiter } = require('./utils/security');
const cleanupService = require('./services/cleanupService');
const gopayMerchantPoller = require('./services/gopayMerchantPoller');

// Start background cron jobs
cleanupService.start();
gopayMerchantPoller.start();

const publicRoutes = require('./routes/v1/publicRoutes');
const kioskRoutes = require('./routes/v1/kioskRoutes');
const adminRoutes = require('./routes/v1/adminRoutes');
const assetRoutes = require('./routes/v1/assetRoutes');
const authRoutes = require('./routes/v1/authRoutes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with namespaces (/kiosk & /admin)
initSocketServer(server);

app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
// WAJIB sebelum limiter: aplikasi berjalan di belakang proxy web server.
// Tanpa ini, req.ip berisi alamat proxy untuk SEMUA pengunjung, sehingga satu
// bucket rate limit dipakai bersama. Akibatnya 20 kali salah password dari satu
// orang mengunci halaman login untuk semua orang selama 15 menit, dan aplikasi
// melaporkannya sebagai "Network Error" karena 429 yang terpotong.
app.set('trust proxy', 1);
app.use(requestId);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
// Berkas statis disajikan dengan path ABSOLUT, bukan relatif.
//
// Kenapa: proses backend dijalankan dari root monorepo, sehingga `express.static('uploads')`
// menunjuk ke <root>/uploads — folder yang tidak ada. Padahal multer menulis ke
// <root>/unismiles-backend/uploads. Akibatnya semua URL gambar mengembalikan 404:
// gambar frame yang di-upload tersimpan di disk dan tercatat di database, tetapi
// tidak bisa ditampilkan di Admin maupun diambil kiosk.
const uploadsDir = path.join(__dirname, 'uploads');

app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));
app.use('/assets', express.static(path.join(uploadsDir, 'assets'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Aset lama disimpan langsung di /uploads (bukan /uploads/assets) sebelum folder
// aset dibuat. URL-nya masih tersimpan di database, jadi tanpa cadangan ini
// gambar lama tampil rusak (404) walau berkasnya masih ada di disk.
app.use('/uploads/assets', express.static(path.join(uploadsDir, 'assets'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

const downloadController = require('./controllers/downloadController');
app.get('/download/:session_code', createRateLimiter({ windowMs: 60_000, max: 20, keyGenerator: req => `download:${req.ip}` }), downloadController.serveDownloadPage);

app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'Uni-Smiles API & WebSocket Server is running' });
});

const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });
app.use('/api/', apiLimiter);

// Penanda versi: dipakai untuk MEMBUKTIKAN proses mana yang sedang melayani API.
//
// Sempat terjadi: perbaikan kode tidak berpengaruh sama sekali karena proses lama
// (diluncurkan manual dari root monorepo, dengan .env yang salah) masih menahan
// port 5017, sementara proses baru crash-loop dengan EADDRINUSE. Tanpa penanda
// ini, mustahil membedakan "kode belum jalan" dari "kode jalan tapi masih salah".
const BUILD_MARKER = 'unismiles-backend/db-env-aliases-1';
app.get('/api/v1/public/__build', (req, res) => {
  res.json({ build: BUILD_MARKER, pid: process.pid, cwd: process.cwd() });
});


app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/kiosk', kioskRoutes);

// PENTING soal urutan: route yang lebih spesifik harus dipasang LEBIH DULU.
//
// Express mencocokkan berurutan, jadi `app.use('/api/v1/admin', adminRoutes)`
// akan menangkap SEMUA /api/v1/admin/* termasuk /api/v1/admin/assets. Akibatnya
// router aset di bawah ini tidak pernah tercapai, dan upload gambar di Frame
// Editor gagal dengan 404 walau berkasnya sudah terkirim.
//
// Ini penyebab nyata "gambar berhasil di-upload tapi tidak muncul di Admin".
app.use('/api/v1/admin/assets', assetRoutes);
// Router terpisah supaya upload aset punya validasi PNG yang lebih ketat.
app.use('/api/v1/admin', adminRoutes);
app.get('/api/kiosk-status', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      maintenanceMode: false,
      brightness: 80,
      volume: 100,
      resolution: '1080x1920',
      paperSize: '4R'
    }
  });
});

app.use('/api/v1/auth', authRoutes);

// Error handling - must be registered AFTER all routes
app.use(notFoundHandler);
app.use(errorHandler);

// Default port mengikuti port runtime KroomBox untuk site ini, supaya nilai di
// server tidak perlu diubah manual setiap kali deploy.
const PORT = process.env.PORT || 5017;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Uni-Smiles REST API & WebSocket Server is running on ${HOST}:${PORT}`);

  // Ringkasan status konfigurasi saat start.
  //
  // Kenapa dicetak: kegagalan konfigurasi sebelumnya hanya terlihat sebagai
  // gejala di fitur (mis. "Email gagal dikirim", logout paksa) sehingga
  // penyebabnya sulit ditemukan. Satu baris di log langsung menunjukkan apa
  // yang belum terpasang. Tidak ada nilai rahasia yang dicetak — hanya
  // "terpasang/belum".
  const isSet = (value) => Boolean(String(value ?? '').trim());
  const emailReady = isSet(process.env.SMTP_USER) && isSet(process.env.SMTP_PASS);
  console.log(
    '[Config] email=' + (emailReady ? 'aktif' : 'BELUM (SMTP_USER/SMTP_PASS kosong)') +
    ' | vision=' + (process.env.PAYMENT_VISION_SERVICE_URL || 'deteksi otomatis port') +
    ' | jwt=' + (isSet(process.env.JWT_SECRET) ? 'ok' : 'KOSONG') +
    ' | base=' + (process.env.PUBLIC_BASE_URL || 'kosong')
  );
});
