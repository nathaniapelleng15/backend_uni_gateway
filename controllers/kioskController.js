const { resolvePackagePrices } = require('../utils/packagePricing');
const kioskModel = require('../models/kioskModel');
const crypto = require('crypto');
const pool = require('../config/db');
const { parseJson, resolvePrice } = require('../utils/price');
const { pushKioskConfig, sendKioskCommand, broadcastToAdmin, isKioskConnected, pushPrintingConfig } = require('../utils/socketServer');
const { publicBaseUrl } = require('../utils/security');
const kioskPrintingConfigModel = require('../models/kioskPrintingConfigModel');
const printingConfigController = require('./printingConfigController');

function canAccessKiosk(user, kiosk) {
  return user?.role === 'Super Admin' || user?.role === 'admin' || String(kiosk?.user_id) === String(user?.id);
}

function notFoundKiosk(res) {
  return res.status(404).json({ success: false, message: 'Kiosk not found.' });
}

/**
 * Kiosk Controller
 * Handles HTTP requests/responses for Kiosk endpoints.
 */
const kioskController = {
  /**
   * @desc    Get all kiosks with real-time health and status data
   * @route   GET /api/v1/admin/kiosks
   * @access  Private (Admin)
   */
  getAdminKiosks: async (req, res, next) => {
    try {
      const userId = req.user ? req.user.id : null;
      const userRole = req.user ? req.user.role : 'Super Admin';

      const kiosks = await kioskModel.getAllKiosksFormatted(userId, userRole);

      kiosks.forEach(kiosk => {
        if (!isKioskConnected(kiosk.id)) {
          kiosk.status = 'offline';
        }
      });

      return res.status(200).json({
        success: true,
        count: kiosks.length,
        data: kiosks,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Get single kiosk by ID formatted
   * @route   GET /api/v1/admin/kiosks/:id
   * @access  Private / Public
   */
  getKioskById: async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ success: false, message: 'Kiosk ID is required.' });
      }

      const rawKiosk = await kioskModel.getKioskById(id);
      const kiosk = kioskModel.formatKioskResponse(rawKiosk);
      if (!kiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, rawKiosk)) return notFoundKiosk(res);

      return res.status(200).json({
        success: true,
        data: kiosk,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Create a new kiosk & generate device token
   * @route   POST /api/v1/admin/kiosks
   * @access  Private (Admin)
   */
  createKiosk: async (req, res, next) => {
    try {
      const { id, name, location, price, base_price, orientation, config } = req.body;
      const userId = req.user ? req.user.id : null;

      if (!name) {
        return res.status(400).json({ success: false, message: 'Kiosk name is required.' });
      }

      const deviceToken = 'kiosk_' + crypto.randomBytes(16).toString('hex');
      const finalId = id || 'KSK-' + Math.floor(1000 + Math.random() * 9000);
      const finalPrice = price !== undefined ? price : (base_price !== undefined ? base_price : 0);

      await kioskModel.create({
        id: finalId,
        name,
        location: location || '',
        base_price: finalPrice,
        price: finalPrice,
        user_id: userId,
        api_key: deviceToken,
        orientation: orientation || 'PORTRAIT 1080x1920',
        status: 'offline',
        config: config || {},
      });
      await kioskPrintingConfigModel.getOrCreate(finalId, {}, userId);

      const newKiosk = await kioskModel.getKioskByIdFormatted(finalId);

      // Notify Admin WebSocket dashboard
      broadcastToAdmin('kiosk:created', { kiosk: newKiosk });

      return res.status(201).json({
        success: true,
        message: 'Kiosk created successfully.',
        data: {
          ...newKiosk,
          deviceToken,
          api_key: deviceToken,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Get configuration desired state for a specific kiosk
   * @route   GET /api/v1/admin/kiosks/:id/config
   * @access  Private (Admin)
   */
  getKioskConfig: async (req, res, next) => {
    try {
      const { id } = req.params;
      const kiosk = await kioskModel.getKioskByIdFormatted(id);

      if (!kiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, await kioskModel.getKioskById(id))) return notFoundKiosk(res);

      return res.status(200).json({
        success: true,
        kioskId: id,
        data: kiosk.config,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Update desired configuration state for a kiosk & notify Kiosk Agent
   * @route   PUT /api/v1/admin/kiosks/:id/config
   * @access  Private (Admin)
   */
  updateKioskConfig: async (req, res, next) => {
    try {
      const { id } = req.params;
      const newConfig = req.body;

      const existingKiosk = await kioskModel.getKioskById(id);
      if (!existingKiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, existingKiosk)) return notFoundKiosk(res);

      await kioskModel.updateConfig(id, newConfig);

      const updatedKiosk = await kioskModel.getKioskByIdFormatted(id);

      // Push desired config update via WebSocket to connected Kiosk Agent
      const agentNotified = pushKioskConfig(id, updatedKiosk.config);

      // Broadcast update to Admin UI dashboard
      broadcastToAdmin('kiosk:updated', { kiosk: updatedKiosk });

      return res.status(200).json({
        success: true,
        message: 'Kiosk configuration updated successfully.',
        agentNotified,
        data: updatedKiosk.config,
        kiosk: updatedKiosk,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Update general kiosk details (name, location, price, orientation)
   * @route   PUT /api/v1/admin/kiosks/:id
   * @access  Private (Admin)
   */
  updateKiosk: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, location, price, base_price, orientation, config } = req.body;

      const existingKiosk = await kioskModel.getKioskById(id);
      if (!existingKiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, existingKiosk)) return notFoundKiosk(res);

      await kioskModel.updateKiosk(id, { name, location, price, base_price, orientation, config });
      const updatedKiosk = await kioskModel.getKioskByIdFormatted(id);

      if (config) {
        pushKioskConfig(id, updatedKiosk.config);
      }

      broadcastToAdmin('kiosk:updated', { kiosk: updatedKiosk });

      return res.status(200).json({
        success: true,
        message: 'Kiosk updated successfully.',
        data: updatedKiosk,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Regenerate device key / token for a kiosk
   * @route   POST /api/v1/admin/kiosks/:id/regenerate-key
   * @access  Private (Admin)
   */
  regenerateKey: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existingKiosk = await kioskModel.getKioskById(id);

      if (!existingKiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, existingKiosk)) return notFoundKiosk(res);

      const newDeviceToken = 'kiosk_' + crypto.randomBytes(16).toString('hex');
      await kioskModel.regenerateApiKey(id, newDeviceToken);

      const updatedKiosk = await kioskModel.getKioskByIdFormatted(id);
      broadcastToAdmin('kiosk:updated', { kiosk: updatedKiosk });

      return res.status(200).json({
        success: true,
        message: 'Device token regenerated successfully.',
        data: {
          id,
          deviceToken: newDeviceToken,
          api_key: newDeviceToken,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Delete a kiosk by ID (Soft delete)
   * @route   DELETE /api/v1/admin/kiosks/:id
   * @access  Private (Admin)
   */
  deleteKiosk: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existingKiosk = await kioskModel.getKioskById(id);
      if (!existingKiosk || !canAccessKiosk(req.user, existingKiosk)) return notFoundKiosk(res);
      const result = await kioskModel.softDelete(id);
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }

      broadcastToAdmin('kiosk:deleted', { kioskId: id });

      return res.status(200).json({
        success: true,
        message: `Kiosk with ID ${id} deleted successfully.`,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Send command to a specific kiosk agent (e.g., CAMERA_SELF_TEST, REBOOT)
   * @route   POST /api/v1/admin/kiosks/:id/commands
   * @access  Private (Admin)
   */
  sendCommand: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { command, payload } = req.body;

      if (!command) {
        return res.status(400).json({ success: false, message: 'Command is required.' });
      }

      const kiosk = await kioskModel.getKioskById(id);
      if (!kiosk) {
        return res.status(404).json({ success: false, message: `Kiosk not found with ID: ${id}` });
      }
      if (!canAccessKiosk(req.user, kiosk)) return notFoundKiosk(res);
      const supportedCommands = new Set([
        'CAMERA_SELF_TEST', 'PRINTER_CLEAN', 'REBOOT', 'SHUTDOWN',
        'SYNC_CONFIG', 'UPDATE_CONFIG', 'REFRESH_PRINTER_STATUS', 'PRINT_PHOTO'
      ]);
      if (typeof command !== 'string' || !supportedCommands.has(command)) {
        return res.status(400).json({ success: false, message: 'Unsupported kiosk command.' });
      }
      if (['REBOOT', 'SHUTDOWN'].includes(command) && !['Super Admin', 'admin'].includes(req.user?.role)) {
        return res.status(403).json({ success: false, message: 'Only Super Admin may issue this command.' });
      }
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
        return res.status(400).json({ success: false, message: 'Command payload must be an object.' });
      }
      if (JSON.stringify(payload || {}).length > 16_384) {
        return res.status(413).json({ success: false, message: 'Command payload is too large.' });
      }

      const dispatched = sendKioskCommand(id, command, payload || {});
      const online = isKioskConnected(id);

      return res.status(200).json({
        success: true,
        message: dispatched
          ? `Command ${command} sent to kiosk ${id}.`
          : `Command ${command} queued for kiosk ${id} (Kiosk currently ${online ? 'online' : 'offline'}).`,
        data: {
          kioskId: id,
          command,
          payload: payload || {},
          dispatched,
          isOnline: online,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @desc    Get frame templates for active kiosk photobooth app
   * @route   GET /api/v1/kiosk/templates
   * @access  Kiosk (API Key verified)
   */
  getKioskTemplates: async (req, res) => {
    try {
      const userId = req.kiosk.user_id;
      // `asset_id` ikut diambil: gambar frame yang dipilih dari daftar aset
      // (hasil "Upload Image" di Frame Editor) disimpan sebagai asset_id, dan
      // kolom image_url-nya sering KOSONG. Tanpa join ke admin_assets, kiosk
      // menerima template tanpa gambar sama sekali.
      const [rows] = await pool.query(
        `SELECT ft.id, ft.name, ft.price, ft.digital_price, ft.digital_print_price, ft.image_url, ft.slot_count, ft.layout_config, ft.layout_id,
                ft.bg_color, ft.accent_color, ft.frame_type, ft.gradient_stops, ft.gradient_angle,
                ft.gradient_style, ft.text_elements,
                a.file_url AS asset_file_url
         FROM frame_templates ft
         LEFT JOIN admin_assets a ON a.id = ft.asset_id AND a.is_active = 1
         WHERE (ft.user_id = ? OR ft.user_id IS NULL) AND ft.is_active = 1 AND ft.deleted_at IS NULL
         ORDER BY ft.created_at DESC`,
        [userId]
      );

      const LAYOUT_LABELS = {
        '1x1': 'Polaroid',
        '2x1': 'Duo Strip',
        '3x1': 'Trio Strip',
        '4x1': 'Film Strip',
        '2x2': 'Classic 2x2',
        '2x3': 'Collage 6',
      };

      const layoutMap = new Map();

      rows.forEach(r => {
        const layoutId = r.layout_id || '1x1';
        if (!layoutMap.has(layoutId)) {
          layoutMap.set(layoutId, {
            id: layoutId,
            label: LAYOUT_LABELS[layoutId] || r.name || 'Custom Layout',
            enabled: true,
            styles: [],
          });
        }

        const parseJSON = (val, fallback = []) => parseJson(val, fallback);
        let layoutConfig = parseJSON(r.layout_config, {});

        // Gambar dari daftar aset disimpan sebagai asset_id, dan kolom image_url
        // sering kosong. API Admin sudah menyuntikkan overlayUrl dari asset_id di
        // frameTemplateController.getTemplates, tetapi endpoint kiosk ini belum —
        // akibatnya Admin menampilkan gambar sementara kiosk tidak.
        if (r.asset_file_url) {
          layoutConfig.overlayUrl = layoutConfig.overlayUrl || layoutConfig.overlay_url || r.asset_file_url;
        }

        // Sumber gambar, berurutan: kolom image_url, lalu overlayUrl di
        // layout_config (termasuk hasil asset_id di atas), lalu berkas aset.
        const rawUrl = (r.image_url && r.image_url.trim())
          || layoutConfig.overlayUrl || layoutConfig.overlay_url
          || r.asset_file_url || '';
        const imageUrl = rawUrl
          ? (rawUrl.startsWith('http') ? rawUrl : `${publicBaseUrl(req)}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`)
          : null;

        const frameType = r.frame_type || (imageUrl ? 'png' : 'color');
        const gradStopsRaw = parseJSON(r.gradient_stops, []);
        const textElemsRaw = parseJSON(r.text_elements, []);

        let backgroundConfig = { type: 'solid', color: r.bg_color || '#ffffff' };
        if (frameType === 'gradient' && gradStopsRaw.length > 0) {
          backgroundConfig = {
            type: 'gradient',
            gradientType: r.gradient_style || 'linear',
            gradientAngle: r.gradient_angle ?? 45,
            gradientStops: gradStopsRaw.map(s => ({
              color: s.color,
              offset: s.position !== undefined ? s.position : (s.offset ?? 0),
            })),
          };
        } else if (frameType === 'png' && imageUrl) {
          backgroundConfig = { type: 'image', color: r.bg_color || '#ffffff' };
        } else if (frameType === 'color') {
          backgroundConfig = { type: 'solid', color: r.bg_color || '#ffffff' };
        }

        const elements = textElemsRaw.map((t, idx) => ({
          id: t.id || `text-${idx}`,
          type: 'text',
          content: t.text || '',
          x: Number(t.x ?? 50),
          y: Number(t.y ?? 50),
          fontSize: Number(t.fontSize || 40),
          fontFamily: t.fontFamily || 'Inter, sans-serif',
          color: t.color || '#FFFFFF',
          fontWeight: t.fontWeight || 'bold',
          opacity: 1,
          rotation: 0,
        }));

        const assetElementsRaw = parseJSON(layoutConfig.assetElements || layoutConfig.asset_elements, []);
        const assetElements = assetElementsRaw.map((a, idx) => {
          const aUrl = a.url || a.imageUrl || a.image_url || '';
          const fullUrl = aUrl.startsWith('http') ? aUrl : `${publicBaseUrl(req)}${aUrl.startsWith('/') ? '' : '/'}${aUrl}`;
          return {
            id: a.id || `asset-${idx}`,
            type: 'sticker',
            content: fullUrl,
            x: Number(a.x ?? 50),
            y: Number(a.y ?? 50),
            width: Number(a.width ?? a.w ?? 20),
            height: Number(a.height ?? a.h ?? 0),
            opacity: Number(a.opacity ?? 1),
            rotation: Number(a.rotation ?? 0),
            anchor: a.anchor || 'top-left'
          };
        });

        const price = resolvePrice({
          templatePrice: r.price,
          layoutConfig,
          kioskBasePrice: req.kiosk.base_price,
        });

        layoutMap.get(layoutId).styles.push({
          id: String(r.id),
          name: r.name,
          overlayUrl: imageUrl,
          backgroundConfig,
          elements: [...elements, ...assetElements],
          _accentColor: r.accent_color || '#FFFFFF',
          _layoutConfig: layoutConfig,
          price,
          ...resolvePackagePrices(r, req.kiosk.base_price),
          layout_price: Number(layoutConfig.layout_price) || price,
        });
      });

      return res.status(200).json({ success: true, data: Array.from(layoutMap.values()) });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * @desc    Receive heartbeat ping from a kiosk hardware device over REST (legacy / fallback)
   * @route   POST /api/v1/kiosk/heartbeat
   * @access  Kiosk (API key required)
   */
  heartbeat: async (req, res) => {
    try {
      const kiosk = req.kiosk; // set by verifyApiKey middleware
      const { printerInk, inkLevel, storage, storageUsedPercent, camera, cameraStatus } = req.body;

      const healthData = {
        printerInk: inkLevel !== undefined ? Number(inkLevel) : (printerInk !== undefined ? Number(printerInk) : (kiosk.health?.printerInk ?? 100)),
        storageUsedPercent: storageUsedPercent !== undefined ? Number(storageUsedPercent) : (storage !== undefined ? Number(storage) : (kiosk.health?.storageUsedPercent ?? 0)),
        cameraStatus: cameraStatus || camera || kiosk.health?.cameraStatus || 'GOOD',
      };

      await kioskModel.updateHeartbeatAndStatus(kiosk.id, healthData);
      const updated = await kioskModel.getKioskByIdFormatted(kiosk.id);

      broadcastToAdmin('kiosk:updated', { kiosk: updated });

      return res.status(200).json({
        success: true,
        message: 'Heartbeat received.',
        data: {
          kiosk_id: kiosk.id,
          status: 'online',
          server_time: new Date().toISOString(),
          kiosk: updated,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * @desc    Get printer configuration for a specific kiosk
   * @route   GET /api/v1/admin/kiosks/:kioskId/printing-config
   * @access  Private (Admin)
   */
  getPrintingConfig: (req, res, next) => printingConfigController.get(req, res, next),

  /**
   * @desc    Update printer configuration for a specific kiosk
   * @route   PUT /api/v1/admin/kiosks/:kioskId/printing-config
   * @access  Private (Admin)
   */
  updatePrintingConfig: (req, res, next) => printingConfigController.update(req, res, next),

  /**
   * @desc    Send a test print command
   * @route   POST /api/v1/admin/kiosks/:kioskId/printing-config/test
   * @access  Private (Admin)
   */
  testPrintingConfig: (req, res, next) => printingConfigController.test(req, res, next),

  /**
   * @desc    Refresh printer status by asking agent to report config
   * @route   POST /api/v1/admin/kiosks/:kioskId/printing-config/refresh
   * @access  Private (Admin)
   */
  refreshPrintingConfig: (req, res, next) => printingConfigController.refresh(req, res, next),
};

module.exports = kioskController;
