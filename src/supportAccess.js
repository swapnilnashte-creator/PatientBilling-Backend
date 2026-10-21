import crypto from 'crypto';
import { pool } from './db.js';

// Support access: a code the hospital Admin creates and reads out; with it the Super Admin may sign in to that hospital for a limited time.
export const CODE_MINUTES = 30; // how long a code can be typed in
export const MAX_ATTEMPTS = 5; // wrong tries before the code is cancelled
export const SESSION_CHOICES = [30, 60, 120]; // minutes the hospital can allow

export const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export const hashCode = (code, hospitalId) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`support:${hospitalId}:${code}`).digest('hex');
export const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// close codes and sessions whose time is over, so that the hospital is free to create a new code
export async function closeStale(db, hospitalId) {
  await db.query(`UPDATE support_access SET status='CANCELLED',ended_at=NOW(),ended_reason='EXPIRED' WHERE hospital_id=$1 AND status='CODE' AND code_expires_at<=NOW()`, [hospitalId]);
  await db.query(`UPDATE support_access SET status='ENDED',ended_at=session_ends_at,ended_reason='TIME' WHERE hospital_id=$1 AND status='SESSION' AND session_ends_at<=NOW()`, [hospitalId]);
}

// the session that is open now for a hospital, or null
export async function openSession(db, hospitalId) {
  await closeStale(db, hospitalId);
  const q = await db.query(
    `SELECT s.id,s.superuser_id,s.session_started_at,s.session_ends_at,s.session_minutes,p.name AS superuser_name
     FROM support_access s LEFT JOIN platform_superusers p ON p.id=s.superuser_id
     WHERE s.hospital_id=$1 AND s.status='SESSION'`, [hospitalId]);
  return q.rows[0] || null;
}

// a support sign-in token is valid only while its session is open (checked on every request it makes)
export async function sessionAllows(hospitalId, superuserId) {
  const q = await pool.query(
    `SELECT 1 FROM support_access WHERE hospital_id=$1 AND superuser_id=$2 AND status='SESSION' AND session_ends_at>NOW()`, [hospitalId, superuserId]);
  return q.rowCount > 0;
}
