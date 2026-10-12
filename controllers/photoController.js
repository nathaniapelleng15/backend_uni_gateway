const Photo = require('../models/photoModel');
const Session = require('../models/sessionModel');
const { assertImageFile } = require('../utils/imageValidation');
const fs = require('fs/promises');
const path = require('path');

const uploadPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo file provided' });
    }

    const session_code = req.params.session_code || req.body.session_code || req.body.session_id;
    if (!session_code) {
      return res.status(400).json({ success: false, message: 'session_code is required' });
    }

    const session = await Session.findByCodeAndKiosk(session_code, req.kiosk.id);
    if (!session) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ success: false, message: 'Session not found or does not belong to this kiosk.' });
    }

    if (session.payment_status !== 'verified') {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ success: false, message: 'Pembayaran belum diverifikasi. Tidak dapat mengunggah foto.' });
    }
    await assertImageFile(req.file);

    const printAsset = req.body.purpose === 'print';
    if (printAsset && session.package_type === 'digital') {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ success: false, message: 'Paket Digital tidak termasuk cetak foto.' });
    }
    let fileUrl = '/uploads/' + req.file.filename;
    if (printAsset) {
      // Keep a session-owned photo row for cleanup, but isolate print-only
      // derivatives from the digital gallery's "last photo is final" fallback.
      const printDir = path.join(__dirname, '../uploads/print');
      await fs.mkdir(printDir, { recursive: true });
      const printPath = path.join(printDir, req.file.filename);
      await fs.rename(req.file.path, printPath);
      req.file.path = printPath;
      fileUrl = '/uploads/print/' + req.file.filename;
    }

    await Photo.create({ session_id: session_code, url: fileUrl });

    return res.status(201).json({ success: true, message: 'Photo uploaded successfully', data: { url: fileUrl }, url: fileUrl });
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { uploadPhoto };
