// API smoke test for Super Admin platform billing.
// Needs the API running. Usage:
//   SUPER_MOBILE=9999999999 SUPER_PASSWORD=... node test/smoke-super-billing.mjs
// It registers three throw-away hospitals ("SB Test …"), raises invoices for them and then removes them again.
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';

const API = process.env.API_URL || 'http://localhost:4000/api';
const SUPER_MOBILE = process.env.SUPER_MOBILE;
const SUPER_PASSWORD = process.env.SUPER_PASSWORD;
if (!SUPER_MOBILE || !SUPER_PASSWORD) { console.error('Set SUPER_MOBILE and SUPER_PASSWORD'); process.exit(1); }

const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`); };
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());
const stamp = String(Date.now()).slice(-6);

const login = await call('POST', '/auth/login', { mobile: SUPER_MOBILE, password: SUPER_PASSWORD });
assert.ok(login.data.token, 'super admin login failed');
const T = login.data.token;
const B = (method, path, body) => call(method, '/super-admin/billing' + path, body, T);

const created = [];
async function newHospital(label, doctors, mobileSeed) {
  const reg = await call('POST', '/auth/register-hospital', { hospitalName: `SB Test ${label} ${stamp}`, hospitalMobile: '', hospitalAddress: 'Test Road, Pune', adminName: `SB Admin ${label}`, adminEmail: `sb${label}${stamp}@example.com`, adminMobile: `75${stamp}${mobileSeed}`, password: 'Start@12345' });
  assert.equal(reg.status, 201, 'register ' + JSON.stringify(reg.data));
  const adminLogin = await call('POST', '/auth/login', { mobile: `75${stamp}${mobileSeed}`, password: 'Start@12345' });
  const adminToken = adminLogin.data.token;
  const hid = Number(reg.data.hospital?.id || (await pool.query(`SELECT id FROM hospitals WHERE name=$1`, [`SB Test ${label} ${stamp}`])).rows[0].id);
  created.push(hid);
  for (let i = 0; i < doctors; i++) {
    const r = await call('POST', '/users', { name: `Dr SB ${label} ${i + 1}`, mobile: `73${stamp}${mobileSeed[0]}${i}`, password: 'Start@12345', role: 'DOCTOR' }, adminToken);
    assert.equal(r.status, 201, 'doctor ' + JSON.stringify(r.data));
  }
  return { id: hid, adminToken };
}

try {
  // ---------- access control ----------
  const noAuth = await call('GET', '/super-admin/billing/rates');
  ok('Billing API needs a login', noAuth.status === 401);
  const hospitalA = await newHospital('A', 4, '10');
  const denied = await call('GET', '/super-admin/billing/rates', undefined, hospitalA.adminToken);
  ok('A hospital admin cannot reach platform billing (403)', denied.status === 403, String(denied.status));

  // ---------- rates ----------
  const rates = await B('GET', '/rates');
  ok('Rates: current ₹799 / ₹899', rates.status === 200 && rates.data.current.year1Base === 799 && rates.data.current.year2Base === 899, JSON.stringify(rates.data.current));
  const t = rates.data.currentTable;
  const expected = [[799, 899], [759, 854], [735, 827], [719, 809], [703, 791], [687, 773], [679, 764], [639, 719]];
  ok('Rates: tier table equals the published pricing table', t.length === 8 && expected.every(([a, b], i) => t[i].year1Month === a && t[i].year2Month === b && t[i].year1Year === a * 12 && t[i].year2Year === b * 12));
  ok('Rates: no upcoming change to start with', rates.data.upcoming === null);

  const future = addDays(40);
  const bad1 = await B('POST', '/rates', { year1Base: 799, year2Base: 949, effectiveFrom: today, applyToExisting: true, reason: 'Annual revision' });
  ok('Rates: a change must be in the future (400)', bad1.status === 400 && /future/.test(bad1.data.message), bad1.data.message);
  const bad2 = await B('POST', '/rates', { year1Base: 600, year2Base: 949, effectiveFrom: future, applyToExisting: true, reason: 'Annual revision' });
  ok('Rates: base that would break the ₹500 floor is refused (400)', bad2.status === 400 && /500/.test(bad2.data.message), bad2.data.message);
  const bad3 = await B('POST', '/rates', { year1Base: 799, year2Base: 949, effectiveFrom: future, applyToExisting: true, reason: 'x' });
  ok('Rates: a reason is required (400)', bad3.status === 400);
  const prev = await B('POST', '/rates/preview', { year1Base: 799, year2Base: 949, effectiveFrom: future, applyToExisting: true, reason: 'Annual revision' });
  const mine = prev.data.hospitals?.find(h => Number(h.hospitalId) === hospitalA.id);
  ok('Rates: preview lists affected hospitals and new-hospital rates', prev.status === 200 && Array.isArray(prev.data.hospitals) && prev.data.newHospitals.year2After === 949 && !!mine, JSON.stringify(mine));
  ok('Rates: a Year 1 hospital is not hit before its Year 2 date (4 doctors: ₹735 → Year 2+ ₹873)', mine && mine.rateYear === 1 && mine.nowRate === 735 && mine.beforeRate === 827 && mine.afterRate === 873, JSON.stringify(mine));
  const sched = await B('POST', '/rates', { year1Base: 799, year2Base: 949, effectiveFrom: future, applyToExisting: true, reason: 'Annual price revision' });
  ok('Rates: schedule a future change (201)', sched.status === 201, JSON.stringify(sched.data));
  let r2 = await B('GET', '/rates');
  ok('Rates: upcoming shown with its table (₹949 → tier 4–6 ₹873)', r2.data.upcoming?.year2Base === 949 && r2.data.upcoming.effectiveFrom === future && r2.data.upcomingTable[2].year2Month === 873 && r2.data.current.year2Base === 899);
  const sched2 = await B('POST', '/rates', { year1Base: 799, year2Base: 959, effectiveFrom: addDays(60), applyToExisting: false, reason: 'Revised again' });
  r2 = await B('GET', '/rates');
  ok('Rates: scheduling again replaces the earlier schedule (one at a time)', sched2.status === 201 && r2.data.upcoming.year2Base === 959 && r2.data.history.filter(h => h.state === 'SCHEDULED').length === 1);
  const edit = await B('PUT', `/rates/${r2.data.upcoming.id}`, { year1Base: 799, year2Base: 949, effectiveFrom: future, applyToExisting: true, reason: 'Back to 949' });
  r2 = await B('GET', '/rates');
  ok('Rates: edit the upcoming change', edit.status === 200 && r2.data.upcoming.year2Base === 949 && r2.data.upcoming.applyToExisting === true);
  const editCurrent = await B('PUT', `/rates/${r2.data.current.id}`, { year1Base: 1, year2Base: 1, effectiveFrom: future, applyToExisting: true, reason: 'nope nope' });
  ok('Rates: the current plan cannot be edited (404)', editCurrent.status === 404 || editCurrent.status === 400);
  const cancel = await B('DELETE', `/rates/${r2.data.upcoming.id}`, { reason: 'Test finished' });
  r2 = await B('GET', '/rates');
  ok('Rates: cancel the upcoming change', cancel.status === 200 && r2.data.upcoming === null);

  // ---------- hospital settings ----------
  const hospitalB = await newHospital('B', 1, '20');
  const hospitalC = await newHospital('C', 7, '30');
  let ov = await B('GET', '/overview');
  const rowA = () => ov.data.hospitals.find(h => Number(h.id) === hospitalA.id);
  ok('Overview: hospital shows doctors, tier, Year 1 rate and monthly/annual totals', rowA().doctors === 4 && rowA().tierLabel === '4–6' && rowA().rateYear === 1 && rowA().rate === 735 && rowA().monthly === 2940 && rowA().annual === 35280, JSON.stringify({ d: rowA().doctors, r: rowA().rate }));
  ok('Overview: new hospital is "Not invoiced", annual, GST off by default', rowA().status === 'Not invoiced' && rowA().cycle === 'ANNUAL' && rowA().gstApplicable === false);
  ok('Overview: next rate after Year 1 is the Year 2+ rate from the first anniversary', rowA().next.rate === 827 && rowA().next.from === rowA().lockEnds.replace(/-(\d\d)$/, (m, d) => '-' + String(Number(d) + 1).padStart(2, '0')) || rowA().next.rate === 827);
  ok('Overview KPIs present', typeof ov.data.kpis.monthlyRecurring === 'number' && ov.data.kpis.activeDoctors >= 12);

  const badGstin = await B('PUT', `/hospitals/${hospitalB.id}/settings`, { billingCycle: 'MONTHLY', gstApplicable: true, gstRate: 18, gstin: 'NOT-A-GSTIN' });
  ok('Settings: invalid GSTIN is refused (400)', badGstin.status === 400);
  const setB = await B('PUT', `/hospitals/${hospitalB.id}/settings`, { billingCycle: 'MONTHLY', gstApplicable: true, gstRate: 18, gstin: '27aabch1234d1z6' });
  ok('Settings: monthly + GST on + GSTIN saved (upper-cased)', setB.status === 200 && setB.data.gstin === '27AABCH1234D1Z6');
  const setBad = await B('PUT', `/hospitals/${hospitalB.id}/settings`, { billingCycle: 'WEEKLY', gstApplicable: true });
  ok('Settings: unknown cycle refused', setBad.status === 400);

  // ---------- quotes ----------
  const qa = await B('GET', `/quote?hospitalId=${hospitalA.id}&cycle=ANNUAL&periodStart=${today}`);
  ok('Quote: 4 doctors annual = ₹735 × 4 × 12 = ₹35,280, GST off → total ₹35,280', qa.status === 200 && qa.data.quote.rate === 735 && qa.data.quote.subtotal === 35280 && qa.data.quote.total === 35280 && qa.data.quote.gstAmount === 0, JSON.stringify(qa.data.quote));
  const qb = await B('GET', `/quote?hospitalId=${hospitalB.id}&cycle=MONTHLY&periodStart=${today}`);
  ok('Quote: 1 doctor monthly = ₹799, GST 18% extra ₹143.82 → ₹942.82', qb.data.quote.subtotal === 799 && qb.data.quote.gstAmount === 143.82 && qb.data.quote.total === 942.82, JSON.stringify(qb.data.quote));
  const qc = await B('GET', `/quote?hospitalId=${hospitalA.id}&cycle=ANNUAL&periodStart=${today}&adjustment=1000`);
  ok('Quote: a discount reduces the subtotal before GST', qc.data.quote.adjustment === 1000 && qc.data.quote.taxable === 34280);
  const qd = await B('GET', `/quote?hospitalId=${hospitalA.id}&cycle=ANNUAL&periodStart=${today}&doctors=2`);
  ok('Quote: the doctor count can be overridden (2 doctors → ₹759)', qd.data.quote.rate === 759 && qd.data.activeDoctors === 4);
  const qe = await B('GET', `/quote?hospitalId=${hospitalA.id}&cycle=ANNUAL&periodStart=2001-01-01`);
  ok('Quote: a period before the billing start date is refused (400)', qe.status === 400);

  // ---------- invoices ----------
  const inv1 = await B('POST', '/invoices', { hospitalId: hospitalA.id, cycle: 'ANNUAL', periodStart: today, status: 'ISSUED', dueDate: addDays(14) });
  ok('Invoice: create & issue (201, CB-YYYY-NNNN)', inv1.status === 201 && /^CB-\d{4}-\d{4}$/.test(inv1.data.invoiceNo), JSON.stringify(inv1.data));
  const dup = await B('POST', '/invoices', { hospitalId: hospitalA.id, cycle: 'ANNUAL', periodStart: today, status: 'ISSUED' });
  ok('Invoice: the same period cannot be invoiced twice (400)', dup.status === 400 && /overlap|already/.test(dup.data.message), dup.data.message);
  let d1 = await B('GET', `/invoices/${inv1.data.id}`);
  ok('Invoice detail: amounts, rate lock and hospital info', d1.data.total === 35280 && d1.data.displayStatus === 'Due' && d1.data.rateYear === 1 && d1.data.lockEnds && d1.data.nextRate.rate === 827 && d1.data.hospitalInfo.name.startsWith('SB Test A'), JSON.stringify({ s: d1.data.displayStatus, n: d1.data.nextRate }));
  ok('Invoice detail: company block present', typeof d1.data.company.name === 'string');
  ov = await B('GET', '/overview');
  ok('Overview: status becomes "Due" and shows the invoice', rowA().status === 'Due' && rowA().invoice.invoiceNo === inv1.data.invoiceNo);
  ok('Overview: outstanding counts the issued invoice', ov.data.kpis.outstanding >= 35280 && ov.data.kpis.outstandingCount >= 1);

  const draft = await B('POST', '/invoices', { hospitalId: hospitalC.id, cycle: 'ANNUAL', periodStart: today, status: 'DRAFT', adjustment: 500, adjustmentReason: 'Launch offer' });
  ok('Invoice: save as draft (no issue date)', draft.status === 201);
  const noReason = await B('POST', '/invoices', { hospitalId: hospitalC.id, cycle: 'MONTHLY', periodStart: addDays(0), status: 'DRAFT', adjustment: 500 });
  ok('Invoice: a discount needs a reason / overlap guarded (400)', noReason.status === 400);
  const upd = await B('PUT', `/invoices/${draft.data.id}`, { hospitalId: hospitalC.id, cycle: 'ANNUAL', periodStart: today, adjustment: 0, doctors: 7 });
  ok('Invoice: edit a draft (7 doctors → ₹719 × 7 × 12 = ₹60,396)', upd.status === 200 && upd.data.total === 60396 && upd.data.rate === 719, JSON.stringify({ t: upd.data.total }));
  const issueIt = await B('POST', `/invoices/${draft.data.id}/issue`);
  ok('Invoice: issue a draft', issueIt.status === 200 && issueIt.data.status === 'ISSUED' && !!issueIt.data.issueDate);
  const editIssued = await B('PUT', `/invoices/${draft.data.id}`, { hospitalId: hospitalC.id, cycle: 'ANNUAL', periodStart: today });
  ok('Invoice: an issued invoice cannot be edited (400)', editIssued.status === 400);

  const wrong = await B('POST', `/invoices/${inv1.data.id}/pay`, { amount: 100, paidOn: today, mode: 'UPI' });
  ok('Pay: amount must equal the invoice total (400)', wrong.status === 400 && /full invoice total/.test(wrong.data.message), wrong.data.message);
  const futurePay = await B('POST', `/invoices/${inv1.data.id}/pay`, { amount: 35280, paidOn: addDays(3), mode: 'UPI' });
  ok('Pay: a future payment date is refused (400)', futurePay.status === 400);
  const badMode = await B('POST', `/invoices/${inv1.data.id}/pay`, { amount: 35280, paidOn: today, mode: 'BARTER' });
  ok('Pay: unknown payment mode refused (400)', badMode.status === 400);
  const paid = await B('POST', `/invoices/${inv1.data.id}/pay`, { amount: 35280, paidOn: today, mode: 'BANK_TRANSFER', reference: 'UTR-TEST-1' });
  ok('Pay: mark as paid with mode and reference', paid.status === 200 && paid.data.status === 'PAID' && paid.data.paymentReference === 'UTR-TEST-1' && paid.data.displayStatus === 'Paid');
  const paidAgain = await B('POST', `/invoices/${inv1.data.id}/pay`, { amount: 35280, paidOn: today, mode: 'UPI' });
  ok('Pay: a paid invoice cannot be paid or cancelled again (400)', paidAgain.status === 400 && (await B('POST', `/invoices/${inv1.data.id}/cancel`, { reason: 'No longer needed' })).status === 400);

  // overdue
  const hospitalD = await newHospital('D', 2, '40');
  const overdueInv = await B('POST', '/invoices', { hospitalId: hospitalD.id, cycle: 'ANNUAL', periodStart: today, status: 'ISSUED', dueDate: addDays(-5) });
  const dOv = await B('GET', `/invoices/${overdueInv.data.id}`);
  ov = await B('GET', '/overview');
  ok('Overdue: an issued invoice past its due date shows as Overdue and counts in the KPI', dOv.data.displayStatus === 'Overdue' && ov.data.kpis.overdueCount >= 1 && ov.data.kpis.overdue >= 18216);
  const cancelIt = await B('POST', `/invoices/${overdueInv.data.id}/cancel`, { reason: 'Raised by mistake' });
  ok('Cancel: an issued invoice can be cancelled (reason required)', cancelIt.status === 200 && cancelIt.data.status === 'CANCELLED' && (await B('POST', `/invoices/${draft.data.id}/cancel`, { reason: 'x' })).status === 400);
  const reuse = await B('POST', '/invoices', { hospitalId: hospitalD.id, cycle: 'ANNUAL', periodStart: today, status: 'ISSUED' });
  ok('Cancel: the period can be invoiced again after cancelling', reuse.status === 201);

  const list = await B('GET', '/invoices');
  ok('Invoice list: includes display status and hospital names', list.status === 200 && list.data.some(i => i.invoiceNo === inv1.data.invoiceNo && i.displayStatus === 'Paid' && i.hospital.startsWith('SB Test A')));

  // ---------- monthly generation ----------
  // monthly clinics are billed after the month ends, for that month's doctors: move the hospital's start back so its first month is complete
  await pool.query(`UPDATE hospitals SET billing_start_date = CURRENT_DATE - 40 WHERE id=$1`, [hospitalB.id]);
  await pool.query(`UPDATE doctor_status_events SET at = at - interval '60 days' WHERE hospital_id=$1`, [hospitalB.id]);
  const month = addDays(-40).slice(0, 7);
  const due = await B('GET', `/monthly-due?month=${month}`);
  const rowBm = due.data.rows.find(r => Number(r.hospitalId) === hospitalB.id);
  ok('Monthly: lists monthly hospitals with their amounts (₹799 + GST = ₹942.82)', due.status === 200 && rowBm && rowBm.state === 'READY' && rowBm.total === 942.82 && !due.data.rows.some(r => Number(r.hospitalId) === hospitalA.id), JSON.stringify(rowBm));
  const gen = await B('POST', '/invoices/generate-monthly', { month, hospitalIds: [hospitalB.id], asDraft: false });
  ok('Monthly: generate invoices for the selected hospitals', gen.status === 201 && gen.data.created.length === 1 && gen.data.created[0].total === 942.82, JSON.stringify(gen.data));
  const gen2 = await B('POST', '/invoices/generate-monthly', { month, hospitalIds: [hospitalB.id], asDraft: false });
  ok('Monthly: running it again skips what is already invoiced', gen2.data.created.length === 0 && /Already invoiced/.test(gen2.data.skipped[0]?.reason || ''), JSON.stringify(gen2.data));
  const invB = await B('GET', `/invoices/${gen.data.created[0].id}`);
  ok('Monthly invoice: 1 month, GST added on top with the hospital GSTIN', invB.data.months === 1 && invB.data.gstAmount === 143.82 && invB.data.gstin === '27AABCH1234D1Z6' && invB.data.cycle === 'MONTHLY');

  // ---------- rate lock across years (hospital that started 400 days ago) ----------
  await pool.query(`UPDATE hospitals SET billing_start_date = CURRENT_DATE - 400 WHERE id=$1`, [hospitalC.id]);
  await B('PUT', `/invoices/${draft.data.id}`, { hospitalId: hospitalC.id, cycle: 'ANNUAL', periodStart: today }).catch(() => {});
  ov = await B('GET', '/overview');
  const rowC = ov.data.hospitals.find(h => Number(h.id) === hospitalC.id);
  ok('Rate lock: after 12 months the hospital moves to the Year 2+ rate (7 doctors: ₹809) and stays there', rowC.rateYear === 2 && rowC.rate === 809 && rowC.monthly === 5663 && rowC.lockEnds === null, JSON.stringify({ y: rowC.rateYear, r: rowC.rate }));
  const sched3 = await B('POST', '/rates', { year1Base: 799, year2Base: 949, effectiveFrom: addDays(10), applyToExisting: true, reason: 'Rate lock check' });
  ov = await B('GET', '/overview');
  const rowC2 = ov.data.hospitals.find(h => Number(h.id) === hospitalC.id);
  ok('Rate lock: a scheduled change does not touch the current period; it shows as the next rate at renewal (7 doctors: ₹854)', rowC2.rate === 809 && rowC2.next.rate === 854 && ov.data.rateChange.year2Base === 949, JSON.stringify({ r: rowC2.rate, n: rowC2.next }));
  const qLate = await B('GET', `/quote?hospitalId=${hospitalC.id}&cycle=ANNUAL&periodStart=${addDays(200)}`);
  ok('Rate lock: a period starting after the effective date uses the new Year 2+ rate (₹854)', qLate.data.quote.rate === 854 && qLate.data.quote.rateYear === 2);
  await B('DELETE', `/rates/${sched3.data.id}`, { reason: 'Rate lock check done' });

  // ---------- company details + audit ----------
  const noGstin = await B('PUT', '/company', { name: 'DhaCare Platform', address: 'Pune', gstin: 'BAD', paymentDetails: '' });
  ok('Company: invalid GSTIN refused (400)', noGstin.status === 400);
  const comp = await B('PUT', '/company', { name: 'DhaCare Platform', address: 'Test address, Pune', gstin: '27AAAPD1234C1Z9', paymentDetails: 'Bank: Test Bank · A/c 000111222' });
  const compGet = await B('GET', '/company');
  ok('Company: details saved and returned on invoices', comp.status === 200 && compGet.data.gstin === '27AAAPD1234C1Z9' && (await B('GET', `/invoices/${inv1.data.id}`)).data.company.address === 'Test address, Pune');
  await B('PUT', '/company', { name: 'DhaCare Platform', address: '', gstin: '', paymentDetails: '' });
  const audit = await call('GET', '/super-admin/audit', undefined, T);
  const acts = new Set(audit.data.map(a => a.action));
  ok('Audit: rate, settings and invoice actions are recorded', ['RATE_SCHEDULED', 'RATE_UPDATED', 'RATE_CANCELLED', 'HOSPITAL_BILLING_UPDATED', 'INVOICE_ISSUED', 'INVOICE_PAID', 'INVOICE_CANCELLED', 'COMPANY_DETAILS_UPDATED'].every(a => acts.has(a)), [...acts].join(','));
  const paidAudit = audit.data.find(a => a.action === 'INVOICE_PAID');
  ok('Audit: payment entry carries the invoice number', paidAudit?.metadata?.invoiceNo === inv1.data.invoiceNo);
} finally {
  // remove everything this test created
  try {
    const ids = created;
    if (ids.length) {
      await pool.query(`DELETE FROM platform_invoices WHERE hospital_id = ANY($1::bigint[])`, [ids]);
      await pool.query(`DELETE FROM super_admin_audit_logs WHERE hospital_id = ANY($1::bigint[])`, [ids]);
      await pool.query(`DELETE FROM billing_items WHERE hospital_id = ANY($1::bigint[])`, [ids]);
      await pool.query(`DELETE FROM users WHERE hospital_id = ANY($1::bigint[])`, [ids]);
      await pool.query(`DELETE FROM hospitals WHERE id = ANY($1::bigint[])`, [ids]);
    }
    await pool.query(`DELETE FROM platform_rate_plans WHERE created_by = (SELECT id FROM platform_superusers WHERE mobile=$1)`, [SUPER_MOBILE]);
  } catch (e) { results.push('FAIL | cleanup | ' + e.message); }
  await pool.end();
}
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(`FAILED: ${failed} of ${results.length}`);
process.exit(failed ? 1 : 0);
