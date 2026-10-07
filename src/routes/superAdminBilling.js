import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { billableDoctors } from '../billing/doctors.js';
import {
  TIERS, RATE_FLOOR, addDays, addMonths, buildQuote, currentPeriodStart, cycleMonths, periodEndFor, pickPlan, rateFor, rateYearFor, round2, tierTable, todayString,
} from '../billing/pricing.js';

// Super Admin → platform billing: rates, hospital billing settings, invoices. Mounted at /api/super-admin/billing.
const router = Router();

const dateSchema = z.string().date();
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const UPI_ID = /^[a-z0-9][a-z0-9._-]{1,99}@[a-z][a-z0-9]{1,63}$/;
const PAY_MODES = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH'];
const num = (value) => (value === null || value === undefined ? null : Number(value));

async function audit(client, req, action, hospitalId, metadata = {}) {
  await client.query(
    `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,metadata) VALUES($1,$2,$3,$4)`,
    [req.user.id, action, hospitalId || null, JSON.stringify(metadata)]
  );
}

// ---------- rate plans ----------
const planSelect = `SELECT id,year1_base,year2_base,effective_from::text AS effective_from,apply_to_existing,reason,created_at,cancelled_at
                    FROM platform_rate_plans ORDER BY effective_from DESC,id DESC`;
export async function loadPlans(client = pool) {
  const q = await client.query(planSelect);
  return q.rows;
}
const planJson = (plan, today) => plan && ({
  id: plan.id, year1Base: num(plan.year1_base), year2Base: num(plan.year2_base), effectiveFrom: plan.effective_from,
  applyToExisting: plan.apply_to_existing, reason: plan.reason, createdAt: plan.created_at,
  state: plan.cancelled_at ? 'CANCELLED' : plan.effective_from > today ? 'SCHEDULED' : 'ACTIVE',
});
export function currentAndUpcoming(plans, today) {
  const live = plans.filter(p => !p.cancelled_at);
  const current = live.filter(p => p.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from) || Number(b.id) - Number(a.id))[0];
  const upcoming = live.filter(p => p.effective_from > today).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0] || null;
  return { current, upcoming };
}
const ratesBody = z.object({
  year1Base: z.coerce.number().positive().max(100000),
  year2Base: z.coerce.number().positive().max(100000),
  effectiveFrom: dateSchema,
  applyToExisting: z.boolean().default(true),
  reason: z.string().trim().min(5).max(500),
});
function assertRatesValid(body, today) {
  if (body.effectiveFrom <= today) throw badRequest('The effective date must be in the future');
  const lowest = TIERS[TIERS.length - 1].pct;
  if (rateFor(body.year1Base, lowest) <= RATE_FLOOR || rateFor(body.year2Base, lowest) <= RATE_FLOOR) {
    throw badRequest(`With the largest tier discount the rate would fall to ₹${RATE_FLOOR} or below. Raise the base rate.`);
  }
}

router.get('/rates', asyncHandler(async (_req, res) => {
  const today = todayString();
  const plans = await loadPlans();
  const { current, upcoming } = currentAndUpcoming(plans, today);
  res.json({
    today,
    current: planJson(current, today),
    upcoming: planJson(upcoming, today),
    history: plans.filter(p => !p.cancelled_at).map(p => planJson(p, today)),
    currentTable: tierTable(current),
    upcomingTable: upcoming ? tierTable(upcoming) : null,
    floor: RATE_FLOOR,
  });
}));

// What a rate change would do to each hospital and when.
async function impactOf(body, ignorePlanId) {
  const today = todayString();
  const plans = await loadPlans();
  const base = plans.filter(p => !p.cancelled_at && String(p.id) !== String(ignorePlanId) && !(p.effective_from > today));
  const hypothetical = { id: 'preview', year1_base: body.year1Base, year2_base: body.year2Base, effective_from: body.effectiveFrom, apply_to_existing: body.applyToExisting, cancelled_at: null };
  const withChange = [...base, hypothetical];
  const hospitals = await hospitalsWithDoctors();
  const rows = [];
  for (const h of hospitals) {
    if (!h.is_active || h.doctors < 1) continue;
    const startDate = h.billing_start_date;
    const cycle = h.billing_cycle;
    const months = cycleMonths(cycle);
    let p1 = currentPeriodStart(startDate, cycle, body.effectiveFrom);
    if (p1 < body.effectiveFrom) p1 = addMonths(p1, months);
    const appliesFrom = rateYearFor(startDate, p1) === 1 ? addMonths(startDate, 12) : p1;
    const nowQ = buildQuote({ plans: base, startDate, cycle, periodStart: currentPeriodStart(startDate, cycle, today), doctors: h.doctors });
    const before = buildQuote({ plans: base, startDate, cycle, periodStart: appliesFrom, doctors: h.doctors });
    const after = buildQuote({ plans: withChange, startDate, cycle, periodStart: appliesFrom, doctors: h.doctors });
    rows.push({
      hospitalId: h.id, hospital: h.name, cycle, doctors: h.doctors, rateYear: nowQ.rateYear,
      nowRate: nowQ.rate, beforeRate: before.rate, afterRate: after.rate, appliesFrom, changes: before.rate !== after.rate,
    });
  }
  const currentPlan = currentAndUpcoming(plans, today).current;
  return {
    effectiveFrom: body.effectiveFrom,
    hospitals: rows,
    newHospitals: { year1Now: num(currentPlan.year1_base), year1After: body.year1Base, year2Now: num(currentPlan.year2_base), year2After: body.year2Base, from: body.effectiveFrom },
  };
}

router.post('/rates/preview', asyncHandler(async (req, res) => {
  const body = ratesBody.parse(req.body);
  assertRatesValid(body, todayString());
  res.json(await impactOf(body, null));
}));

async function replaceUpcoming(client, req, body, planId) {
  const today = todayString();
  const existing = (await client.query(`SELECT id FROM platform_rate_plans WHERE cancelled_at IS NULL AND effective_from > $1::date AND ($2::bigint IS NULL OR id <> $2)`, [today, planId || null])).rows;
  for (const row of existing) await client.query(`UPDATE platform_rate_plans SET cancelled_at=NOW(),cancelled_by=$1 WHERE id=$2`, [req.user.id, row.id]);
  const ins = await client.query(
    `INSERT INTO platform_rate_plans(year1_base,year2_base,effective_from,apply_to_existing,reason,created_by)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [body.year1Base, body.year2Base, body.effectiveFrom, body.applyToExisting, body.reason, req.user.id]
  );
  return { id: ins.rows[0].id, replaced: existing.map(r => r.id) };
}

router.post('/rates', asyncHandler(async (req, res) => {
  const body = ratesBody.parse(req.body);
  assertRatesValid(body, todayString());
  const result = await withTransaction(async (client) => {
    const r = await replaceUpcoming(client, req, body, null);
    await audit(client, req, 'RATE_SCHEDULED', null, { reason: body.reason, year1Base: body.year1Base, year2Base: body.year2Base, effectiveFrom: body.effectiveFrom, applyToExisting: body.applyToExisting, replaced: r.replaced });
    return r;
  });
  res.status(201).json(result);
}));

router.put('/rates/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = ratesBody.parse(req.body);
  const today = todayString();
  assertRatesValid(body, today);
  const result = await withTransaction(async (client) => {
    const cur = await client.query(`SELECT id FROM platform_rate_plans WHERE id=$1 AND cancelled_at IS NULL AND effective_from > $2::date`, [id, today]);
    if (!cur.rowCount) throw notFound('Only an upcoming rate change can be edited');
    await client.query(`UPDATE platform_rate_plans SET cancelled_at=NOW(),cancelled_by=$1 WHERE id=$2`, [req.user.id, id]);
    const r = await replaceUpcoming(client, req, body, id);
    await audit(client, req, 'RATE_UPDATED', null, { reason: body.reason, year1Base: body.year1Base, year2Base: body.year2Base, effectiveFrom: body.effectiveFrom, applyToExisting: body.applyToExisting });
    return r;
  });
  res.json(result);
}));

router.delete('/rates/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body || {});
  await withTransaction(async (client) => {
    const q = await client.query(
      `UPDATE platform_rate_plans SET cancelled_at=NOW(),cancelled_by=$1 WHERE id=$2 AND cancelled_at IS NULL AND effective_from > $3::date RETURNING year1_base,year2_base,effective_from::text AS effective_from`,
      [req.user.id, id, todayString()]
    );
    if (!q.rowCount) throw notFound('Only an upcoming rate change can be cancelled');
    await audit(client, req, 'RATE_CANCELLED', null, { reason, year1Base: num(q.rows[0].year1_base), year2Base: num(q.rows[0].year2_base), effectiveFrom: q.rows[0].effective_from });
  });
  res.json({ cancelled: true });
}));

// ---------- hospitals ----------
// GST can only be charged when the platform company has a GSTIN on file; the hospital switch is the second condition.
export const companyHasGstin = async (client = pool) => Boolean((await client.query(`SELECT gstin FROM platform_billing_company WHERE id=1`)).rows[0]?.gstin);
export async function hospitalsWithDoctors(id = null) {
  const gstAvailable = await companyHasGstin();
  const q = await pool.query(
    `SELECT h.id,h.name,h.address,h.mobile,h.is_active,h.billing_start_date::text AS billing_start_date,h.billing_cycle,h.gst_applicable,h.gst_rate,h.gstin,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL) AS doctors,
            adm.name AS admin_name,adm.mobile AS admin_mobile,adm.email AS admin_email
     FROM hospitals h
     LEFT JOIN LATERAL (SELECT u.name,u.mobile,u.email FROM users u WHERE u.hospital_id=h.id AND u.role='ADMIN' AND u.is_active=TRUE AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1) adm ON TRUE
     WHERE ($1::bigint IS NULL OR h.id=$1)
     ORDER BY h.created_at DESC,h.id DESC`,
    [id]
  );
  return q.rows.map(r => ({ ...r, gst_requested: r.gst_applicable, gst_applicable: Boolean(r.gst_applicable && gstAvailable), gst_rate: num(r.gst_rate) }));
}

const invoiceStatus = (row, today) => {
  if (row.status === 'ISSUED') return row.due_date && row.due_date < today ? 'Overdue' : 'Due';
  return { DRAFT: 'Draft', PAID: 'Paid', CANCELLED: 'Cancelled' }[row.status];
};
export const invoiceSelect = `SELECT i.id,i.invoice_no,i.hospital_id,h.name AS hospital_name,i.cycle,i.period_start::text AS period_start,i.period_end::text AS period_end,
         i.doctors,i.rate_year,i.base_rate,i.tier_label,i.discount_pct,i.rate,i.months,i.subtotal,i.adjustment,i.adjustment_reason,i.gst_applicable,i.gst_rate,i.gst_amount,i.gstin,i.total,
         i.kind,i.parent_id,i.prev_doctors,i.prev_rate,i.prorate_days,i.period_days,i.status,i.issue_date::text AS issue_date,i.due_date::text AS due_date,i.paid_on::text AS paid_on,i.paid_amount,i.payment_mode,i.payment_reference,i.payment_note,i.notes,i.cancel_reason,i.created_at
  FROM platform_invoices i JOIN hospitals h ON h.id=i.hospital_id`;
export function invoiceJson(row, today) {
  return {
    id: row.id, kind: row.kind, parentId: row.parent_id, prevDoctors: row.prev_doctors, prevRate: num(row.prev_rate), prorateDays: row.prorate_days, periodDays: row.period_days, invoiceNo: row.invoice_no, hospitalId: row.hospital_id, hospital: row.hospital_name, cycle: row.cycle,
    periodStart: row.period_start, periodEnd: row.period_end, doctors: row.doctors, rateYear: row.rate_year, baseRate: num(row.base_rate),
    tierLabel: row.tier_label, discountPct: num(row.discount_pct), rate: num(row.rate), months: row.months, subtotal: num(row.subtotal),
    adjustment: num(row.adjustment), adjustmentReason: row.adjustment_reason, gstApplicable: row.gst_applicable, gstRate: num(row.gst_rate),
    gstAmount: num(row.gst_amount), gstin: row.gstin, total: num(row.total), status: row.status, displayStatus: invoiceStatus(row, today),
    issueDate: row.issue_date, dueDate: row.due_date, paidOn: row.paid_on, paidAmount: num(row.paid_amount), paymentMode: row.payment_mode,
    paymentReference: row.payment_reference, paymentNote: row.payment_note, notes: row.notes, cancelReason: row.cancel_reason, createdAt: row.created_at,
  };
}

router.get('/overview', asyncHandler(async (_req, res) => {
  const today = todayString();
  const [plans, hospitals, invoices] = await Promise.all([
    loadPlans(),
    hospitalsWithDoctors(),
    pool.query(`${invoiceSelect} WHERE i.status <> 'CANCELLED' ORDER BY i.period_start DESC,i.id DESC`),
  ]);
  const { current, upcoming } = currentAndUpcoming(plans, today);
  const byHospital = new Map();
  const openTopUps = new Map();
  const covering = new Map(); // doctors an annual clinic has been billed for today (period invoice + top-ups)
  for (const row of invoices.rows) {
    if (row.kind === 'PERIOD' && !byHospital.has(row.hospital_id)) byHospital.set(row.hospital_id, row);
    if (row.kind === 'TOPUP' && row.status === 'ISSUED' && !openTopUps.has(row.hospital_id)) openTopUps.set(row.hospital_id, row);
    if (row.cycle === 'ANNUAL' && (row.status === 'ISSUED' || row.status === 'PAID') && row.period_start <= today && row.period_end >= today) covering.set(row.hospital_id, Math.max(covering.get(row.hospital_id) || 0, Number(row.doctors)));
  }

  let mrr = 0; let activeDoctors = 0; let activeHospitals = 0;
  const rows = hospitals.map(h => {
    const months = cycleMonths(h.billing_cycle);
    const startDate = h.billing_start_date;
    const periodNow = currentPeriodStart(startDate, h.billing_cycle, today);
    const quote = h.doctors >= 1 ? buildQuote({ plans, startDate, cycle: h.billing_cycle, periodStart: periodNow, doctors: h.doctors }) : null;
    let next = null;
    if (quote) {
      const nextFrom = quote.rateYear === 1 ? quote.year2From : addMonths(periodNow, months);
      const nq = buildQuote({ plans, startDate, cycle: h.billing_cycle, periodStart: nextFrom, doctors: h.doctors });
      next = { from: nextFrom, rate: nq.rate, rateYear: nq.rateYear };
    }
    const latest = byHospital.get(h.id);
    const latestJson = latest ? invoiceJson(latest, today) : null;
    const covers = latest && latest.period_end >= today;
    let status; let suggestedPeriodStart;
    if (h.billing_cycle === 'MONTHLY') {
      // billed at month end: the oldest finished month without an invoice is what is waiting to be billed
      const nextStart = latest ? addDays(latest.period_end, 1) : startDate;
      const waiting = periodEndFor(nextStart, 1) < today;
      if (latest && (latest.status === 'ISSUED' || latest.status === 'DRAFT')) status = invoiceStatus(latest, today);
      else if (waiting || !latest) status = h.is_active ? 'Not invoiced' : 'Inactive';
      else status = invoiceStatus(latest, today);
      suggestedPeriodStart = nextStart;
    } else {
      if (latest && (covers || latest.status === 'ISSUED')) status = invoiceStatus(latest, today);
      else status = h.is_active ? 'Not invoiced' : 'Inactive';
      suggestedPeriodStart = latest && covers ? addMonths(latest.period_start, latest.months) : (latest && latest.period_end < today ? periodNow : (latest ? addMonths(latest.period_start, latest.months) : periodNow));
    }
    const topUp = openTopUps.get(h.id);
    if (topUp && (status === 'Paid' || status === 'Not invoiced')) status = invoiceStatus(topUp, today);
    const billedDoctors = h.billing_cycle === 'ANNUAL' ? (covering.get(h.id) ?? null) : null;
    if (h.is_active) { activeHospitals += 1; activeDoctors += h.doctors; if (quote) mrr += quote.rate * h.doctors; }
    return {
      id: h.id, name: h.name, address: h.address, isActive: h.is_active, adminName: h.admin_name, adminMobile: h.admin_mobile, adminEmail: h.admin_email,
      billingStartDate: startDate, cycle: h.billing_cycle, gstApplicable: h.gst_applicable, gstRequested: h.gst_requested, gstRate: h.gst_rate, gstin: h.gstin,
      doctors: h.doctors, billedDoctors, extraDoctors: billedDoctors && h.doctors > billedDoctors ? h.doctors - billedDoctors : 0,
      periodStart: periodNow, periodEnd: quote ? quote.periodEnd : null, rateYear: quote?.rateYear || null, tierLabel: quote?.tierLabel || null, discountPct: quote?.discountPct ?? null,
      rate: quote?.rate ?? null, monthly: quote ? quote.rate * h.doctors : 0, annual: quote ? quote.rate * h.doctors * 12 : 0,
      lockEnds: quote?.lockEnds || null, next, status, invoice: latestJson, suggestedPeriodStart,
      nextInvoiceOn: h.billing_cycle === 'MONTHLY' ? addMonths(periodNow, 1) : null,
    };
  });
  const open = invoices.rows.filter(r => r.status === 'ISSUED');
  const overdue = open.filter(r => r.due_date < today);
  res.json({
    today,
    gstAvailable: await companyHasGstin(),
    kpis: {
      monthlyRecurring: round2(mrr), annualRunRate: round2(mrr * 12), activeDoctors, activeHospitals,
      outstanding: round2(open.reduce((s, r) => s + Number(r.total), 0)), outstandingCount: open.length,
      overdue: round2(overdue.reduce((s, r) => s + Number(r.total), 0)), overdueCount: overdue.length,
      overdueHospital: overdue.length === 1 ? overdue[0].hospital_name : null,
    },
    rateChange: upcoming ? planJson(upcoming, today) : null,
    currentRates: planJson(current, today),
    hospitals: rows,
  });
}));

router.put('/hospitals/:id/settings', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = z.object({
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']),
    gstApplicable: z.boolean(),
    gstRate: z.coerce.number().min(0).max(40).default(18),
    gstin: z.string().trim().toUpperCase().max(15).optional().default(''),
  }).parse(req.body);
  if (body.gstin && !GSTIN.test(body.gstin)) throw badRequest('Enter a valid 15-character GSTIN, or leave it empty');
  const result = await withTransaction(async (client) => {
    const old = await client.query(`SELECT billing_cycle,gst_applicable,gst_rate,gstin FROM hospitals WHERE id=$1`, [id]);
    if (!old.rowCount) throw notFound('Hospital not found');
    await client.query(
      `UPDATE hospitals SET billing_cycle=$1,gst_applicable=$2,gst_rate=$3,gstin=$4,updated_at=NOW() WHERE id=$5`,
      [body.billingCycle, body.gstApplicable, body.gstRate, body.gstin || null, id]
    );
    await audit(client, req, 'HOSPITAL_BILLING_UPDATED', id, { cycle: body.billingCycle, gstApplicable: body.gstApplicable, gstRate: body.gstRate, gstin: body.gstin || null, was: { cycle: old.rows[0].billing_cycle, gstApplicable: old.rows[0].gst_applicable } });
    return { id, billingCycle: body.billingCycle, gstApplicable: body.gstApplicable, gstRate: body.gstRate, gstin: body.gstin || null };
  });
  res.json(result);
}));

// ---------- quote + invoices ----------
const invoiceInput = z.object({
  hospitalId: z.coerce.number().int().positive(),
  cycle: z.enum(['MONTHLY', 'ANNUAL']),
  periodStart: dateSchema,
  doctors: z.coerce.number().int().positive().optional(),
  adjustment: z.coerce.number().min(0).max(100000000).optional().default(0),
  adjustmentReason: z.string().trim().max(300).optional().default(''),
  dueDate: dateSchema.optional(),
  notes: z.string().trim().max(500).optional().default(''),
});

async function quoteFor(client, input) {
  const [hospital] = await hospitalsWithDoctors(input.hospitalId);
  if (!hospital) throw notFound('Hospital not found');
  if (input.periodStart < hospital.billing_start_date) throw badRequest(`The period cannot start before the hospital's billing start date (${hospital.billing_start_date})`);
  const plans = await loadPlans(client);
  // Monthly clinics are billed for the doctors of that month; annual ones for the doctors active now.
  const billable = input.cycle === 'MONTHLY' ? await billableDoctors(client, hospital.id, input.periodStart, periodEndFor(input.periodStart, 1)) : null;
  const doctors = input.doctors ?? (billable ? billable.count : hospital.doctors);
  const quote = buildQuote({
    plans, startDate: hospital.billing_start_date, cycle: input.cycle, periodStart: input.periodStart, doctors,
    adjustment: input.adjustment, gstApplicable: hospital.gst_applicable, gstRate: hospital.gst_rate ?? 18,
  });
  let nextRate = null;
  if (quote.rateYear === 1) {
    nextRate = { from: quote.year2From, rate: buildQuote({ plans, startDate: hospital.billing_start_date, cycle: input.cycle, periodStart: quote.year2From, doctors }).rate };
  } else {
    const from = addMonths(quote.periodStart, quote.months);
    nextRate = { from, rate: buildQuote({ plans, startDate: hospital.billing_start_date, cycle: input.cycle, periodStart: from, doctors }).rate };
  }
  return { hospital, quote, nextRate, billable };
}

router.get('/quote', asyncHandler(async (req, res) => {
  const input = invoiceInput.parse({ ...req.query, doctors: req.query.doctors || undefined, adjustment: req.query.adjustment || 0 });
  const { hospital, quote, nextRate, billable } = await quoteFor(pool, input);
  const overlap = await pool.query(
    `SELECT invoice_no FROM platform_invoices WHERE hospital_id=$1 AND status<>'CANCELLED' AND kind='PERIOD' AND period_start<=$3::date AND period_end>=$2::date LIMIT 1`,
    [input.hospitalId, quote.periodStart, quote.periodEnd]
  );
  res.json({
    quote, nextRate, activeDoctors: hospital.doctors, billable: billable && { count: billable.count, active: billable.active, removedButConsulted: billable.removedButConsulted }, hospital: { id: hospital.id, name: hospital.name, startDate: hospital.billing_start_date, gstApplicable: hospital.gst_applicable, gstRequested: hospital.gst_requested, gstAvailable: await companyHasGstin(), gstRate: hospital.gst_rate, gstin: hospital.gstin, cycle: hospital.billing_cycle },
    overlapsInvoice: overlap.rows[0]?.invoice_no || null,
  });
}));

router.get('/invoices', asyncHandler(async (req, res) => {
  const today = todayString();
  const hospitalId = req.query.hospitalId === undefined ? null : z.coerce.number().int().positive().parse(req.query.hospitalId);
  const q = hospitalId
    ? await pool.query(`${invoiceSelect} WHERE i.hospital_id=$1 ORDER BY i.period_start DESC,i.id DESC`, [hospitalId])
    : await pool.query(`${invoiceSelect} ORDER BY i.created_at DESC,i.id DESC LIMIT 500`);
  res.json(q.rows.map(r => invoiceJson(r, today)));
}));

export async function invoiceDetail(id) {
  const today = todayString();
  const q = await pool.query(`${invoiceSelect} WHERE i.id=$1`, [id]);
  if (!q.rowCount) throw notFound('Invoice not found');
  const [hospital] = await hospitalsWithDoctors(q.rows[0].hospital_id);
  const company = (await pool.query(`SELECT name,address,gstin,payment_details,upi_id,upi_name,support_phone,support_email FROM platform_billing_company WHERE id=1`)).rows[0];
  const plans = await loadPlans();
  const row = invoiceJson(q.rows[0], today);
  let nextRate = null;
  if (row.cycle && row.rateYear === 1 && hospital) {
    const nextFrom = addMonths(hospital.billing_start_date, 12);
    try { nextRate = { from: nextFrom, rate: buildQuote({ plans, startDate: hospital.billing_start_date, cycle: row.cycle, periodStart: nextFrom, doctors: row.doctors }).rate }; } catch { nextRate = null; }
  }
  return {
    ...row,
    hospitalInfo: hospital && { name: hospital.name, address: hospital.address, mobile: hospital.mobile, adminName: hospital.admin_name, adminMobile: hospital.admin_mobile, gstin: row.gstin || hospital.gstin },
    company: { name: company.name, address: company.address, gstin: company.gstin, paymentDetails: company.payment_details, upiId: company.upi_id, upiName: company.upi_name, supportPhone: company.support_phone, supportEmail: company.support_email },
    lockEnds: row.rateYear === 1 && hospital ? addDays(addMonths(hospital.billing_start_date, 12), -1) : null,
    nextRate,
  };
}
router.get('/invoices/:id', asyncHandler(async (req, res) => {
  res.json(await invoiceDetail(z.coerce.number().int().positive().parse(req.params.id)));
}));

async function createInvoice(client, req, input, status) {
  const { hospital, quote } = await quoteFor(client, input);
  if (!hospital.is_active) throw badRequest('This company is inactive. Activate it before raising an invoice.');
  if (quote.adjustment > 0 && input.adjustmentReason.length < 3) throw badRequest('Give a reason for the discount or credit');
  const overlap = await client.query(
    `SELECT invoice_no FROM platform_invoices WHERE hospital_id=$1 AND status<>'CANCELLED' AND kind='PERIOD' AND period_start<=$3::date AND period_end>=$2::date LIMIT 1`,
    [hospital.id, quote.periodStart, quote.periodEnd]
  );
  if (overlap.rowCount) throw badRequest(`This period overlaps invoice ${overlap.rows[0].invoice_no}`);
  const today = todayString();
  const issued = status === 'ISSUED';
  const due = input.dueDate || addDays(today, 14);
  const no = await client.query(`SELECT nextval('platform_invoice_no_seq') AS n`);
  const invoiceNo = `CB-${today.slice(0, 4)}-${String(no.rows[0].n).padStart(4, '0')}`;
  const ins = await client.query(
    `INSERT INTO platform_invoices(invoice_no,hospital_id,cycle,period_start,period_end,doctors,rate_year,base_rate,tier_label,discount_pct,rate,months,subtotal,adjustment,adjustment_reason,
        gst_applicable,gst_rate,gst_amount,gstin,total,status,issue_date,due_date,notes,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
    [invoiceNo, hospital.id, input.cycle, quote.periodStart, quote.periodEnd, quote.doctors, quote.rateYear, quote.baseRate, quote.tierLabel, quote.discountPct, quote.rate, quote.months, quote.subtotal,
      quote.adjustment, quote.adjustment > 0 ? input.adjustmentReason : null, quote.gstApplicable, quote.gstRate, quote.gstAmount, quote.gstApplicable ? hospital.gstin : null, quote.total, status,
      issued ? today : null, due, input.notes || null, req.user.id]
  );
  await audit(client, req, issued ? 'INVOICE_ISSUED' : 'INVOICE_CREATED', hospital.id, { invoiceNo, total: quote.total, cycle: input.cycle, period: `${quote.periodStart} to ${quote.periodEnd}` });
  return { id: ins.rows[0].id, invoiceNo };
}

function translateDuplicate(error) {
  if (error?.code === '23505') throw badRequest('An invoice already exists for this period');
  throw error;
}

router.post('/invoices', asyncHandler(async (req, res) => {
  const input = invoiceInput.extend({ status: z.enum(['DRAFT', 'ISSUED']).default('ISSUED') }).parse(req.body);
  try {
    const created = await withTransaction(client => createInvoice(client, req, input, input.status));
    res.status(201).json(created);
  } catch (e) { translateDuplicate(e); }
}));

router.put('/invoices/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const input = invoiceInput.parse(req.body);
  await withTransaction(async (client) => {
    const cur = await client.query(`SELECT status,hospital_id FROM platform_invoices WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rowCount) throw notFound('Invoice not found');
    if (cur.rows[0].status !== 'DRAFT') throw badRequest('Only a draft can be edited. Cancel the invoice and raise a new one instead.');
    if (Number(cur.rows[0].hospital_id) !== input.hospitalId) throw badRequest('The hospital of an invoice cannot be changed');
    const { hospital, quote } = await quoteFor(client, input);
    if (quote.adjustment > 0 && input.adjustmentReason.length < 3) throw badRequest('Give a reason for the discount or credit');
    const overlap = await client.query(
      `SELECT invoice_no FROM platform_invoices WHERE hospital_id=$1 AND id<>$4 AND status<>'CANCELLED' AND kind='PERIOD' AND period_start<=$3::date AND period_end>=$2::date LIMIT 1`,
      [hospital.id, quote.periodStart, quote.periodEnd, id]
    );
    if (overlap.rowCount) throw badRequest(`This period overlaps invoice ${overlap.rows[0].invoice_no}`);
    await client.query(
      `UPDATE platform_invoices SET cycle=$1,period_start=$2,period_end=$3,doctors=$4,rate_year=$5,base_rate=$6,tier_label=$7,discount_pct=$8,rate=$9,months=$10,subtotal=$11,adjustment=$12,adjustment_reason=$13,
          gst_applicable=$14,gst_rate=$15,gst_amount=$16,gstin=$17,total=$18,due_date=$19,notes=$20,updated_at=NOW() WHERE id=$21`,
      [input.cycle, quote.periodStart, quote.periodEnd, quote.doctors, quote.rateYear, quote.baseRate, quote.tierLabel, quote.discountPct, quote.rate, quote.months, quote.subtotal, quote.adjustment,
        quote.adjustment > 0 ? input.adjustmentReason : null, quote.gstApplicable, quote.gstRate, quote.gstAmount, quote.gstApplicable ? hospital.gstin : null, quote.total, input.dueDate || addDays(todayString(), 14), input.notes || null, id]
    );
  }).catch(translateDuplicate);
  res.json(await invoiceDetail(id));
}));

router.post('/invoices/:id/issue', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  await withTransaction(async (client) => {
    const q = await client.query(
      `UPDATE platform_invoices SET status='ISSUED',issue_date=$2::date,due_date=COALESCE(due_date,$3::date),updated_at=NOW() WHERE id=$1 AND status='DRAFT' RETURNING invoice_no,hospital_id,total`,
      [id, todayString(), addDays(todayString(), 14)]
    );
    if (!q.rowCount) throw badRequest('Only a draft can be issued');
    await audit(client, req, 'INVOICE_ISSUED', q.rows[0].hospital_id, { invoiceNo: q.rows[0].invoice_no, total: num(q.rows[0].total) });
  });
  res.json(await invoiceDetail(id));
}));

router.post('/invoices/:id/pay', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = z.object({
    amount: z.coerce.number().positive(),
    paidOn: dateSchema,
    mode: z.enum(PAY_MODES),
    reference: z.string().trim().max(80).optional().default(''),
    note: z.string().trim().max(300).optional().default(''),
  }).parse(req.body);
  if (body.paidOn > todayString()) throw badRequest('The payment date cannot be in the future');
  await withTransaction(async (client) => {
    const cur = await client.query(`SELECT status,total,invoice_no,hospital_id FROM platform_invoices WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rowCount) throw notFound('Invoice not found');
    if (cur.rows[0].status !== 'ISSUED') throw badRequest('Only an issued invoice can be marked as paid');
    if (round2(body.amount) !== round2(cur.rows[0].total)) throw badRequest(`Enter the full invoice total (₹${Number(cur.rows[0].total).toLocaleString('en-IN')}). Part-payments are not supported yet.`);
    await client.query(
      `UPDATE platform_invoices SET status='PAID',paid_on=$2,paid_amount=$3,payment_mode=$4,payment_reference=$5,payment_note=$6,updated_at=NOW() WHERE id=$1`,
      [id, body.paidOn, round2(body.amount), body.mode, body.reference || null, body.note || null]
    );
    await audit(client, req, 'INVOICE_PAID', cur.rows[0].hospital_id, { invoiceNo: cur.rows[0].invoice_no, amount: round2(body.amount), mode: body.mode, reference: body.reference || null });
  });
  res.json(await invoiceDetail(id));
}));

router.post('/invoices/:id/cancel', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  await withTransaction(async (client) => {
    const q = await client.query(
      `UPDATE platform_invoices SET status='CANCELLED',cancel_reason=$2,updated_at=NOW() WHERE id=$1 AND status IN ('DRAFT','ISSUED') RETURNING invoice_no,hospital_id`,
      [id, reason]
    );
    if (!q.rowCount) throw badRequest('A paid invoice cannot be cancelled');
    await audit(client, req, 'INVOICE_CANCELLED', q.rows[0].hospital_id, { invoiceNo: q.rows[0].invoice_no, reason });
  });
  res.json(await invoiceDetail(id));
}));

// ---------- monthly generation ----------
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
async function monthlyRows(month) {
  const today = todayString();
  const plans = await loadPlans();
  const hospitals = (await hospitalsWithDoctors()).filter(h => h.is_active && h.billing_cycle === 'MONTHLY');
  const existing = await pool.query(`SELECT hospital_id,period_start::text AS period_start,invoice_no FROM platform_invoices WHERE status<>'CANCELLED' AND kind='PERIOD'`);
  const taken = new Map(existing.rows.map(r => [`${r.hospital_id}|${r.period_start}`, r.invoice_no]));
  const rows = [];
  for (const h of hospitals) {
    const day = Number(h.billing_start_date.slice(8, 10));
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const periodStart = `${month}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    if (periodStart < h.billing_start_date) continue;
    const base = { hospitalId: h.id, hospital: h.name, periodStart, gstApplicable: h.gst_applicable, doctors: h.doctors };
    const key = `${h.id}|${periodStart}`;
    if (taken.has(key)) { rows.push({ ...base, state: 'INVOICED', invoiceNo: taken.get(key) }); continue; }
    // Billed at the end of the month, for that month's doctors (active at month end + anyone who completed a consultation).
    const periodEnd = periodEndFor(periodStart, 1);
    const bill = await billableDoctors(pool, h.id, periodStart, periodEnd, today);
    base.doctors = bill.count; base.activeDoctors = bill.active; base.removedButConsulted = bill.removedButConsulted.map(d => d.name);
    if (bill.count < 1) { rows.push({ ...base, state: 'NO_DOCTORS' }); continue; }
    const q = buildQuote({ plans, startDate: h.billing_start_date, cycle: 'MONTHLY', periodStart, doctors: bill.count, gstApplicable: h.gst_applicable, gstRate: h.gst_rate ?? 18 });
    rows.push({ ...base, periodEnd: q.periodEnd, rate: q.rate, rateYear: q.rateYear, tierLabel: q.tierLabel, subtotal: q.subtotal, gstAmount: q.gstAmount, total: q.total, state: periodEnd < today ? 'READY' : 'UPCOMING', readyOn: addDays(periodEnd, 1) });
  }
  return rows;
}
router.get('/monthly-due', asyncHandler(async (req, res) => {
  const month = monthSchema.parse(req.query.month || todayString().slice(0, 7));
  res.json({ month, rows: await monthlyRows(month) });
}));
router.post('/invoices/generate-monthly', asyncHandler(async (req, res) => {
  const body = z.object({ month: monthSchema, hospitalIds: z.array(z.coerce.number().int().positive()).min(1), asDraft: z.boolean().default(false) }).parse(req.body);
  const rows = (await monthlyRows(body.month)).filter(r => body.hospitalIds.includes(Number(r.hospitalId)));
  const created = []; const skipped = [];
  for (const row of rows) {
    if (row.state !== 'READY') { skipped.push({ hospital: row.hospital, reason: row.state === 'INVOICED' ? `Already invoiced (${row.invoiceNo})` : row.state === 'UPCOMING' ? `The month is not over yet (ready on ${row.readyOn})` : 'No doctors to bill for that month' }); continue; }
    try {
      const made = await withTransaction(client => createInvoice(client, req, { hospitalId: row.hospitalId, cycle: 'MONTHLY', periodStart: row.periodStart, adjustment: 0, adjustmentReason: '', notes: '' }, body.asDraft ? 'DRAFT' : 'ISSUED'));
      created.push({ hospital: row.hospital, invoiceNo: made.invoiceNo, id: made.id, total: row.total });
    } catch (e) { skipped.push({ hospital: row.hospital, reason: e.message }); }
  }
  res.status(201).json({ created, skipped });
}));

// ---------- company details printed on invoices ----------
router.get('/company', asyncHandler(async (_req, res) => {
  const q = await pool.query(`SELECT name,address,gstin,payment_details,upi_id,upi_name,support_phone,support_email FROM platform_billing_company WHERE id=1`);
  const r = q.rows[0];
  res.json({ name: r.name, address: r.address || '', gstin: r.gstin || '', paymentDetails: r.payment_details || '', upiId: r.upi_id || '', upiName: r.upi_name || '', supportPhone: r.support_phone || '', supportEmail: r.support_email || '' });
}));
router.put('/company', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(160),
    address: z.string().trim().max(1000).optional().default(''),
    gstin: z.string().trim().toUpperCase().max(15).optional().default(''),
    paymentDetails: z.string().trim().max(1500).optional().default(''),
    upiId: z.string().trim().toLowerCase().max(100).optional().default(''),
    upiName: z.string().trim().max(60).optional().default(''),
    supportPhone: z.string().trim().max(30).optional().default(''),
    supportEmail: z.string().trim().toLowerCase().max(120).optional().default(''),
  }).parse(req.body);
  if (body.supportPhone && !/^[+\d][\d\s()-]{6,28}$/.test(body.supportPhone)) throw badRequest('Enter a valid support phone number');
  if (body.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.supportEmail)) throw badRequest('Enter a valid support email address');
  if (body.upiId && !UPI_ID.test(body.upiId)) throw badRequest('Enter a valid UPI ID such as name@bank or 9876543210@ybl');
  if (body.upiId && body.upiName.length < 2) throw badRequest('Add the name shown to the payer when they scan (your business name)');
  if (body.gstin && !GSTIN.test(body.gstin)) throw badRequest('Enter a valid 15-character GSTIN, or leave it empty');
  await withTransaction(async (client) => {
    await client.query(`UPDATE platform_billing_company SET name=$1,address=$2,gstin=$3,payment_details=$4,upi_id=$6,upi_name=$7,support_phone=$8,support_email=$9,updated_at=NOW(),updated_by=$5 WHERE id=1`, [body.name, body.address || null, body.gstin || null, body.paymentDetails || null, req.user.id, body.upiId || null, body.upiName || null, body.supportPhone || null, body.supportEmail || null]);
    await audit(client, req, 'COMPANY_DETAILS_UPDATED', null, {});
  });
  res.json(body);
}));

export default router;
