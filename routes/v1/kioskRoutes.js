const express = require('express');
const router = express.Router();
const upload = require('../../middlewares/uploadMiddleware');

const verifyApiKey = require('../../middlewares/apiKeyMiddleware');
const sessionController = require('../../controllers/sessionController');

const photoController = require('../../controllers/photoController');
const paymentController = require('../../controllers/paymentController');

const kioskController = require('../../controllers/kioskController');
const printJobController = require('../../controllers/printJobController');
const printingConfigController = require('../../controllers/printingConfigController');
const { createRateLimiter } = require('../../utils/security');

router.use(verifyApiKey);

router.get('/connection', (req, res) => {
  return res.status(200).json({
    success: true,
    data: { kiosk_id: req.kiosk.id }
  });
});

/**
 * POST /api/v1/kiosk/heartbeat
 * Hardware kiosk calls this every ~60 seconds to report it is alive.
 * Body: { printerInk, storage, camera }
 */
router.post('/heartbeat', kioskController.heartbeat);

const { PaymentVerificationController, uploadMemory } = require('../../controllers/paymentVerificationController');

router.get('/payments', paymentController.getKioskPaymentMethods);
router.get('/templates', kioskController.getKioskTemplates);
router.post('/sessions/start', sessionController.startSession);
router.get('/sessions/:session_code/payment-status', sessionController.getPaymentStatus);

router.post('/sessions/:session_code/payment', sessionController.verifyPayment);
router.post('/sessions/:session_code/payment-verifications', uploadMemory, PaymentVerificationController.submitEvidence);
router.get('/sessions/:session_code/payment-verifications/:attempt_id', PaymentVerificationController.checkAttempt);
router.post('/sessions/:session_code/photos', upload.single('photo'), photoController.uploadPhoto);
router.put('/sessions/:session_code/complete', sessionController.completeSession);
router.post('/sessions/:session_code/send-email', createRateLimiter({ windowMs: 10 * 60_000, max: 3, keyGenerator: req => `${req.kiosk?.id || 'unknown'}:${req.ip}` }), sessionController.sendDigitalCopy);
router.post('/sessions/:session_code/print', printJobController.createPrintJob);
router.get('/print-jobs/:job_id', printJobController.getPrintJob);

/**
 * Laporan status printer langsung dari browser kiosk.
 *
 * Kenapa dari browser, bukan dari kiosk-agent: printer label NIIMBOT tersambung
 * lewat Web Bluetooth DI BROWSER, jadi hanya browser yang tahu printer mana yang
 * sedang terpakai dan apakah sambungannya hidup. Agent OS tidak melihat printer
 * itu sama sekali (NIIMBOT bukan printer sistem).
 *
 * Tanpa ini, panel Admin hanya bisa menampilkan status printer sistem — dan
 * untuk kiosk berlabel termal, statusnya akan selalu kosong.
 *
 * Hasilnya tersimpan di kolom reported_* milik kiosk_printing_configs, jadi
 * panel Admin memakai tampilan yang sudah ada (Desired/Reported Configuration).
 */
router.post('/printer-status', printingConfigController.reportFromBrowser);

/**
 * Pengaturan cetak untuk kiosk, lewat HTTP.
 *
 * Ini jalur CADANGAN untuk kiosk yang mencetak langsung lewat Web Bluetooth:
 * tanpa endpoint ini, ukuran kertas / kepekatan / geser vertikal dari Admin
 * hanya sampai lewat WebSocket (butuh kiosk-agent berjalan).
 *
 * Hanya membaca. Kiosk tetap tidak bisa mengubah konfigurasi dari sini.
 */
router.get('/printing-config', printingConfigController.getForKiosk);

module.exports = router;
