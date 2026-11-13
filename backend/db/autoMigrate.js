const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./index');

const DEFAULT_BUSINESS_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';
const DEMO_OPS_BUSINESS_ID = '11111111-2222-3333-4444-555555555555';

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
    // 1. Check if core businesses / workspaces table exists
    const checkTable = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('businesses', 'workspaces')
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

    // 3. Ensure default workspace and demo operations workspace exist
    const wsTableCheck = await pool.query(`
      SELECT
        EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspaces') AS has_workspaces,
        EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'businesses') AS has_businesses;
    `);
    const hasWorkspacesTable = Boolean(wsTableCheck.rows?.[0]?.has_workspaces);
    const hasBusinessesTable = Boolean(wsTableCheck.rows?.[0]?.has_businesses);

    if (hasWorkspacesTable) {
      const userLookup = await pool.query(`
        SELECT id FROM users
        ORDER BY (id = '10000000-0000-4000-8000-000000000001' OR LOWER(email) = 'demo@maxitext.studio') DESC, created_at ASC
        LIMIT 1;
      `);
      const ownerUserId = userLookup.rows?.[0]?.id || null;

      if (ownerUserId) {
        await pool.query(
          `INSERT INTO workspaces (id, user_id, name)
           VALUES ($1, $2, 'Veloura Apparel')
           ON CONFLICT (id) DO NOTHING;`,
          [DEFAULT_BUSINESS_ID, ownerUserId]
        );

        await pool.query(
          `INSERT INTO workspaces (id, user_id, name)
           VALUES ($1, $2, 'Echo Demo Operations Workspace')
           ON CONFLICT (id) DO NOTHING;`,
          [DEMO_OPS_BUSINESS_ID, ownerUserId]
        );
      }
    } else if (hasBusinessesTable) {
      await pool.query(
        `INSERT INTO businesses (id, name)
         VALUES ($1, 'Default Business')
         ON CONFLICT (id) DO NOTHING;`,
        [DEFAULT_BUSINESS_ID]
      );

      await pool.query(
        `INSERT INTO businesses (id, name)
         VALUES ($1, 'Echo Demo Operations Workspace')
         ON CONFLICT (id) DO NOTHING;`,
        [DEMO_OPS_BUSINESS_ID]
      );
    }

    // 4. Ensure Echo Demo Operations Workspace has orders.csv seeded if empty
    try {
      const ordersTableCheck = await pool.query(`
        SELECT
          EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'orders'
          ) AS has_orders,
          EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'workspace_id'
          ) AS has_workspace_col;
      `);
      let existingOrdersCount = 0;
      if (ordersTableCheck.rows?.[0]?.has_orders) {
        const countSql = ordersTableCheck.rows?.[0]?.has_workspace_col
          ? 'SELECT COUNT(*)::int AS cnt FROM orders WHERE business_id = $1 OR workspace_id = $1;'
          : 'SELECT COUNT(*)::int AS cnt FROM orders WHERE business_id = $1;';
        const countRes = await pool.query(countSql, [DEMO_OPS_BUSINESS_ID]);
        existingOrdersCount = Number(countRes.rows?.[0]?.cnt || 0);
      }

      if (existingOrdersCount === 0) {
        const demoCsvPath = path.resolve(__dirname, '..', 'demo', 'Commercial Orders Dataset.csv');
        if (fs.existsSync(demoCsvPath)) {
          const {
            createOrRegisterDynamicTableFromCsv,
            parseAndValidateSheetCsv,
            importSheetRecordsToDatabase,
          } = require('../src/services/sheetCsvImportService');
          const buffer = fs.readFileSync(demoCsvPath);
          const schema = await createOrRegisterDynamicTableFromCsv(
            'orders',
            buffer,
            DEMO_OPS_BUSINESS_ID
          );
          const { validRecords } = parseAndValidateSheetCsv(buffer, schema, {
            mode: 'replace',
          });
          await importSheetRecordsToDatabase(DEMO_OPS_BUSINESS_ID, schema, validRecords, {
            mode: 'replace',
          });
          console.log('[AutoMigrate] Seeded orders.csv for Echo Demo Operations Workspace.');
        }
      }
    } catch (seedErr) {
      console.warn('[AutoMigrate] Optional demo orders seed skipped:', seedErr.message);
    }

    console.log('[AutoMigrate] Database migration check completed successfully.');
  } catch (err) {
    // Catch gracefully in case of mock pools, offline DB, or connection glitches
    console.warn('[AutoMigrate] Note during schema check:', err.message);
  }
}

module.exports = { autoMigrateDatabase, DEFAULT_BUSINESS_ID, DEMO_OPS_BUSINESS_ID };
