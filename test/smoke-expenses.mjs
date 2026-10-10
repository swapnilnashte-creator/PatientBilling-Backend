// Expenses API smoke test. Needs the API running and DATABASE_URL set:  node --env-file=.env test/smoke-expenses.mjs
import { pool } from '../src/db.js';

const API = process.env.API_URL || 'http://localhost:4000/api';
const out = [];
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`);
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const stamp = String(Date.now()).slice(-6);
const reg = await call('POST', '/auth/register-hospital', { hospitalName: `Exp Test ${stamp}`, hospitalMobile: '9890011122', hospitalAddress: 'Road 1', adminName: 'Exp Admin', adminEmail: `exp${stamp}@example.com`, adminMobile: `79${stamp}10`, password: 'Start@12345' });
const hospitalId = Number(reg.data.hospital.id);
const today = new Date().toISOString().slice(0, 10);
try {
  const admin = (await call('POST', '/auth/login', { mobile: `79${stamp}10`, password: 'Start@12345' })).data.token;
  const mk = async (name, mobile, role) => (await call('POST', '/users', { name, mobile, password: 'Start@12345', role, acknowledgeBilling: role === 'DOCTOR' }, admin)).data;
  await mk('Dr Exp', `78${stamp}11`, 'DOCTOR'); await mk('Rec Exp', `78${stamp}12`, 'RECEPTIONIST');
  const login = async mobile => (await call('POST', '/auth/login', { mobile, password: 'Start@12345' })).data.token;
  const doc = await login(`78${stamp}11`); const rec = await login(`78${stamp}12`);

  check('doctors have no access to expenses', (await call('GET', '/expenses', null, doc)).status === 403 && (await call('GET', '/expenses/categories', null, doc)).status === 403 && (await call('POST', '/expenses', {}, doc)).status === 403);
  const cats = await call('GET', '/expenses/categories', null, admin);
  check('a hospital starts with the standard categories', cats.status === 200 && cats.data.length >= 8 && cats.data.some(c => c.name === 'Salaries'), String(cats.data.length));
  const salaries = cats.data.find(c => c.name === 'Salaries');
  const mine = await call('POST', '/expenses/categories', { name: 'Ambulance fuel', color: '#ff0000' }, admin);
  check('admin can add their own category', mine.status === 201 && mine.data.name === 'Ambulance fuel');
  check('duplicate category name is refused', (await call('POST', '/expenses/categories', { name: 'ambulance FUEL' }, admin)).status === 409);
  check('the subscription name is reserved', (await call('POST', '/expenses/categories', { name: 'DhaCare subscription' }, admin)).status === 400);
  check('reception cannot add categories', (await call('POST', '/expenses/categories', { name: 'Tea' }, rec)).status === 403);

  const base = { date: today, amount: 14200, categoryId: Number(mine.data.id), paidTo: 'Pune Fuel', paymentMode: 'UPI', note: 'Diesel' };
  const add = await call('POST', '/expenses', base, admin);
  check('admin adds an expense', add.status === 201 && add.data.id);
  check('amount must be above zero', (await call('POST', '/expenses', { ...base, amount: 0 }, admin)).status === 400);
  check('future date is refused', (await call('POST', '/expenses', { ...base, date: '2999-01-01' }, admin)).status === 400);
  check('unknown payment mode is refused', (await call('POST', '/expenses', { ...base, paymentMode: 'BARTER' }, admin)).status === 400);
  check('another hospital’s category is refused', (await call('POST', '/expenses', { ...base, categoryId: 999999999 }, admin)).status === 400);
  const recAdd = await call('POST', '/expenses', { ...base, amount: 500, paidTo: 'Tea stall', categoryId: Number(salaries.id), paymentMode: 'CASH' }, rec);
  check('reception can add an expense', recAdd.status === 201);
  check('reception cannot edit or delete', (await call('PUT', `/expenses/${add.data.id}`, base, rec)).status === 403 && (await call('DELETE', `/expenses/${add.data.id}`, null, rec)).status === 403);

  const list = await call('GET', '/expenses', null, admin);
  check('list shows both with the day as plain text and the right total', list.data.count === 2 && list.data.total === 14700 && list.data.items[0].date === today, JSON.stringify(list.data.items.map(i => [i.date, i.amount, i.categoryName])));
  check('reception sees the list too', (await call('GET', '/expenses', null, rec)).data.count === 2);
  const filtered = await call('GET', `/expenses?categoryId=${mine.data.id}&q=diesel`, null, admin);
  check('filter by category and search', filtered.data.count === 1 && filtered.data.items[0].paidTo === 'Pune Fuel');
  check('date range excludes other days', (await call('GET', '/expenses?from=2001-01-01&to=2001-01-31', null, admin)).data.count === 0);

  const edit = await call('PUT', `/expenses/${add.data.id}`, { ...base, amount: 15000, note: 'Diesel + oil' }, admin);
  check('admin edits an expense', edit.status === 200 && (await call('GET', '/expenses', null, admin)).data.total === 15500);
  // switching a category off stops new use, old entries keep it
  await call('PUT', `/expenses/categories/${mine.data.id}`, { isActive: false }, admin);
  check('a switched-off category cannot be used for new expenses', (await call('POST', '/expenses', base, admin)).status === 400);
  check('…and is hidden from reception’s picker', !(await call('GET', '/expenses/categories', null, rec)).data.some(c => c.id === mine.data.id));
  check('…but the old entry can still be edited', (await call('PUT', `/expenses/${add.data.id}`, { ...base, amount: 15000 }, admin)).status === 200);

  // subscription: only once paid
  const inv = async (status, paidOn) => (await pool.query(`INSERT INTO platform_invoices(invoice_no,hospital_id,cycle,period_start,period_end,doctors,rate_year,base_rate,tier_label,discount_pct,rate,months,subtotal,adjustment,gst_amount,total,status,issue_date,due_date,paid_on,paid_amount,payment_mode)
    VALUES($1,$2,'MONTHLY',$7::date,$7::date,1,1,500,'Test',0,500,1,500,0,0,590,$4,$3,$3,$5,$6,'UPI') RETURNING id`, [`T-${stamp}-${status}`, hospitalId, today, status, paidOn, paidOn ? 590 : null, status === 'PAID' ? '2026-01-01' : today])).rows[0].id;
  await inv('ISSUED', null);
  check('an unpaid subscription invoice is NOT an expense', (await call('GET', '/expenses', null, admin)).data.items.every(i => i.kind !== 'SUBSCRIPTION'));
  await inv('PAID', today);
  const withSub = (await call('GET', '/expenses', null, admin)).data;
  const sub = withSub.items.find(i => i.kind === 'SUBSCRIPTION');
  check('once paid, the subscription appears automatically', sub && sub.amount === 590 && sub.categoryName === 'DhaCare subscription' && sub.date === today && withSub.total === 15000 + 500 + 590, JSON.stringify(sub));
  check('reception does not see platform billing', (await call('GET', '/expenses', null, rec)).data.items.every(i => i.kind !== 'SUBSCRIPTION'));
  check('subscription can be filtered as a category', (await call('GET', '/expenses?categoryId=subscription', null, admin)).data.count === 1);
  check('a subscription row cannot be edited as an expense', (await call('PUT', `/expenses/${encodeURIComponent(sub.id)}`, base, admin)).status >= 400);

  const sum = await call('GET', '/expenses/summary', null, admin);
  check('summary: spent includes manual + paid subscription, net = collected − spent', sum.status === 200 && sum.data.spent === 16090 && sum.data.net === sum.data.collected - 16090 && sum.data.months.length === 6 && sum.data.categories.some(c => c.name === 'DhaCare subscription'), JSON.stringify({ spent: sum.data.spent, net: sum.data.net }));
  check('summary is admin only', (await call('GET', '/expenses/summary', null, rec)).status === 403);

  check('admin deletes an expense (soft)', (await call('DELETE', `/expenses/${recAdd.data.id}`, null, admin)).status === 200 && (await call('GET', '/expenses', null, admin)).data.items.every(i => i.id !== String(recAdd.data.id)));
} catch (error) {
  out.push(`CRASH | ${error.stack}`);
} finally {
  try {
    await pool.query('DELETE FROM expenses WHERE hospital_id=$1', [hospitalId]);
    await pool.query('DELETE FROM expense_categories WHERE hospital_id=$1', [hospitalId]);
    await pool.query('DELETE FROM platform_invoices WHERE hospital_id=$1', [hospitalId]);
    for (const table of ['billing_items', 'users']) await pool.query(`DELETE FROM ${table} WHERE hospital_id=$1`, [hospitalId]);
    await pool.query('DELETE FROM hospitals WHERE id=$1', [hospitalId]);
  } catch (error) { out.push(`FAIL | cleanup | ${error.message}`); }
  await pool.end();
}
console.log(out.join('\n'));
console.log('FAILED:', out.filter(line => !line.startsWith('PASS')).length, 'of', out.length);
process.exit(out.some(line => !line.startsWith('PASS')) ? 1 : 0);
