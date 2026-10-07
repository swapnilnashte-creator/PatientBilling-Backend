import { addDays, buildQuote, buildTopUp, currentPeriodStart, cycleMonths, periodEndFor, round2, todayString } from './pricing.js';

// Doctor-based platform billing (database side).
//  - billableDoctors: who a clinic is billed for in a period (active at the end of it, or completed a consultation in it)
//  - annualCap / doctorImpact / autoTopUp: annual clinics adding doctors beyond what the year was billed for

const IST = `'Asia/Kolkata'`;
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function plansOf(client) {
  return (await client.query(`SELECT id,year1_base,year2_base,effective_from::text AS effective_from,apply_to_existing,cancelled_at FROM platform_rate_plans`)).rows;
}

/** Doctors a clinic is billed for in [periodStart, periodEnd]:
 *  everyone active when the period ended (or today, if it is still running) PLUS any doctor who completed
 *  a consultation in the period even if they were removed before it ended. */
export async function billableDoctors(client, hospitalId, periodStart, periodEnd, today = todayString()) {
  const asOf = periodEnd < today ? periodEnd : today;
  const q = await client.query(
    `SELECT u.id,u.name,
            COALESCE((SELECT e.active FROM doctor_status_events e WHERE e.user_id=u.id AND (e.at AT TIME ZONE ${IST})::date <= $4::date ORDER BY e.at DESC,e.id DESC LIMIT 1),FALSE) AS active_at_end,
            EXISTS (SELECT 1 FROM visit_doctors vd WHERE vd.hospital_id=u.hospital_id AND vd.doctor_id=u.id AND vd.status='COMPLETED'
                      AND (vd.completed_at AT TIME ZONE ${IST})::date BETWEEN $2::date AND $3::date) AS consulted
     FROM users u WHERE u.hospital_id=$1 AND u.role='DOCTOR' ORDER BY u.name`,
    [hospitalId, periodStart, periodEnd, asOf]
  );
  const counted = q.rows.filter(r => r.active_at_end || r.consulted);
  return {
    count: counted.length,
    active: counted.filter(r => r.active_at_end).length,
    removedButConsulted: counted.filter(r => !r.active_at_end).map(r => ({ id: r.id, name: r.name })),
    doctors: counted.map(r => ({ id: r.id, name: r.name, active: r.active_at_end, consulted: r.consulted })),
  };
}

const activeCount = async (client, hospitalId) =>
  Number((await client.query(`SELECT COUNT(*)::int AS n FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL`, [hospitalId])).rows[0].n);

async function hospitalFor(client, hospitalId, lock = false) {
  const q = await client.query(
    `SELECT h.id,h.name,h.billing_start_date::text AS start_date,h.billing_cycle,h.gst_applicable,h.gst_rate,h.gstin,h.is_active,
            (SELECT gstin IS NOT NULL AND gstin<>'' FROM platform_billing_company WHERE id=1) AS company_gst
     FROM hospitals h WHERE h.id=$1 ${lock ? 'FOR UPDATE OF h' : ''}`,
    [hospitalId]
  );
  const h = q.rows[0];
  if (!h) return null;
  return { ...h, gst_effective: Boolean(h.gst_applicable && h.company_gst), gst_rate: num(h.gst_rate) ?? 18 };
}

/** The annual period running today and what it has been billed for so far (period invoice + any top-ups). */
export async function annualCap(client, hospitalId, today = todayString()) {
  const q = await client.query(
    `SELECT id,kind,doctors,rate,period_start::text AS period_start,period_end::text AS period_end,parent_id
     FROM platform_invoices
     WHERE hospital_id=$1 AND cycle='ANNUAL' AND status IN ('ISSUED','PAID') AND period_start<=$2::date AND period_end>=$2::date
     ORDER BY (kind='PERIOD') DESC, period_start DESC, id DESC`,
    [hospitalId, today]
  );
  const period = q.rows.find(r => r.kind === 'PERIOD');
  if (!period) return null;
  const chain = [period, ...q.rows.filter(r => r.kind === 'TOPUP' && String(r.parent_id) === String(period.id))].sort((a, b) => Number(a.id) - Number(b.id));
  const latest = chain[chain.length - 1];
  return { periodId: period.id, periodStart: period.period_start, periodEnd: period.period_end, cap: Math.max(...chain.map(r => Number(r.doctors))), rate: num(latest.rate) };
}

/** What happens to the bill if one more doctor becomes active. `candidateId` = an existing (deactivated) doctor being re-activated. */
export async function doctorImpact(client, hospitalId, { candidateId = null, today = todayString() } = {}) {
  const h = await hospitalFor(client, hospitalId);
  if (!h) return { mode: 'NONE', requiresConfirm: false };
  const plans = await plansOf(client);
  const active = await activeCount(client, hospitalId);
  const gst = { gstApplicable: h.gst_effective, gstRate: h.gst_rate };

  if (h.billing_cycle === 'ANNUAL') {
    const cap = await annualCap(client, hospitalId, today);
    if (!cap) return { mode: 'NONE', requiresConfirm: false, cycle: 'ANNUAL', reason: 'no-current-invoice' };
    const after = active + 1;
    if (after <= cap.cap) return { mode: 'NONE', requiresConfirm: false, cycle: 'ANNUAL', withinCap: true, cap: cap.cap, active, after };
    const topUp = buildTopUp({ plans, startDate: h.start_date, periodStart: cap.periodStart, periodEnd: cap.periodEnd, from: today, prevDoctors: cap.cap, prevRate: cap.rate, newDoctors: after, ...gst });
    return { mode: 'TOPUP', requiresConfirm: true, cycle: 'ANNUAL', cap: cap.cap, active, after, rateBefore: cap.rate, rateAfter: topUp.rate, tierAfter: topUp.tierLabel, periodEnd: cap.periodEnd, topUp };
  }

  // MONTHLY: billed at month end for the doctors of that month
  const periodStart = currentPeriodStart(h.start_date, 'MONTHLY', today);
  const periodEnd = periodEndFor(periodStart, cycleMonths('MONTHLY'));
  const now = await billableDoctors(client, hospitalId, periodStart, periodEnd, today);
  if (candidateId && now.doctors.some(d => String(d.id) === String(candidateId))) return { mode: 'NONE', requiresConfirm: false, cycle: 'MONTHLY', alreadyCounted: true };
  const before = now.count; const after = before + 1;
  const quote = (n) => (n >= 1 ? buildQuote({ plans, startDate: h.start_date, cycle: 'MONTHLY', periodStart, doctors: n, ...gst }) : null);
  const qb = quote(before); const qa = quote(after);
  return {
    mode: 'MONTHLY', requiresConfirm: true, cycle: 'MONTHLY', before, after, periodStart, periodEnd,
    rateBefore: qb?.rate ?? null, rateAfter: qa.rate, tierAfter: qa.tierLabel,
    monthlyBefore: qb ? round2(qb.subtotal) : 0, monthlyAfter: round2(qa.subtotal), gstApplicable: h.gst_effective, gstRate: h.gst_rate,
    totalAfter: qa.total,
  };
}

/** Called in the same transaction that activates a doctor. Bills the annual top-up right away when the cap is exceeded. */
export async function autoTopUp(client, hospitalId, today = todayString()) {
  const h = await hospitalFor(client, hospitalId, true);
  if (!h || h.billing_cycle !== 'ANNUAL') return null;
  const cap = await annualCap(client, hospitalId, today);
  if (!cap) return null;
  const active = await activeCount(client, hospitalId);
  if (active <= cap.cap) return null;
  const plans = await plansOf(client);
  const t = buildTopUp({ plans, startDate: h.start_date, periodStart: cap.periodStart, periodEnd: cap.periodEnd, from: today, prevDoctors: cap.cap, prevRate: cap.rate, newDoctors: active, gstApplicable: h.gst_effective, gstRate: h.gst_rate });
  if (t.subtotal <= 0) return null;
  const no = await client.query(`SELECT nextval('platform_invoice_no_seq') AS n`);
  const invoiceNo = `CB-${today.slice(0, 4)}-${String(no.rows[0].n).padStart(4, '0')}`;
  const ins = await client.query(
    `INSERT INTO platform_invoices(invoice_no,hospital_id,cycle,kind,parent_id,period_start,period_end,doctors,rate_year,base_rate,tier_label,discount_pct,rate,months,subtotal,adjustment,
        gst_applicable,gst_rate,gst_amount,gstin,total,status,issue_date,due_date,notes,prev_doctors,prev_rate,prorate_days,period_days)
     VALUES($1,$2,'ANNUAL','TOPUP',$3,$4,$5,$6,$7,$8,$9,$10,$11,12,$12,0,$13,$14,$15,$16,$17,'ISSUED',$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
    [invoiceNo, hospitalId, cap.periodId, today, cap.periodEnd, t.doctors, t.rateYear, t.baseRate, t.tierLabel, t.discountPct, t.rate, t.subtotal, t.gstApplicable, t.gstRate, t.gstAmount,
      t.gstApplicable ? h.gstin : null, t.total, today, addDays(today, 14), `Automatic top-up: ${t.prevDoctors} → ${t.doctors} doctors`, t.prevDoctors, t.prevRate, t.remainingDays, t.periodDays]
  );
  return { id: ins.rows[0].id, invoiceNo, ...t };
}

/** What happens to the bill if an active doctor is deactivated. Annual clinics keep what they were billed for;
 *  monthly clinics stop being charged for the doctor unless they completed a consultation this month. */
export async function deactivationImpact(client, hospitalId, doctorId, today = todayString()) {
  const h = await hospitalFor(client, hospitalId);
  if (!h) return { mode: 'NONE', requiresConfirm: false };
  const plans = await plansOf(client);
  const gst = { gstApplicable: h.gst_effective, gstRate: h.gst_rate };
  if (h.billing_cycle === 'ANNUAL') {
    const cap = await annualCap(client, hospitalId, today);
    if (!cap) return { mode: 'NONE', requiresConfirm: false, cycle: 'ANNUAL' };
    const active = await activeCount(client, hospitalId);
    return { mode: 'REMOVE_ANNUAL', requiresConfirm: true, cycle: 'ANNUAL', cap: cap.cap, active, after: active - 1, periodEnd: cap.periodEnd, rate: cap.rate };
  }
  const periodStart = currentPeriodStart(h.start_date, 'MONTHLY', today);
  const periodEnd = periodEndFor(periodStart, cycleMonths('MONTHLY'));
  const now = await billableDoctors(client, hospitalId, periodStart, periodEnd, today);
  const me = now.doctors.find(d => String(d.id) === String(doctorId));
  if (!me) return { mode: 'NONE', requiresConfirm: false, cycle: 'MONTHLY' };
  const stillCharged = Boolean(me.consulted);
  const before = now.count; const after = stillCharged ? before : before - 1;
  const quote = (n) => (n >= 1 ? buildQuote({ plans, startDate: h.start_date, cycle: 'MONTHLY', periodStart, doctors: n, ...gst }) : null);
  const qb = quote(before); const qa = quote(after);
  return {
    mode: 'REMOVE_MONTHLY', requiresConfirm: true, cycle: 'MONTHLY', stillCharged, before, after, periodStart, periodEnd,
    rateBefore: qb?.rate ?? null, rateAfter: qa?.rate ?? null, tierAfter: qa?.tierLabel ?? null,
    monthlyBefore: qb ? round2(qb.subtotal) : 0, monthlyAfter: qa ? round2(qa.subtotal) : 0, gstApplicable: h.gst_effective, gstRate: h.gst_rate,
  };
}
