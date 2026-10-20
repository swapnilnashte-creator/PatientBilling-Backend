import pg from 'pg';
import 'dotenv/config';
import { logError } from './errorLog.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: true }
    : false,
  keepAlive: true,
  idleTimeoutMillis: 30000,
  max: Number(process.env.DB_POOL_MAX) || 10,
});
// A database connection that drops while idle must not crash the server (the next request just opens a new one)
pool.on('error', (error) => { console.error('Idle database connection error:', error.message); logError(error, { source: 'idle database connection' }); });

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
