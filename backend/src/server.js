const app = require('./app');
const env = require('./config/env');
const { getPool } = require('../db');
const { autoMigrateDatabase } = require('../db/autoMigrate');

const server = app.listen(env.port, env.host, async () => {
  console.log(
    `Echo Support Assistant Backend running at http://${env.host}:${env.port} (${env.nodeEnv})`
  );
  try {
    await autoMigrateDatabase();
  } catch (err) {
    console.warn('[Server Startup] Auto-migration warning:', err.message);
  }
});

async function shutdown(signal) {
  console.log(`\nReceived ${signal}. Closing HTTP server and database pool...`);
  server.close(async () => {
    try {
      const pool = getPool();
      await pool.end();
    } catch {
      // Ignore pool close errors if pool was not initialized
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
