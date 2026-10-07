import 'dotenv/config';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { pool } from '../src/db.js';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = `MultiFirm-${suffix}!`;
const otherPassword = `Other-${suffix}!`;
const mobile = `9${String(Date.now()).slice(-9)}`;
const hospitalIds = [];
const userIds = [];
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

try {
  const [hash, otherHash] = await Promise.all([bcrypt.hash(password, 4), bcrypt.hash(otherPassword, 4)]);
  for (const [position, passwordHash] of [hash, hash, otherHash].entries()) {
    const hospitalQ = await pool.query(
      `INSERT INTO hospitals(name) VALUES($1) RETURNING id`,
      [`Multi Firm Smoke ${position + 1} ${suffix}`]
    );
    const hospitalId = hospitalQ.rows[0].id;
    hospitalIds.push(hospitalId);
    const userQ = await pool.query(
      `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role)
       VALUES($1,$2,$3,$4,$5,'ADMIN') RETURNING id`,
      [hospitalId, `Multi Firm Admin ${position + 1}`, mobile, `multi-firm-${suffix}@example.test`, passwordHash]
    );
    userIds.push(userQ.rows[0].id);
  }

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const rejected = await request(baseUrl, '/auth/login', {
    method: 'POST', body: JSON.stringify({ mobile, password: 'wrong-password' }),
  });
  assert(!rejected.response.ok && !rejected.body.firms, 'Invalid credentials exposed firm choices');

  const login = await request(baseUrl, '/auth/login', {
    method: 'POST', body: JSON.stringify({ mobile, password }),
  });
  assert(login.response.ok, `Multi-firm login failed (${login.response.status})`);
  assert(login.body.requiresFirmSelection === true, 'Firm selection was not requested');
  assert(login.body.token === undefined, 'A full session token was issued before firm selection');
  assert(login.body.firms?.length === 2, 'Firm choices were not limited to password-validated accounts');

  const singleMatch = await request(baseUrl, '/auth/login', {
    method: 'POST', body: JSON.stringify({ mobile, password: otherPassword }),
  });
  assert(singleMatch.response.ok && singleMatch.body.token, 'Single validated firm did not issue a session');
  assert(singleMatch.body.requiresFirmSelection === undefined, 'Single validated firm unnecessarily requested selection');
  assert(singleMatch.body.user?.hospitalId === Number(hospitalIds[2]), 'Single-match session used the wrong firm');

  const selectedHospitalId = Number(login.body.firms[1].hospitalId);
  const selected = await request(baseUrl, '/auth/select-firm', {
    method: 'POST',
    body: JSON.stringify({ selectionToken: login.body.selectionToken, hospitalId: selectedHospitalId }),
  });
  assert(selected.response.ok && selected.body.token, 'Selected firm did not issue a session');
  assert(selected.body.user?.hospitalId === selectedHospitalId, 'Session was issued for the wrong firm');

  const forbidden = await request(baseUrl, '/auth/select-firm', {
    method: 'POST',
    body: JSON.stringify({ selectionToken: login.body.selectionToken, hospitalId: Number(hospitalIds[2]) }),
  });
  assert(!forbidden.response.ok, 'Selection token allowed a firm whose password was not validated');

  console.log('Multi-firm login smoke test passed');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (userIds.length || hospitalIds.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (userIds.length) await client.query(`DELETE FROM users WHERE id=ANY($1::bigint[])`, [userIds]);
      if (hospitalIds.length) await client.query(`DELETE FROM hospitals WHERE id=ANY($1::bigint[])`, [hospitalIds]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.end();
}
