import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';

// Dietitians: a client's programme, the weight taken every day, and the plan given for each week.
// A programme belongs to one dietitian (a doctor whose speciality is DIETITIAN). The dietitian writes the plans; the Admin can read everything;
// reception can enter and correct weights. Dates are plain 'YYYY-MM-DD' strings (India time). A plan covers the From and To dates the dietitian chooses; the plans of one programme never overlap.
const router = Router();
router.use(allow('ADMIN', 'DOCTOR', 'RECEPTIONIST'));
// Everything diet is there only while the hospital has an active doctor whose speciality is Dietitian
export async function hospitalHasDietitian(client, hospitalId) {
  return (await client.query(`SELECT 1 FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND speciality='DIETITIAN' AND is_active=TRUE AND deleted_at IS NULL LIMIT 1`, [hospitalId])).rowCount > 0;
}
router.use(asyncHandler(async (req, res, next) => {
  if (!(await hospitalHasDietitian(pool, req.user.hospitalId))) throw forbidden('Diet programmes are not set up in this hospital. Add a doctor with the Dietitian speciality first.');
  next();
}));

const TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
const BACKDATE_DAYS = 7; // a weight can be entered for today or up to a week back
const JUMP_KG = 3; // a change bigger than this from the last weight must be confirmed
const day = (col) => `to_char(${col},'YYYY-MM-DD')`;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date').refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Use a valid date');
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const todayIso = async () => (await pool.query(`SELECT ${day(TODAY_SQL)} AS d`)).rows[0].d;

// A plan is a list of times with what to eat then: time is the clock time, 24-hour 'HH:MM' at any minute. There are no fixed meal names; every row with food written needs its time, and rows are kept in clock order.
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional();
const mealsSchema = z.array(z.object({ text: z.string().trim().max(600), time: clock }).refine(m => !m.text || m.time, { message: 'Set the time for every row you wrote' })).max(12)
  // a time can be used once in a plan; rows with nothing written are dropped, so they do not count
  .superRefine((list, ctx) => {
    const seen = new Set();
    for (const m of list) {
      if (!m.text || !m.time) continue;
      if (seen.has(m.time)) { const h = Number(m.time.slice(0, 2)); ctx.addIssue({ code: 'custom', message: `The time ${h % 12 || 12}:${m.time.slice(3)} ${h < 12 ? 'AM' : 'PM'} is used more than once. Use each time once` }); return; }
      seen.add(m.time);
    }
  });
const cleanMeals = (meals) => meals.filter(m => m.text).map(m => ({ time: m.time, text: m.text })).sort((x, y) => x.time.localeCompare(y.time));
const planSchema = z.object({
  meals: mealsSchema.default([]),
  kcal: z.number().int().min(300).max(6000).nullable().optional(),
  proteinG: z.number().int().min(5).max(400).nullable().optional(),
  instructions: z.string().trim().max(3000).optional().default(''),
  basedOn: z.boolean().optional(), // a new plan started from the earlier plan
  startDate: dateSchema.optional(), // the plan's From and To; a new plan with no To runs the dietitian's default number of days
  endDate: dateSchema.optional(),
});

async function isDietitian(userId, hospitalId) {
  const q = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND hospital_id=$2 AND role='DOCTOR' AND speciality='DIETITIAN' AND is_active=TRUE AND deleted_at IS NULL`, [userId, hospitalId]);
  return q.rowCount > 0;
}
// a doctor who is not a dietitian has nothing here
async function guard(req) {
  if (req.user.role === 'DOCTOR' && !(await isDietitian(req.user.id, req.user.hospitalId))) throw forbidden('Diet programmes are for dietitians');
}
// who may write plans, change a programme or enrol a client: the dietitian only
async function writer(req) {
  if (req.user.role !== 'DOCTOR' || !(await isDietitian(req.user.id, req.user.hospitalId))) throw forbidden('Only the dietitian can do this');
}

const PROGRAMME_COLS = `p.id,p.patient_id,p.doctor_id,${day('p.start_date')} AS start_date,p.goal_weight_kg,p.height_cm,${day('p.goal_date')} AS goal_date,p.food_pattern,p.reasons,p.notes,p.status,${day('p.ended_on')} AS ended_on,
  pt.full_name,pt.mobile,pt.gender,pt.date_of_birth,d.name AS doctor_name,d.qualification AS doctor_qualification,d.registration_no AS doctor_registration_no`;
const PROGRAMME_FROM = `FROM diet_programmes p JOIN patients pt ON pt.id=p.patient_id AND pt.hospital_id=p.hospital_id JOIN users d ON d.id=p.doctor_id AND d.hospital_id=p.hospital_id`;

async function getProgramme(req, id, client = pool) {
  const q = await client.query(`SELECT ${PROGRAMME_COLS} ${PROGRAMME_FROM} WHERE p.id=$1 AND p.hospital_id=$2`, [id, req.user.hospitalId]);
  if (!q.rowCount) throw notFound('Programme not found');
  const row = q.rows[0];
  if (req.user.role === 'DOCTOR' && Number(row.doctor_id) !== req.user.id) throw forbidden('This client belongs to another dietitian');
  return row;
}

const dmyS = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const MAX_PLAN_DAYS = 92; // the longest a single plan can run
const MAX_AHEAD_DAYS = 60; // how far ahead a plan can start
// the dietitian's own default plan length in days (7 until she sets another)
async function defaultPlanDays(client, userId, hospitalId) {
  const q = await client.query(`SELECT diet_plan_days FROM users WHERE id=$1 AND hospital_id=$2`, [userId, hospitalId]);
  return q.rows[0]?.diet_plan_days || 7;
}
// A plan's dates: From and To, up to 92 days, not before the programme started, not more than 60 days ahead, and never overlapping another plan of the same programme.
async function checkPeriod(client, req, p, start, end, today, selfId) {
  if (diffDays(end, start) < 0) throw badRequest('The To date is before the From date');
  if (diffDays(end, start) + 1 > MAX_PLAN_DAYS) throw badRequest(`A plan can run up to ${MAX_PLAN_DAYS} days`);
  if (diffDays(start, p.start_date) < 0) throw badRequest(`A plan cannot start before the programme (${dmyS(p.start_date)})`);
  if (diffDays(start, today) > MAX_AHEAD_DAYS) throw badRequest(`A plan can start up to ${MAX_AHEAD_DAYS} days from today`);
  const clash = (await client.query(
    `SELECT ${day('week_start')} AS s,${day('week_end')} AS e FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_start<=$4::date AND week_end>=$3::date ${selfId ? 'AND id<>$5' : ''} ORDER BY week_start LIMIT 1`,
    selfId ? [req.user.hospitalId, p.id, start, end, selfId] : [req.user.hospitalId, p.id, start, end])).rows[0];
  if (clash) throw badRequest(`These dates overlap the plan of ${dmyS(clash.s)} to ${dmyS(clash.e)}. Choose dates that do not overlap`);
}

async function record(client, req, programmeId, kind, refDate, action, before, after) {
  await client.query(
    `INSERT INTO diet_history(hospital_id,programme_id,kind,ref_date,action,before_data,after_data,changed_by,changed_by_name,changed_by_role,by_support) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [req.user.hospitalId, programmeId, kind, refDate, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.user.id, req.user.name || null, req.user.role, Boolean(req.user.impersonatedBySuperuserId)]);
}

const planRow = (r) => ({ id: Number(r.id), weekStart: r.week_start, weekEnd: r.week_end, meals: r.meals, kcal: r.kcal, proteinG: r.protein_g, instructions: r.instructions || '', howMade: r.how_made, copiedFromWeekId: r.copied_from_week_id ? Number(r.copied_from_week_id) : null, reviewNote: r.review_note || '', reviewedAt: r.reviewed_at, updatedAt: r.updated_at });
const PLAN_COLS = `id,${day('week_start')} AS week_start,${day('week_end')} AS week_end,meals,kcal,protein_g,instructions,how_made,copied_from_week_id,review_note,reviewed_at,updated_at`;

// A weight taken at a visit (the vitals box) is also that day's weight in the client's running programme, so the two never disagree.
export async function syncVisitWeight(client, { hospitalId, patientId, visitId, weightKg, user }) {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w < 10 || w > 300) return;
  const day = await client.query(`SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d FROM visits WHERE id=$1 AND hospital_id=$2`, [visitId, hospitalId]);
  const on = day.rows[0]?.d;
  const prog = on && (await client.query(`SELECT id FROM diet_programmes WHERE hospital_id=$1 AND patient_id=$2 AND status='ACTIVE' AND start_date<=$3::date ORDER BY id LIMIT 1`, [hospitalId, patientId, on])).rows[0];
  if (!prog) return;
  const old = (await client.query(`SELECT weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date=$3`, [hospitalId, patientId, on])).rows[0];
  await client.query(`INSERT INTO weight_log(hospital_id,patient_id,on_date,weight_kg,entered_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (hospital_id,patient_id,on_date) DO UPDATE SET weight_kg=EXCLUDED.weight_kg,entered_by=EXCLUDED.entered_by,updated_at=NOW()`, [hospitalId, patientId, on, w, user.id]);
  if (old && Number(old.weight_kg) !== w) await record(client, { user: { ...user, hospitalId } }, prog.id, 'WEIGHT', on, 'CHANGED', { kg: Number(old.weight_kg) }, { kg: w });
}

// ---- Today: the dietitian's clients with the weights of the last days and what needs doing

router.get('/today', asyncHandler(async (req, res) => {
  await guard(req);
  const status = z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']).catch('ACTIVE').parse(req.query.status);
  const today = await todayIso();
  const mine = req.user.role === 'DOCTOR';
  const q = await pool.query(`SELECT ${PROGRAMME_COLS} ${PROGRAMME_FROM} WHERE p.hospital_id=$1 AND p.status=$2 ${mine ? 'AND p.doctor_id=$3' : ''} ORDER BY lower(pt.full_name),p.id`, mine ? [req.user.hospitalId, status, req.user.id] : [req.user.hospitalId, status]);
  const ids = q.rows.map(r => Number(r.id));
  const patients = [...new Set(q.rows.map(r => Number(r.patient_id)))];
  const weights = patients.length ? (await pool.query(`SELECT patient_id,${day('on_date')} AS d,weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=ANY($2) AND on_date>=$3::date-14 ORDER BY on_date`, [req.user.hospitalId, patients, today])).rows : [];
  const latest = patients.length ? (await pool.query(`SELECT DISTINCT ON (patient_id) patient_id,${day('on_date')} AS d,weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=ANY($2) ORDER BY patient_id,on_date DESC`, [req.user.hospitalId, patients])).rows : [];
  const plans = ids.length ? (await pool.query(`SELECT programme_id,${day('week_start')} AS week_start,${day('week_end')} AS week_end FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=ANY($2) ORDER BY week_start`, [req.user.hospitalId, ids])).rows : [];
  const pkgRows = ids.length ? (await pool.query(`${PKG_SELECT} WHERE k.hospital_id=$1 AND k.programme_id=ANY($2) AND k.status='ACTIVE' AND k.end_date>=$3::date-30 ORDER BY k.start_date`, [req.user.hospitalId, ids, today])).rows : [];
  const clients = q.rows.map(r => {
    const mineW = weights.filter(x => Number(x.patient_id) === Number(r.patient_id)).map(x => ({ date: x.d, kg: Number(x.weight_kg) }));
    const last = latest.find(x => Number(x.patient_id) === Number(r.patient_id));
    const mine = plans.filter(x => Number(x.programme_id) === Number(r.id));
    const cur = mine.find(x => x.week_start <= today && today <= x.week_end); // the plan that covers today
    const nxt = mine.find(x => x.week_start > today);
    const daysLeft = cur ? diffDays(cur.week_end, today) : null;
    const weekAgo = mineW.filter(x => x.date <= addDays(today, -7)).pop();
    const todayKg = mineW.find(x => x.date === today)?.kg ?? null;
    const lastKg = last ? Number(last.weight_kg) : null;
    return {
      id: Number(r.id), patientId: Number(r.patient_id), name: r.full_name, mobile: r.mobile, doctorName: r.doctor_name, status: r.status, startDate: r.start_date,
      goalWeightKg: r.goal_weight_kg === null ? null : Number(r.goal_weight_kg), heightCm: r.height_cm === null ? null : Number(r.height_cm), goalDate: r.goal_date, planNo: cur ? mine.indexOf(cur) + 1 : null, planStart: cur ? cur.week_start : null, planEnd: cur ? cur.week_end : null,
      todayKg, lastKg, lastDate: last ? last.d : null, daysSinceWeight: last ? diffDays(today, last.d) : null,
      weekChangeKg: weekAgo && lastKg !== null ? Math.round((lastKg - weekAgo.kg) * 10) / 10 : null,
      recent: mineW.filter(x => x.date > addDays(today, -8)),
      plan: { current: Boolean(cur), next: Boolean(nxt), ever: mine.length > 0 },
      package: pickPackage(pkgRows.filter(x => Number(x.programme_id) === Number(r.id)), today),
      reviewDue: status === 'ACTIVE' && (!cur || (daysLeft <= 1 && !nxt)), // no plan for today, or the plan ends tomorrow and nothing follows
    };
  });
  res.json({ today, status, readOnly: req.user.role !== 'DOCTOR', clients });
}));

// ---- Programmes

const heightSchema = z.number({ error: 'Enter the height in cm' }).min(50, 'The height must be between 50 and 250 cm').max(250, 'The height must be between 50 and 250 cm');
const programmeSchema = z.object({
  heightCm: heightSchema.optional(), // changed on the Programme tab; never blank once set
  goalWeightKg: z.number().min(10).max(300).nullable().optional(),
  goalDate: dateSchema.nullable().optional(),
  foodPattern: z.enum(['VEG', 'EGG', 'NONVEG', 'JAIN', 'VEGAN', 'OTHER']).nullable().optional(),
  reasons: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(3000).nullable().optional(),
});

router.post('/programmes', asyncHandler(async (req, res) => {
  await writer(req);
  // the height and the weight today are both needed: the BMI is worked out from them
  const data = programmeSchema.extend({ patientId: z.coerce.number().int().positive(), startDate: dateSchema.optional(), heightCm: heightSchema, startWeightKg: z.number({ error: 'Enter the weight today in kg' }).min(10, 'The weight must be between 10 and 300 kg').max(300, 'The weight must be between 10 and 300 kg') }).parse(req.body);
  const today = await todayIso();
  const startDate = data.startDate || today;
  if (diffDays(startDate, today) > 0) throw badRequest('The start date cannot be in the future');
  if (data.goalDate && diffDays(data.goalDate, today) <= 0) throw badRequest('The goal date must be a future date');
  if (diffDays(today, startDate) > 60) throw badRequest('The start date cannot be more than 60 days back');
  const id = await withTransaction(async (client) => {
    const pt = await client.query(`SELECT id FROM patients WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`, [data.patientId, req.user.hospitalId]);
    if (!pt.rowCount) throw notFound('Patient not found');
    const running = await client.query(`SELECT id FROM diet_programmes WHERE hospital_id=$1 AND patient_id=$2 AND doctor_id=$3 AND status<>'COMPLETED'`, [req.user.hospitalId, data.patientId, req.user.id]);
    if (running.rowCount) throw badRequest('This client already has a programme with you');
    const ins = await client.query(
      `INSERT INTO diet_programmes(hospital_id,patient_id,doctor_id,start_date,goal_weight_kg,goal_date,food_pattern,reasons,notes,created_by,height_cm) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,$10) RETURNING id`,
      [req.user.hospitalId, data.patientId, req.user.id, startDate, data.goalWeightKg ?? null, data.goalDate ?? null, data.foodPattern ?? null, data.reasons || null, data.notes || null, data.heightCm]);
    if (data.startWeightKg) {
      await client.query(`INSERT INTO weight_log(hospital_id,patient_id,on_date,weight_kg,entered_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (hospital_id,patient_id,on_date) DO NOTHING`, [req.user.hospitalId, data.patientId, startDate, data.startWeightKg, req.user.id]);
    }
    return Number(ins.rows[0].id);
  });
  res.status(201).json({ id });
}));

// the programmes of one patient (for the visit page and the patient page)
router.get('/patient/:patientId', asyncHandler(async (req, res) => {
  await guard(req);
  const pid = z.coerce.number().int().positive().parse(req.params.patientId);
  const mine = req.user.role === 'DOCTOR';
  const q = await pool.query(`SELECT p.id,p.status,${day('p.start_date')} AS start_date,d.name AS doctor_name FROM diet_programmes p JOIN users d ON d.id=p.doctor_id AND d.hospital_id=p.hospital_id WHERE p.hospital_id=$1 AND p.patient_id=$2 ${mine ? 'AND p.doctor_id=$3' : ''} ORDER BY p.id DESC`, mine ? [req.user.hospitalId, pid, req.user.id] : [req.user.hospitalId, pid]);
  const today = await todayIso();
  const pk = q.rows.length ? (await pool.query(`${PKG_SELECT} WHERE k.hospital_id=$1 AND k.programme_id=ANY($2) AND k.status='ACTIVE' ORDER BY k.start_date`, [req.user.hospitalId, q.rows.map(r => Number(r.id))])).rows : [];
  res.json(q.rows.map(r => ({ id: Number(r.id), status: r.status, startDate: r.start_date, doctorName: r.doctor_name, package: r.status === 'COMPLETED' ? null : pickPackage(pk.filter(x => Number(x.programme_id) === Number(r.id)), today) })));
}));

router.get('/programmes/:id', asyncHandler(async (req, res) => {
  await guard(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const p = await getProgramme(req, id);
  const today = await todayIso();
  const weights = (await pool.query(`SELECT ${day('on_date')} AS date,weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date>=$3::date ORDER BY on_date`, [req.user.hospitalId, p.patient_id, p.start_date])).rows.map(r => ({ date: r.date, kg: Number(r.weight_kg) }));
  const before = (await pool.query(`SELECT ${day('on_date')} AS date,weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date<$3::date ORDER BY on_date DESC LIMIT 1`, [req.user.hospitalId, p.patient_id, p.start_date])).rows[0];
  const all = (await pool.query(`SELECT ${PLAN_COLS} FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 ORDER BY week_start`, [req.user.hospitalId, id])).rows.map(planRow);
  const weeks = all.map((w, i) => ({ ...w, no: i + 1 })).reverse().slice(0, 120); // newest first; no is the plan's number in the programme
  res.json({
    programme: { id: Number(p.id), patientId: Number(p.patient_id), doctorId: Number(p.doctor_id), doctorName: p.doctor_name, doctorQualification: p.doctor_qualification, doctorRegistrationNo: p.doctor_registration_no, name: p.full_name, mobile: p.mobile, gender: p.gender, dateOfBirth: p.date_of_birth,
      startDate: p.start_date, goalWeightKg: p.goal_weight_kg === null ? null : Number(p.goal_weight_kg), heightCm: p.height_cm === null ? null : Number(p.height_cm), goalDate: p.goal_date, foodPattern: p.food_pattern, reasons: p.reasons || '', notes: p.notes || '', status: p.status, endedOn: p.ended_on },
    today, planDays: await defaultPlanDays(pool, p.doctor_id, req.user.hospitalId), weights, previousWeight: before ? { date: before.date, kg: Number(before.weight_kg) } : null, weeks,
    canWrite: req.user.role === 'DOCTOR' && Number(p.doctor_id) === req.user.id, canWeigh: p.status === 'ACTIVE',
  });
}));

router.patch('/programmes/:id', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = programmeSchema.extend({ status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']).optional() }).parse(req.body);
  await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    if (p.status === 'COMPLETED') throw badRequest('This programme is finished');
    const has = (k) => data[k] !== undefined;
    // a new goal date must be in the future; one set earlier and left as it is can be saved again
    if (data.goalDate && data.goalDate !== p.goal_date && diffDays(data.goalDate, await todayIso()) <= 0) throw badRequest('The goal date must be a future date');
    await client.query(
      `UPDATE diet_programmes SET height_cm=COALESCE($14::numeric,height_cm), goal_weight_kg=CASE WHEN $3 THEN $4 ELSE goal_weight_kg END, goal_date=CASE WHEN $5 THEN $6::date ELSE goal_date END, food_pattern=CASE WHEN $7 THEN $8 ELSE food_pattern END,
         reasons=CASE WHEN $9 THEN $10 ELSE reasons END, notes=CASE WHEN $11 THEN $12 ELSE notes END, status=COALESCE($13,status),
         ended_on=CASE WHEN $13='COMPLETED' THEN ${TODAY_SQL} ELSE ended_on END, updated_at=NOW()
       WHERE id=$1 AND hospital_id=$2`,
      [id, req.user.hospitalId, has('goalWeightKg'), data.goalWeightKg ?? null, has('goalDate'), data.goalDate ?? null, has('foodPattern'), data.foodPattern ?? null, has('reasons'), data.reasons || null, has('notes'), data.notes || null, data.status ?? null, data.heightCm ?? null]);
  });
  res.json({ ok: true });
}));

// ---- Weights

router.put('/programmes/:id/weights', asyncHandler(async (req, res) => {
  await guard(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = z.object({ date: dateSchema.optional(), weightKg: z.number().min(10, 'Enter the weight in kg').max(300, 'Enter the weight in kg'), confirm: z.boolean().optional() }).parse(req.body);
  const today = await todayIso();
  const date = data.date || today;
  if (diffDays(date, today) > 0) throw badRequest('A weight cannot be entered for a future day');
  if (diffDays(today, date) > BACKDATE_DAYS) throw badRequest(`A weight can be entered for today or up to ${BACKDATE_DAYS} days back`);
  const weight = Math.round(data.weightKg * 10) / 10;
  await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    if (p.status !== 'ACTIVE') throw badRequest('This programme is not running. Resume it to enter weights.');
    if (diffDays(date, p.start_date) < 0) throw badRequest('That day is before the programme started');
    if (!data.confirm) {
      const prev = (await client.query(`SELECT ${day('on_date')} AS d,weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date<$3::date ORDER BY on_date DESC LIMIT 1`, [req.user.hospitalId, p.patient_id, date])).rows[0];
      if (prev && Math.abs(weight - Number(prev.weight_kg)) > JUMP_KG) {
        const e = badRequest(`This is ${Math.abs(Math.round((weight - Number(prev.weight_kg)) * 10) / 10)} kg ${weight > Number(prev.weight_kg) ? 'more' : 'less'} than the last weight (${Number(prev.weight_kg)} kg). Check it and confirm if it is right.`);
        e.status = 409; e.needConfirm = true; throw e;
      }
    }
    const old = (await client.query(`SELECT weight_kg FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date=$3`, [req.user.hospitalId, p.patient_id, date])).rows[0];
    await client.query(
      `INSERT INTO weight_log(hospital_id,patient_id,on_date,weight_kg,entered_by) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (hospital_id,patient_id,on_date) DO UPDATE SET weight_kg=EXCLUDED.weight_kg,entered_by=EXCLUDED.entered_by,updated_at=NOW()`,
      [req.user.hospitalId, p.patient_id, date, weight, req.user.id]);
    if (old && Number(old.weight_kg) !== weight) await record(client, req, id, 'WEIGHT', date, 'CHANGED', { kg: Number(old.weight_kg) }, { kg: weight });
  });
  res.json({ ok: true, date, kg: weight });
}));

router.delete('/programmes/:id/weights/:date', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const date = dateSchema.parse(req.params.date);
  await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    const old = (await client.query(`DELETE FROM weight_log WHERE hospital_id=$1 AND patient_id=$2 AND on_date=$3 RETURNING weight_kg`, [req.user.hospitalId, p.patient_id, date])).rows[0];
    if (old) await record(client, req, id, 'WEIGHT', date, 'REMOVED', { kg: Number(old.weight_kg) }, null);
  });
  res.json({ ok: true });
}));

// ---- Weekly plans

router.put('/programmes/:id/weeks/:weekStart', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = planSchema.parse(req.body);
  const urlStart = dateSchema.parse(req.params.weekStart); // the plan's From date (a new plan starts there unless startDate says otherwise)
  const today = await todayIso();
  const out = await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    if (p.status === 'COMPLETED') throw badRequest('This programme is finished');
    const meals = cleanMeals(data.meals);
    const old = (await client.query(`SELECT ${PLAN_COLS} FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_start=$3 FOR UPDATE`, [req.user.hospitalId, id, urlStart])).rows[0];
    const start = data.startDate || urlStart;
    const length = old ? diffDays(old.week_end, old.week_start) : (await defaultPlanDays(client, req.user.id, req.user.hospitalId)) - 1;
    const end = data.endDate || addDays(start, length);
    if (!old || start !== old.week_start || end !== old.week_end) await checkPeriod(client, req, p, start, end, today, old ? Number(old.id) : null);
    const after = { weekStart: start, weekEnd: end, meals, kcal: data.kcal ?? null, proteinG: data.proteinG ?? null, instructions: data.instructions };
    if (!old) {
      const src = data.basedOn ? (await client.query(`SELECT id FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_start<$3 ORDER BY week_start DESC LIMIT 1`, [req.user.hospitalId, id, start])).rows[0] : null;
      await client.query(`INSERT INTO diet_plan_weeks(hospital_id,programme_id,week_start,week_end,meals,kcal,protein_g,instructions,how_made,copied_from_week_id,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [req.user.hospitalId, id, start, end, JSON.stringify(meals), after.kcal, after.proteinG, after.instructions || null, src ? 'EDITED' : 'NEW', src ? src.id : null, req.user.id]);
      await record(client, req, id, 'PLAN', start, 'CREATED', null, after);
    } else {
      const was = { weekStart: old.week_start, weekEnd: old.week_end, meals: old.meals, kcal: old.kcal, proteinG: old.protein_g, instructions: old.instructions || '' };
      if (JSON.stringify(was) !== JSON.stringify(after)) {
        await client.query(`UPDATE diet_plan_weeks SET week_start=$3,week_end=$4,meals=$5::jsonb,kcal=$6,protein_g=$7,instructions=$8,how_made=CASE WHEN how_made='SAME' THEN 'EDITED' ELSE how_made END,updated_at=NOW() WHERE hospital_id=$1 AND id=$2`,
          [req.user.hospitalId, old.id, start, end, JSON.stringify(meals), after.kcal, after.proteinG, after.instructions || null]);
        await record(client, req, id, 'PLAN', start, 'CHANGED', was, after);
      }
    }
    return { weekStart: start, weekEnd: end };
  });
  res.json({ ok: true, ...out });
}));

// "Same plan again": a new plan that is a copy of the plan before it (kept as its own row so every plan shows exactly what was given).
// The new plan starts on :weekStart and runs as long as the plan it copies, unless endDate says otherwise.
router.post('/programmes/:id/weeks/:weekStart/copy', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = z.object({ endDate: dateSchema.optional() }).parse(req.body || {});
  const ws = dateSchema.parse(req.params.weekStart);
  const today = await todayIso();
  const out = await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    if (p.status === 'COMPLETED') throw badRequest('This programme is finished');
    const exists = await client.query(`SELECT 1 FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_start=$3`, [req.user.hospitalId, id, ws]);
    if (exists.rowCount) throw badRequest('A plan already starts on this date');
    // the latest plan before this one (normally the plan just finished)
    const src = (await client.query(`SELECT ${PLAN_COLS} FROM diet_plan_weeks WHERE hospital_id=$1 AND programme_id=$2 AND week_start<$3 ORDER BY week_start DESC LIMIT 1`, [req.user.hospitalId, id, ws])).rows[0];
    if (!src) throw badRequest('There is no earlier plan to copy. Write the first plan.');
    const end = body.endDate || addDays(ws, diffDays(src.week_end, src.week_start));
    await checkPeriod(client, req, p, ws, end, today, null);
    await client.query(`INSERT INTO diet_plan_weeks(hospital_id,programme_id,week_start,week_end,meals,kcal,protein_g,instructions,how_made,copied_from_week_id,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'SAME',$9,$10)`,
      [req.user.hospitalId, id, ws, end, JSON.stringify(src.meals), src.kcal, src.protein_g, src.instructions, src.id, req.user.id]);
    await record(client, req, id, 'PLAN', ws, 'COPIED', null, { fromWeek: src.week_start, weekStart: ws, weekEnd: end });
    return { weekStart: ws, weekEnd: end };
  });
  res.status(201).json({ ok: true, ...out });
}));

// the dietitian's note on how a plan went (the review); :weekStart is the plan's From date
router.put('/programmes/:id/weeks/:weekStart/review', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const note = z.object({ note: z.string().trim().max(2000) }).parse(req.body).note;
  await withTransaction(async (client) => {
    await getProgramme(req, id, client);
    const ws = dateSchema.parse(req.params.weekStart);
    const u = await client.query(`UPDATE diet_plan_weeks SET review_note=$4,reviewed_at=NOW(),reviewed_by=$5,updated_at=NOW() WHERE hospital_id=$1 AND programme_id=$2 AND week_start=$3`, [req.user.hospitalId, id, ws, note || null, req.user.id]);
    if (!u.rowCount) throw notFound('That plan was not found');
  });
  res.json({ ok: true });
}));

router.get('/programmes/:id/history', asyncHandler(async (req, res) => {
  await guard(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  await getProgramme(req, id);
  const q = await pool.query(`SELECT id,kind,${day('ref_date')} AS ref_date,action,before_data,after_data,changed_by_name,changed_by_role,by_support,created_at FROM diet_history WHERE hospital_id=$1 AND programme_id=$2 ORDER BY id DESC LIMIT 100`, [req.user.hospitalId, id]);
  res.json(q.rows);
}));

// ---- Packages: what a client pays for a stretch of days (monthly, quarterly, yearly or any dates), paid in instalments.
// The dietitian sets the package; the visits inside its dates are counted against it, and an optional consult limit is hers to set.
// The dietitian, the Admin and reception can record an instalment. Income counts on the day an instalment is received, apart from visit payments.

const PKG_MAX_DAYS = 800;
const PAY_BACK_DAYS = 30; // an instalment can be dated up to a month back
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const packageSchema = z.object({
  name: z.string().trim().min(1, 'Give the package a name').max(60),
  startDate: dateSchema,
  endDate: dateSchema,
  amount: z.number().min(0).max(10000000),
  consultLimit: z.number().int().min(1).max(365).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});
const instalmentSchema = z.object({
  amount: z.number().positive('Enter the amount received').max(10000000),
  paymentMode: z.enum(['CASH', 'UPI', 'CARD', 'OTHER']),
  referenceNo: z.string().trim().max(120).optional().default(''),
  paidOn: dateSchema.optional(),
});

const PKG_SELECT = `SELECT k.id,k.programme_id,k.patient_id,k.doctor_id,k.name,${day('k.start_date')} AS start_date,${day('k.end_date')} AS end_date,k.amount,k.consult_limit,k.notes,k.status,
  COALESCE((SELECT SUM(x.amount) FROM diet_package_payments x WHERE x.hospital_id=k.hospital_id AND x.package_id=k.id),0) AS paid,
  (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=k.hospital_id AND v.patient_id=k.patient_id AND v.doctor_id=k.doctor_id
     AND v.status IN ('WITH_DOCTOR','PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT','COMPLETED') AND (v.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN k.start_date AND k.end_date) AS used
  FROM diet_packages k`;
const packageRow = (r, today, payments = []) => {
  const state = r.status === 'CANCELLED' ? 'CANCELLED' : today < r.start_date ? 'UPCOMING' : today > r.end_date ? 'ENDED' : 'ACTIVE';
  const limit = r.consult_limit === null ? null : Number(r.consult_limit);
  return {
    id: Number(r.id), programmeId: Number(r.programme_id), name: r.name, startDate: r.start_date, endDate: r.end_date, amount: Number(r.amount), paid: round2(r.paid), balance: round2(Number(r.amount) - Number(r.paid)),
    consultLimit: limit, used: r.used, left: limit === null ? null : Math.max(0, limit - r.used), notes: r.notes || '', status: r.status, state,
    daysLeft: state === 'ACTIVE' ? diffDays(r.end_date, today) : null, payments,
  };
};
// the package to show for a client: the one running today, else the next one coming, else the one that ended last
const pickPackage = (rows, today) => {
  const all = rows.map(r => packageRow(r, today));
  const k = all.find(x => x.state === 'ACTIVE') || all.find(x => x.state === 'UPCOMING') || [...all].reverse().find(x => x.state === 'ENDED') || null;
  return k && { id: k.id, name: k.name, startDate: k.startDate, endDate: k.endDate, state: k.state, daysLeft: k.daysLeft, amount: k.amount, paid: k.paid, balance: k.balance, consultLimit: k.consultLimit, used: k.used, left: k.left };
};
const paymentRow = (r) => ({ id: Number(r.id), amount: Number(r.amount), paymentMode: r.payment_mode, referenceNo: r.reference_no || '', paidOn: r.paid_on, acceptedByName: r.accepted_by_name || '' });
const PAY_SELECT = `SELECT id,package_id,amount,payment_mode,reference_no,${day('paid_on')} AS paid_on,accepted_by_name FROM diet_package_payments`;

async function packagePeriod(client, req, p, d, selfId) {
  if (diffDays(d.endDate, d.startDate) < 0) throw badRequest('The To date is before the From date');
  if (diffDays(d.endDate, d.startDate) + 1 > PKG_MAX_DAYS) throw badRequest(`A package can run up to ${PKG_MAX_DAYS} days`);
  if (diffDays(d.startDate, p.start_date) < 0) throw badRequest(`A package cannot start before the programme (${dmyS(p.start_date)})`);
  const clash = (await client.query(
    `SELECT name,${day('start_date')} AS s,${day('end_date')} AS e FROM diet_packages WHERE hospital_id=$1 AND programme_id=$2 AND status='ACTIVE' AND start_date<=$4::date AND end_date>=$3::date ${selfId ? 'AND id<>$5' : ''} ORDER BY start_date LIMIT 1`,
    selfId ? [req.user.hospitalId, p.id, d.startDate, d.endDate, selfId] : [req.user.hospitalId, p.id, d.startDate, d.endDate])).rows[0];
  if (clash) throw badRequest(`These dates overlap the package “${clash.name}” of ${dmyS(clash.s)} to ${dmyS(clash.e)}. Choose dates that do not overlap`);
}
async function addInstalment(client, req, pkg, d, today) {
  const paidOn = d.paidOn || today;
  if (diffDays(paidOn, today) > 0) throw badRequest('The payment date cannot be in the future');
  if (diffDays(today, paidOn) > PAY_BACK_DAYS) throw badRequest(`The payment date can be up to ${PAY_BACK_DAYS} days back`);
  const paid = Number((await client.query(`SELECT COALESCE(SUM(amount),0) AS s FROM diet_package_payments WHERE hospital_id=$1 AND package_id=$2`, [req.user.hospitalId, pkg.id])).rows[0].s);
  const balance = round2(Number(pkg.amount) - paid);
  if (round2(d.amount) > balance) throw badRequest(balance > 0 ? `Only ₹${balance} is left to pay on this package` : 'This package is fully paid');
  const ins = await client.query(
    `INSERT INTO diet_package_payments(hospital_id,package_id,amount,payment_mode,reference_no,paid_on,accepted_by,accepted_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.user.hospitalId, pkg.id, round2(d.amount), d.paymentMode, d.referenceNo || null, paidOn, req.user.id, req.user.name || null]);
  await record(client, req, pkg.programme_id, 'PACKAGE', paidOn, 'PAID', null, { package: pkg.name, amount: round2(d.amount), mode: d.paymentMode, reference: d.referenceNo || null });
  return Number(ins.rows[0].id);
}
// the package, only if this user may see its programme
async function getPackage(req, pid, client = pool) {
  const q = await client.query(`${PKG_SELECT} WHERE k.id=$1 AND k.hospital_id=$2`, [pid, req.user.hospitalId]);
  if (!q.rowCount) throw notFound('Package not found');
  const programme = await getProgramme(req, Number(q.rows[0].programme_id), client);
  return { row: q.rows[0], programme };
}

// The diet package a visit falls under (the client's package with this visit's doctor, running on the visit's day), for the printed bill: its dates, fee, what is received so far and which consult this visit is.
export async function dietPackageForVisit(client, hospitalId, visit) {
  const q = await client.query(
    `${PKG_SELECT} WHERE k.hospital_id=$1 AND k.patient_id=$2 AND k.doctor_id=$3 AND k.status='ACTIVE'
       AND (SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date FROM visits WHERE hospital_id=$1 AND id=$4) BETWEEN k.start_date AND k.end_date ORDER BY k.start_date DESC LIMIT 1`,
    [hospitalId, visit.patient_id, visit.doctor_id, visit.id]);
  if (!q.rowCount || !(await hospitalHasDietitian(client, hospitalId))) return null;
  const k = packageRow(q.rows[0], '9999-12-31');
  const no = (await client.query(
    `SELECT COUNT(*)::int AS n FROM visits v WHERE v.hospital_id=$1 AND v.patient_id=$2 AND v.doctor_id=$3 AND v.status IN ('WITH_DOCTOR','PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT','COMPLETED')
       AND (v.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $4::date AND $5::date AND (v.created_at,v.id)<=(SELECT created_at,id FROM visits WHERE hospital_id=$1 AND id=$6)`,
    [hospitalId, visit.patient_id, visit.doctor_id, k.startDate, k.endDate, visit.id])).rows[0].n;
  const payments = (await client.query(`${PAY_SELECT} WHERE hospital_id=$1 AND package_id=$2 ORDER BY paid_on,id`, [hospitalId, k.id])).rows.map(paymentRow);
  return { name: k.name, startDate: k.startDate, endDate: k.endDate, amount: k.amount, paid: k.paid, balance: k.balance, consultLimit: k.consultLimit, consultNo: Math.max(no, 1), payments };
}

// A patient's diet packages with their instalments, for the patient page. The Admin and reception see every dietitian's; a doctor only their own.
export async function patientPackages(client, hospitalId, patientId, doctorId = null) {
  const today = (await client.query(`SELECT ${day(TODAY_SQL)} AS d`)).rows[0].d;
  const rows = (await client.query(`${PKG_SELECT} WHERE k.hospital_id=$1 AND k.patient_id=$2 AND k.status='ACTIVE' ${doctorId ? 'AND k.doctor_id=$3' : ''} ORDER BY k.start_date DESC,k.id DESC`, doctorId ? [hospitalId, patientId, doctorId] : [hospitalId, patientId])).rows;
  if (rows.length && !(await hospitalHasDietitian(client, hospitalId))) return [];
  const pays = rows.length ? (await client.query(`${PAY_SELECT} WHERE hospital_id=$1 AND package_id=ANY($2) ORDER BY paid_on DESC,id DESC`, [hospitalId, rows.map(r => Number(r.id))])).rows : [];
  const doctors = rows.length ? (await client.query(`SELECT id,name FROM users WHERE hospital_id=$1 AND id=ANY($2)`, [hospitalId, [...new Set(rows.map(r => Number(r.doctor_id)))]])).rows : [];
  return rows.map(r => ({ ...packageRow(r, today, pays.filter(x => Number(x.package_id) === Number(r.id)).map(paymentRow)), programmeId: Number(r.programme_id), doctorName: (doctors.find(d => Number(d.id) === Number(r.doctor_id)) || {}).name || '' }));
}

router.get('/programmes/:id/packages', asyncHandler(async (req, res) => {
  await guard(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const p = await getProgramme(req, id);
  const today = await todayIso();
  const rows = (await pool.query(`${PKG_SELECT} WHERE k.hospital_id=$1 AND k.programme_id=$2 AND k.status='ACTIVE' ORDER BY k.start_date DESC,k.id DESC`, [req.user.hospitalId, id])).rows;
  const pays = rows.length ? (await pool.query(`${PAY_SELECT} WHERE hospital_id=$1 AND package_id=ANY($2) ORDER BY paid_on DESC,id DESC`, [req.user.hospitalId, rows.map(r => Number(r.id))])).rows : [];
  res.json({
    today, programmeStart: p.start_date, canWrite: req.user.role === 'DOCTOR' && Number(p.doctor_id) === req.user.id && p.status !== 'COMPLETED', canPay: true, canRemovePayment: req.user.role !== 'RECEPTIONIST',
    packages: rows.map(r => packageRow(r, today, pays.filter(x => Number(x.package_id) === Number(r.id)).map(paymentRow))),
  });
}));

router.post('/programmes/:id/packages', asyncHandler(async (req, res) => {
  await writer(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = packageSchema.extend({ firstPayment: instalmentSchema.nullable().optional() }).parse(req.body);
  const today = await todayIso();
  const pid = await withTransaction(async (client) => {
    const p = await getProgramme(req, id, client);
    if (p.status === 'COMPLETED') throw badRequest('This programme is finished');
    await packagePeriod(client, req, p, data, null);
    if (data.firstPayment && round2(data.firstPayment.amount) > round2(data.amount)) throw badRequest('The amount received is more than the package amount');
    const ins = await client.query(
      `INSERT INTO diet_packages(hospital_id,programme_id,patient_id,doctor_id,name,start_date,end_date,amount,consult_limit,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.hospitalId, id, p.patient_id, p.doctor_id, data.name, data.startDate, data.endDate, round2(data.amount), data.consultLimit ?? null, data.notes || null, req.user.id]);
    const newId = Number(ins.rows[0].id);
    await record(client, req, id, 'PACKAGE', today, 'ADDED', null, { package: data.name, startDate: data.startDate, endDate: data.endDate, amount: round2(data.amount), consultLimit: data.consultLimit ?? null });
    if (data.firstPayment) await addInstalment(client, req, { id: newId, programme_id: id, name: data.name, amount: round2(data.amount) }, data.firstPayment, today);
    return newId;
  });
  res.status(201).json({ id: pid });
}));

router.put('/packages/:pid', asyncHandler(async (req, res) => {
  await writer(req);
  const pid = z.coerce.number().int().positive().parse(req.params.pid);
  const data = packageSchema.parse(req.body);
  const today = await todayIso();
  await withTransaction(async (client) => {
    const { row, programme } = await getPackage(req, pid, client);
    if (row.status === 'CANCELLED') throw badRequest('This package was cancelled');
    await packagePeriod(client, req, programme, data, pid);
    const cur = packageRow(row, today);
    if (round2(data.amount) < cur.paid) throw badRequest(`₹${cur.paid} is already received, so the amount cannot be less than that`);
    await client.query(
      `UPDATE diet_packages SET name=$3,start_date=$4,end_date=$5,amount=$6,consult_limit=$7,notes=$8,updated_at=NOW() WHERE id=$1 AND hospital_id=$2`,
      [pid, req.user.hospitalId, data.name, data.startDate, data.endDate, round2(data.amount), data.consultLimit ?? null, data.notes || null]);
    await record(client, req, Number(row.programme_id), 'PACKAGE', today, 'CHANGED',
      { package: cur.name, startDate: cur.startDate, endDate: cur.endDate, amount: cur.amount, consultLimit: cur.consultLimit },
      { package: data.name, startDate: data.startDate, endDate: data.endDate, amount: round2(data.amount), consultLimit: data.consultLimit ?? null });
  });
  res.json({ ok: true });
}));

// a package with nothing received can be cancelled; once money is received, change its dates or amount instead
router.post('/packages/:pid/cancel', asyncHandler(async (req, res) => {
  await writer(req);
  const pid = z.coerce.number().int().positive().parse(req.params.pid);
  const today = await todayIso();
  await withTransaction(async (client) => {
    const { row } = await getPackage(req, pid, client);
    if (row.status === 'CANCELLED') return;
    if (Number(row.paid) > 0) throw badRequest('Money is already received on this package. Change its dates or amount instead of cancelling');
    await client.query(`UPDATE diet_packages SET status='CANCELLED',updated_at=NOW() WHERE id=$1 AND hospital_id=$2`, [pid, req.user.hospitalId]);
    await record(client, req, Number(row.programme_id), 'PACKAGE', today, 'CANCELLED', { package: row.name, amount: Number(row.amount) }, null);
  });
  res.json({ ok: true });
}));

router.post('/packages/:pid/payments', asyncHandler(async (req, res) => {
  await guard(req);
  const pid = z.coerce.number().int().positive().parse(req.params.pid);
  const data = instalmentSchema.parse(req.body);
  const today = await todayIso();
  await withTransaction(async (client) => {
    const { row } = await getPackage(req, pid, client);
    if (row.status === 'CANCELLED') throw badRequest('This package was cancelled');
    await addInstalment(client, req, { id: pid, programme_id: row.programme_id, name: row.name, amount: row.amount }, data, today);
  });
  res.status(201).json({ ok: true });
}));

// a wrongly entered instalment can be removed by the dietitian or the Admin; the history keeps who removed what
router.delete('/packages/:pid/payments/:payId', asyncHandler(async (req, res) => {
  if (req.user.role === 'RECEPTIONIST') throw forbidden('Ask the dietitian or the Admin to remove a payment');
  await guard(req);
  const pid = z.coerce.number().int().positive().parse(req.params.pid);
  const payId = z.coerce.number().int().positive().parse(req.params.payId);
  const today = await todayIso();
  await withTransaction(async (client) => {
    const { row } = await getPackage(req, pid, client);
    const pay = (await client.query(`${PAY_SELECT} WHERE hospital_id=$1 AND package_id=$2 AND id=$3`, [req.user.hospitalId, pid, payId])).rows[0];
    if (!pay) throw notFound('Payment not found');
    await client.query(`DELETE FROM diet_package_payments WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, payId]);
    await record(client, req, Number(row.programme_id), 'PACKAGE', today, 'REMOVED', { package: row.name, amount: Number(pay.amount), mode: pay.payment_mode, paidOn: pay.paid_on, reference: pay.reference_no || null }, null);
  });
  res.json({ ok: true });
}));

// ---- The dietitian's own settings: how many days a new plan runs unless she picks other dates

router.get('/settings', asyncHandler(async (req, res) => {
  await guard(req);
  res.json({ planDays: await defaultPlanDays(pool, req.user.id, req.user.hospitalId) });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  await writer(req);
  const { planDays } = z.object({ planDays: z.number().int().min(1, 'Use 1 to 60 days').max(60, 'Use 1 to 60 days') }).parse(req.body);
  await pool.query(`UPDATE users SET diet_plan_days=$3 WHERE id=$1 AND hospital_id=$2`, [req.user.id, req.user.hospitalId, planDays]);
  res.json({ ok: true, planDays });
}));

// ---- The hospital's own plan templates (starting points)

const templateSchema = z.object({ name: z.string().trim().min(2).max(120), kcal: z.number().int().min(300).max(6000).nullable().optional(), meals: mealsSchema.default([]), instructions: z.string().trim().max(3000).optional().default('') });

async function templateWriter(req) {
  if (req.user.role === 'RECEPTIONIST') throw forbidden('Not allowed for this role');
  await guard(req);
}

router.get('/templates', asyncHandler(async (req, res) => {
  await guard(req);
  const q = await pool.query(`SELECT id,name,kcal,meals,instructions FROM diet_plan_templates WHERE hospital_id=$1 AND is_active=TRUE ORDER BY lower(name)`, [req.user.hospitalId]);
  res.json({ templates: q.rows.map(r => ({ id: Number(r.id), name: r.name, kcal: r.kcal, meals: r.meals, instructions: r.instructions || '' })) });
}));

router.post('/templates', asyncHandler(async (req, res) => {
  await templateWriter(req);
  const d = templateSchema.parse(req.body);
  try {
    const q = await pool.query(`INSERT INTO diet_plan_templates(hospital_id,name,kcal,meals,instructions) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id`, [req.user.hospitalId, d.name, d.kcal ?? null, JSON.stringify(cleanMeals(d.meals)), d.instructions || null]);
    res.status(201).json({ id: Number(q.rows[0].id) });
  } catch (e) { if (e.code === '23505') throw badRequest('A plan with this name already exists'); throw e; }
}));

router.put('/templates/:id', asyncHandler(async (req, res) => {
  await templateWriter(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const d = templateSchema.parse(req.body);
  try {
    const q = await pool.query(`UPDATE diet_plan_templates SET name=$3,kcal=$4,meals=$5::jsonb,instructions=$6,updated_at=NOW() WHERE id=$1 AND hospital_id=$2 AND is_active=TRUE`, [id, req.user.hospitalId, d.name, d.kcal ?? null, JSON.stringify(cleanMeals(d.meals)), d.instructions || null]);
    if (!q.rowCount) throw notFound('Plan not found');
  } catch (e) { if (e.code === '23505') throw badRequest('A plan with this name already exists'); throw e; }
  res.json({ ok: true });
}));

router.delete('/templates/:id', asyncHandler(async (req, res) => {
  await templateWriter(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  // a name is released by renaming the removed row, so the same name can be used again
  await pool.query(`UPDATE diet_plan_templates SET is_active=FALSE,name=left(name,90)||' (removed '||id||')',updated_at=NOW() WHERE id=$1 AND hospital_id=$2`, [id, req.user.hospitalId]);
  res.json({ ok: true });
}));

// ---- The master list of foods, drinks and activities the dietitian picks from while writing a plan. A short built-in list of common items, plus the hospital's own additions; she can always type anything else.

const STARTER_ITEMS = [
  '1 glass warm water', '1 glass warm water with lemon', '1 cup green tea', '1 cup tea without sugar', '1 cup black coffee without sugar', '1 glass buttermilk',
  '1 glass coconut water', '1 glass lemon water without sugar', '1 glass skimmed milk', '1 cup toned milk without sugar', '1 glass jeera water',
  '1 bowl oats porridge', '2 idli with sambar', '1 bowl vegetable poha', '1 bowl vegetable upma', '2 besan chilla', '2 moong dal chilla', '1 bowl vegetable daliya', '1 bowl khichdi',
  '1 roti', '2 rotis', '1 katori dal', '1 katori sabzi', '1 bowl cooked rice', '1 bowl vegetable soup', '1 katori curd', '1 bowl sprouts salad', '1 bowl cucumber and tomato salad', '1 bowl mixed vegetable salad',
  '1 apple', '1 bowl papaya', '1 bowl mixed fruit', '1 fistful roasted chana', '5 soaked almonds', '1 boiled egg', '2 egg whites', '100 g grilled chicken', '100 g paneer',
  // activities, so a plan can carry the exercise as well as the meals
  '30 minutes brisk walk', '20 minutes yoga', '15 minutes stretching', '10 minutes deep breathing', '30 minutes cycling', '10 minutes walk after a meal',
];
const itemSchema = z.object({ name: z.string().trim().min(2).max(200) });

router.get('/items', asyncHandler(async (req, res) => {
  await guard(req);
  const q = await pool.query(`SELECT id,name FROM diet_items WHERE hospital_id=$1 ORDER BY lower(name)`, [req.user.hospitalId]);
  res.json({ starter: STARTER_ITEMS, mine: q.rows.map(r => ({ id: Number(r.id), name: r.name })) });
}));

router.post('/items', asyncHandler(async (req, res) => {
  await templateWriter(req);
  const { name } = itemSchema.parse(req.body);
  // an item already in the hospital's list is returned as it is, so adding twice is harmless
  const q = await pool.query(`INSERT INTO diet_items(hospital_id,name,created_by) VALUES($1,$2,$3) ON CONFLICT (hospital_id, lower(name)) DO UPDATE SET name=diet_items.name RETURNING id,name`, [req.user.hospitalId, name, req.user.id]);
  res.status(201).json({ id: Number(q.rows[0].id), name: q.rows[0].name });
}));

router.delete('/items/:id', asyncHandler(async (req, res) => {
  await templateWriter(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  await pool.query(`DELETE FROM diet_items WHERE id=$1 AND hospital_id=$2`, [id, req.user.hospitalId]);
  res.json({ ok: true });
}));

export default router;
