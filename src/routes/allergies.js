import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';

const router = Router();
const WHO = ['ADMIN', 'DOCTOR', 'RECEPTIONIST']; // who can read
const EDIT = ['ADMIN', 'DOCTOR']; // who can change

// Allergies are recorded while a doctor has the patient: the doctor's visit has to be started and still open.
async function assertConsulting(db, req, patientId) {
  const q = await db.query(
    `SELECT 1 FROM visits v JOIN visit_doctors vd ON vd.hospital_id=v.hospital_id AND vd.visit_id=v.id
     WHERE v.hospital_id=$1 AND v.patient_id=$2 AND v.status='WITH_DOCTOR' AND vd.status='IN_PROGRESS'
       AND ($3='ADMIN' OR vd.doctor_id=$4) LIMIT 1`, [req.user.hospitalId, patientId, req.user.role, req.user.id]);
  if (!q.rowCount) throw forbidden('Allergies can be changed once the doctor has started the visit');
}

async function read(db, hospitalId, patientId) {
  const p = await db.query(
    `SELECT p.allergy_status,p.allergy_checked_at,u.name AS checked_by FROM patients p
     LEFT JOIN users u ON u.hospital_id=p.hospital_id AND u.id=p.allergy_checked_by
     WHERE p.hospital_id=$1 AND p.id=$2 AND p.deleted_at IS NULL`, [hospitalId, patientId]);
  if (!p.rowCount) throw notFound('Patient not found');
  const items = await db.query(
    `SELECT a.id,a.name,a.note,a.created_at,u.name AS added_by FROM patient_allergies a
     JOIN users u ON u.hospital_id=a.hospital_id AND u.id=a.recorded_by
     WHERE a.hospital_id=$1 AND a.patient_id=$2 ORDER BY a.id`, [hospitalId, patientId]);
  const r = p.rows[0];
  return {
    status: r.allergy_status, checkedAt: r.allergy_checked_at, checkedBy: r.checked_by,
    items: items.rows.map(i => ({ id: Number(i.id), name: i.name, note: i.note, addedBy: i.added_by, addedAt: i.created_at })),
  };
}
const stamp = (db, hospitalId, patientId, userId, status) => db.query(
  `UPDATE patients SET allergy_status=$3,allergy_checked_at=NOW(),allergy_checked_by=$4,updated_at=NOW() WHERE hospital_id=$1 AND id=$2`,
  [hospitalId, patientId, status, userId]);

// The hospital's own list: every allergy typed at this hospital becomes a one-tap choice for the next patient.
// It is worked out from what is on file, so there is nothing to maintain; one nobody has any more drops off by itself.
router.get('/options', allow(...WHO), asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT (array_agg(name ORDER BY created_at))[1] AS name,COUNT(*)::int AS used FROM patient_allergies
     WHERE hospital_id=$1 GROUP BY lower(name) ORDER BY COUNT(*) DESC,lower(name) LIMIT 30`, [req.user.hospitalId]);
  res.json({ options: q.rows.map(r => r.name) });
}));

router.get('/patient/:patientId', allow(...WHO), asyncHandler(async (req, res) => {
  res.json(await read(pool, req.user.hospitalId, Number(req.params.patientId)));
}));

// One tap on a chip adds an allergy. The same allergy twice is quietly kept once.
router.post('/patient/:patientId', allow(...EDIT), asyncHandler(async (req, res) => {
  const d = z.object({ name: z.string().trim().min(2, 'Enter the allergy').max(80), note: z.string().trim().max(160).optional().default('') }).parse(req.body);
  const patientId = Number(req.params.patientId);
  await assertConsulting(pool, req, patientId);
  await withTransaction(async (client) => {
    await read(client, req.user.hospitalId, patientId);
    await client.query(
      `INSERT INTO patient_allergies(hospital_id,patient_id,name,note,recorded_by) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (hospital_id,patient_id,lower(name)) DO UPDATE SET note=COALESCE(NULLIF(EXCLUDED.note,''),patient_allergies.note)`,
      [req.user.hospitalId, patientId, d.name, d.note || null, req.user.id]);
    await stamp(client, req.user.hospitalId, patientId, req.user.id, 'LISTED');
  });
  res.status(201).json(await read(pool, req.user.hospitalId, patientId));
}));

router.patch('/:id', allow(...EDIT), asyncHandler(async (req, res) => {
  const d = z.object({ note: z.string().trim().max(160) }).parse(req.body);
  const own = await pool.query(`SELECT patient_id FROM patient_allergies WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id]);
  if (!own.rowCount) throw notFound('Allergy not found');
  await assertConsulting(pool, req, Number(own.rows[0].patient_id));
  const q = await pool.query(`UPDATE patient_allergies SET note=$3 WHERE hospital_id=$1 AND id=$2 RETURNING patient_id`, [req.user.hospitalId, req.params.id, d.note || null]);
  if (!q.rowCount) throw notFound('Allergy not found');
  res.json(await read(pool, req.user.hospitalId, Number(q.rows[0].patient_id)));
}));

router.delete('/:id', allow(...EDIT), asyncHandler(async (req, res) => {
  const own = await pool.query(`SELECT patient_id FROM patient_allergies WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id]);
  if (!own.rowCount) throw notFound('Allergy not found');
  await assertConsulting(pool, req, Number(own.rows[0].patient_id));
  const patientId = await withTransaction(async (client) => {
    const q = await client.query(`DELETE FROM patient_allergies WHERE hospital_id=$1 AND id=$2 RETURNING patient_id`, [req.user.hospitalId, req.params.id]);
    if (!q.rowCount) throw notFound('Allergy not found');
    const pid = Number(q.rows[0].patient_id);
    const left = await client.query(`SELECT COUNT(*)::int AS n FROM patient_allergies WHERE hospital_id=$1 AND patient_id=$2`, [req.user.hospitalId, pid]);
    // with the last one removed, the list is empty again and has to be confirmed
    if (!left.rows[0].n) await stamp(client, req.user.hospitalId, pid, req.user.id, 'NOT_ASKED');
    return pid;
  });
  res.json(await read(pool, req.user.hospitalId, patientId));
}));

// "No known allergies": one tap records that somebody asked.
router.post('/patient/:patientId/none', allow(...EDIT), asyncHandler(async (req, res) => {
  const patientId = Number(req.params.patientId);
  await assertConsulting(pool, req, patientId);
  const cur = await read(pool, req.user.hospitalId, patientId);
  if (cur.items.length) throw badRequest('Remove the listed allergies first, or keep them');
  await stamp(pool, req.user.hospitalId, patientId, req.user.id, 'NONE');
  res.json(await read(pool, req.user.hospitalId, patientId));
}));

// "Still correct": a returning patient's list is confirmed in one tap.
router.post('/patient/:patientId/confirm', allow(...EDIT), asyncHandler(async (req, res) => {
  const patientId = Number(req.params.patientId);
  await assertConsulting(pool, req, patientId);
  const cur = await read(pool, req.user.hospitalId, patientId);
  await stamp(pool, req.user.hospitalId, patientId, req.user.id, cur.items.length ? 'LISTED' : 'NONE');
  res.json(await read(pool, req.user.hospitalId, patientId));
}));

export default router;
