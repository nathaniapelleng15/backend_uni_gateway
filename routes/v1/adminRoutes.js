const express = require('express');
const router = express.Router();
const upload = require('../../middlewares/uploadMiddleware');
const { verifyToken } = require('../../middlewares/authMiddleware');
const paymentController = require('../../controllers/paymentController');
const kioskController = require('../../controllers/kioskController');
const dashboardController = require('../../controllers/dashboardController');
const frameTemplateController = require('../../controllers/frameTemplateController');
const sessionController = require('../../controllers/sessionController');
const adminController = require('../../controllers/adminController');
const authMiddleware = require('../../middlewares/authMiddleware');
const gopayMerchantSessionController = require('../../controllers/gopayMerchantSessionController');
const { createRateLimiter } = require('../../utils/security');

router.use(verifyToken);

router.post(
  '/gopay-merchant/session-import',
  authMiddleware.requireRole(['Super Admin']),
  createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyGenerator: req => `gopay-session-import:${req.user?.id || req.ip}`,
  }),
  gopayMerchantSessionController.importSession
);

const systemSettingsController = require('../../controllers/systemSettingsController');

router.get('/settings', systemSettingsController.getAdminSettings);
router.put('/settings', systemSettingsController.updateSettings);

router.get('/dashboard', dashboardController.getDashboardStats);

router.get('/payment-profile', paymentController.getAdminPaymentProfile);
router.post('/payment-profile/qris', upload.single('qris_image'), paymentController.uploadAdminQRIS);
router.put('/payment-profile', paymentController.updateAdminPaymentProfile);

router.get('/kiosks', kioskController.getAdminKiosks);
router.post('/kiosks', kioskController.createKiosk);
router.put('/kiosks/:id', kioskController.updateKiosk);
router.delete('/kiosks/:id', kioskController.deleteKiosk);
router.post('/kiosks/:id/regenerate-key', kioskController.regenerateKey);

const printingConfigController = require('../../controllers/printingConfigController');

router.get('/kiosks/:kioskId/printing-config', printingConfigController.get);
router.put('/kiosks/:kioskId/printing-config', printingConfigController.update);
router.post('/kiosks/:kioskId/printing-config/test', printingConfigController.test);
router.post('/kiosks/:kioskId/printing-config/refresh', printingConfigController.refresh);
router.get('/templates', frameTemplateController.getTemplates);
router.post('/templates/generate', frameTemplateController.generateTemplate);
router.post('/templates', upload.single('frame_image'), frameTemplateController.uploadTemplate);
router.put('/templates/layout/:layout_id/prices', frameTemplateController.updateLayoutPackagePrices);
router.put('/templates/:id', frameTemplateController.updateTemplate);
router.delete('/templates/:id', frameTemplateController.deleteTemplate);

const { PaymentVerificationController } = require('../../controllers/paymentVerificationController');

router.get('/sessions', sessionController.getAdminSessions);
router.get('/payment-verifications/attempts', PaymentVerificationController.getAttempts);
/**
 * Diagnostik vision service (OCR bukti bayar).
 *
 * Tanpa ini, "apakah scan pembayaran jalan?" hanya bisa dijawab dengan menunggu
 * ada pembeli yang gagal dipindai — dan jawabannya datang terlambat. Endpoint
 * ini mengukur jalurnya langsung, memakai daftar alamat yang sama dengan yang
 * dipakai pemrosesan sungguhan.
 */
router.get('/payment-verifications/vision-health', PaymentVerificationController.visionHealth);
router.get('/payment-verifications/attempts/:attempt_id/evidence', PaymentVerificationController.getEvidenceFile);
router.post('/payment-verifications/attempts/:attempt_id/override', PaymentVerificationController.overridePayment);

// Endpoint: POST /api/v1/admin/admin-mitra
router.post(
  '/admin-mitra',
  authMiddleware.requireRole(['Super Admin']),
  adminController.createAdminMitra
);

module.exports = router;
