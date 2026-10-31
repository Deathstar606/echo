const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./index');

const DEFAULT_BUSINESS_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';

/**
 * Automatically inspects PostgreSQL and applies any pending baseline schemas,
 * migrations, and essential seed entities on backend startup.
 * Completely idempotent and safe to run on every startup.
 */
async function autoMigrateDatabase() {
  let pool;
  try {
    pool = getPool();
  } catch (err) {
    console.warn('[AutoMigrate] Database not configured, skipping auto-migration:', err.message);
    return;
  }

  try {
    // 1. Check if core businesses table exists
    const checkTable = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'businesses'
      );
    `);

    const hasBusinesses = Boolean(checkTable.rows?.[0]?.exists);
    if (!hasBusinesses) {
      console.log('[AutoMigrate] Core tables not found. Running schema.sql...');
      const schemaPath = path.resolve(__dirname, 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await pool.query(schemaSql);
        console.log('[AutoMigrate] Core schema initialized successfully.');
      }
    }

    // 2. Track and apply migrations from migrations/ folder
    const migrationsDir = path.resolve(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir)) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      const appliedRes = await pool.query('SELECT filename FROM schema_migrations;');
      const appliedSet = new Set(appliedRes.rows.map((r) => r.filename));

      for (const file of migrationFiles) {
        if (!appliedSet.has(file)) {
          const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          console.log(`[AutoMigrate] Applying pending migration: ${file}...`);
          await pool.query(migrationSql);
          await pool.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING;',
            [file]
          );
          console.log(`[AutoMigrate] Migration ${file} applied successfully.`);
        }
      }
    }

    // 3. Ensure default business exists
    await pool.query(
      `INSERT INTO businesses (id, name)
       VALUES ($1, 'Default Business')
       ON CONFLICT (id) DO NOTHING;`,
      [DEFAULT_BUSINESS_ID]
    );

    console.log('[AutoMigrate] Database migration check completed successfully.');
  } catch (err) {
    // Catch gracefully in case of mock pools, offline DB, or connection glitches
    console.warn('[AutoMigrate] Note during schema check:', err.message);
  }
}

module.exports = { autoMigrateDatabase, DEFAULT_BUSINESS_ID };
