import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';

const NEXT_SHOWN = 5;
const newToken = () => crypto.randomBytes(24).toString('base64url');

// ---- for the Admin: create, regenerate or switch off the private link ----
export const displayAdmin = Router();
const readAdmin = async (hospitalId) => {
  const q = await pool.query('SELECT display_token,display_voice,display_chime FROM hospitals WHERE id=$1', [hospitalId]);
  const r = q.rows[0] || {};
  return { token: r.display_token || null, voice: r.display_voice || 'en', chime: r.display_chime !== false };
};
displayAdmin.get('/', allow('ADMIN'), asyncHandler(async (req, res) => { res.json(await readAdmin(req.user.hospitalId)); }));
// the chime and the language of the spoken call
displayAdmin.put('/settings', allow('ADMIN'), asyncHandler(async (req, res) => {
  const d = z.object({ voice: z.enum(['off', 'en', 'hi', 'mr']), chime: z.boolean() }).parse(req.body);
  await pool.query('UPDATE hospitals SET display_voice=$2,display_chime=$3 WHERE id=$1', [req.user.hospitalId, d.voice, d.chime]);
  res.json(await readAdmin(req.user.hospitalId));
}));

// A doctor (or the front desk for a doctor) calls a waiting patient: the TV highlights the token and sounds the chime.
displayAdmin.post('/call', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const d = z.object({ visitId: z.coerce.number().int().positive(), doctorId: z.coerce.number().int().positive().optional() }).parse(req.body);
  const doctorId = req.user.role === 'DOCTOR' ? req.user.id : d.doctorId;
  if (!doctorId) throw badRequest('Choose the doctor who is calling');
  if (req.user.role === 'DOCTOR' && d.doctorId && d.doctorId !== req.user.id) throw forbidden('You can call only your own patients');
  const q = await pool.query(
    `SELECT v.daily_number FROM visit_doctors vd JOIN visits v ON v.hospital_id=vd.hospital_id AND v.id=vd.visit_id
     WHERE vd.hospital_id=$1 AND vd.visit_id=$2 AND vd.doctor_id=$3 AND vd.status='WAITING' AND v.status='WAITING_FOR_DOCTOR'
       AND NOT EXISTS (SELECT 1 FROM visit_doctors e WHERE e.hospital_id=vd.hospital_id AND e.visit_id=vd.visit_id AND e.position<vd.position AND e.status IN ('WAITING','IN_PROGRESS'))`,
    [req.user.hospitalId, d.visitId, doctorId]);
  if (!q.rowCount) throw badRequest('This patient is not waiting for you right now');
  // a double tap within two seconds is one call
  const recent = await pool.query(`SELECT id FROM display_calls WHERE hospital_id=$1 AND visit_id=$2 AND doctor_id=$3 AND called_at > NOW() - interval '2 seconds' LIMIT 1`, [req.user.hospitalId, d.visitId, doctorId]);
  if (recent.rowCount) return res.json({ id: Number(recent.rows[0].id), token: q.rows[0].daily_number });
  const ins = await pool.query(
    `INSERT INTO display_calls(hospital_id,visit_id,doctor_id,token,called_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [req.user.hospitalId, d.visitId, doctorId, q.rows[0].daily_number, req.user.id]);
  res.json({ id: Number(ins.rows[0].id), token: q.rows[0].daily_number });
}));
// a new link every time; the old one stops working at once
displayAdmin.post('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const token = newToken();
  await pool.query('UPDATE hospitals SET display_token=$2 WHERE id=$1', [req.user.hospitalId, token]);
  res.json({ token });
}));
displayAdmin.delete('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  await pool.query('UPDATE hospitals SET display_token=NULL WHERE id=$1', [req.user.hospitalId]);
  res.json({ token: null });
}));

// ---- for the TV: no sign-in, only the link. It returns tokens, doctor names and nothing else. ----
export const displayPublic = Router();
displayPublic.get('/:token', asyncHandler(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  const token = String(req.params.token || '');
  if (token.length < 20 || token.length > 64) throw notFound('This display link is not valid');
  const h = await pool.query('SELECT id,name,logo_data,logo_mime,display_voice,display_chime FROM hospitals WHERE display_token=$1 AND is_active=TRUE', [token]);
  if (!h.rowCount) throw notFound('This display link is not valid');
  const hospital = h.rows[0];
  const doctors = await pool.query(`SELECT id,name FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE ORDER BY name`, [hospital.id]);
  // today's visits (India time) that are still with the doctors
  const rows = await pool.query(
    `SELECT vd.doctor_id,vd.status,v.daily_number,v.id AS visit_id FROM visit_doctors vd
     JOIN visits v ON v.hospital_id=vd.hospital_id AND v.id=vd.visit_id
     WHERE vd.hospital_id=$1 AND vd.status IN ('WAITING','IN_PROGRESS')
       AND v.status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR')
       AND (v.created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       AND NOT EXISTS (SELECT 1 FROM visit_doctors e WHERE e.hospital_id=vd.hospital_id AND e.visit_id=vd.visit_id AND e.position<vd.position AND e.status IN ('WAITING','IN_PROGRESS'))
     ORDER BY v.daily_number NULLS LAST,v.id`, [hospital.id]);
  const by = new Map();
  for (const r of rows.rows) { const k = String(r.doctor_id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  // the latest call for each doctor in the last 90 seconds, while that patient is still waiting
  const calls = await pool.query(`SELECT DISTINCT ON (doctor_id) id,doctor_id,visit_id,token FROM display_calls WHERE hospital_id=$1 AND called_at > NOW() - interval '90 seconds' ORDER BY doctor_id,id DESC`, [hospital.id]);
  const calling = new Map();
  for (const c of calls.rows) {
    const waiting = (by.get(String(c.doctor_id)) || []).some(r => r.status === 'WAITING' && String(r.visit_id) === String(c.visit_id));
    if (waiting) calling.set(String(c.doctor_id), { id: Number(c.id), token: c.token });
  }
  res.json({
    sound: { voice: hospital.display_voice, chime: hospital.display_chime },
    hospital: { name: hospital.name, logo: hospital.logo_data ? `data:${hospital.logo_mime};base64,${hospital.logo_data.toString('base64')}` : null },
    now: new Date().toISOString(),
    doctors: doctors.rows.map(d => {
      const mine = by.get(String(d.id)) || [];
      return {
        id: Number(d.id), name: d.name,
        now: mine.filter(r => r.status === 'IN_PROGRESS').map(r => r.daily_number),
        next: mine.filter(r => r.status === 'WAITING').map(r => r.daily_number).slice(0, NEXT_SHOWN),
        waiting: mine.filter(r => r.status === 'WAITING').length,
        calling: calling.get(String(d.id)) || null,
      };
    }),
  });
}));
