import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { mobileSchema } from '../mobile.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

const router = Router();

const MAX_LOGO_BYTES = 200 * 1024; // the app compresses to a few KB–tens of KB; this is only a safety limit
const MAX_LOGO_SIDE = 1024;

// The logo travels with the hospital row as a small data URL so it can be shown and printed without extra requests.
const toRow = (r) => ({ id: r.id, name: r.name, mobile: r.mobile, address: r.address, logo: r.logo_data ? `data:${r.logo_mime};base64,${r.logo_data.toString('base64')}` : null, logoUpdatedAt: r.logo_updated_at, logoBytes: r.logo_data ? r.logo_data.length : 0 });
const COLS = 'id,name,mobile,address,logo_data,logo_mime,logo_updated_at,weekly_off,timings';

const MAX_ON_LETTERHEAD = 6;
const sessionsOf = (timings) => (Array.isArray(timings?.sessions) ? timings.sessions : []);

// The hospital row plus everything a printed bill needs: the logo, the doctors on the letterhead (in order), timings and weekly off.
async function payload(hospitalId) {
  const q = await pool.query(`SELECT ${COLS} FROM hospitals WHERE id=$1`, [hospitalId]);
  if (!q.rowCount) throw notFound('Hospital not found');
  const docs = await pool.query(
    `SELECT id,name,qualification,registration_no FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL AND on_letterhead=TRUE ORDER BY letterhead_order NULLS LAST,id`,
    [hospitalId]
  );
  const row = q.rows[0];
  return { ...toRow(row), letterhead: { doctors: docs.rows.map(d => ({ id: d.id, name: d.name, qualification: d.qualification, registrationNo: d.registration_no })), showTimings: row.timings?.show !== false, sessions: sessionsOf(row.timings), weeklyOff: row.weekly_off || [] } };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await payload(req.user.hospitalId));
}));

// ---------- letterhead settings (Admin) ----------
router.get('/letterhead', allow('ADMIN'), asyncHandler(async (req, res) => {
  const [h, docs] = await Promise.all([
    pool.query(`SELECT weekly_off,timings FROM hospitals WHERE id=$1`, [req.user.hospitalId]),
    pool.query(`SELECT id,name,qualification,registration_no,on_letterhead,letterhead_order FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL ORDER BY on_letterhead DESC,letterhead_order NULLS LAST,name`, [req.user.hospitalId]),
  ]);
  res.json({
    max: MAX_ON_LETTERHEAD,
    doctors: docs.rows.map(d => ({ id: d.id, name: d.name, qualification: d.qualification, registrationNo: d.registration_no, show: d.on_letterhead })),
    showTimings: h.rows[0].timings?.show !== false, sessions: sessionsOf(h.rows[0].timings), weeklyOff: h.rows[0].weekly_off || [],
  });
}));

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const letterheadBody = z.object({
  doctors: z.array(z.object({ id: z.coerce.number().int().positive(), show: z.boolean() })).max(200),
  showTimings: z.boolean(),
  sessions: z.array(z.object({ from: z.string().regex(TIME), to: z.string().regex(TIME) })).max(2),
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(7),
});
router.put('/letterhead', allow('ADMIN'), asyncHandler(async (req, res) => {
  const body = letterheadBody.parse(req.body);
  if (new Set(body.doctors.map(d => d.id)).size !== body.doctors.length) throw badRequest('A doctor is listed twice');
  const shown = body.doctors.filter(d => d.show);
  if (shown.length > MAX_ON_LETTERHEAD) throw badRequest(`At most ${MAX_ON_LETTERHEAD} doctors can be shown on the letterhead`);
  const weeklyOff = [...new Set(body.weeklyOff)].sort();
  if (weeklyOff.length >= 7) throw badRequest('The hospital must be open on at least one day');
  for (const [i, s] of body.sessions.entries()) {
    if (s.from >= s.to) throw badRequest(`Session ${i + 1}: the closing time must be after the opening time`);
    if (i > 0 && s.from < body.sessions[i - 1].to) throw badRequest('Session 2 must start after session 1 ends');
  }
  await withTransaction(async (client) => {
    const ok = await client.query(`SELECT id FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL AND id=ANY($2::bigint[])`, [req.user.hospitalId, body.doctors.map(d => d.id)]);
    if (ok.rowCount !== body.doctors.length) throw badRequest('One of the doctors was not found');
    for (const [i, d] of body.doctors.entries()) await client.query(`UPDATE users SET on_letterhead=$1,letterhead_order=$2 WHERE id=$3 AND hospital_id=$4`, [d.show, i + 1, d.id, req.user.hospitalId]);
    await client.query(`UPDATE hospitals SET weekly_off=$1::smallint[],timings=$2::jsonb,updated_at=NOW() WHERE id=$3`, [weeklyOff, JSON.stringify({ show: body.showTimings, sessions: body.sessions }), req.user.hospitalId]);
  });
  res.json(await payload(req.user.hospitalId));
}));

// Read the real image header (not just the declared type) and the pixel size where the format makes it cheap.
function inspectImage(buf) {
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg' };
  if (buf.length > 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return { mime: 'image/webp' };
  }
  return null;
}

router.put('/logo', allow('ADMIN'), asyncHandler(async (req, res) => {
  const { image } = z.object({ image: z.string().max(400_000) }).parse(req.body);
  const m = new RegExp('^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$').exec(image);
  if (!m) throw badRequest('Upload a PNG, JPEG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_LOGO_BYTES) throw badRequest('The logo is too large. Crop it smaller and try again.');
  const info = inspectImage(buf);
  if (!info || info.mime !== m[1]) throw badRequest('This file is not a valid PNG, JPEG or WebP image');
  if (info.width && (info.width > MAX_LOGO_SIDE || info.height > MAX_LOGO_SIDE)) throw badRequest(`The logo can be at most ${MAX_LOGO_SIDE} × ${MAX_LOGO_SIDE} pixels`);
  // one UPDATE: the previous logo is replaced only now that the new one is accepted and stored
  const q = await pool.query(`UPDATE hospitals SET logo_data=$1,logo_mime=$2,logo_updated_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING ${COLS}`, [buf, info.mime, req.user.hospitalId]);
  res.json(await payload(req.user.hospitalId));
}));

router.delete('/logo', allow('ADMIN'), asyncHandler(async (req, res) => {
  const q = await pool.query(`UPDATE hospitals SET logo_data=NULL,logo_mime=NULL,logo_updated_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [req.user.hospitalId]);
  res.json(await payload(req.user.hospitalId));
}));

router.put('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2).max(160),
    mobile: z.union([z.literal(''), mobileSchema]).optional().default(''),
    address: z.string().max(1000).optional().default(''),
  }).parse(req.body);
  const q = await pool.query(
    `UPDATE hospitals SET name=$1,mobile=$2,address=$3,updated_at=NOW() WHERE id=$4 RETURNING ${COLS}`,
    [data.name, data.mobile || null, data.address || null, req.user.hospitalId]
  );
  res.json(await payload(req.user.hospitalId));
}));

export default router;
