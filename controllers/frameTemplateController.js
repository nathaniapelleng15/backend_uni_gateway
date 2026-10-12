const { validatePackagePrices } = require('../utils/packagePricing');
const pool = require('../config/db');
const fs = require('fs/promises');
const { assertImageFile } = require('../utils/imageValidation');

function normalizeManagedUrl(value) {
  if (!value) return '';
  if (value.startsWith('/uploads/')) return value;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw Object.assign(new Error('Frame image must be a managed upload URL'), { statusCode: 400 }); }
  const base = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (base) {
    const baseUrl = new URL(base);
    if (parsed.origin === baseUrl.origin && parsed.pathname.startsWith('/uploads/')) return `${parsed.pathname}${parsed.search}`;
  }
  throw Object.assign(new Error('External frame image URLs are not allowed'), { statusCode: 400 });
}

function validateLayoutConfig(layoutConfig) {
  if (!layoutConfig) return;
  if (JSON.stringify(layoutConfig).length > 256 * 1024) {
    throw Object.assign(new Error('Frame layout configuration is too large'), { statusCode: 400 });
  }
  if (typeof layoutConfig === 'object') {
    const urls = [layoutConfig.overlayUrl, ...(Array.isArray(layoutConfig.assetElements) ? layoutConfig.assetElements.map(item => item?.content || item?.url) : [])].filter(Boolean);
    urls.forEach(normalizeManagedUrl);
  }
}

const hasField = (object, field) => Object.prototype.hasOwnProperty.call(object, field);

async function validateAsset(assetId, user) {
  if (assetId === undefined || assetId === null || assetId === '') return null;
  let query = 'SELECT id, file_url FROM admin_assets WHERE id = ? AND is_active = 1';
  const params = [assetId];
  if (user.role !== 'Super Admin') {
    query += ' AND admin_id = ?';
    params.push(user.id);
  }
  const [rows] = await pool.query(query, params);
  if (!rows.length) {
    const error = new Error('Asset not found, inactive, or not authorized');
    error.statusCode = 400;
    throw error;
  }
  return rows[0];
}

/**
 * GET /admin/templates
 * Fetch all frame templates for the authenticated admin.
 */
const getTemplates = async (req, res) => {
  try {
    const user_id = req.user.id;
    const user_role = req.user.role;

    let query = `
      SELECT ft.id, ft.name, ft.price, ft.digital_price, ft.digital_print_price, ft.layout_id, ft.image_url, ft.slot_count, ft.layout_config,
             bg_color, accent_color, frame_type, gradient_stops, gradient_angle,
             gradient_style, text_elements, ft.asset_id, aa.file_url AS asset_url,
             ft.is_active, ft.usage_count, ft.created_at
      FROM frame_templates ft
      LEFT JOIN admin_assets aa ON aa.id = ft.asset_id
      WHERE ft.deleted_at IS NULL
    `;
    const params = [];

    if (user_role !== 'Super Admin') {
      query += ' AND ft.user_id = ?';
      params.push(user_id);
    }

    query += ' ORDER BY ft.created_at DESC';

    const [rows] = await pool.query(query, params);

    const templates = rows.map(r => ({
      ...r,
      layout_config: typeof r.layout_config === 'string'
        ? JSON.parse(r.layout_config || '[]')
        : (r.layout_config || []),
      gradient_stops: typeof r.gradient_stops === 'string'
        ? JSON.parse(r.gradient_stops || '[]')
        : (r.gradient_stops || []),
      text_elements: typeof r.text_elements === 'string'
        ? JSON.parse(r.text_elements || '[]')
        : (r.text_elements || []),
      is_active: Boolean(r.is_active),
      price: Number(r.price) || 0,
      digital_price: r.digital_price == null ? null : Number(r.digital_price),
      digital_print_price: r.digital_print_price == null ? null : Number(r.digital_print_price),
    })).map(template => {
      if (template.asset_id && template.asset_url && template.layout_config && typeof template.layout_config === 'object') {
        template.layout_config.overlayUrl = template.layout_config.overlayUrl || template.asset_url;
      }
      delete template.asset_url;
      return template;
    });

    return res.status(200).json({ success: true, data: templates });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * POST /admin/templates
 * Upload a frame template with an actual PNG image file.
 */
const uploadTemplate = async (req, res) => {
  try {
    const packagePrices = validatePackagePrices(req.body);
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    await assertImageFile(req.file, { allowed: ['png'], maxBytes: 15 * 1024 * 1024 });

    let { name, price, slot_count, layout_config, layout_id, bg_color, accent_color, asset_id } = req.body;
    const user_id = req.user.id;
    const imageUrl = '/uploads/' + req.file.filename;

    const asset = await validateAsset(asset_id, req.user);
    if (asset && layout_config && typeof layout_config === 'object') layout_config.overlayUrl = layout_config.overlayUrl || asset.file_url;

    if (typeof layout_config === 'object') {
      layout_config = JSON.stringify(layout_config);
    }

    await pool.query(
      `INSERT INTO frame_templates
         (user_id, name, price, digital_price, digital_print_price, layout_id, image_url, slot_count, layout_config,
          bg_color, accent_color, frame_type, asset_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'png', ?, 1)`,
      [
        user_id,
        name,
        packagePrices.digital_price ?? (Number(price) || 0),
        packagePrices.digital_price ?? null,
        packagePrices.digital_print_price ?? null,
        layout_id || '1x1',
        imageUrl,
        slot_count || 1,
        layout_config || '[]',
        bg_color || 'transparent',
        accent_color || '#FFFFFF',
        asset_id || null,
      ]
    );

    return res.status(201).json({ success: true, message: 'Template uploaded successfully' });
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * POST /admin/templates/generate
 * Generate a frame template from color/gradient config (no image needed).
 */
const generateTemplate = async (req, res) => {
  try {
    const packagePrices = validatePackagePrices(req.body);
    let {
      name, price, layout_id, bg_color, accent_color, slot_count, layout_config, image_url,
      frame_type, gradient_stops, gradient_angle, gradient_style, text_elements, asset_id
    } = req.body;
    const user_id = req.user.id;

    if (!name || !layout_id) {
      return res.status(400).json({ success: false, message: 'name and layout_id are required' });
    }

    if (typeof gradient_stops === 'object') gradient_stops = JSON.stringify(gradient_stops);
    if (typeof text_elements === 'object') text_elements = JSON.stringify(text_elements);
    const asset = await validateAsset(asset_id, req.user);
    if (typeof layout_config === 'string') {
      try { layout_config = JSON.parse(layout_config); } catch (_) { throw Object.assign(new Error('layout_config must be valid JSON'), { statusCode: 400 }); }
    }
    if (asset && layout_config && typeof layout_config === 'object') layout_config.overlayUrl = layout_config.overlayUrl || asset.file_url;
    validateLayoutConfig(layout_config);
    if (typeof layout_config === 'object') layout_config = JSON.stringify(layout_config);

    await pool.query(
      `INSERT INTO frame_templates
         (user_id, name, price, digital_price, digital_print_price, layout_id, image_url, slot_count, layout_config,
          bg_color, accent_color, frame_type, gradient_stops, gradient_angle,
          gradient_style, text_elements, asset_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        user_id,
        name,
        packagePrices.digital_price ?? (Number(price) || 0),
        packagePrices.digital_price ?? null,
        packagePrices.digital_print_price ?? null,
        layout_id,
        normalizeManagedUrl(image_url || ''),
        slot_count || 1,
        layout_config || '[]',
        bg_color || '#1E293B',
        accent_color || '#FFFFFF',
        frame_type || 'color',
        gradient_stops || '[]',
        gradient_angle || 45,
        gradient_style || 'linear',
        text_elements || '[]',
        asset_id || null,
      ]
    );

    return res.status(201).json({ success: true, message: 'Template created successfully' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /admin/templates/:id
 * Update or toggle a frame template (including is_active).
 */
const updateTemplate = async (req, res) => {
  try {
    const packagePrices = validatePackagePrices(req.body);
    const { id } = req.params;
    const user_id = req.user.id;
    const user_role = req.user.role;

    let {
      name, price, layout_id, bg_color, accent_color, slot_count, layout_config, image_url,
      frame_type, gradient_stops, gradient_angle, gradient_style, text_elements, is_active, asset_id
    } = req.body;

    const asset = await validateAsset(asset_id, req.user);
    if (asset && layout_config && typeof layout_config === 'object') layout_config.overlayUrl = layout_config.overlayUrl || asset.file_url;
    if (typeof layout_config === 'string') {
      try { layout_config = JSON.parse(layout_config); } catch (_) { throw Object.assign(new Error('layout_config must be valid JSON'), { statusCode: 400 }); }
    }
    validateLayoutConfig(layout_config);
    if (typeof layout_config === 'object') layout_config = JSON.stringify(layout_config);
    if (typeof gradient_stops === 'object') gradient_stops = JSON.stringify(gradient_stops);
    if (typeof text_elements === 'object') text_elements = JSON.stringify(text_elements);

    let query = `
      UPDATE frame_templates SET
        name = COALESCE(?, name),
        price = COALESCE(?, price),
        digital_price = COALESCE(?, digital_price),
        digital_print_price = COALESCE(?, digital_print_price),
        layout_id = COALESCE(?, layout_id),
        slot_count = COALESCE(?, slot_count),
        layout_config = COALESCE(?, layout_config),
        bg_color = COALESCE(?, bg_color),
        accent_color = COALESCE(?, accent_color),
        frame_type = COALESCE(?, frame_type),
        gradient_stops = COALESCE(?, gradient_stops),
        gradient_angle = COALESCE(?, gradient_angle),
        gradient_style = COALESCE(?, gradient_style),
        text_elements = COALESCE(?, text_elements),
        asset_id = COALESCE(?, asset_id),
        is_active = COALESCE(?, is_active)
      WHERE id = ? AND deleted_at IS NULL
    `;
    const params = [
      name || null,
      packagePrices.digital_price ?? (price != null && price !== '' ? Number(price) : null),
      packagePrices.digital_price ?? null,
      packagePrices.digital_print_price ?? null,
      layout_id || null,
      slot_count || null,
      layout_config || null,
      bg_color || null,
      accent_color || null,
      frame_type || null,
      gradient_stops || null,
      gradient_angle != null ? gradient_angle : null,
      gradient_style || null,
      text_elements || null,
      hasField(req.body, 'asset_id') ? (asset_id || null) : null,
      is_active != null ? (is_active ? 1 : 0) : null,
      id,
    ];

    if (user_role !== 'Super Admin') {
      query += ' AND user_id = ?';
      params.push(user_id);
    }

    const [result] = await pool.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Template not found or not authorized' });
    }

    return res.status(200).json({ success: true, message: 'Template updated' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /admin/templates/:id
 * Soft-delete a frame template.
 */
const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;
    const user_role = req.user.role;

    let query = 'UPDATE frame_templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL';
    const params = [id];

    if (user_role !== 'Super Admin') {
      query += ' AND user_id = ?';
      params.push(user_id);
    }

    const [result] = await pool.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Template not found or not authorized' });
    }

    return res.status(200).json({ success: true, message: 'Template deleted' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// One atomic update for all authorized styles in a layout.
const updateLayoutPackagePrices = async (req, res) => {
  let connection;
  try {
    const prices = validatePackagePrices(req.body, true);
    const layoutId = String(req.params.layout_id || '');
    if (!layoutId || layoutId.length > 50) return res.status(400).json({ success: false, message: 'layout_id tidak valid.' });
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let scope = 'layout_id = ? AND deleted_at IS NULL';
    const scopeParams = [layoutId];
    if (req.user.role !== 'Super Admin') {
      scope += ' AND user_id = ?';
      scopeParams.push(req.user.id);
    }
    const [rows] = await connection.query(`SELECT id FROM frame_templates WHERE ${scope} FOR UPDATE`, scopeParams);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Tidak ada frame pada layout ini yang dapat diubah.' });
    }
    await connection.query(`UPDATE frame_templates SET price = ?, digital_price = ?, digital_print_price = ? WHERE ${scope}`,
      [prices.digital_price, prices.digital_price, prices.digital_print_price, ...scopeParams]);
    await connection.commit();
    return res.status(200).json({ success: true, data: { ...prices, updated_frames: rows.length } });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    connection?.release();
  }
};

module.exports = { updateLayoutPackagePrices, getTemplates, uploadTemplate, generateTemplate, updateTemplate, deleteTemplate };
