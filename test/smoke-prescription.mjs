// Prescription API smoke test. Needs the API running and DATABASE_URL set:
//   node --env-file=.env test/smoke-prescription.mjs
// It registers a throw-away hospital, exercises the medicine search and prescription endpoints, then deletes it.
import { pool } from '../src/db.js';

const API = process.env.API_URL || 'http://localhost:4000/api';
const out = [];
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`);
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const stamp = String(Date.now()).slice(-6);
const reg = await call('POST', '/auth/register-hospital', { hospitalName: `Rx Test ${stamp}`, hospitalMobile: '9890011122', hospitalAddress: 'Road 1', adminName: 'Rx Admin', adminEmail: `rx${stamp}@example.com`, adminMobile: `79${stamp}10`, password: 'Start@12345' });
const hospitalId = Number(reg.data.hospital.id);
try {
  const admin = (await call('POST', '/auth/login', { mobile: `79${stamp}10`, password: 'Start@12345' })).data.token;
  const mk = async (name, mobile, role) => (await call('POST', '/users', { name, mobile, password: 'Start@12345', role, acknowledgeBilling: role === 'DOCTOR' }, admin)).data;
  const doc = await mk('Dr Rx', `78${stamp}11`, 'DOCTOR');
  const doc2 = await mk('Dr Other', `78${stamp}12`, 'DOCTOR');
  const rec = await mk('Rec Rx', `78${stamp}13`, 'RECEPTIONIST');
  const login = async mobile => (await call('POST', '/auth/login', { mobile, password: 'Start@12345' })).data.token;
  const dt = await login(`78${stamp}11`); const dt2 = await login(`78${stamp}12`); const rt = await login(`78${stamp}13`);
  const patient = (await call('POST', '/patients', { fullName: 'Rx Patient', mobile: '9833300009', gender: 'MALE', age: 40 }, admin)).data;
  const visit = (await call('POST', '/visits', { patientId: Number(patient.id), doctorIds: [Number(doc.id)] }, admin)).data;
  const vid = Number(visit.id);

  // ---- medicine search
  let t = Date.now();
  const s1 = await call('GET', '/medicines/search?q=para', null, dt);
  check('search "para" returns name-prefix matches first', s1.status === 200 && s1.data.items.length > 0 && s1.data.items.every(i => i.name.toLowerCase().startsWith('para') && i.matched === 'name'), `${s1.data.items.length} items, ${Date.now() - t} ms`);
  check('search reports how many start with the text', s1.data.prefixTotal > s1.data.items.length, `prefixTotal ${s1.data.prefixTotal}`);
  t = Date.now();
  const s2 = await call('GET', '/medicines/search?q=paracetamol&limit=15', null, dt);
  check('search "paracetamol" also finds brands by ingredient', s2.data.items.some(i => i.matched === 'ingredient' && /paracetamol/i.test(i.composition)), `${s2.data.items.length} items, ${Date.now() - t} ms`);
  const s3 = await call('GET', '/medicines/search?q=p', null, dt);
  check('one letter returns nothing', s3.status === 200 && s3.data.items.length === 0);
  const s4 = await call('GET', '/medicines/search?q=' + encodeURIComponent('100%_'), null, dt);
  check('% and _ are treated as plain text', s4.status === 200 && s4.data.items.length === 0);
  check('search needs a login', (await call('GET', '/medicines/search?q=para')).status === 401);
  const med = s1.data.items[0];

  // ---- prescription rules
  const items = [
    { medicineId: med.id, name: med.name, composition: med.composition, manufacturer: med.manufacturer, packSize: med.packSize, dose: '1-0-1', timing: 'AFTER_FOOD', durationDays: 5, note: 'only if fever' },
    { medicineId: null, name: 'Home remedy tea', dose: 'SOS', timing: 'ANY' },
  ];
  check('cannot prescribe before the visit starts', (await call('PUT', `/visits/${vid}/prescription`, { items }, dt)).status === 400);
  await call('POST', `/visits/${vid}/start`, null, dt);
  check('reception cannot write a prescription', (await call('PUT', `/visits/${vid}/prescription`, { items }, rt)).status === 403);
  const byAdmin = await call('PUT', `/visits/${vid}/prescription`, { items: [items[1]] }, admin);
  check('admin can write it, stored under the consulting doctor', byAdmin.status === 200 && byAdmin.data.prescription.length === 1 && byAdmin.data.prescription[0].doctor_name === 'Dr Rx');
  check('another doctor cannot write it', (await call('PUT', `/visits/${vid}/prescription`, { items }, dt2)).status === 403);
  check('bad timing is rejected', (await call('PUT', `/visits/${vid}/prescription`, { items: [{ name: 'X', timing: 'NEVER' }] }, dt)).status === 400);
  check('blank name is rejected', (await call('PUT', `/visits/${vid}/prescription`, { items: [{ name: '  ' }] }, dt)).status === 400);
  const put = await call('PUT', `/visits/${vid}/prescription`, { items }, dt);
  check('doctor saves the prescription', put.status === 200 && put.data.prescription.length === 2 && put.data.prescription[0].dose === '1-0-1' && put.data.prescription[1].medicine_id === null, `status ${put.status}`);
  const get = await call('GET', `/visits/${vid}`, null, rt);
  check('visit returns the prescription in order, with the doctor', get.data.prescription?.length === 2 && get.data.prescription[0].name === med.name && get.data.prescription[0].doctor_name === 'Dr Rx' && get.data.prescription[0].duration_days === 5);
  const put2 = await call('PUT', `/visits/${vid}/prescription`, { items: [items[1]] }, dt);
  check('saving again replaces the list', put2.data.prescription.length === 1 && put2.data.prescription[0].name === 'Home remedy tea');
  await call('PUT', `/visits/${vid}/prescription`, { items }, dt);

  // ---- frequent + last
  const fr = await call('GET', '/medicines/frequent', null, dt);
  check('frequently used lists the doctor’s medicines with last dose', fr.status === 200 && fr.data.some(f => f.name === med.name && f.dose === '1-0-1' && f.durationDays === 5), JSON.stringify(fr.data.map(f => f.name)));
  check('frequently used is not available to reception', (await call('GET', '/medicines/frequent', null, rt)).status === 403);
  check('admin gets the hospital’s frequently used', (await call('GET', '/medicines/frequent', null, admin)).data.length > 0);
  await call('POST', `/visits/${vid}/doctor-complete`, { action: 'SEND_TO_RECEPTION', charges: [] }, dt);
  const afterDone = await call('PUT', `/visits/${vid}/prescription`, { items: [items[0]] }, dt);
  check('the doctor can still correct the prescription after finishing the visit', afterDone.status === 200 && afterDone.data.prescription.length === 1 && afterDone.data.prescription[0].name === med.name);
  check('reception still cannot', (await call('PUT', `/visits/${vid}/prescription`, { items }, rt)).status === 403);
  check('another doctor still cannot', (await call('PUT', `/visits/${vid}/prescription`, { items }, dt2)).status === 403);
  await call('PUT', `/visits/${vid}/prescription`, { items }, dt);
  const visit2 = (await call('POST', '/visits', { patientId: Number(patient.id), doctorIds: [Number(doc.id)] }, admin)).data;
  const last = await call('GET', `/visits/${Number(visit2.id)}/prescription/last`, null, dt);
  check('"copy last visit" returns the earlier prescription', last.status === 200 && last.data?.visitId === vid && last.data.items.length === 2 && last.data.doctorName === 'Dr Rx');
  const none = await call('GET', `/visits/${vid}/prescription/last`, null, dt);
  check('first visit has no earlier prescription', none.status === 200 && none.data === null);
  check('other doctor cannot read this visit’s prescription', (await call('GET', `/visits/${vid}`, null, dt2)).status === 403);
} catch (error) {
  out.push(`CRASH | ${error.stack}`);
} finally {
  try {
    await pool.query('DELETE FROM visit_prescription_items WHERE hospital_id=$1', [hospitalId]);
    for (const table of ['visit_doctors', 'visits', 'patients', 'billing_items', 'users']) await pool.query(`DELETE FROM ${table} WHERE hospital_id=$1`, [hospitalId]);
    await pool.query('DELETE FROM hospital_visit_counters WHERE hospital_id=$1', [hospitalId]);
    await pool.query('DELETE FROM hospitals WHERE id=$1', [hospitalId]);
  } catch (error) { out.push(`FAIL | cleanup | ${error.message}`); }
  await pool.end();
}
console.log(out.join('\n'));
console.log('FAILED:', out.filter(line => !line.startsWith('PASS')).length, 'of', out.length);
process.exit(out.some(line => !line.startsWith('PASS')) ? 1 : 0);
