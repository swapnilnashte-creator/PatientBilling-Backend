import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { mobileSchema } from '../mobile.js';
import { captchaReady, captchaSecret, captchaSiteKey, checkStamp, makeStamp, verifyCaptcha } from './booking.js';

// The public "My diet" page (user decisions 2026-11-21): one address for every diet client. The client types their mobile number, the 4-digit
// PIN their dietitian set, and passes the captcha (Cloudflare Turnstile) every time; the page then lists the programmes on that number whose PIN
// matches (several clinics or several people on one number each have their own PIN). Five wrong PINs lock a programme for 24 hours.
// It shows the progress chart, the plan for today and lets the client enter today's weight (marked as entered by the client).
// A short-lived pass (30 minutes) carries the number and the programmes the PIN opened; every call checks them again.
const router = Router();
const PASS_MINUTES = 30;
const passSecret = () => `${process.env.JWT_SECRET || 'dev-secret'}:diet-client`; // not valid as a staff login
const day = (col) => `to_char(${col},'YYYY-MM-DD')`;
const TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
const JUMP_KG = 3;
const PIN_TRIES = 5; // wrong PINs in a row before the page locks for that programme
const PIN_LOCK_HOURS = 24;
const WRONG = 'The mobile number or the PIN is not right. Check them, or ask your dietitian.';

// ---- limits: every call from one device, and look-ups per device and per number (kept in memory) ----
const buckets = new Map();
function over(key, limit, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) { buckets.set(key, list); return true; }
  list.push(now); buckets.set(key, list);
  if (buckets.size > 20000) for (const [k, v] of buckets) if (!v.some(t => now - t < 86400000)) buckets.delete(k);
  return false;
}
const tooMany = (message) => Object.assign(new Error(message), { status: 429 });
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  if (over(`all:${req.ip}`, 60, 60000)) return res.status(429).json({ message: 'Too many requests. Please wait a minute and try again.' });
  next();
});

// the hospitals whose diet module is on (an active dietitian) and which are open
const LIVE_HOSPITAL = `h.is_active=TRUE AND h.deactivated_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.hospital_id=h.id AND u.role='DOCTOR' AND u.speciality='DIETITIAN' AND u.is_active=TRUE AND u.deleted_at IS NULL)`;

function readPass(req) {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const p = jwt.verify(raw, passSecret());
    if (p.kind !== 'diet-client' || !/^\d{10}$/.test(String(p.m)) || !Array.isArray(p.p)) throw new Error('bad');
    return { mobile: p.m, ids: p.p.map(Number) };
  } catch { throw Object.assign(new Error('Please enter your mobile number again.'), { status: 401, needLogin: true }); }
}

router.get('/config', asyncHandler(async (_req, res) => {
  res.json({ available: Boolean(captchaReady()), captchaSiteKey: captchaSecret() ? captchaSiteKey() : '', stamp: makeStamp() });
}));

// ---- the number and the captcha: the clinics and patients on that number that have a diet programme ----
router.post('/find', asyncHandler(async (req, res) => {
  const d = z.object({ mobile: mobileSchema, pin: z.string().regex(/^\d{4}$/, 'Enter the 4-digit PIN your dietitian gave you'), captcha: z.string().max(4096).optional().default(''), stamp: z.string().max(100), website: z.string().max(200).optional().default('') }).parse(req.body);
  if (!captchaReady()) throw Object.assign(new Error('This page is not available right now. Please call your clinic.'), { status: 503 });
  if (d.website) throw badRequest('We could not check this number. Please try again.');
  if (!checkStamp(d.stamp)) throw badRequest('That was too quick, or the page was open too long. Please reload the page and try again.');
  if (!(await verifyCaptcha(d.captcha, req.ip))) throw badRequest('Please complete the check ("I am not a robot") and try again.');
  if (over(`find-ip:${req.ip}`, 20, 3600e3)) throw tooMany('Too many tries from this device. Please try again in an hour.');
  if (over(`find-m:${d.mobile}`, 15, 3600e3)) throw tooMany('Too many tries for this number. Please try again in an hour.');
  // each patient on the number, in each open clinic with a dietitian, with their latest programme (a running one first)
  const q = await pool.query(
    `SELECT DISTINCT ON (pt.id) h.id AS hospital_id,h.name AS hospital_name,pt.id AS patient_id,pt.full_name,p.id AS programme_id,p.status,${day('p.start_date')} AS start_date,d.name AS doctor_name,
       p.client_pin_hash,(p.client_pin_locked_until > NOW()) AS locked
     FROM patients pt JOIN hospitals h ON h.id=pt.hospital_id
     JOIN diet_programmes p ON p.patient_id=pt.id AND p.hospital_id=pt.hospital_id
     JOIN users d ON d.id=p.doctor_id AND d.hospital_id=p.hospital_id
     WHERE pt.mobile=$1 AND pt.deleted_at IS NULL AND ${LIVE_HOSPITAL}
     ORDER BY pt.id, (p.status='ACTIVE') DESC, p.start_date DESC, p.id DESC`, [d.mobile]);
  // the PIN: each candidate programme (latest per person on the number) is checked; wrong tries count on every unlocked one that has a PIN
  const open = [];
  for (const r of q.rows) if (r.client_pin_hash && !r.locked && (await bcrypt.compare(d.pin, r.client_pin_hash))) open.push(r);
  if (!open.length) {
    const tried = q.rows.filter(r => r.client_pin_hash && !r.locked).map(r => Number(r.programme_id));
    const now = tried.length ? (await pool.query(
      `UPDATE diet_programmes SET client_pin_fails=client_pin_fails+1, client_pin_locked_until=CASE WHEN client_pin_fails+1 >= $2 THEN NOW() + make_interval(hours => $3) ELSE client_pin_locked_until END WHERE id=ANY($1::bigint[]) RETURNING id,(client_pin_locked_until > NOW()) AS locked`,
      [tried, PIN_TRIES, PIN_LOCK_HOURS])).rows : [];
    const lockedNow = new Set(now.filter(x => x.locked).map(x => Number(x.id)));
    // every programme on the number is now locked (this try was the 5th wrong one, or they were locked before): say so
    if (q.rows.length && q.rows.every(r => r.locked || !r.client_pin_hash || lockedNow.has(Number(r.programme_id))) && q.rows.some(r => r.locked || lockedNow.has(Number(r.programme_id)))) throw tooMany(`Too many wrong PINs. Please try again after ${PIN_LOCK_HOURS} hours, or ask your dietitian for a new PIN.`);
    throw badRequest(WRONG);
  }
  await pool.query(`UPDATE diet_programmes SET client_pin_fails=0 WHERE id=ANY($1::bigint[]) AND client_pin_fails<>0`, [open.map(r => Number(r.programme_id))]);
  const clinics = [];
  for (const r of open.sort((a, b) => a.hospital_name.localeCompare(b.hospital_name) || a.full_name.localeCompare(b.full_name))) {
    let c = clinics.find(x => x.id === Number(r.hospital_id));
    if (!c) { c = { id: Number(r.hospital_id), name: r.hospital_name, clients: [] }; clinics.push(c); }
    c.clients.push({ programmeId: Number(r.programme_id), name: r.full_name, dietitian: r.doctor_name, status: r.status, startDate: r.start_date });
  }
  const pass = jwt.sign({ kind: 'diet-client', m: d.mobile, p: open.map(r => Number(r.programme_id)) }, passSecret(), { expiresIn: `${PASS_MINUTES}m` });
  res.json({ pass, minutes: PASS_MINUTES, clinics });
}));

// the programme, only when it belongs to a patient with the number on the pass
async function programmeFor(client, { mobile, ids }, id) {
  if (!ids.includes(Number(id))) throw notFound('This programme was not found for your number.');
  const q = await client.query(
    `SELECT p.id,p.hospital_id,p.patient_id,p.status,${day('p.start_date')} AS start_date,p.goal_weight_kg,p.height_cm,${day('p.goal_date')} AS goal_date,
       pt.full_name,pt.gender,h.name AS hospital_name,h.mobile AS hospital_mobile,d.name AS doctor_name,d.qualification AS doctor_qualification,${day(TODAY_SQL)} AS today
     FROM diet_programmes p JOIN patients pt ON pt.id=p.patient_id AND pt.hospital_id=p.hospital_id JOIN hospitals h ON h.id=p.hospital_id
     JOIN users d ON d.id=p.doctor_id AND d.hospital_id=p.hospital_id
     WHERE p.id=$1 AND pt.mobile=$2 AND pt.deleted_at IS NULL AND p.client_pin_hash IS NOT NULL AND (p.client_pin_locked_until IS NULL OR p.client_pin_locked_until <= NOW()) AND ${LIVE_HOSPITAL}`, [id, mobile]);
  if (!q.rowCount) throw notFound('This programme was not found for your number.');
  return q.rows[0];
}
const planOut = (r) => r && { start: r.s, end: r.e, meals: (r.meals || []).map(m => ({ time: m.time, text: m.text })), kcal: r.kcal, proteinG: r.protein_g, instructions: r.instructions || '' };

router.get('/programme/:id', asyncHandler(async (req, res) => {
  const who = readPass(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const p = await programmeFor(pool, who, id);
  const weights = (await pool.query(`SELECT ${day('on_date')} AS date,weight_kg,by_client FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date>=$3::date ORDER BY on_date`, [p.hospital_id, p.patient_id, p.start_date]))
    .rows.map(r => ({ date: r.date, kg: Number(r.weight_kg), byClient: r.by_client }));
  const plans = (await pool.query(`SELECT ${day('week_start')} AS s,${day('week_end')} AS e,meals,kcal,protein_g,instructions FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_end>=$3::date ORDER BY week_start`, [p.hospital_id, p.id, p.today])).rows;
  const current = plans.find(x => x.s <= p.today && p.today <= x.e) || null;
  const next = plans.find(x => x.s > p.today) || null;
  const todayRow = weights.find(w => w.date === p.today) || null;
  res.json({
    today: p.today,
    clinic: { name: p.hospital_name, mobile: p.hospital_mobile || '' },
    client: { name: p.full_name, gender: p.gender },
    dietitian: { name: p.doctor_name, qualification: p.doctor_qualification || '' },
    programme: { id: Number(p.id), status: p.status, startDate: p.start_date, goalWeightKg: p.goal_weight_kg === null ? null : Number(p.goal_weight_kg), goalDate: p.goal_date, heightCm: p.height_cm === null ? null : Number(p.height_cm) },
    weights, plan: planOut(current), nextPlan: planOut(next),
    todayWeight: todayRow,
    // the client enters today's weight while the programme runs, unless the clinic already recorded today's
    canWeigh: p.status === 'ACTIVE' && p.start_date <= p.today && !(todayRow && !todayRow.byClient),
  });
}));

router.put('/programme/:id/weight', asyncHandler(async (req, res) => {
  const who = readPass(req);
  const { mobile } = who;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const d = z.object({ weightKg: z.number().min(10, 'Enter your weight in kg').max(300, 'Enter your weight in kg'), confirm: z.boolean().optional() }).parse(req.body);
  if (over(`weigh:${mobile}`, 20, 3600e3) || over(`weigh-ip:${req.ip}`, 40, 3600e3)) throw tooMany('Too many changes. Please try again later.');
  const weight = Math.round(d.weightKg * 10) / 10;
  const out = await withTransaction(async (client) => {
    const p = await programmeFor(client, who, id);
    if (p.status !== 'ACTIVE') throw badRequest('Your programme is not running at the moment, so a weight cannot be entered. Please ask your dietitian.');
    if (p.start_date > p.today) throw badRequest('Your programme has not started yet.');
    const now = (await client.query(`SELECT weight_kg,by_client FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date=$3::date FOR UPDATE`, [p.hospital_id, p.patient_id, p.today])).rows[0];
    if (now && !now.by_client) throw Object.assign(new Error(`Your clinic has already recorded today's weight (${Number(now.weight_kg)} kg).`), { status: 409 });
    if (!d.confirm) {
      const prev = (await client.query(`SELECT weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date<$3::date ORDER BY on_date DESC LIMIT 1`, [p.hospital_id, p.patient_id, p.today])).rows[0];
      if (prev && Math.abs(weight - Number(prev.weight_kg)) > JUMP_KG) {
        const diff = Math.round(Math.abs(weight - Number(prev.weight_kg)) * 10) / 10;
        throw Object.assign(new Error(`This is ${diff} kg ${weight > Number(prev.weight_kg) ? 'more' : 'less'} than your last weight (${Number(prev.weight_kg)} kg). Check it and confirm if it is right.`), { status: 409, needConfirm: true });
      }
    }
    await client.query(
      `INSERT INTO weight_log(hospital_id,patient_id,on_date,weight_kg,entered_by,by_client) VALUES($1,$2,$3::date,$4,NULL,TRUE)
       ON CONFLICT (hospital_id,patient_id,on_date) DO UPDATE SET weight_kg=EXCLUDED.weight_kg,entered_by=NULL,by_client=TRUE,updated_at=NOW()`,
      [p.hospital_id, p.patient_id, p.today, weight]);
    if (!now || Number(now.weight_kg) !== weight) {
      await client.query(
        `INSERT INTO diet_history(hospital_id,programme_id,kind,ref_date,action,before_data,after_data,changed_by,changed_by_name,changed_by_role,by_support) VALUES($1,$2,'WEIGHT',$3::date,$4,$5,$6,NULL,$7,'CLIENT',FALSE)`,
        [p.hospital_id, p.id, p.today, now ? 'CHANGED' : 'ADDED', now ? JSON.stringify({ kg: Number(now.weight_kg) }) : null, JSON.stringify({ kg: weight }), `${p.full_name} (client)`]);
    }
    return { date: p.today, kg: weight };
  });
  res.json({ ok: true, ...out });
}));

export default router;
