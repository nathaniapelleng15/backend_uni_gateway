const { validatePackagePrices } = require('../utils/packagePricing');
const pool = require('../config/db');

const FrameTemplate = {
  async getActiveFrames(userId) {
    const [rows] = await pool.query(
      `SELECT ft.id, ft.name, ft.price, ft.digital_price, ft.digital_print_price, ft.category, ft.user_id, ft.image_url, ft.slot_count,
              ft.layout_config, ft.asset_id, aa.file_url AS asset_url, ft.is_active,
              ft.usage_count, ft.created_at, ft.updated_at
       FROM frame_templates ft
       LEFT JOIN admin_assets aa ON aa.id = ft.asset_id AND aa.is_active = 1
       WHERE ft.is_active = 1 AND ft.deleted_at IS NULL AND (ft.user_id IS NULL OR ft.user_id = ?)`,
      [userId]
    );
    return rows.map(row => {
      if (row.asset_id && row.asset_url) {
        const config = typeof row.layout_config === 'string'
          ? JSON.parse(row.layout_config || '{}')
          : (row.layout_config || {});
        config.overlayUrl = config.overlayUrl || row.asset_url;
        row.layout_config = config;
      }
      delete row.asset_url;
      return row;
    });
  },

  async create(frameData) {
    const packagePrices = validatePackagePrices(frameData);
    const { name, price, category, user_id, image_url, slot_count, layout_config } = frameData;
    const [result] = await pool.query(
      'INSERT INTO frame_templates (name, price, digital_price, digital_print_price, category, user_id, image_url, slot_count, layout_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, packagePrices.digital_price ?? (Number(price) || 0), packagePrices.digital_price ?? null, packagePrices.digital_print_price ?? null, category || null, user_id || null, image_url || '', slot_count, layout_config ? JSON.stringify(layout_config) : null]
    );
    return result;
  },
};

module.exports = FrameTemplate;
