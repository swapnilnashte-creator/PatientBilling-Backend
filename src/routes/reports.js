import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest } from '../utils.js';

const router = Router();
router.use(allow('ADMIN','RECEPTIONIST'));

router.get('/doctors/:doctorId/visits', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const allTime = String(req.query.allTime || '') === '1';
  const dateFrom = allTime ? null : z.string().date().parse(String(req.query.dateFrom || today));
  const dateTo = allTime ? null : z.string().date().parse(String(req.query.dateTo || today));
  const doctorId = z.coerce.number().int().positive().parse(req.params.doctorId);
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest('From date cannot be after To date');

  const doctorQ = await pool.query(
    `SELECT id,name FROM users
     WHERE id=$1 AND hospital_id=$2 AND role='DOCTOR' AND deleted_at IS NULL`,
    [doctorId, req.user.hospitalId]
  );
  if (!doctorQ.rowCount) throw badRequest('Doctor not found');

  const q = await pool.query(
    `SELECT v.id,v.visit_number,p.full_name,p.mobile,vd.completed_at AS consultation_date,
            CASE
              WHEN pay.id IS NOT NULL THEN 'PAID'
              WHEN v.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT') THEN 'UNPAID'
              ELSE 'NOT_FINALIZED'
            END AS payment_status,
            COALESCE(SUM(vc.amount),0)::numeric(14,2) AS amount
     FROM visit_doctors vd
     JOIN visits v ON v.id=vd.visit_id AND v.hospital_id=vd.hospital_id
     JOIN patients p ON p.id=v.patient_id AND p.hospital_id=v.hospital_id
     LEFT JOIN visit_charges vc ON vc.hospital_id=vd.hospital_id AND vc.visit_id=vd.visit_id AND vc.doctor_id=vd.doctor_id
     LEFT JOIN payments pay ON pay.hospital_id=v.hospital_id AND pay.visit_id=v.id
     WHERE vd.hospital_id=$1 AND vd.doctor_id=$2 AND vd.status='COMPLETED'
       AND ($3::date IS NULL OR vd.completed_at >= $3::date)
       AND ($4::date IS NULL OR vd.completed_at < $4::date + INTERVAL '1 day')
     GROUP BY v.id,v.visit_number,p.id,p.full_name,p.mobile,vd.completed_at,pay.id
     ORDER BY vd.completed_at DESC,v.id DESC`,
    [req.user.hospitalId, doctorId, dateFrom, dateTo]
  );
  res.json({ doctor: doctorQ.rows[0], visits: q.rows, range: { dateFrom, dateTo, allTime } });
}));

router.get('/', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const allTime = String(req.query.allTime || '') === '1';
  const dateFrom = allTime ? null : z.string().date().parse(String(req.query.dateFrom || today));
  const dateTo = allTime ? null : z.string().date().parse(String(req.query.dateTo || today));
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest('From date cannot be after To date');
  const params = [req.user.hospitalId, dateFrom, dateTo];
  const inRange = column => `($2::date IS NULL OR ${column} >= $2::date) AND ($3::date IS NULL OR ${column} < $3::date + INTERVAL '1 day')`;

  const [summaryQ, doctorsQ, incomeQ, modesQ, patientsQ, statusesQ] = await Promise.all([
    pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=$1 AND ${inRange('v.created_at')}) AS visits,
        (SELECT COUNT(DISTINCT v.patient_id)::int FROM visits v WHERE v.hospital_id=$1 AND ${inRange('v.created_at')}) AS patients,
        (SELECT COUNT(*)::int FROM patients p WHERE p.hospital_id=$1 AND p.deleted_at IS NULL AND ${inRange('p.created_at')}) AS new_patients,
        (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=$1 AND v.status='COMPLETED' AND ${inRange('v.completed_at')}) AS completed,
        (SELECT COUNT(*)::int FROM visit_doctors vd WHERE vd.hospital_id=$1 AND vd.status='COMPLETED' AND ${inRange('vd.completed_at')}) AS consultations,
        (SELECT COALESCE(SUM(p.amount),0)::numeric(14,2) FROM payments p WHERE p.hospital_id=$1 AND ${inRange('p.paid_at')}) AS income,
        (SELECT COALESCE(AVG(p.amount),0)::numeric(14,2) FROM payments p WHERE p.hospital_id=$1 AND ${inRange('p.paid_at')}) AS average_payment,
        (SELECT COALESCE(SUM(vc.amount),0)::numeric(14,2)
         FROM visits v JOIN visit_charges vc ON vc.hospital_id=v.hospital_id AND vc.visit_id=v.id
         WHERE v.hospital_id=$1 AND v.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT') AND ${inRange('v.created_at')}) AS outstanding,
        (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=$1 AND v.status='LEFT_WITHOUT_PAYMENT' AND ${inRange('v.left_at')}) AS left_without_payment,
        (SELECT COUNT(*)::int FROM visit_doctors vd WHERE vd.hospital_id=$1 AND vd.status='SKIPPED' AND ${inRange('vd.skipped_at')}) AS skipped_consultations`,
      params
    ),
    pool.query(
      `SELECT u.id,u.name,
        (SELECT COUNT(*)::int FROM visit_doctors vd WHERE vd.hospital_id=u.hospital_id AND vd.doctor_id=u.id AND vd.status='COMPLETED' AND ${inRange('vd.completed_at')}) AS consultations,
        (SELECT COUNT(DISTINCT v.patient_id)::int FROM visit_doctors vd JOIN visits v ON v.id=vd.visit_id AND v.hospital_id=vd.hospital_id WHERE vd.hospital_id=u.hospital_id AND vd.doctor_id=u.id AND vd.status='COMPLETED' AND ${inRange('vd.completed_at')}) AS patients,
        (SELECT COALESCE(SUM(vc.amount),0)::numeric(14,2) FROM visit_charges vc WHERE vc.hospital_id=u.hospital_id AND vc.doctor_id=u.id AND ${inRange('vc.created_at')}) AS billed_amount,
        (SELECT COALESCE(SUM(pds.amount),0)::numeric(14,2) FROM payment_doctor_settlements pds WHERE pds.hospital_id=u.hospital_id AND pds.doctor_id=u.id AND ${inRange('pds.settled_at')}) AS settled_amount,
        (SELECT COUNT(*)::int FROM visit_doctors vd WHERE vd.hospital_id=u.hospital_id AND vd.doctor_id=u.id AND vd.status='SKIPPED' AND ${inRange('vd.skipped_at')}) AS skipped
       FROM users u
       WHERE u.hospital_id=$1 AND u.role='DOCTOR' AND u.deleted_at IS NULL
       ORDER BY u.name`,
      params
    ),
    pool.query(
      `SELECT p.paid_at::date AS date,COUNT(*)::int AS payments,
              COALESCE(SUM(p.amount),0)::numeric(14,2) AS total,
              COALESCE(SUM(p.amount) FILTER (WHERE p.payment_mode='CASH'),0)::numeric(14,2) AS cash,
              COALESCE(SUM(p.amount) FILTER (WHERE p.payment_mode='UPI'),0)::numeric(14,2) AS upi,
              COALESCE(SUM(p.amount) FILTER (WHERE p.payment_mode='CARD'),0)::numeric(14,2) AS card,
              COALESCE(SUM(p.amount) FILTER (WHERE p.payment_mode='OTHER'),0)::numeric(14,2) AS other
       FROM payments p WHERE p.hospital_id=$1 AND ${inRange('p.paid_at')}
       GROUP BY p.paid_at::date ORDER BY date DESC`,
      params
    ),
    pool.query(
      `SELECT p.payment_mode,COUNT(*)::int AS payments,COALESCE(SUM(p.amount),0)::numeric(14,2) AS amount
       FROM payments p WHERE p.hospital_id=$1 AND ${inRange('p.paid_at')}
       GROUP BY p.payment_mode ORDER BY amount DESC`,
      params
    ),
    pool.query(
      `WITH scoped AS (
         SELECT v.id,v.patient_id,v.visit_number,v.created_at,v.status
         FROM visits v WHERE v.hospital_id=$1 AND ${inRange('v.created_at')}
       ), charge_totals AS (
         SELECT vc.visit_id,SUM(vc.amount)::numeric(14,2) amount
         FROM visit_charges vc WHERE vc.hospital_id=$1 GROUP BY vc.visit_id
       ), payment_totals AS (
         SELECT pay.visit_id,SUM(pay.amount)::numeric(14,2) amount
         FROM payments pay WHERE pay.hospital_id=$1 GROUP BY pay.visit_id
       )
       SELECT p.id,p.full_name,p.mobile,COUNT(s.id)::int AS visits,
              (${inRange('p.created_at')}) AS is_new,
              (ARRAY_AGG(s.visit_number ORDER BY s.created_at DESC))[1] AS last_visit_number,
              MAX(s.created_at) AS last_visit_at,
              COALESCE(SUM(ct.amount),0)::numeric(14,2) AS billed_amount,
              COALESCE(SUM(pt.amount),0)::numeric(14,2) AS paid_amount,
              COALESCE(SUM(ct.amount) FILTER (WHERE s.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT')),0)::numeric(14,2) AS outstanding_amount
       FROM scoped s JOIN patients p ON p.id=s.patient_id AND p.hospital_id=$1
       LEFT JOIN charge_totals ct ON ct.visit_id=s.id
       LEFT JOIN payment_totals pt ON pt.visit_id=s.id
       GROUP BY p.id,p.full_name,p.mobile
       ORDER BY last_visit_at DESC LIMIT 2000`,
      params
    ),
    pool.query(
      `SELECT v.status,COUNT(*)::int AS visits,COUNT(DISTINCT v.patient_id)::int AS patients,
              COALESCE(SUM(c.amount),0)::numeric(14,2) AS billed_amount
       FROM visits v
       LEFT JOIN LATERAL (SELECT COALESCE(SUM(vc.amount),0) AS amount FROM visit_charges vc WHERE vc.hospital_id=v.hospital_id AND vc.visit_id=v.id) c ON TRUE
       WHERE v.hospital_id=$1 AND ${inRange('v.created_at')}
       GROUP BY v.status ORDER BY visits DESC`,
      params
    ),
  ]);

  res.json({
    range: { dateFrom, dateTo, allTime },
    summary: summaryQ.rows[0],
    doctors: doctorsQ.rows,
    incomeByDay: incomeQ.rows,
    paymentModes: modesQ.rows,
    patients: patientsQ.rows,
    visitStatuses: statusesQ.rows,
  });
}));

export default router;
