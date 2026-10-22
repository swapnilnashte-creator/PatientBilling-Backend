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
    `SELECT s.id,s.superuser_id,s.session_started_at,s.session_ends_at,s.session_minutes,s.emergency,s.emergency_reason,p.name AS superuser_name
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

// Emergency access: a Super Admin who cannot get the hospital's code chooses this instead. It needs a written reason and is never silent: a support session is
// opened that the hospital sees (red banner, a line with the reason in its Support history). It lasts EMERGENCY_MINUTES and the hospital cannot end it.
export const EMERGENCY_MINUTES = 60;
export async function ensureEmergencySession(db, hospitalId, superuserId, reason) {
  await closeStale(db, hospitalId);
  const open = await db.query(`SELECT id,status,superuser_id FROM support_access WHERE hospital_id=$1 AND status IN ('CODE','SESSION') FOR UPDATE`, [hospitalId]);
  const mine = open.rows.find(r => r.status === 'SESSION' && Number(r.superuser_id) === Number(superuserId));
  if (mine) return mine.id;
  if (open.rows.some(r => r.status === 'SESSION')) throw Object.assign(new Error('Another support session is open for this hospital. Try again when it ends.'), { status: 409 });
  await db.query(`UPDATE support_access SET status='CANCELLED',ended_at=NOW(),ended_reason='EMERGENCY' WHERE hospital_id=$1 AND status='CODE'`, [hospitalId]);
  const row = await db.query(
    `INSERT INTO support_access(hospital_id,status,code_hash,code_expires_at,session_minutes,superuser_id,session_started_at,session_ends_at,emergency,emergency_reason)
     VALUES($1,'SESSION','EMERGENCY',NOW(),$3::smallint,$2,NOW(),NOW()+make_interval(mins=>$4::int),TRUE,$5) RETURNING id`, [hospitalId, superuserId, EMERGENCY_MINUTES, EMERGENCY_MINUTES, reason]);
  await db.query(`INSERT INTO support_access_events(support_id,hospital_id,action) VALUES($1,$2,'EMERGENCY')`, [row.rows[0].id, hospitalId]);
  return row.rows[0].id;
}
