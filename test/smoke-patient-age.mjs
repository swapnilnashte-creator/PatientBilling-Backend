// Age-or-date-of-birth rule for registering a visit. Needs the API running and DATABASE_URL set:
//   node --env-file=.env test/smoke-patient-age.mjs
// It registers a throw-away hospital, checks the rule, then deletes it.
import { pool } from '../src/db.js';

const API = process.env.API_URL || 'http://localhost:4000/api';
const out = [];
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`);
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const stamp = String(Date.now()).slice(-6);
const reg = await call('POST', '/auth/register-hospital', { hospitalName: `Age Test ${stamp}`, hospitalMobile: '9890011122', hospitalAddress: 'Road 1', adminName: 'Age Admin', adminEmail: `age${stamp}@example.com`, adminMobile: `79${stamp}10`, password: 'Start@12345' });
const hospitalId = Number(reg.data.hospital.id);
// DATE columns arrive as local-midnight timestamps; compare in local time
const ymd = v => { const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ageNow = dob => { const d = new Date(dob); const n = new Date(); let y = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) y -= 1; return y; };
try {
  const admin = (await call('POST', '/auth/login', { mobile: `79${stamp}10`, password: 'Start@12345' })).data.token;
  const doc = (await call('POST', '/users', { name: 'Dr Age', mobile: `78${stamp}11`, password: 'Start@12345', role: 'DOCTOR', acknowledgeBilling: true }, admin)).data;
  const base = { fullName: 'Age Patient', mobile: '9833300021', gender: 'MALE' };

  const none = await call('POST', '/patients', base, admin);
  check('a patient with neither age nor date of birth is rejected', none.status === 400 && /age or date of birth/i.test(none.data.message), none.data.message);
  check('both null is rejected too', (await call('POST', '/patients', { ...base, age: null, dateOfBirth: null }, admin)).status === 400);
  check('age above 120 is rejected', (await call('POST', '/patients', { ...base, age: 121 }, admin)).status === 400);
  check('negative age is rejected', (await call('POST', '/patients', { ...base, age: -1 }, admin)).status === 400);
  check('a date of birth in the future is rejected', (await call('POST', '/patients', { ...base, dateOfBirth: '2999-01-01' }, admin)).status === 400);

  const byAge = await call('POST', '/patients', { ...base, age: 40 }, admin);
  check('age alone is accepted and stored as an estimated date of birth', byAge.status === 201 && byAge.data.dob_estimated === true && ageNow(byAge.data.date_of_birth) === 40, JSON.stringify(byAge.data));
  const byDob = await call('POST', '/patients', { ...base, mobile: '9833300022', dateOfBirth: '1980-03-15' }, admin);
  check('a real date of birth is stored as given and not marked estimated', byDob.status === 201 && ymd(byDob.data.date_of_birth) === '1980-03-15' && byDob.data.dob_estimated === false);
  const both = await call('POST', '/patients', { ...base, mobile: '9833300023', dateOfBirth: '1990-01-01', age: 5 }, admin);
  check('when both are sent the exact date wins', both.status === 201 && ymd(both.data.date_of_birth) === '1990-01-01' && both.data.dob_estimated === false);
  const infant = await call('POST', '/patients', { ...base, mobile: '9833300024', age: 0 }, admin);
  check('age 0 (infant) is accepted', infant.status === 201);

  check('editing a patient also needs age or date of birth', (await call('PUT', `/patients/${byAge.data.id}`, base, admin)).status === 400);
  const edit = await call('PUT', `/patients/${byAge.data.id}`, { ...base, dateOfBirth: '1984-06-01' }, admin);
  check('giving the exact date later replaces the estimate', edit.status === 200 && edit.data.dob_estimated === false && ymd(edit.data.date_of_birth) === '1984-06-01');
  const edit2 = await call('PUT', `/patients/${byDob.data.id}`, { ...base, mobile: '9833300022', age: 50 }, admin);
  check('age on an existing patient becomes the new estimate', edit2.status === 200 && edit2.data.dob_estimated === true && ageNow(edit2.data.date_of_birth) === 50);

  const visit = await call('POST', '/visits', { patientId: Number(byAge.data.id), doctorIds: [Number(doc.id)] }, admin);
  check('a visit can be registered once the patient has an age', visit.status === 201);
  // a legacy patient saved before the rule (no date of birth at all) cannot get a visit
  const legacy = await pool.query(`INSERT INTO patients(hospital_id,full_name,mobile,created_by,updated_by) VALUES($1,'Legacy Patient','9833300025',(SELECT id FROM users WHERE hospital_id=$1 LIMIT 1),(SELECT id FROM users WHERE hospital_id=$1 LIMIT 1)) RETURNING id`, [hospitalId]);
  const blocked = await call('POST', '/visits', { patientId: Number(legacy.rows[0].id), doctorIds: [Number(doc.id)] }, admin);
  check('a visit for a patient with no age on file is refused', blocked.status === 400 && /age or date of birth/i.test(blocked.data.message), blocked.data.message);
  const search = await call('GET', '/patients/search?q=983330002', null, admin);
  check('patient search returns the estimated flag', search.data.some(p => p.dob_estimated === true));
} catch (error) {
  out.push(`CRASH | ${error.stack}`);
} finally {
  try {
    for (const table of ['visit_doctors', 'visits', 'patients', 'billing_items', 'users']) await pool.query(`DELETE FROM ${table} WHERE hospital_id=$1`, [hospitalId]);
    await pool.query('DELETE FROM hospital_visit_counters WHERE hospital_id=$1', [hospitalId]);
    await pool.query('DELETE FROM hospitals WHERE id=$1', [hospitalId]);
  } catch (error) { out.push(`FAIL | cleanup | ${error.message}`); }
  await pool.end();
}
console.log(out.join('\n'));
console.log('FAILED:', out.filter(line => !line.startsWith('PASS')).length, 'of', out.length);
process.exit(out.some(line => !line.startsWith('PASS')) ? 1 : 0);
