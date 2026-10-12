const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const pool = require('../config/db');

async function migrate(executor = pool) {
  const connection = await executor.getConnection();
  let acquired = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK('unismiles_package_prices_migration', 30) AS acquired");
    acquired = Number(locks[0].acquired) === 1;
    if (!acquired) throw new Error('Migrasi harga paket sedang dijalankan proses lain.');
    const columns = [
      ['frame_templates', 'digital_price', 'DECIMAL(12,2) NULL'],
      ['frame_templates', 'digital_print_price', 'DECIMAL(12,2) NULL'],
      ['sessions', 'package_type', "VARCHAR(20) NOT NULL DEFAULT 'digital_print'"],
      ['sessions', 'package_base_amount', 'DECIMAL(12,2) NULL'],
    ];
    for (const [table, column, definition] of columns) {
      const [rows] = await connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
      );
      if (!rows.length) await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // NULL prices deliberately retain the legacy template/kiosk fallback.
    // Existing sessions and payment amounts are never recalculated.
    console.log('[Migration] Package price and session package columns ready.');
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('unismiles_package_prices_migration')").catch(() => {});
    connection.release();
  }
}

if (require.main === module) {
  migrate().catch(error => { console.error('[Migration] Failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { migrate };
