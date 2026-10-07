import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils.js';
import { addMonths, buildQuote, currentPeriodStart, round2, todayString } from '../billing/pricing.js';
import { hospitalsWithDoctors, invoiceDetail, invoiceJson, invoiceSelect, loadPlans } from './superAdminBilling.js';

// Hospital Admin → their CareBill subscription: current plan and the invoices the platform has issued to them.
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
    hospital: { name: hospital.name, billingStartDate: hospital.billing_start_date, cycle: hospital.billing_cycle, doctors: hospital.doctors, gstApplicable: hospital.gst_applicable, gstRate: hospital.gst_rate, gstin: hospital.gstin },
    plan,
    totals: {
      outstanding: round2(open.reduce((sum, r) => sum + r.total, 0)), outstandingCount: open.length,
      overdueCount: open.filter(r => r.displayStatus === 'Overdue').length,
      paid: round2(rows.filter(r => r.status === 'PAID').reduce((sum, r) => sum + r.total, 0)),
      nextDue: open.map(r => r.dueDate).filter(Boolean).sort()[0] || null,
    },
    company: { name: co.name, address: co.address, gstin: co.gstin, paymentDetails: co.payment_details, upiId: co.upi_id, upiName: co.upi_name, supportPhone: co.support_phone, supportEmail: co.support_email },
    invoices: rows,
  });
}));

router.get('/invoices/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const invoice = await invoiceDetail(id).catch(() => null);
  if (!invoice || String(invoice.hospitalId) !== String(req.user.hospitalId) || invoice.status === 'DRAFT') throw notFound('Invoice not found');
  res.json(forHospital(invoice));
}));

export default router;
