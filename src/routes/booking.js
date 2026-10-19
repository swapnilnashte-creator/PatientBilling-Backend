// Public online booking. No sign-in. This router never reads or returns patient data: it gives out the hospital's name, its doctors
// and free times, and it accepts a booking. A patient's own QR code only ever resolves to the hospital's booking address.
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { mobileSchema } from '../mobile.js';
import { bookableDays, hospitalHours, istDay, istTime, slotInstant, slotsOfDay } from '../bookingSlots.js';
import { todayIst } from '../vaccination.js';

const router = Router();
const SECRET = () => String(process.env.JWT_SECRET || 'dev-secret');
const isProduction = () => process.env.NODE_ENV === 'production';

// What a new hospital starts with; the Admin changes the list in Hospital Settings. Severity: LOW normal, MEDIUM moderate, HIGH urgent.
export const DEFAULT_REASONS = [['Fever', 'MEDIUM'], ['Cold or cough', 'LOW'], ['Stomach pain', 'MEDIUM'], ['Vomiting or loose motions', 'MEDIUM'], ['Headache', 'LOW'], ['Body pain', 'LOW'], ['Skin problem', 'LOW'], ['Injury', 'HIGH'], ['Vaccination', 'LOW'], ['Follow-up visit', 'LOW'], ['Routine check-up', 'LOW'], ['Report review', 'LOW']];
export const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };
export const worst = (list) => list.reduce((w, x) => (SEVERITY_RANK[x] > SEVERITY_RANK[w] ? x : w), 'LOW');
// the hospital's own list, in the order the Admin set; a hospital that has none yet gets the defaults
export async function hospitalReasons(hospitalId, db = pool) {
  let q = await db.query('SELECT name,severity FROM booking_reasons WHERE hospital_id=$1 ORDER BY position,id', [hospitalId]);
  if (!q.rowCount) {
    for (const [i, [name, severity]] of DEFAULT_REASONS.entries()) {
      await db.query('INSERT INTO booking_reasons(hospital_id,name,severity,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [hospitalId, name, severity, i + 1]);
    }
    q = await db.query('SELECT name,severity FROM booking_reasons WHERE hospital_id=$1 ORDER BY position,id', [hospitalId]);
  }
  return q.rows;
}

// the most bookings one hospital takes online in an hour and in a day; beyond that booking pauses and the staff are warned
export const BURST = { perHour: 40, perDay: 300 };
const MIN_FILL_MS = 4000;          // a person needs a few seconds to fill the form; a script does not
const MAX_FILL_MS = 3 * 3600e3;
const hash = (value) => crypto.createHmac('sha256', SECRET()).update(String(value)).digest('hex');

// ---- light limit for every public call from one device: 90 calls a minute ----
const calls = new Map();
router.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || 'x';
  const list = (calls.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= 90) return res.status(429).json({ message: 'Too many requests. Please wait a minute and try again.' });
  list.push(now); calls.set(key, list);
  if (calls.size > 5000) for (const [k, v] of calls) if (!v.some(t => now - t < 60000)) calls.delete(k);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});

// the form carries a stamp from the server, so a bot that posts at once is turned away
const makeStamp = () => { const t = Date.now(); return `${t}.${hash(`form:${t}`).slice(0, 32)}`; };
function checkStamp(stamp) {
  const [t, sig] = String(stamp || '').split('.');
  if (!t || !sig || sig !== hash(`form:${t}`).slice(0, 32)) return false;
  const age = Date.now() - Number(t);
  return age >= MIN_FILL_MS && age <= MAX_FILL_MS;
}

const captchaSecret = () => String(process.env.TURNSTILE_SECRET || '').trim();
const captchaSiteKey = () => String(process.env.TURNSTILE_SITE_KEY || '').trim();
// online booking needs the captcha in production; in development it is skipped
const captchaReady = () => (captchaSecret() && captchaSiteKey()) || !isProduction();

async function verifyCaptcha(token, ip) {
  if (!captchaSecret()) return true; // development only: captchaReady() blocks production without it
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: captchaSecret(), response: String(token), remoteip: ip || '' });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j.success === true;
  } catch (err) {
    console.error('Turnstile check failed', err.message);
    return false;
  }
}

async function hospitalBySlug(slug) {
  const clean = String(slug || '').toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(clean)) throw notFound('This booking page was not found');
  const q = await pool.query(
    `SELECT id,name,mobile,address,booking_advance_days FROM hospitals
     WHERE lower(booking_slug)=$1 AND booking_enabled=TRUE AND is_active=TRUE AND deactivated_at IS NULL`,
    [clean]
  );
  if (!q.rowCount) throw notFound('Online booking is not available for this address');
  return q.rows[0];
}

// The public side knows a doctor only by a private code, never by the database number.
export async function ensureDoctorCodes(hospitalId) {
  await pool.query(`UPDATE users SET booking_code=substr(replace(gen_random_uuid()::text,'-',''),1,10) WHERE hospital_id=$1 AND role='DOCTOR' AND booking_code IS NULL`, [hospitalId]);
}
async function bookableDoctors(hospitalId, onlyCode = null) {
  await ensureDoctorCodes(hospitalId);
  const q = await pool.query(
    `SELECT u.id,u.name,u.qualification,u.booking_code FROM users u
     WHERE u.hospital_id=$1 AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL AND u.online_booking=TRUE
       AND EXISTS (SELECT 1 FROM doctor_schedules s WHERE s.hospital_id=u.hospital_id AND s.doctor_id=u.id)
       AND ($2::text IS NULL OR u.booking_code=$2)
     ORDER BY u.name`,
    [hospitalId, onlyCode]
  );
  return q.rows.map(r => ({ id: Number(r.id), code: r.booking_code, name: r.name, qualification: r.qualification || '' }));
}
const publicDoctor = (d) => ({ code: d.code, name: d.name, qualification: d.qualification });

const loadSchedules = async (hospitalId, doctorId) => (await pool.query(
  `SELECT weekday,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS "end",slot_minutes AS "slotMinutes",per_slot AS "perSlot"
   FROM doctor_schedules WHERE hospital_id=$1 AND doctor_id=$2`, [hospitalId, doctorId])).rows;

// Free slots for the days a patient may book: [{ day, slots: [{ time, at }] }] (days with nothing free are left out)
async function freeSlots(hospital, doctorId) {
  const days = bookableDays(hospital.booking_advance_days);
  const schedules = await loadSchedules(hospital.id, doctorId);
  const hours = await hospitalHours(hospital.id);
  const off = new Set((await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day FROM doctor_days_off WHERE hospital_id=$1 AND doctor_id=$2 AND day BETWEEN $3 AND $4`,
    [hospital.id, doctorId, days[0], days[days.length - 1]])).rows.map(r => r.day));
  const taken = new Map();
  (await pool.query(
    `SELECT slot_at,COUNT(*)::int AS n FROM appointments
     WHERE hospital_id=$1 AND doctor_id=$2 AND slot_day BETWEEN $3 AND $4 AND status IN ('BOOKED','ARRIVED') GROUP BY slot_at`,
    [hospital.id, doctorId, days[0], days[days.length - 1]])).rows.forEach(r => taken.set(new Date(r.slot_at).getTime(), r.n));
  const now = Date.now();
  const out = [];
  for (const day of days) {
    if (off.has(day)) continue;
    const slots = slotsOfDay(day, schedules, hours)
      .map(s => ({ time: s.time, at: slotInstant(day, s.time), perSlot: s.perSlot }))
      .filter(s => s.at.getTime() > now && (taken.get(s.at.getTime()) || 0) < s.perSlot)
      .map(s => ({ time: s.time, at: s.at.toISOString() }));
    if (slots.length) out.push({ day, slots });
  }
  return out;
}

// ---- the hospital's booking page: name, doctors, and what the form needs ----
router.get('/h/:slug', asyncHandler(async (req, res) => {
  const hospital = await hospitalBySlug(req.params.slug);
  res.json({
    hospital: { name: hospital.name, mobile: hospital.mobile || '', address: hospital.address || '', hours: await hospitalHours(hospital.id) },
    doctors: (await bookableDoctors(hospital.id)).map(publicDoctor),
    reasons: await hospitalReasons(hospital.id),
    advanceDays: hospital.booking_advance_days,
    available: captchaReady(),
    captchaSiteKey: captchaSecret() ? captchaSiteKey() : '',
    stamp: makeStamp(),
  });
}));

router.get('/h/:slug/slots', asyncHandler(async (req, res) => {
  const hospital = await hospitalBySlug(req.params.slug);
  const code = z.string().regex(/^[a-z0-9]{6,16}$/).parse(String(req.query.doctor || ''));
  const [doctor] = await bookableDoctors(hospital.id, code);
  if (!doctor) throw notFound('This doctor is not taking online bookings');
  res.json({ doctor: publicDoctor(doctor), days: await freeSlots(hospital, doctor.id) });
}));

// A patient's QR (printed on their bill or pad) only tells the page which hospital it belongs to. Nothing about the patient is returned.
router.get('/code/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(code)) throw notFound('This code is not valid');
  const q = await pool.query(
    `SELECT h.booking_slug FROM patients p JOIN hospitals h ON h.id=p.hospital_id
     WHERE p.qr_code=$1 AND p.deleted_at IS NULL AND h.booking_enabled=TRUE AND h.booking_slug IS NOT NULL`, [code]);
  if (!q.rowCount) throw notFound('Online booking is not available for this code');
  res.json({ slug: q.rows[0].booking_slug });
}));

// ---- booking ----
const bookSchema = z.object({
  doctor: z.string().regex(/^[a-z0-9]{6,16}$/),
  slotAt: z.string().datetime({ offset: true }),
  stamp: z.string().max(100),
  captcha: z.string().max(4096).optional().default(''),
  website: z.string().max(200).optional().default(''), // hidden field; people leave it empty
  patientCode: z.string().max(40).optional(),
  fullName: z.string().trim().min(2).max(160).optional(),
  mobile: mobileSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  dateOfBirth: z.string().date().optional(),
  age: z.number().int().min(0).max(365).optional(),
  ageUnit: z.enum(['YEARS', 'MONTHS', 'DAYS']).optional(),
  reasons: z.array(z.string().trim().min(1).max(60)).max(12).optional().default([]),
  reasonNote: z.string().trim().max(200).optional().default(''),
});

const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newReference = () => Array.from(crypto.randomBytes(8), b => REF_CHARS[b % REF_CHARS.length]).join('');

// counts attempts from one device and one mobile; older entries are removed as we go
async function tooMany(hospitalId, kind, key, limit, windowSql) {
  const q = await pool.query(`SELECT COUNT(*)::int AS n FROM booking_hits WHERE kind=$1 AND key_hash=$2 AND created_at > NOW() - ${windowSql}`, [kind, key]);
  return q.rows[0].n >= limit;
}

router.post('/h/:slug/book', asyncHandler(async (req, res) => {
  const hospital = await hospitalBySlug(req.params.slug);
  const d = bookSchema.parse(req.body);
  const [chosen] = await bookableDoctors(hospital.id, d.doctor);
  if (!chosen) throw badRequest('This doctor is not taking online bookings');
  d.doctorId = chosen.id;
  if (!captchaReady()) throw Object.assign(new Error('Online booking is not available right now. Please call the hospital.'), { status: 503 });
  if (d.website) throw badRequest('We could not accept this booking. Please try again.');
  if (!checkStamp(d.stamp)) throw badRequest('That was too quick, or the page was open too long. Please reload the page and try again.');

  // who is booking: a patient's own code (no details asked), or the details of a new patient
  let who;
  if (d.patientCode) {
    const code = d.patientCode.trim().toLowerCase();
    const pq = await pool.query(
      `SELECT id,full_name,mobile,gender,to_char(date_of_birth,'YYYY-MM-DD') AS dob,dob_estimated FROM patients
       WHERE hospital_id=$1 AND qr_code=$2 AND deleted_at IS NULL`, [hospital.id, code]);
    if (!pq.rowCount) throw badRequest('This code is not valid. Please enter your details instead.');
    const p = pq.rows[0];
    // name, mobile, gender and age or date of birth are all needed to book; an older record that lacks one asks for the details instead
    if (!p.full_name || !p.mobile || !p.gender || !p.dob) throw Object.assign(new Error('Some of your details are not on file yet. Please enter them to book.'), { status: 422, needDetails: true });
    who = { patientId: Number(p.id), fullName: p.full_name, mobile: p.mobile, gender: p.gender, dob: p.dob, dobEstimated: p.dob_estimated, source: 'QR', reasons: [], reasonNote: '', severity: 'LOW' };
  } else {
    if (!d.fullName || !d.mobile || !d.gender) throw badRequest('Please enter your name, mobile number and gender');
    if (!d.dateOfBirth && d.age === undefined) throw badRequest('Please enter the date of birth or the age');
    if (d.dateOfBirth && d.dateOfBirth > todayIst()) throw badRequest('Date of birth cannot be in the future');
    if (d.age !== undefined && d.age > ({ YEARS: 120, MONTHS: 59, DAYS: 365 })[d.ageUnit || 'YEARS']) throw badRequest('Age is too high for the chosen unit');
    const ownReasons = await hospitalReasons(hospital.id);
    const reasons = [...new Set(d.reasons)].filter(r => ownReasons.some(x => x.name === r));
    const severity = worst(reasons.map(r => ownReasons.find(x => x.name === r).severity));
    if (!reasons.length && !d.reasonNote) throw badRequest('Please choose at least one reason for the visit, or write it');
    let dob = d.dateOfBirth || null;
    if (!dob) {
      const unit = d.ageUnit || 'YEARS';
      const dq = await pool.query(`SELECT to_char(CURRENT_DATE - ($1::int * CASE $2::text WHEN 'MONTHS' THEN INTERVAL '1 month' WHEN 'DAYS' THEN INTERVAL '1 day' ELSE INTERVAL '1 year' END), 'YYYY-MM-DD') AS dob`, [d.age, unit]);
      dob = dq.rows[0].dob;
    }
    who = { patientId: null, fullName: d.fullName.replace(/\s+/g, ' '), mobile: d.mobile, gender: d.gender, dob, dobEstimated: !d.dateOfBirth, source: 'WEB', reasons, reasonNote: d.reasonNote, severity };
  }

  // the captcha, then limits per device and per mobile number
  if (!(await verifyCaptcha(d.captcha, req.ip))) throw badRequest('Please complete the check ("I am not a robot") and try again.');
  // a number the hospital has blocked gets the same plain refusal as any other failure
  const blocked = await pool.query('SELECT 1 FROM blocked_mobiles WHERE hospital_id=$1 AND mobile=$2', [hospital.id, who.mobile]);
  if (blocked.rowCount) throw badRequest('We could not accept this booking. Please call the hospital.');
  // unusually many bookings at once: pause online booking for this hospital for a while and tell the staff
  const burst = await pool.query(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS h, COUNT(*)::int AS d FROM appointments WHERE hospital_id=$1 AND created_at > NOW() - INTERVAL '1 day'`, [hospital.id]);
  if (burst.rows[0].h >= BURST.perHour || burst.rows[0].d >= BURST.perDay) {
    await pool.query(`INSERT INTO booking_hits(hospital_id,kind,key_hash) VALUES($1,'cap','cap')`, [hospital.id]);
    throw Object.assign(new Error('Online booking is very busy right now. Please try again later, or call the hospital.'), { status: 429 });
  }
  const ipKey = hash(`ip:${req.ip}`);
  const mobileKey = hash(`mobile:${hospital.id}:${who.mobile}`);
  if (await tooMany(hospital.id, 'ip', ipKey, 30, `INTERVAL '1 hour'`) || await tooMany(hospital.id, 'mobile', mobileKey, 6, `INTERVAL '1 day'`)) {
    throw Object.assign(new Error('Too many booking attempts. Please try again later, or call the hospital.'), { status: 429 });
  }
  await pool.query(`INSERT INTO booking_hits(hospital_id,kind,key_hash) VALUES($1,'ip',$2),($1,'mobile',$3)`, [hospital.id, ipKey, mobileKey]);
  pool.query(`DELETE FROM booking_hits WHERE created_at < NOW() - INTERVAL '2 days'`).catch(() => {});

  const slotAt = new Date(d.slotAt);
  const day = istDay(slotAt);
  const time = istTime(slotAt);
  const row = await withTransaction(async (client) => {
    // two people booking the last place of a slot are served one after the other
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`appt:${hospital.id}:${d.doctorId}`]);
    const doc = await client.query(
      `SELECT u.id,u.name FROM users u WHERE u.hospital_id=$1 AND u.id=$2 AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL AND u.online_booking=TRUE`,
      [hospital.id, d.doctorId]);
    if (!doc.rowCount) throw badRequest('This doctor is not taking online bookings');
    if (!bookableDays(hospital.booking_advance_days).includes(day) || slotAt.getTime() <= Date.now()) throw badRequest('That time is not open for booking. Please choose another.');
    const sched = (await client.query(
      `SELECT weekday,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS "end",slot_minutes AS "slotMinutes",per_slot AS "perSlot"
       FROM doctor_schedules WHERE hospital_id=$1 AND doctor_id=$2`, [hospital.id, d.doctorId])).rows;
    const slot = slotsOfDay(day, sched, await hospitalHours(hospital.id, client)).find(s => s.time === time);
    const off = await client.query(`SELECT 1 FROM doctor_days_off WHERE hospital_id=$1 AND doctor_id=$2 AND day=$3`, [hospital.id, d.doctorId, day]);
    if (!slot || off.rowCount) throw badRequest('That time is not open for booking. Please choose another.');
    // the same person, doctor and day: the same request sent twice (a double tap) gets the booking already made; a different time is refused
    const dupe = await client.query(
      `SELECT reference,slot_at,ip_hash FROM appointments WHERE hospital_id=$1 AND doctor_id=$2 AND slot_day=$3 AND mobile=$4 AND lower(full_name)=lower($5) AND status='BOOKED' LIMIT 1`,
      [hospital.id, d.doctorId, day, who.mobile, who.fullName]);
    if (dupe.rowCount) {
      const old = dupe.rows[0];
      if (new Date(old.slot_at).getTime() === slotAt.getTime() && old.ip_hash === ipKey) return { reference: old.reference, doctorName: doc.rows[0].name };
      throw Object.assign(new Error(`You already have an appointment with this doctor on that day, at ${istTime(old.slot_at)}. To change it, please call the hospital${hospital.mobile ? ` on ${hospital.mobile}` : ''}.`), { status: 409, duplicate: true });
    }
    const used = await client.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE hospital_id=$1 AND doctor_id=$2 AND slot_at=$3 AND status IN ('BOOKED','ARRIVED')`, [hospital.id, d.doctorId, slotAt]);
    if (used.rows[0].n >= slot.perSlot) throw Object.assign(new Error('Sorry, that time was just taken. Please choose another.'), { status: 409 });
    const live = await client.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE hospital_id=$1 AND mobile=$2 AND status='BOOKED' AND slot_at > NOW()`, [hospital.id, who.mobile]);
    if (live.rows[0].n >= 4) throw badRequest('This mobile number already has several upcoming appointments. Please call the hospital.');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = newReference();
      const ins = await client.query(
        `INSERT INTO appointments(hospital_id,reference,doctor_id,slot_at,slot_day,patient_id,full_name,mobile,gender,date_of_birth,dob_estimated,reasons,reason_note,source,ip_hash,severity)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (hospital_id, reference) DO NOTHING RETURNING reference`,
        [hospital.id, reference, d.doctorId, slotAt, day, who.patientId, who.fullName, who.mobile, who.gender, who.dob, who.dobEstimated, who.reasons, who.reasonNote || null, who.source, ipKey, who.severity]);
      if (ins.rowCount) return { reference, doctorName: doc.rows[0].name };
    }
    throw new Error('Could not create a booking reference');
  });
  res.status(201).json({ reference: row.reference, doctorName: row.doctorName, hospitalName: hospital.name, slotAt: slotAt.toISOString(), day, time });
}));

// ---- the patient moves their own booking to another time ----
// Who may: whoever knows the booking number AND the mobile number it was made with. Only a booking that is still waiting, up to an hour
// before its time, and at most twice. The doctor stays the same. Every try is counted per device, so the pair cannot be guessed.
export const RESCHEDULE = { max: 2, cutoffMinutes: 60 };
const manageSchema = z.object({ reference: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/), mobile: mobileSchema });
const NOT_FOUND = 'We could not find a booking with this booking number and mobile number. Please check both and try again.';

async function ownBooking(db, hospital, d) {
  const q = await db.query(
    `SELECT a.id,a.doctor_id,a.slot_at,a.reschedule_count,u.name AS doctor_name,u.qualification,u.booking_code
     FROM appointments a JOIN users u ON u.hospital_id=a.hospital_id AND u.id=a.doctor_id
     WHERE a.hospital_id=$1 AND a.reference=$2 AND a.mobile=$3 AND a.status='BOOKED'`, [hospital.id, d.reference, d.mobile]);
  return q.rows[0] || null;
}
function canMove(row) {
  if (new Date(row.slot_at).getTime() - Date.now() < RESCHEDULE.cutoffMinutes * 60000) return { ok: false, reason: `A booking can be changed up to ${RESCHEDULE.cutoffMinutes} minutes before its time. Please call the hospital.` };
  if (row.reschedule_count >= RESCHEDULE.max) return { ok: false, reason: 'This booking has already been changed twice. Please call the hospital to change it again.' };
  return { ok: true, reason: '' };
}
async function manageLimit(hospital, req) {
  const key = hash(`manage:${req.ip}`);
  if (await tooMany(hospital.id, 'manage', key, 25, `INTERVAL '1 hour'`)) throw Object.assign(new Error('Too many tries. Please wait a while, or call the hospital.'), { status: 429 });
  await pool.query(`INSERT INTO booking_hits(hospital_id,kind,key_hash) VALUES($1,'manage',$2)`, [hospital.id, key]);
}

router.post('/h/:slug/manage/find', asyncHandler(async (req, res) => {
  const hospital = await hospitalBySlug(req.params.slug);
  const parsed = manageSchema.safeParse(req.body);
  await manageLimit(hospital, req);
  if (!parsed.success) throw notFound(NOT_FOUND);
  const row = await ownBooking(pool, hospital, parsed.data);
  if (!row) throw notFound(NOT_FOUND);
  const can = canMove(row);
  res.json({
    doctor: { code: row.booking_code, name: row.doctor_name, qualification: row.qualification || '' },
    day: istDay(row.slot_at), time: istTime(row.slot_at), slotAt: new Date(row.slot_at).toISOString(),
    canChange: can.ok, reason: can.reason, changesLeft: Math.max(0, RESCHEDULE.max - row.reschedule_count),
  });
}));

router.post('/h/:slug/manage/reschedule', asyncHandler(async (req, res) => {
  const hospital = await hospitalBySlug(req.params.slug);
  if (!captchaReady()) throw Object.assign(new Error('Online booking is not available right now. Please call the hospital.'), { status: 503 });
  const d = manageSchema.extend({ slotAt: z.string().datetime({ offset: true }), stamp: z.string().max(100), captcha: z.string().max(4096).optional().default(''), website: z.string().max(200).optional().default('') }).parse(req.body);
  if (d.website) throw badRequest('We could not accept this change. Please try again.');
  if (!checkStamp(d.stamp)) throw badRequest('That was too quick, or the page was open too long. Please reload the page and try again.');
  if (!(await verifyCaptcha(d.captcha, req.ip))) throw badRequest('Please complete the check ("I am not a robot") and try again.');
  await manageLimit(hospital, req);
  const slotAt = new Date(d.slotAt);
  const day = istDay(slotAt); const time = istTime(slotAt);
  const out = await withTransaction(async (client) => {
    const own = await ownBooking(client, hospital, d);
    if (!own) throw notFound(NOT_FOUND);
    // two people changing into the last place of a slot are served one after the other
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`appt:${hospital.id}:${own.doctor_id}`]);
    const can = canMove(own);
    if (!can.ok) throw badRequest(can.reason);
    if (new Date(own.slot_at).getTime() === slotAt.getTime()) throw badRequest('That is the time you already have. Please choose another.');
    const doc = await client.query(`SELECT 1 FROM users u WHERE u.hospital_id=$1 AND u.id=$2 AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL AND u.online_booking=TRUE`, [hospital.id, own.doctor_id]);
    if (!doc.rowCount) throw badRequest('This doctor is not taking online bookings. Please call the hospital.');
    if (!bookableDays(hospital.booking_advance_days).includes(day) || slotAt.getTime() <= Date.now() + RESCHEDULE.cutoffMinutes * 60000) throw badRequest('That time is not open for booking. Please choose another.');
    const sched = (await client.query(
      `SELECT weekday,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS "end",slot_minutes AS "slotMinutes",per_slot AS "perSlot"
       FROM doctor_schedules WHERE hospital_id=$1 AND doctor_id=$2`, [hospital.id, own.doctor_id])).rows;
    const slot = slotsOfDay(day, sched, await hospitalHours(hospital.id, client)).find(x => x.time === time);
    const off = await client.query(`SELECT 1 FROM doctor_days_off WHERE hospital_id=$1 AND doctor_id=$2 AND day=$3`, [hospital.id, own.doctor_id, day]);
    if (!slot || off.rowCount) throw badRequest('That time is not open for booking. Please choose another.');
    const used = await client.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE hospital_id=$1 AND doctor_id=$2 AND slot_at=$3 AND status IN ('BOOKED','ARRIVED')`, [hospital.id, own.doctor_id, slotAt]);
    if (used.rows[0].n >= slot.perSlot) throw Object.assign(new Error('Sorry, that time was just taken. Please choose another.'), { status: 409 });
    try {
      // the booking number stays the same; the staff see that it was moved, and an old WhatsApp message no longer matches
      await client.query(
        `UPDATE appointments SET slot_at=$3,slot_day=$4,previous_slot_at=slot_at,reschedule_count=reschedule_count+1,whatsapp_sent_at=NULL,whatsapp_sent_by=NULL WHERE hospital_id=$1 AND id=$2`,
        [hospital.id, own.id, slotAt, day]);
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('You already have another appointment with this doctor on that day. Please choose another day.'), { status: 409 });
      throw err;
    }
    return { doctorName: own.doctor_name, left: Math.max(0, RESCHEDULE.max - own.reschedule_count - 1) };
  });
  res.json({ reference: d.reference, doctorName: out.doctorName, hospitalName: hospital.name, slotAt: slotAt.toISOString(), day, time, changesLeft: out.left });
}));

export default router;
