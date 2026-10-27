const app = require('./app');
const env = require('./config/env');
const { getPool } = require('../db');

const server = app.listen(env.port, env.host, () => {
  console.log(
    `Echo Support Assistant Backend running at http://${env.host}:${env.port} (${env.nodeEnv})`
  );
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
