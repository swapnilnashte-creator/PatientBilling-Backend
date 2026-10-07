// Pure pricing rules for platform (Super Admin) billing. No database access here.
//
// Rate = single-doctor base rate less the tier discount (by active doctor count), rounded to the rupee.
// A hospital's first 12 months use the Year 1 base in force on its start date; from month 13 the Year 2+
// base in force on the billing period's start date applies and stays constant until the base changes.
// GST is optional, decided per hospital, and added on top of the (adjusted) subtotal.

export const TIERS = [
  { min: 1, max: 1, label: '1', pct: 0 },
  { min: 2, max: 3, label: '2–3', pct: 5 },
  { min: 4, max: 6, label: '4–6', pct: 8 },
  { min: 7, max: 9, label: '7–9', pct: 10 },
  { min: 10, max: 12, label: '10–12', pct: 12 },
  { min: 13, max: 15, label: '13–15', pct: 14 },
  { min: 16, max: 25, label: '16–25', pct: 15 },
  { min: 26, max: Infinity, label: '26+', pct: 20 },
];
export const RATE_FLOOR = 500;

export function tierFor(doctors) {
  const n = Number(doctors);
  return TIERS.find(t => n >= t.min && n <= t.max) || TIERS[0];
}

export const rateFor = (base, pct) => Math.round(Number(base) * (1 - Number(pct) / 100));
export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// ---- date helpers (all dates are 'YYYY-MM-DD' strings, calendar maths in UTC) ----
const toDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromDate = (date) => date.toISOString().slice(0, 10);
export const todayString = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function addMonths(iso, months) {
  const d = toDate(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fromDate(target);
}
export function addDays(iso, days) { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + days); return fromDate(d); }
export const periodEndFor = (periodStart, months) => addDays(addMonths(periodStart, months), -1);
export const cycleMonths = (cycle) => (cycle === 'MONTHLY' ? 1 : 12);

/** Start of the billing period (for this cycle) that contains `asOf`. */
export function currentPeriodStart(startDate, cycle, asOf) {
  const step = cycleMonths(cycle);
  let k = 0;
  while (addMonths(startDate, (k + 1) * step) <= asOf) k += 1;
  return asOf < startDate ? startDate : addMonths(startDate, k * step);
}

/** The rate plan in force for a hospital on a date. Plans that don't apply to existing hospitals are skipped
 *  for hospitals that started before the plan's effective date. */
export function pickPlan(plans, startDate, asOf) {
  const usable = plans
    .filter(p => !p.cancelled_at && String(p.effective_from) <= asOf && (p.apply_to_existing || String(p.effective_from) <= startDate))
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)) || Number(b.id) - Number(a.id));
  if (usable.length) return usable[0];
  return [...plans].filter(p => !p.cancelled_at).sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)))[0];
}

export const rateYearFor = (startDate, periodStart) => (periodStart < addMonths(startDate, 12) ? 1 : 2);

/** Full quote for one invoice. */
export function buildQuote({ plans, startDate, cycle, periodStart, doctors, adjustment = 0, gstApplicable = false, gstRate = 18 }) {
  const n = Number(doctors);
  if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('At least one doctor is needed to raise an invoice'), { status: 400 });
  const months = cycleMonths(cycle);
  const rateYear = rateYearFor(startDate, periodStart);
  const plan = rateYear === 1 ? pickPlan(plans, startDate, startDate) : pickPlan(plans, startDate, periodStart);
  const baseRate = Number(rateYear === 1 ? plan.year1_base : plan.year2_base);
  const tier = tierFor(n);
  const rate = rateFor(baseRate, tier.pct);
  const subtotal = round2(rate * n * months);
  const credit = round2(Math.min(Math.max(Number(adjustment) || 0, 0), subtotal));
  const taxable = round2(subtotal - credit);
  const gstAmount = gstApplicable ? round2(taxable * Number(gstRate) / 100) : 0;
  return {
    cycle, periodStart, periodEnd: periodEndFor(periodStart, months), months, doctors: n,
    rateYear, planId: plan.id, baseRate, tierLabel: tier.label, discountPct: tier.pct, rate,
    subtotal, adjustment: credit, taxable, gstApplicable: !!gstApplicable, gstRate: gstApplicable ? Number(gstRate) : 0,
    gstAmount, total: round2(taxable + gstAmount),
    // what happens to this hospital's rate after the Year 1 lock ends
    lockEnds: rateYear === 1 ? addDays(addMonths(startDate, 12), -1) : null,
    year2From: rateYear === 1 ? addMonths(startDate, 12) : null,
  };
}

/** Rates table for a plan (used by the Pricing screen). */
export function tierTable(plan) {
  return TIERS.map(t => {
    const y1 = rateFor(plan.year1_base, t.pct);
    const y2 = rateFor(plan.year2_base, t.pct);
    return { doctors: t.label, discountPct: t.pct, year1Month: y1, year1Year: y1 * 12, year2Month: y2, year2Year: y2 * 12 };
  });
}

export const daysBetween = (fromIso, toIso) => Math.round((toDate(toIso) - toDate(fromIso)) / 86400000);

/** Top-up for an annual period when doctors are added beyond what the year was billed for.
 *  The whole year is re-priced at the new doctor count (its tier may improve) and the clinic pays the difference
 *  to what it has already been billed, pro-rated for the days left in the period (from `from` to periodEnd, inclusive). */
export function buildTopUp({ plans, startDate, periodStart, periodEnd, from, prevDoctors, prevRate, newDoctors, gstApplicable = false, gstRate = 18 }) {
  const added = Number(newDoctors) - Number(prevDoctors);
  if (added < 1) throw Object.assign(new Error('No additional doctors to bill'), { status: 400 });
  const q = buildQuote({ plans, startDate, cycle: 'ANNUAL', periodStart, doctors: newDoctors });
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  const remaining = Math.min(periodDays, Math.max(0, daysBetween(from, periodEnd) + 1));
  const fullYearDiff = round2(q.rate * Number(newDoctors) * 12 - Number(prevRate) * Number(prevDoctors) * 12);
  const subtotal = round2(Math.max(0, fullYearDiff) * remaining / periodDays);
  const gstAmount = gstApplicable ? round2(subtotal * Number(gstRate) / 100) : 0;
  return {
    added, prevDoctors: Number(prevDoctors), prevRate: Number(prevRate), doctors: Number(newDoctors),
    rate: q.rate, baseRate: q.baseRate, tierLabel: q.tierLabel, discountPct: q.discountPct, rateYear: q.rateYear,
    periodStart, periodEnd, from, periodDays, remainingDays: remaining, fullYearDiff,
    subtotal, gstApplicable: !!gstApplicable, gstRate: gstApplicable ? Number(gstRate) : 0, gstAmount, total: round2(subtotal + gstAmount),
  };
}
