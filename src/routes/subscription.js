import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { addMonths, buildQuote, currentPeriodStart, round2, todayString } from '../billing/pricing.js';
import { hospitalsWithDoctors, invoiceDetail, invoiceJson, invoiceSelect, loadPlans } from './superAdminBilling.js';
import { currentMessageRate } from '../billing/messages.js';
import { whatsappPlatformOn } from '../whatsappApi.js';
import { effectiveReminders, forgetReminderDays, reminderDefaults, remindersToStore, timesSchema } from '../whatsappReminders.js';

// WhatsApp messages DhaCare sent for the hospital through the Meta API: on or off, the price, what waits for the next invoice,
// what has been billed, and the last 6 months. Null when messages were never switched on and none were ever sent.
async function whatsappBilling(hospitalId, invoices) {
  const [h, waiting, months] = await Promise.all([
    pool.query(`SELECT h.whatsapp_reminders,h.whatsapp_api_enabled,h.whatsapp_api_changed_at,h.whatsapp_api_hospital_on,h.whatsapp_api_hospital_changed_at,u.name AS hospital_changed_by
                FROM hospitals h LEFT JOIN users u ON u.hospital_id=h.id AND u.id=h.whatsapp_api_hospital_changed_by WHERE h.id=$1`, [hospitalId]),
    pool.query(`SELECT COUNT(*)::int AS n,COALESCE(SUM(rate),0)::float8 AS amount,MIN(sent_at) AS since FROM whatsapp_messages WHERE hospital_id=$1 AND status<>'FAILED' AND invoice_id IS NULL`, [hospitalId]),
    pool.query(
      `SELECT to_char(sent_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS month,
              COUNT(*) FILTER (WHERE status<>'FAILED')::int AS sent, COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
              COALESCE(SUM(rate) FILTER (WHERE status<>'FAILED'),0)::float8 AS amount,
              COUNT(*) FILTER (WHERE status<>'FAILED' AND invoice_id IS NOT NULL)::int AS billed
       FROM whatsapp_messages WHERE hospital_id=$1 AND sent_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '5 months'
       GROUP BY 1 ORDER BY 1 DESC`, [hospitalId]),
  ]);
  const row = h.rows[0] || {};
  const defaults = await reminderDefaults();
  const allowed = Boolean(row.whatsapp_api_enabled);         // DhaCare lets this hospital use it
  const own = row.whatsapp_api_hospital_on !== false;       // the hospital's own switch
  const paused = !(await whatsappPlatformOn());              // DhaCare has paused all messages (Super Admin, for every hospital)
  const on = allowed && own && !paused;                      // messages are sent only when both are on and nothing is paused
  const billedInvoices = invoices.filter(i => i.status !== 'CANCELLED' && i.messagesCount > 0);
  // hidden only for a clinic DhaCare never switched on (once switched, the clinic keeps seeing where it stands, even when off)
  if (!allowed && !row.whatsapp_api_changed_at && !months.rowCount && !waiting.rows[0].n && !billedInvoices.length) return null;
  return {
    enabled: on, allowed, hospitalOn: own, paused, since: allowed ? row.whatsapp_api_changed_at : null,
    hospitalChangedAt: row.whatsapp_api_hospital_changed_at, hospitalChangedBy: row.hospital_changed_by || null, rate: await currentMessageRate(),
    waiting: { count: waiting.rows[0].n, amount: round2(waiting.rows[0].amount), since: waiting.rows[0].since },
    billed: { count: billedInvoices.reduce((n, i) => n + i.messagesCount, 0), amount: round2(billedInvoices.reduce((n, i) => n + i.messagesAmount, 0)), invoices: billedInvoices.length },
    reminders: effectiveReminders(row.whatsapp_reminders, defaults), reminderDefaults: defaults,
    months: months.rows.map(m => ({ month: m.month, sent: m.sent, failed: m.failed, amount: round2(m.amount), billed: m.billed })),
  };
}

// Hospital Admin → their DhaCare subscription: current plan and the invoices the platform has issued to them.
// Drafts stay private to the Super Admin until issued; internal notes are never sent.
const router = Router();
router.use(allow('ADMIN'));

const forHospital = ({ notes, paymentNote, ...invoice }) => invoice;

router.get('/', asyncHandler(async (req, res) => {
  const today = todayString();
  const [hospital] = await hospitalsWithDoctors(req.user.hospitalId);
  if (!hospital) throw notFound('Hospital not found');
  const [plans, invoices, company] = await Promise.all([
    loadPlans(),
    pool.query(`${invoiceSelect} WHERE i.hospital_id=$1 AND i.status<>'DRAFT' ORDER BY i.period_start DESC,i.id DESC`, [req.user.hospitalId]),
    pool.query(`SELECT name,address,gstin,payment_details,upi_id,upi_name,support_phone,support_email FROM platform_billing_company WHERE id=1`),
  ]);

  let plan = null;
  if (hospital.doctors >= 1) {
    const periodStart = currentPeriodStart(hospital.billing_start_date, hospital.billing_cycle, today);
    const quote = buildQuote({ plans, startDate: hospital.billing_start_date, cycle: hospital.billing_cycle, periodStart, doctors: hospital.doctors, gstApplicable: hospital.gst_applicable, gstRate: hospital.gst_rate ?? 18 });
    const nextFrom = quote.rateYear === 1 ? quote.year2From : addMonths(periodStart, quote.months);
    const next = buildQuote({ plans, startDate: hospital.billing_start_date, cycle: hospital.billing_cycle, periodStart: nextFrom, doctors: hospital.doctors });
    plan = {
      periodStart: quote.periodStart, periodEnd: quote.periodEnd, rate: quote.rate, rateYear: quote.rateYear, tierLabel: quote.tierLabel, discountPct: quote.discountPct,
      baseRate: quote.baseRate, monthly: round2(quote.rate * hospital.doctors), lockEnds: quote.lockEnds,
      next: { from: nextFrom, rate: next.rate, rateYear: next.rateYear },
    };
  }

  const rows = invoices.rows.map(row => forHospital(invoiceJson(row, today)));
  const open = rows.filter(r => r.status === 'ISSUED');
  const co = company.rows[0] || {};
  res.json({
    today,
    hospital: { name: hospital.name, billingStartDate: hospital.billing_start_date, cycle: hospital.billing_cycle, doctors: hospital.doctors, freeDoctors: hospital.free_doctors, gstApplicable: hospital.gst_applicable, gstRate: hospital.gst_rate, gstin: hospital.gstin },
    plan,
    totals: {
      outstanding: round2(open.reduce((sum, r) => sum + r.total, 0)), outstandingCount: open.length,
      overdueCount: open.filter(r => r.displayStatus === 'Overdue').length,
      paid: round2(rows.filter(r => r.status === 'PAID').reduce((sum, r) => sum + r.total, 0)),
      nextDue: open.map(r => r.dueDate).filter(Boolean).sort()[0] || null,
    },
    company: { name: co.name, address: co.address, gstin: co.gstin, paymentDetails: co.payment_details, upiId: co.upi_id, upiName: co.upi_name, supportPhone: co.support_phone, supportEmail: co.support_email },
    invoices: rows,
    whatsapp: await whatsappBilling(req.user.hospitalId, rows),
  });
}));

// The hospital's own switch for WhatsApp messages through Meta. Works only while DhaCare allows them for the hospital:
// when DhaCare has switched them off, nothing is sent and this switch cannot turn them on.
router.put('/whatsapp', asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const q = await pool.query(`SELECT whatsapp_api_enabled FROM hospitals WHERE id=$1`, [req.user.hospitalId]);
  if (!q.rows[0]?.whatsapp_api_enabled) throw badRequest('WhatsApp messages are switched off by DhaCare for your clinic. Please contact DhaCare to use them.');
  await pool.query(
    `UPDATE hospitals SET whatsapp_api_hospital_on=$2,whatsapp_api_hospital_changed_at=NOW(),whatsapp_api_hospital_changed_by=$3,updated_at=NOW() WHERE id=$1`,
    [req.user.hospitalId, enabled, req.user.id]);
  const invoices = (await pool.query(`${invoiceSelect} WHERE i.hospital_id=$1 AND i.status<>'DRAFT'`, [req.user.hospitalId])).rows.map(r => invoiceJson(r, todayString()));
  res.json(await whatsappBilling(req.user.hospitalId, invoices));
}));

// The hospital's own reminder times, and each reminder on or off. Times equal to DhaCare's defaults are not kept, so later default changes apply.
const dayChoice = z.object({ on: z.boolean(), days: z.number().int(), hour: z.number().int() });
router.put('/whatsapp/reminders', asyncHandler(async (req, res) => {
  const d = z.object({ appointment: z.object({ on: z.boolean(), hours: z.number().int() }), followUp: dayChoice, vaccination: dayChoice }).parse(req.body);
  const times = timesSchema.safeParse(d);
  if (!times.success) throw badRequest('Choose 1 hour to 7 days before an appointment, and 0 to 14 days before, between 7 AM and 8 PM, for the other reminders.');
  const stored = remindersToStore(d, await reminderDefaults());
  await pool.query(`UPDATE hospitals SET whatsapp_reminders=$2,updated_at=NOW() WHERE id=$1`, [req.user.hospitalId, stored ? JSON.stringify(stored) : null]);
  forgetReminderDays(Number(req.user.hospitalId)); // the next check looks at this hospital's lists again today
  const invoices = (await pool.query(`${invoiceSelect} WHERE i.hospital_id=$1 AND i.status<>'DRAFT'`, [req.user.hospitalId])).rows.map(r => invoiceJson(r, todayString()));
  res.json(await whatsappBilling(req.user.hospitalId, invoices));
}));

router.get('/invoices/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const invoice = await invoiceDetail(id).catch(() => null);
  if (!invoice || String(invoice.hospitalId) !== String(req.user.hospitalId) || invoice.status === 'DRAFT') throw notFound('Invoice not found');
  res.json(forHospital(invoice));
}));

export default router;
