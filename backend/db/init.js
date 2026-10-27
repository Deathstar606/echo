const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./index');

async function initializeDatabase() {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const migrationsDir = path.resolve(__dirname, 'migrations');

  console.log('Initializing PostgreSQL database schema and migrations...');
  const pool = getPool();

  try {
    await pool.query(schemaSql);

    if (fs.existsSync(migrationsDir)) {
      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of migrationFiles) {
        const migrationSql = fs.readFileSync(
          path.join(migrationsDir, file),
          'utf8'
        );
        await pool.query(migrationSql);
        console.log(`Applied migration: ${file}`);
      }
    }

    console.log(
      'Database schema initialized successfully (businesses, context_entries, customers, conversations, messages, announcements, announcement_recipients, products, services).'
    );
  } catch (error) {
    console.error('Failed to initialize database schema:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  initializeDatabase().catch(() => {
    process.exit(1);
  });
}

module.exports = { initializeDatabase };
