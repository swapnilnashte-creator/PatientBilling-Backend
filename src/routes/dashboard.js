import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { asyncHandler, badRequest } from '../utils.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const allTime = String(req.query.allTime || '') === '1';
  const dateFrom = req.query.dateFrom ? z.string().date().parse(String(req.query.dateFrom)) : null;
  const dateTo = req.query.dateTo ? z.string().date().parse(String(req.query.dateTo)) : null;
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest('From date cannot be after To date');

  const addDateRange = (where, params, column) => {
    if (allTime) return where;
    if (!dateFrom && !dateTo) return `${where} AND ${column} >= date_trunc('day',NOW()) AND ${column} < date_trunc('day',NOW()) + INTERVAL '1 day'`;
    if (dateFrom) { params.push(dateFrom); where += ` AND ${column} >= $${params.length}::date`; }
    if (dateTo) { params.push(dateTo); where += ` AND ${column} < ($${params.length}::date + INTERVAL '1 day')`; }
    return where;
  };

  const params = [req.user.hospitalId];
  let visitWhere = 'hospital_id=$1';
  if (req.user.role === 'DOCTOR') {
    params.push(req.user.id);
    visitWhere += ` AND doctor_id=$2`;
  }
  visitWhere = addDateRange(visitWhere, params, 'created_at');
  const q = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE status='WAITING_FOR_DOCTOR')::int AS waiting,
      COUNT(*) FILTER (WHERE status='WITH_DOCTOR')::int AS with_doctor,
      COUNT(*) FILTER (WHERE status='PAYMENT_PENDING')::int AS payment_pending,
      COUNT(*) FILTER (WHERE status='LEFT_BEFORE_DOCTOR')::int AS left_before_doctor,
      COUNT(*) FILTER (WHERE status='LEFT_WITHOUT_PAYMENT')::int AS left_without_payment,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE status='CANCELLED')::int AS cancelled
     FROM visits
     WHERE ${visitWhere}`,
    params
  );

  const revenueParams = [req.user.hospitalId];
  let revenueFrom = 'payments p';
  let revenueWhere = 'p.hospital_id=$1';
  if (req.user.role === 'DOCTOR') {
    revenueParams.push(req.user.id);
    revenueFrom += ' JOIN visits v ON v.id=p.visit_id AND v.hospital_id=p.hospital_id';
    revenueWhere += ' AND v.doctor_id=$2';
  }
  revenueWhere = addDateRange(revenueWhere, revenueParams, 'p.paid_at');
  const revenue = await pool.query(
    `SELECT COALESCE(SUM(p.amount),0)::numeric(12,2) AS revenue FROM ${revenueFrom} WHERE ${revenueWhere}`,
    revenueParams
  );
  let completed = q.rows[0].completed;
  if (req.user.role === 'DOCTOR') {
    const completedParams = [req.user.hospitalId, req.user.id];
    let completedWhere = 'vd.hospital_id=$1 AND vd.doctor_id=$2 AND vd.status=\'COMPLETED\'';
    completedWhere = addDateRange(completedWhere, completedParams, 'vd.completed_at');
    const completedQ = await pool.query(
      `SELECT COUNT(*)::int AS completed
       FROM visit_doctors vd
       WHERE ${completedWhere}`,
      completedParams
    );
    completed = completedQ.rows[0].completed;
  }
  const result = { ...q.rows[0], completed, revenue: revenue.rows[0].revenue, todayRevenue: revenue.rows[0].revenue };
  // Admin only: what was spent in the same period (recorded expenses plus DhaCare subscription invoices once paid, as on the
  // Expenses page) and what is left after those costs
  if (req.user.role === 'ADMIN') {
    const from = allTime ? null : (dateFrom || (dateTo ? null : 'today'));
    const to = allTime ? null : (dateTo || (dateFrom ? null : 'today'));
    const range = (column) => {
      const p = []; let w = '';
      if (from === 'today') w += ` AND ${column}=CURRENT_DATE`;
      else if (from) { p.push(from); w += ` AND ${column}>=$${p.length + 1}::date`; }
      if (to && to !== 'today') { p.push(to); w += ` AND ${column}<=$${p.length + 1}::date`; }
      return { p, w };
    };
    const e = range('expense_date'); const i = range('paid_on');
    const [spent, subs] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS v FROM expenses WHERE hospital_id=$1 AND deleted_at IS NULL${e.w}`, [req.user.hospitalId, ...e.p]),
      pool.query(`SELECT COALESCE(SUM(COALESCE(paid_amount,total)),0)::numeric(14,2) AS v FROM platform_invoices WHERE hospital_id=$1 AND status='PAID' AND paid_on IS NOT NULL${i.w}`, [req.user.hospitalId, ...i.p]),
    ]);
    result.expenses = Math.round((Number(spent.rows[0].v) + Number(subs.rows[0].v)) * 100) / 100;
    result.net = Math.round((Number(revenue.rows[0].revenue) - result.expenses) * 100) / 100;
  }
  res.json(result);
}));

export default router;
