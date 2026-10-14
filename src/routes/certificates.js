import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';
import { CERTIFICATE_TYPES, typeByKey } from '../certificateTypes.js';

const router = Router();

const ISSUE_STATUSES = ['WITH_DOCTOR', 'PAYMENT_PENDING', 'COMPLETED'];
const ROW = `c.id,c.number,c.type_key,c.title,c.body,c.fields,c.status,c.issued_at,c.cancelled_at,c.cancel_reason,c.visit_id,c.patient_id,c.doctor_id,
  p.full_name AS patient_name,p.mobile AS patient_mobile,p.gender AS patient_gender,p.date_of_birth AS patient_dob,p.address AS patient_address,
  d.name AS doctor_name,d.qualification AS doctor_qualification,d.registration_no AS doctor_registration_no,cb.name AS cancelled_by_name,c.issued_by,ib.name AS issued_by_name`;
const FROM = `FROM certificates c
  JOIN patients p ON p.id=c.patient_id
  JOIN users d ON d.id=c.doctor_id
  LEFT JOIN users cb ON cb.id=c.cancelled_by
  LEFT JOIN users ib ON ib.id=c.issued_by`;

// the standard types with this hospital's own wording where it has saved one
async function typesFor(hospitalId) {
  const saved = await pool.query(`SELECT type_key,title,body FROM certificate_templates WHERE hospital_id=$1`, [hospitalId]);
  const byKey = new Map(saved.rows.map(r => [r.type_key, r]));
  return CERTIFICATE_TYPES.map(t => {
    const own = byKey.get(t.key);
    return { ...t, template: { title: own?.title || t.title, body: own?.body || t.body, custom: Boolean(own) }, standard: { title: t.title, body: t.body } };
  });
}

router.get('/types', allow('ADMIN', 'DOCTOR', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  res.json(await typesFor(req.user.hospitalId));
}));

// Admin saves the hospital's own wording for a standard type, or goes back to the standard wording.
const templateBody = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(20).max(2000) });
router.put('/templates/:typeKey', allow('ADMIN'), asyncHandler(async (req, res) => {
  const type = typeByKey(req.params.typeKey);
  if (!type) throw notFound('Certificate type not found');
  const data = templateBody.parse(req.body);
  await pool.query(
    `INSERT INTO certificate_templates(hospital_id,type_key,title,body,updated_by) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (hospital_id,type_key) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
    [req.user.hospitalId, type.key, data.title, data.body, req.user.id]
  );
  res.json(await typesFor(req.user.hospitalId));
}));
router.delete('/templates/:typeKey', allow('ADMIN'), asyncHandler(async (req, res) => {
  if (!typeByKey(req.params.typeKey)) throw notFound('Certificate type not found');
  await pool.query(`DELETE FROM certificate_templates WHERE hospital_id=$1 AND type_key=$2`, [req.user.hospitalId, req.params.typeKey]);
  res.json(await typesFor(req.user.hospitalId));
}));

// The register. A doctor sees the certificates they issued; Admin and Reception see everyone's.
router.get('/', allow('ADMIN', 'DOCTOR', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const q = z.object({
    visitId: z.coerce.number().int().positive().optional(),
    search: z.string().trim().max(80).optional(),
    type: z.string().max(20).optional(),
    status: z.enum(['ISSUED', 'CANCELLED']).optional(),
  }).parse(req.query);
  const params = [req.user.hospitalId];
  let where = 'WHERE c.hospital_id=$1';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); where += ` AND c.doctor_id=$${params.length}`; }
  if (q.visitId) { params.push(q.visitId); where += ` AND c.visit_id=$${params.length}`; }
  if (q.type) { params.push(q.type); where += ` AND c.type_key=$${params.length}`; }
  if (q.status) { params.push(q.status); where += ` AND c.status=$${params.length}`; }
  if (q.search) { params.push(`%${q.search.replace(/[%_]/g, m => `\\${m}`)}%`); where += ` AND (c.number ILIKE $${params.length} OR p.full_name ILIKE $${params.length} OR p.mobile ILIKE $${params.length})`; }
  const rows = await pool.query(`SELECT ${ROW} ${FROM} ${where} ORDER BY c.issued_at DESC,c.id DESC LIMIT 500`, params);
  res.json(rows.rows);
}));

router.get('/:id', allow('ADMIN', 'DOCTOR', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const rows = await pool.query(`SELECT ${ROW} ${FROM} WHERE c.hospital_id=$1 AND c.id=$2`, [req.user.hospitalId, req.params.id]);
  if (!rows.rowCount) throw notFound('Certificate not found');
  if (req.user.role === 'DOCTOR' && Number(rows.rows[0].doctor_id) !== req.user.id) throw forbidden('This certificate was issued by another doctor');
  res.json(rows.rows[0]);
}));

// A doctor issues a certificate for a patient they are seeing; an Admin can issue one on behalf of a doctor of that visit.
const issueBody = z.object({
  visitId: z.coerce.number().int().positive(),
  typeKey: z.string().min(1).max(20),
  doctorId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(10).max(3000),
  fields: z.record(z.string().max(60), z.string().max(1000)).default({}),
});
router.post('/', allow('DOCTOR', 'ADMIN'), asyncHandler(async (req, res) => {
  const data = issueBody.parse(req.body);
  const type = typeByKey(data.typeKey);
  if (!type) throw badRequest('Unknown certificate type');
  for (const field of type.fields) {
    if (field.required && !String(data.fields[field.key] || '').trim()) throw badRequest(`${field.label} is required`);
  }
  const created = await withTransaction(async (client) => {
    // the doctor who signs: the signed-in doctor, or the doctor an Admin chose
    const signer = req.user.role === 'DOCTOR' ? req.user.id : data.doctorId;
    if (!signer) throw badRequest('Choose the doctor this certificate is for');
    const visit = await client.query(
      `SELECT v.id,v.patient_id,v.status FROM visits v
       WHERE v.id=$1 AND v.hospital_id=$2
         AND (v.doctor_id=$3 OR EXISTS(SELECT 1 FROM visit_doctors vd WHERE vd.visit_id=v.id AND vd.hospital_id=v.hospital_id AND vd.doctor_id=$3))
       FOR UPDATE OF v`,
      [data.visitId, req.user.hospitalId, signer]
    );
    if (!visit.rowCount) throw forbidden(req.user.role === 'DOCTOR' ? 'This visit is not assigned to you' : 'That doctor is not part of this visit');
    if (!ISSUE_STATUSES.includes(visit.rows[0].status)) throw badRequest('Start the consultation before issuing a certificate');
    const counter = await client.query(
      `INSERT INTO certificate_counters(hospital_id,code,year,next_number)
       VALUES($1,$2,(EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Kolkata'))::int,2)
       ON CONFLICT (hospital_id,code,year) DO UPDATE SET next_number=certificate_counters.next_number+1
       RETURNING year,next_number-1 AS seq`,
      [req.user.hospitalId, type.code]
    );
    const number = `${type.code}-${counter.rows[0].year}-${String(counter.rows[0].seq).padStart(4, '0')}`;
    const ins = await client.query(
      `INSERT INTO certificates(hospital_id,number,type_key,title,body,fields,visit_id,patient_id,doctor_id,issued_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING id`,
      [req.user.hospitalId, number, type.key, data.title, data.body, JSON.stringify(data.fields), data.visitId, visit.rows[0].patient_id, signer, req.user.id]
    );
    return ins.rows[0].id;
  });
  const row = await pool.query(`SELECT ${ROW} ${FROM} WHERE c.hospital_id=$1 AND c.id=$2`, [req.user.hospitalId, created]);
  res.status(201).json(row.rows[0]);
}));

// A mistake is cancelled with a reason, never edited. The record stays.
router.post('/:id/cancel', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const found = await pool.query(`SELECT id,doctor_id,status FROM certificates WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id]);
  if (!found.rowCount) throw notFound('Certificate not found');
  const cert = found.rows[0];
  if (req.user.role === 'DOCTOR' && Number(cert.doctor_id) !== req.user.id) throw forbidden('Only the doctor who issued it, or an Admin, can cancel this certificate');
  if (cert.status === 'CANCELLED') throw badRequest('This certificate is already cancelled');
  await pool.query(`UPDATE certificates SET status='CANCELLED',cancelled_at=NOW(),cancelled_by=$3,cancel_reason=$4 WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, cert.id, req.user.id, reason]);
  const row = await pool.query(`SELECT ${ROW} ${FROM} WHERE c.hospital_id=$1 AND c.id=$2`, [req.user.hospitalId, cert.id]);
  res.json(row.rows[0]);
}));

export default router;
