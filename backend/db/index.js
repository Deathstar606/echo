const { Pool } = require('pg');
const env = require('../src/config/env');
const AppError = require('../src/utils/AppError');

let poolInstance = null;

/**
 * Normalizes the connection string when explicit SSL settings are configured
 * so pg-connection-string's sslmode parameter does not overwrite custom SSL options
 * (important for Aiven PostgreSQL URLs that include ?sslmode=require).
 */
function normalizeConnectionString(connectionString, sslConfig) {
  if (!connectionString || !sslConfig) {
    return connectionString;
  }
  try {
    const url = new URL(connectionString);
    if (url.searchParams.has('sslmode')) {
      url.searchParams.delete('sslmode');
      return url.toString();
    }
  } catch {
    // Fallback to raw connection string if URL parsing fails
  }
  return connectionString;
}

function getPool() {
  if (poolInstance) {
    return poolInstance;
  }

  if (!env.databaseUrl) {
    throw new AppError(
      'Database configuration error: DATABASE_URL is not set in environment variables.',
      500
    );
  }

  poolInstance = new Pool({
    connectionString: normalizeConnectionString(env.databaseUrl, env.dbSsl),
    ssl: env.dbSsl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  poolInstance.on('error', (err) => {
    console.error('Unexpected PostgreSQL idle client error:', err.message);
  });

  return poolInstance;
}

/**
 * Allows replacing the pool instance (e.g., for testing or graceful shutdown).
 */
function setPool(customPool) {
  poolInstance = customPool;
}

/**
 * Executes a single parameterized SQL query.
 */
async function query(text, params = []) {
  const pool = getPool();
  return pool.query(text, params);
}

/**
 * Executes a callback inside a database transaction (BEGIN -> work -> COMMIT / ROLLBACK).
 */
async function withTransaction(callback) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to rollback transaction:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  setPool,
  query,
  withTransaction,
};
