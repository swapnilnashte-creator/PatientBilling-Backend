import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler } from '../utils.js';
import { sentMap } from './reminders.js';
import { addDays, daysBetween, todayIst } from '../vaccination.js';

const router = Router();
export const DEFAULT_FOLLOW_UP_MESSAGE = "Hello {patient},\n\nGreetings from {hospital}.\n\nThis is a friendly reminder that your follow-up visit with {doctor} is due around {when}.\n\nPlease contact us at {hospitalPhone} to schedule your appointment.\n\nThank you,\n{hospital}";
const readMessage = async (hospitalId) => {
  const q = await pool.query('SELECT follow_up_reminder_message FROM hospitals WHERE id=$1', [hospitalId]);
  return { reminderMessage: q.rows[0]?.follow_up_reminder_message || null, defaultReminderMessage: DEFAULT_FOLLOW_UP_MESSAGE };
};

// The wording of the WhatsApp message. An empty message goes back to the standard wording.
router.get('/message', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => { res.json(await readMessage(req.user.hospitalId)); }));
router.put('/message', allow('ADMIN'), asyncHandler(async (req, res) => {
  const { message } = z.object({ message: z.string().trim().max(600) }).parse(req.body);
  await pool.query('UPDATE hospitals SET follow_up_reminder_message=$2 WHERE id=$1', [req.user.hospitalId, message || null]);
  res.json(await readMessage(req.user.hospitalId));
}));
const LAPSED_AFTER_DAYS = 180; // a follow-up this long overdue is no longer listed

// Patients a doctor asked to come back, and who have not been seen since.
// The due day is the visit day plus the follow-up days the doctor chose. A patient with any later visit has come back, so is not listed.
router.get('/', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const today = todayIst();
  const params = [hospitalId];
  let doctorSql = '';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); doctorSql = ` AND vd.doctor_id=$2`; }
  const q = await pool.query(
    `SELECT v.id AS visit_id,v.patient_id,p.full_name,p.mobile,COALESCE(p.whatsapp_mobile,p.mobile) AS whatsapp,to_char(p.date_of_birth,'YYYY-MM-DD') AS dob,p.dob_estimated,
            to_char(v.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_on,
            MIN(vd.follow_up_days) AS follow_up_days,
            (ARRAY_AGG(u.name ORDER BY vd.follow_up_days,vd.position))[1] AS doctor_name
     FROM visits v
     JOIN visit_doctors vd ON vd.hospital_id=v.hospital_id AND vd.visit_id=v.id AND vd.follow_up_days IS NOT NULL
     JOIN users u ON u.hospital_id=vd.hospital_id AND u.id=vd.doctor_id
     JOIN patients p ON p.hospital_id=v.hospital_id AND p.id=v.patient_id AND p.deleted_at IS NULL
     WHERE v.hospital_id=$1 AND v.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR')${doctorSql}
       AND v.created_at > NOW() - INTERVAL '546 days' -- a follow-up is at most 365 days after the visit and is dropped 180 days after it is due, so older visits can never be listed (keeps this fast as years pass)
       AND NOT EXISTS (SELECT 1 FROM visits v2 WHERE v2.hospital_id=v.hospital_id AND v2.patient_id=v.patient_id AND v2.id>v.id AND v2.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR'))
     GROUP BY v.id,p.id`, params);
  const totals = { overdue: 0, week: 0, soon: 0 };
  const rows = [];
  for (const r of q.rows) {
    const dueOn = addDays(r.visit_on, Number(r.follow_up_days));
    const daysLeft = daysBetween(today, dueOn);
    if (daysLeft < -LAPSED_AFTER_DAYS || daysLeft > days) continue;
    if (daysLeft < 0) totals.overdue += 1; else if (daysLeft <= 7) totals.week += 1; else totals.soon += 1;
    rows.push({ visitId: Number(r.visit_id), patientId: Number(r.patient_id), name: r.full_name, mobile: r.mobile, whatsapp: r.whatsapp, dob: r.dob, dobEstimated: r.dob_estimated,
      visitOn: r.visit_on, followUpDays: Number(r.follow_up_days), doctor: r.doctor_name, dueOn, daysLeft, status: daysLeft < 0 ? 'OVERDUE' : daysLeft <= 7 ? 'DUE_SOON' : 'UPCOMING' });
  }
  rows.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
  const sent = await sentMap(pool, hospitalId, 'FOLLOW_UP', rows.map(r => r.patientId));
  const called = await sentMap(pool, hospitalId, 'FOLLOW_UP_CALL', rows.map(r => r.patientId));
  for (const r of rows) { r.reminder = sent.get(`${r.patientId}:${r.visitId}`) || null; r.call = called.get(`${r.patientId}:${r.visitId}`) || null; }
  res.json({ days, totals, total: rows.length, rows: rows.slice(0, 500), ...(await readMessage(hospitalId)) });
}));

export default router;
