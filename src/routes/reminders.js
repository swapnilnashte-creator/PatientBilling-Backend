import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils.js';

const router = Router();
const body = z.object({ kind: z.enum(['FOLLOW_UP', 'VACCINE', 'FOLLOW_UP_CALL', 'VACCINE_CALL']), patientId: z.coerce.number().int().positive(), ref: z.string().trim().min(1).max(40) });

// Who has already been sent a reminder: the list pages call this to colour the WhatsApp button.
export async function sentMap(db, hospitalId, kind, patientIds) {
  const map = new Map();
  if (!patientIds.length) return map;
  const q = await db.query(
    `SELECT rs.patient_id,rs.ref,rs.sent_at,u.name AS sent_by_name FROM reminder_sends rs
     JOIN users u ON u.hospital_id=rs.hospital_id AND u.id=rs.sent_by
     WHERE rs.hospital_id=$1 AND rs.kind=$2 AND rs.patient_id=ANY($3::bigint[])`, [hospitalId, kind, patientIds]);
  for (const r of q.rows) map.set(`${r.patient_id}:${r.ref}`, { sentAt: r.sent_at, sentBy: r.sent_by_name });
  return map;
}

// Staff tapped WhatsApp (or Call, for the *_CALL kinds) for this patient: remember it, with who and when. Tapping again updates the time.
router.post('/sent', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const d = body.parse(req.body);
  const p = await pool.query('SELECT 1 FROM patients WHERE hospital_id=$1 AND id=$2 AND deleted_at IS NULL', [req.user.hospitalId, d.patientId]);
  if (!p.rowCount) throw notFound('Patient not found');
  const r = await pool.query(
    `INSERT INTO reminder_sends(hospital_id,kind,patient_id,ref,sent_by) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (hospital_id,kind,patient_id,ref) DO UPDATE SET sent_by=EXCLUDED.sent_by,sent_at=NOW() RETURNING sent_at`,
    [req.user.hospitalId, d.kind, d.patientId, d.ref, req.user.id]);
  res.json({ sentAt: r.rows[0].sent_at, sentBy: req.user.name });
}));

// Marked by mistake: take the mark off.
router.post('/unsent', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const d = body.parse(req.body);
  await pool.query('DELETE FROM reminder_sends WHERE hospital_id=$1 AND kind=$2 AND patient_id=$3 AND ref=$4', [req.user.hospitalId, d.kind, d.patientId, d.ref]);
  res.json({ ok: true });
}));

export default router;
