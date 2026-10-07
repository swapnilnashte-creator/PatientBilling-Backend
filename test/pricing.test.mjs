// Run with: node test/pricing.test.mjs
import assert from 'node:assert/strict';
import { TIERS, tierFor, rateFor, tierTable, buildQuote, pickPlan, addMonths, addDays, currentPeriodStart, rateYearFor } from '../src/billing/pricing.js';

const plan = (id, y1, y2, from, extra = {}) => ({ id, year1_base: y1, year2_base: y2, effective_from: from, apply_to_existing: true, cancelled_at: null, ...extra });

// 1. The published pricing table (₹799 / ₹899 base) is reproduced exactly.
const expected = [
  ['1', 799, 899], ['2–3', 759, 854], ['4–6', 735, 827], ['7–9', 719, 809],
  ['10–12', 703, 791], ['13–15', 687, 773], ['16–25', 679, 764], ['26+', 639, 719],
];
const table = tierTable(plan(1, 799, 899, '2000-01-01'));
expected.forEach(([label, y1, y2], i) => {
  assert.equal(table[i].doctors, label);
  assert.equal(table[i].year1Month, y1, `${label} year 1`);
  assert.equal(table[i].year2Month, y2, `${label} year 2`);
  assert.equal(table[i].year1Year, y1 * 12);
  assert.equal(table[i].year2Year, y2 * 12);
});
assert.ok(table.every(r => r.year1Month > 500 && r.year2Month > 500), 'floor above ₹500');

// 2. Tiers
assert.equal(tierFor(1).label, '1'); assert.equal(tierFor(3).label, '2–3'); assert.equal(tierFor(26).label, '26+'); assert.equal(tierFor(40).pct, 20);

// 3. Dates
assert.equal(addMonths('2026-01-31', 1), '2026-02-28'); assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
assert.equal(addMonths('2026-10-03', 12), '2027-10-03'); assert.equal(addDays('2027-10-03', -1), '2027-10-02');
assert.equal(currentPeriodStart('2026-08-12', 'ANNUAL', '2026-10-04'), '2026-08-12');
assert.equal(currentPeriodStart('2026-08-12', 'MONTHLY', '2026-10-04'), '2026-09-12');
assert.equal(currentPeriodStart('2026-08-12', 'ANNUAL', '2027-08-12'), '2027-08-12');

// 4. Annual Year 1 quote: 4 doctors, 8% off 799 -> 735 x 4 x 12
const plans = [plan(1, 799, 899, '2000-01-01')];
let q = buildQuote({ plans, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 4 });
assert.equal(q.rate, 735); assert.equal(q.subtotal, 35280); assert.equal(q.total, 35280); assert.equal(q.rateYear, 1);
assert.equal(q.periodEnd, '2027-10-02'); assert.equal(q.year2From, '2027-10-03'); assert.equal(q.gstAmount, 0);

// 5. GST is optional and added on top: 35,280 + 18% = 41,630.40
q = buildQuote({ plans, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 4, gstApplicable: true, gstRate: 18 });
assert.equal(q.gstAmount, 6350.4); assert.equal(q.total, 41630.4);

// 6. Monthly: one month, same per-doctor rate
q = buildQuote({ plans, startDate: '2026-10-01', cycle: 'MONTHLY', periodStart: '2026-10-01', doctors: 1 });
assert.equal(q.months, 1); assert.equal(q.subtotal, 799); assert.equal(q.periodEnd, '2026-10-31');
q = buildQuote({ plans, startDate: '2026-10-01', cycle: 'MONTHLY', periodStart: '2026-10-01', doctors: 1, gstApplicable: true });
assert.equal(q.gstAmount, 143.82); assert.equal(q.total, 942.82);

// 7. Rate lock: months 1-12 Year 1, month 13 onwards Year 2+ (constant every year)
assert.equal(rateYearFor('2026-10-01', '2027-09-01'), 1); assert.equal(rateYearFor('2026-10-01', '2027-10-01'), 2);
q = buildQuote({ plans, startDate: '2026-10-01', cycle: 'MONTHLY', periodStart: '2027-10-01', doctors: 1 });
assert.equal(q.rateYear, 2); assert.equal(q.rate, 899);
const y3 = buildQuote({ plans, startDate: '2026-10-01', cycle: 'ANNUAL', periodStart: '2028-10-01', doctors: 1 });
assert.equal(y3.rate, 899, 'year 3 equals year 2 until the base changes');
q = buildQuote({ plans, startDate: '2026-03-15', cycle: 'ANNUAL', periodStart: '2027-03-15', doctors: 1 });
assert.equal(q.rateYear, 2); assert.equal(q.subtotal, 10788);

// 8. Upcoming change: Year 2+ ₹899 -> ₹949 from 2026-11-01 (applies to existing hospitals at renewal)
const withChange = [...plans, plan(2, 799, 949, '2026-11-01')];
q = buildQuote({ plans: withChange, startDate: '2026-03-15', cycle: 'ANNUAL', periodStart: '2027-03-15', doctors: 1 });
assert.equal(q.rate, 949); assert.equal(q.subtotal, 11388);
q = buildQuote({ plans: withChange, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2027-10-03', doctors: 4 });
assert.equal(q.rate, 873, 'hospital leaving Year 1 gets the Year 2+ rate in force that day');
// A hospital still in Year 1 keeps the Year 1 rate it started on
q = buildQuote({ plans: withChange, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 4 });
assert.equal(q.rate, 735);
// A period starting before the effective date is unaffected
q = buildQuote({ plans: withChange, startDate: '2025-03-15', cycle: 'ANNUAL', periodStart: '2026-03-15', doctors: 1 });
assert.equal(q.rate, 899);

// 9. New-hospitals-only changes skip existing hospitals
const newOnly = [...plans, plan(3, 849, 999, '2026-11-01', { apply_to_existing: false })];
q = buildQuote({ plans: newOnly, startDate: '2026-03-15', cycle: 'ANNUAL', periodStart: '2027-03-15', doctors: 1 });
assert.equal(q.rate, 899, 'existing hospital keeps its starting rates');
q = buildQuote({ plans: newOnly, startDate: '2026-12-01', cycle: 'ANNUAL', periodStart: '2026-12-01', doctors: 1 });
assert.equal(q.rate, 849, 'new hospital gets the new Year 1 base');

// 10. Cancelled plans are ignored
const cancelled = [...plans, plan(4, 1, 1, '2026-01-01', { cancelled_at: '2026-02-01' })];
assert.equal(pickPlan(cancelled, '2026-03-01', '2026-06-01').id, 1);

// 11. Adjustment (discount/credit) reduces the taxable amount before GST; cannot exceed the subtotal
q = buildQuote({ plans, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 4, adjustment: 1000, gstApplicable: true });
assert.equal(q.taxable, 34280); assert.equal(q.gstAmount, 6170.4); assert.equal(q.total, 40450.4);
q = buildQuote({ plans, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 4, adjustment: 999999 });
assert.equal(q.total, 0);
assert.throws(() => buildQuote({ plans, startDate: '2026-10-03', cycle: 'ANNUAL', periodStart: '2026-10-03', doctors: 0 }), /At least one doctor/);

console.log('pricing tests passed:', TIERS.length, 'tiers,', 'all assertions ok');

// 9. Top-ups for annual clinics that add doctors mid-year.
import { buildTopUp, daysBetween } from '../src/billing/pricing.js';
{
  const plans = [plan(1, 799, 899, '2000-01-01')];
  const base = { plans, startDate: '2026-04-01', periodStart: '2026-04-01', periodEnd: '2027-03-31' };
  let t = buildTopUp({ ...base, from: '2026-10-01', prevDoctors: 4, prevRate: 735, newDoctors: 5 });
  assert.equal(t.rate, 735); assert.equal(t.periodDays, 365); assert.equal(t.remainingDays, 182);
  assert.equal(t.fullYearDiff, 8820); assert.equal(t.subtotal, Math.round(8820 * 182 / 365 * 100) / 100);
  t = buildTopUp({ ...base, from: '2026-04-01', prevDoctors: 6, prevRate: 735, newDoctors: 7 }); // 7 doctors re-tiers everyone
  assert.equal(t.rate, 719); assert.equal(t.fullYearDiff, 7 * 719 * 12 - 6 * 735 * 12); assert.equal(t.subtotal, t.fullYearDiff);
  t = buildTopUp({ ...base, from: '2026-04-01', prevDoctors: 1, prevRate: 799, newDoctors: 2, gstApplicable: true, gstRate: 18 });
  assert.equal(t.gstAmount, Math.round(t.subtotal * 0.18 * 100) / 100); assert.equal(t.total, Math.round((t.subtotal + t.gstAmount) * 100) / 100);
  assert.equal(daysBetween('2026-04-01', '2027-03-31'), 364);
  assert.throws(() => buildTopUp({ ...base, from: '2026-04-01', prevDoctors: 4, prevRate: 735, newDoctors: 4 }));
}
console.log('top-up tests passed');
