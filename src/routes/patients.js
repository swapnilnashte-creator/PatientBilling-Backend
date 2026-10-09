import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { asyncHandler, notFound } from '../utils.js';
import { allow } from '../middleware/auth.js';
import { mobileSchema } from '../mobile.js';

const router = Router();

const patientSchema = z.object({
  fullName: z.string().min(2).max(160),
  mobile: mobileSchema,
  gender: z.enum(['MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY']).nullable().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  age: z.number().int().min(0).max(120).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
})
  // an exact birth date, or just the age in years (stored as an estimated birth date)
  .refine(d => d.dateOfBirth || (d.age !== null && d.age !== undefined), { message: 'Age or date of birth is required', path: ['age'] })
  .refine(d => !d.dateOfBirth || d.dateOfBirth <= new Date(Date.now() + 864e5).toISOString().slice(0, 10), { message: 'Date of birth cannot be in the future', path: ['dateOfBirth'] });

// date_of_birth = the given date, or today minus the age when only an age was given
const dobSql = (dobParam, ageParam) => `COALESCE($${dobParam}::date,(CURRENT_DATE-($${ageParam}::int*INTERVAL '1 year'))::date)`;

router.get('/search', asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json([]);
  const q = await pool.query(
    `SELECT p.id,p.full_name,p.mobile,p.gender,p.date_of_birth,p.dob_estimated,p.address,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS visit_count,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS last_visit_at
     FROM patients p
     WHERE p.hospital_id=$1 AND p.deleted_at IS NULL
       AND (p.mobile ILIKE $2 OR p.full_name ILIKE $2)
     ORDER BY p.updated_at DESC LIMIT 20`,
    [req.user.hospitalId, `%${term}%`]
  );
  res.json(q.rows);
}));

// Reception scans the QR printed on a returning patient's bill, pad or prescription: the code resolves to the patient of THIS hospital only.
router.get('/by-code/:code', allow('ADMIN','RECEPTIONIST','DOCTOR'), asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(code)) throw notFound('Patient not found');
  const q = await pool.query(
    `SELECT p.id,p.full_name,p.mobile,p.gender,p.date_of_birth,p.dob_estimated,p.address,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS visit_count,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS last_visit_at,
            (SELECT v.status FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id AND v.status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR','PAYMENT_PENDING') ORDER BY v.id DESC LIMIT 1) AS open_visit_status
     FROM patients p WHERE p.hospital_id=$1 AND p.qr_code=$2 AND p.deleted_at IS NULL`,
    [req.user.hospitalId, code]
  );
  if (!q.rowCount) throw notFound('Patient not found');
  const row = q.rows[0];
  if (req.user.role === 'DOCTOR') {
    // a doctor scans to open this patient's visit with them: only visits assigned to this doctor, from the last two days (the screen keeps today's)
    const visits = await pool.query(
      `SELECT id,status,created_at FROM visits WHERE hospital_id=$1 AND patient_id=$2 AND doctor_id=$3 AND created_at >= NOW() - INTERVAL '2 days' ORDER BY id DESC`,
      [req.user.hospitalId, row.id, req.user.id]
    );
    row.recent_visits = visits.rows;
  }
  res.json(row);
}));

router.post('/', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  const q = await pool.query(
    `INSERT INTO patients(hospital_id,full_name,mobile,gender,date_of_birth,dob_estimated,address,created_by,updated_by)
     VALUES($1,$2,$3,$4,${dobSql(5, 6)},$5::date IS NULL,$7,$8,$8)
     RETURNING id,full_name,mobile,gender,date_of_birth,dob_estimated,address`,
    [req.user.hospitalId, data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.age ?? null, data.address || null, req.user.id]
  );
  res.status(201).json(q.rows[0]);
}));

router.put('/:id', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  const q = await pool.query(
    `UPDATE patients SET full_name=$1,mobile=$2,gender=$3,date_of_birth=${dobSql(4, 5)},dob_estimated=$4::date IS NULL,address=$6,updated_by=$7,updated_at=NOW()
     WHERE id=$8 AND hospital_id=$9 AND deleted_at IS NULL
     RETURNING id,full_name,mobile,gender,date_of_birth,dob_estimated,address`,
    [data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.age ?? null, data.address || null, req.user.id, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('Patient not found');
  res.json(q.rows[0]);
}));

router.get('/:id/history', asyncHandler(async (req, res) => {
  const patient = await pool.query(
    `SELECT id,full_name,mobile,gender,date_of_birth,dob_estimated,address FROM patients
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
