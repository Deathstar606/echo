const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./index');
const {
  parseAndValidateProductsCsv,
  importProductsToDatabase,
} = require('../src/services/sheetCsvImportService');

const DEFAULT_BUSINESS_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';

async function initializeDatabase() {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const migrationsDir = path.resolve(__dirname, 'migrations');
  const productsCsvPath = path.resolve(__dirname, '..', 'products.csv');

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

    // Clear legacy context_entries for the default business so inquiries use products.csv
    await pool.query(
      'DELETE FROM context_entries WHERE business_id = $1;',
      [DEFAULT_BUSINESS_ID]
    );

    // Import products.csv into the products table for the default business
    if (fs.existsSync(productsCsvPath)) {
      const csvBuffer = fs.readFileSync(productsCsvPath);
      const { validRecords, rejectedRows } = parseAndValidateProductsCsv(csvBuffer);
      const importedCount = await importProductsToDatabase(
        DEFAULT_BUSINESS_ID,
        validRecords
      );
      console.log(
        `Seeded products.csv for business ${DEFAULT_BUSINESS_ID}: ${importedCount} imported (${rejectedRows.length} rejected).`
      );
    }

    console.log(
      'Database schema initialized successfully (businesses, context_entries, customers, conversations, messages, announcements, announcement_recipients, products).'
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
