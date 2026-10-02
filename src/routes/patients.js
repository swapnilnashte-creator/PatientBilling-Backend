import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { asyncHandler, notFound } from '../utils.js';
import { allow } from '../middleware/auth.js';

const router = Router();

const patientSchema = z.object({
  fullName: z.string().min(2).max(160),
  mobile: z.string().min(5).max(20),
  gender: z.enum(['MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY']).nullable().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
});

router.get('/search', asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json([]);
  const q = await pool.query(
    `SELECT id,full_name,mobile,gender,date_of_birth,address
     FROM patients
     WHERE hospital_id=$1 AND deleted_at IS NULL
       AND (mobile ILIKE $2 OR full_name ILIKE $2)
     ORDER BY updated_at DESC LIMIT 20`,
    [req.user.hospitalId, `%${term}%`]
  );
  res.json(q.rows);
}));

router.post('/', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  const q = await pool.query(
    `INSERT INTO patients(hospital_id,full_name,mobile,gender,date_of_birth,address,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING id,full_name,mobile,gender,date_of_birth,address`,
    [req.user.hospitalId, data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.address || null, req.user.id]
  );
  res.status(201).json(q.rows[0]);
}));

router.put('/:id', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  const q = await pool.query(
    `UPDATE patients SET full_name=$1,mobile=$2,gender=$3,date_of_birth=$4,address=$5,updated_by=$6,updated_at=NOW()
     WHERE id=$7 AND hospital_id=$8 AND deleted_at IS NULL
     RETURNING id,full_name,mobile,gender,date_of_birth,address`,
    [data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.address || null, req.user.id, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('Patient not found');
  res.json(q.rows[0]);
}));

router.get('/:id/history', asyncHandler(async (req, res) => {
  const patient = await pool.query(
    `SELECT id,full_name,mobile,gender,date_of_birth,address FROM patients
     WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`,
    [req.params.id, req.user.hospitalId]
  );
  if (!patient.rowCount) throw notFound('Patient not found');

  const visits = await pool.query(
    `SELECT v.id,v.visit_number,v.status,v.created_at,v.completed_at,
            COALESCE((SELECT string_agg(CASE WHEN vd.doctor_notes IS NOT NULL THEN du.name || ': ' || vd.doctor_notes END,E'\n\n' ORDER BY vd.position)
                      FROM visit_doctors vd JOIN users du ON du.id=vd.doctor_id AND du.hospital_id=vd.hospital_id
                      WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id),v.doctor_notes) AS doctor_notes,
            v.left_at,v.left_note,
            COALESCE((SELECT string_agg(du.name,', ' ORDER BY vd.position)
                      FROM visit_doctors vd JOIN users du ON du.id=vd.doctor_id AND du.hospital_id=vd.hospital_id
                      WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id AND vd.status<>'SKIPPED'),u.name) AS doctor_name,
            COALESCE(SUM(vc.amount),0)::numeric(12,2) AS total_amount,
            p.payment_mode,p.paid_at,
            CASE
              WHEN p.id IS NOT NULL THEN 'PAID'
              WHEN v.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT') THEN 'UNPAID'
              WHEN v.status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR') THEN 'NOT_FINALIZED'
              ELSE 'NO_BILL'
            END AS bill_status
     FROM visits v
     JOIN users u ON u.id=v.doctor_id
     LEFT JOIN visit_charges vc ON vc.visit_id=v.id AND vc.hospital_id=v.hospital_id
     LEFT JOIN payments p ON p.visit_id=v.id AND p.hospital_id=v.hospital_id
     WHERE v.hospital_id=$1 AND v.patient_id=$2
     GROUP BY v.id,u.name,p.id,p.payment_mode,p.paid_at
     ORDER BY v.created_at DESC LIMIT 50`,
    [req.user.hospitalId, req.params.id]
  );
  res.json({ patient: patient.rows[0], visits: visits.rows });
}));

export default router;
