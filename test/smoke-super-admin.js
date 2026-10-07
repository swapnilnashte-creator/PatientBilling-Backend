import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const baseUrl = process.env.SMOKE_API_URL || `http://localhost:${process.env.PORT || 4000}/api`;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = `Smoke-${suffix}!`;
let superuserId;
let hospitalId;
let adminId;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const hash = await bcrypt.hash(password, 4);
  const superMobile = `8${String(Date.now()).slice(-9)}`;
  const superQ = await pool.query(
    `INSERT INTO platform_superusers(name,mobile,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,mobile`,
    ['Super Admin Smoke Test', superMobile, `super-smoke-${suffix}@example.test`, hash]
  );
  superuserId = superQ.rows[0].id;
  const hospitalQ = await pool.query(
    `INSERT INTO hospitals(name,mobile) VALUES($1,$2) RETURNING id`,
    [`Super Admin Smoke Hospital ${suffix}`, '0000000000']
  );
  hospitalId = hospitalQ.rows[0].id;
  const smokeMobile = `7${String(Date.now()).slice(-9)}`;
  const adminQ = await pool.query(
    `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'ADMIN') RETURNING id`,
    [hospitalId, 'Smoke Hospital Admin', smokeMobile, `hospital-smoke-${suffix}@example.test`, hash]
  );
  adminId = adminQ.rows[0].id;

  const login = await request('/auth/login', {
    method: 'POST', body: JSON.stringify({ mobile: superQ.rows[0].mobile, password }),
  });
  assert(login.response.ok && login.body.user?.role === 'SUPER_ADMIN', 'Super Admin login failed');
  const superHeaders = { Authorization: `Bearer ${login.body.token}` };

  const mobileLogin = await request('/auth/login', {
    method: 'POST', body: JSON.stringify({ mobile: smokeMobile, password }),
  });
  assert(mobileLogin.response.ok && mobileLogin.body.user?.role === 'ADMIN', 'Hospital Admin mobile login failed');

  const list = await request('/super-admin/hospitals', { headers: superHeaders });
  assert(list.response.ok && list.body.some(item => Number(item.id) === Number(hospitalId)), 'Hospital listing failed');

  const impersonation = await request(`/super-admin/hospitals/${hospitalId}/login-as-admin`, { method: 'POST', headers: superHeaders });
  assert(impersonation.response.ok && impersonation.body.user?.impersonatedBy, 'Admin impersonation failed');

  const deactivation = await request(`/super-admin/hospitals/${hospitalId}/status`, {
    method: 'PATCH', headers: superHeaders,
    body: JSON.stringify({ isActive: false, reason: 'Automated Super Admin smoke test' }),
  });
  assert(deactivation.response.ok && !deactivation.body.is_active, `Hospital deactivation failed (${deactivation.response.status}: ${JSON.stringify(deactivation.body)})`);
  const blocked = await request('/dashboard', { headers: { Authorization: `Bearer ${impersonation.body.token}` } });
  assert(blocked.response.status === 401, 'Deactivated hospital session was not blocked');

  const activation = await request(`/super-admin/hospitals/${hospitalId}/status`, {
    method: 'PATCH', headers: superHeaders,
    body: JSON.stringify({ isActive: true, reason: 'Automated Super Admin smoke test cleanup' }),
  });
  assert(activation.response.ok && activation.body.is_active, `Hospital reactivation failed (${activation.response.status}: ${JSON.stringify(activation.body)})`);
  const audit = await request('/super-admin/audit', { headers: superHeaders });
  const actions = new Set(audit.body.filter(row => Number(row.hospital_id) === Number(hospitalId)).map(row => row.action));
  assert(['IMPERSONATE_ADMIN', 'DEACTIVATE_HOSPITAL', 'ACTIVATE_HOSPITAL'].every(action => actions.has(action)), 'Audit trail is incomplete');

  console.log('Super Admin smoke test passed');
} finally {
  if (superuserId || hospitalId || adminId) {
    await pool.query('BEGIN');
    try {
      if (superuserId) await pool.query(`DELETE FROM super_admin_audit_logs WHERE superuser_id=$1`, [superuserId]);
      if (adminId) await pool.query(`DELETE FROM users WHERE id=$1`, [adminId]);
      if (hospitalId) await pool.query(`DELETE FROM hospitals WHERE id=$1`, [hospitalId]);
      if (superuserId) await pool.query(`DELETE FROM platform_superusers WHERE id=$1`, [superuserId]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  await pool.end();
}
