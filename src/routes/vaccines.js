import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';
import { sentMap } from './reminders.js';
import { DEFAULT_REMINDER_MESSAGE, REMOVED_REMINDER_FIELDS, STARTER_VACCINES, addDays, daysBetween, todayIst, workOutSchedule } from '../vaccination.js';

const router = Router();
const OPEN_FOR_STAFF = ['WAITING_FOR_DOCTOR', 'WITH_DOCTOR', 'PAYMENT_PENDING'];

async function readSettings(db, hospitalId) {
  const q = await db.query(
    `SELECT h.vaccination_enabled,h.vaccine_schedule_approved_at,h.vaccine_schedule_changed_at,h.vaccine_reminder_message,u.name AS approved_by_name
     FROM hospitals h LEFT JOIN users u ON u.id=h.vaccine_schedule_approved_by AND u.hospital_id=h.id WHERE h.id=$1`, [hospitalId]);
  const r = q.rows[0];
  const approved = Boolean(r.vaccine_schedule_approved_at) && (!r.vaccine_schedule_changed_at || r.vaccine_schedule_approved_at >= r.vaccine_schedule_changed_at);
  return { enabled: r.vaccination_enabled, approved, approvedAt: r.vaccine_schedule_approved_at, approvedBy: r.approved_by_name || null, changedAt: r.vaccine_schedule_changed_at, reminderMessage: r.vaccine_reminder_message && !REMOVED_REMINDER_FIELDS.test(r.vaccine_reminder_message) ? r.vaccine_reminder_message : null, defaultReminderMessage: DEFAULT_REMINDER_MESSAGE };
}
const markChanged = (db, hospitalId) => db.query(`UPDATE hospitals SET vaccine_schedule_changed_at=NOW() WHERE id=$1`, [hospitalId]);

async function loadCatalogue(db, hospitalId, { activeOnly = false } = {}) {
  const v = await db.query(
    `SELECT id,name,protects_against,group_key,price,is_active,sort_order FROM vaccines WHERE hospital_id=$1 ${activeOnly ? 'AND is_active=TRUE' : ''} ORDER BY sort_order,lower(name)`, [hospitalId]);
  const s = await db.query(`SELECT vaccine_id,dose_no,label,due_age_days,min_age_days,min_gap_days FROM vaccine_schedule WHERE hospital_id=$1 ORDER BY vaccine_id,dose_no`, [hospitalId]);
  const doses = new Map();
  for (const d of s.rows) { const k = String(d.vaccine_id); if (!doses.has(k)) doses.set(k, []); doses.get(k).push(d); }
  return v.rows.map(r => ({ ...r, id: Number(r.id), price: Number(r.price), doses: doses.get(String(r.id)) || [] }));
}
const catalogueJson = (r) => ({ id: r.id, name: r.name, protectsAgainst: r.protects_against, group: r.group_key, price: r.price, isActive: r.is_active,
  doses: r.doses.map(d => ({ doseNo: d.dose_no, label: d.label, dueAgeDays: d.due_age_days, minAgeDays: d.min_age_days, minGapDays: d.min_gap_days })) });

const recordsOf = async (db, hospitalId, patientIds) => {
  if (!patientIds.length) return new Map();
  const q = await db.query(
    `SELECT pv.id,pv.patient_id,pv.vaccine_id,pv.dose_no,pv.status,to_char(pv.given_on,'YYYY-MM-DD') AS given_on,pv.batch_no,to_char(pv.expiry_on,'YYYY-MM') AS expiry_on,pv.site,pv.brand,pv.note,
            pv.visit_id,pv.price_charged,pv.charge_id,to_char(pv.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS recorded_on,u.name AS recorded_by_name
     FROM patient_vaccinations pv JOIN users u ON u.id=pv.recorded_by AND u.hospital_id=pv.hospital_id
     WHERE pv.hospital_id=$1 AND pv.patient_id=ANY($2::bigint[]) ORDER BY pv.given_on NULLS LAST,pv.id`, [hospitalId, patientIds]);
  const m = new Map();
  for (const r of q.rows) { const k = String(r.patient_id); if (!m.has(k)) m.set(k, []); m.get(k).push({ ...r, vaccine_id: Number(r.vaccine_id), id: Number(r.id), visit_id: r.visit_id ? Number(r.visit_id) : null }); }
  return m;
};

// ---- who can see what is switched on ----
router.get('/status', asyncHandler(async (req, res) => { res.json(await readSettings(pool, req.user.hospitalId)); }));

router.put('/enable', allow('ADMIN'), asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await withTransaction(async (client) => {
    if (enabled) {
      const have = await client.query(`SELECT COUNT(*)::int AS n FROM vaccines WHERE hospital_id=$1`, [req.user.hospitalId]);
      if (!have.rows[0].n) {
        // the starter schedule is loaded as a draft: it still needs to be approved
        let order = 0;
        for (const [name, protects, doses] of STARTER_VACCINES) {
          order += 1;
          const v = await client.query(`INSERT INTO vaccines(hospital_id,name,protects_against,group_key,sort_order) VALUES($1,$2,$3,'CHILD',$4) RETURNING id`, [req.user.hospitalId, name, protects, order]);
          for (let i = 0; i < doses.length; i += 1) {
            const [label, due, min, gap] = doses[i];
            await client.query(`INSERT INTO vaccine_schedule(hospital_id,vaccine_id,dose_no,label,due_age_days,min_age_days,min_gap_days) VALUES($1,$2,$3,$4,$5,$6,$7)`, [req.user.hospitalId, v.rows[0].id, i + 1, label, due, min, gap]);
          }
        }
        await markChanged(client, req.user.hospitalId);
      }
    }
    await client.query(`UPDATE hospitals SET vaccination_enabled=$2 WHERE id=$1`, [req.user.hospitalId, enabled]);
  });
  res.json(await readSettings(pool, req.user.hospitalId));
}));

// The wording of the WhatsApp reminder. An empty message goes back to the standard wording.
router.put('/reminder-message', allow('ADMIN'), asyncHandler(async (req, res) => {
  const { message } = z.object({ message: z.string().trim().max(600) }).parse(req.body);
  if (REMOVED_REMINDER_FIELDS.test(message)) throw badRequest('The message cannot include vaccine names or doses. Use fields such as the patient name, hospital name, due date and status.');
  await pool.query(`UPDATE hospitals SET vaccine_reminder_message=$2 WHERE id=$1`, [req.user.hospitalId, message || null]);
  res.json(await readSettings(pool, req.user.hospitalId));
}));

router.post('/approve', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const s = await readSettings(pool, req.user.hospitalId);
  if (!s.enabled) throw badRequest('Switch vaccination on first');
  await pool.query(`UPDATE hospitals SET vaccine_schedule_approved_by=$2,vaccine_schedule_approved_at=NOW() WHERE id=$1`, [req.user.hospitalId, req.user.id]);
  res.json(await readSettings(pool, req.user.hospitalId));
}));

// ---- the vaccine list and its schedule ----
router.get('/catalogue', asyncHandler(async (req, res) => {
  const [settings, rows] = await Promise.all([readSettings(pool, req.user.hospitalId), loadCatalogue(pool, req.user.hospitalId)]);
  res.json({ ...settings, vaccines: rows.map(catalogueJson) });
}));

const vaccineBody = z.object({
  name: z.string().trim().min(2).max(120),
  protectsAgainst: z.string().trim().max(200).optional().default(''),
  group: z.enum(['CHILD', 'ADULT', 'TRAVEL']).optional().default('CHILD'),
  price: z.coerce.number().min(0).max(1000000).optional().default(0),
  isActive: z.boolean().optional().default(true),
});
const dupName = (e) => (e?.code === '23505' ? badRequest('A vaccine with this name already exists') : e);

router.post('/catalogue', allow('ADMIN'), asyncHandler(async (req, res) => {
  const d = vaccineBody.parse(req.body);
  try {
    const q = await pool.query(
      `INSERT INTO vaccines(hospital_id,name,protects_against,group_key,price,is_active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(sort_order),0)+1 FROM vaccines WHERE hospital_id=$1)) RETURNING id`,
      [req.user.hospitalId, d.name, d.protectsAgainst, d.group, d.price, d.isActive]);
    await markChanged(pool, req.user.hospitalId);
    const all = await loadCatalogue(pool, req.user.hospitalId);
    res.status(201).json(catalogueJson(all.find(v => v.id === Number(q.rows[0].id))));
  } catch (e) { throw dupName(e); }
}));

router.put('/catalogue/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const d = vaccineBody.parse(req.body);
  const before = (await pool.query(`SELECT name,group_key,is_active FROM vaccines WHERE id=$1 AND hospital_id=$2`, [req.params.id, req.user.hospitalId])).rows[0];
  try {
    const q = await pool.query(
      `UPDATE vaccines SET name=$3,protects_against=$4,group_key=$5,price=$6,is_active=$7,updated_at=NOW() WHERE id=$1 AND hospital_id=$2 RETURNING id`,
      [req.params.id, req.user.hospitalId, d.name, d.protectsAgainst, d.group, d.price, d.isActive]);
    if (!q.rowCount) throw notFound('Vaccine not found');
    if (before.name !== d.name || before.group_key !== d.group || before.is_active !== d.isActive) await markChanged(pool, req.user.hospitalId);
    const all = await loadCatalogue(pool, req.user.hospitalId);
    res.json(catalogueJson(all.find(v => v.id === Number(req.params.id))));
  } catch (e) { throw dupName(e); }
}));

router.put('/catalogue/:id/schedule', allow('ADMIN'), asyncHandler(async (req, res) => {
  const { doses } = z.object({ doses: z.array(z.object({
    label: z.string().trim().max(40).optional().default(''),
    dueAgeDays: z.coerce.number().int().min(0).max(40000),
    minAgeDays: z.coerce.number().int().min(0).max(40000),
    minGapDays: z.coerce.number().int().min(0).max(4000).optional().default(0),
  })).max(20) }).parse(req.body);
  for (const d of doses) if (d.minAgeDays > d.dueAgeDays) throw badRequest('The earliest age cannot be later than the due age');
  await withTransaction(async (client) => {
    const v = await client.query(`SELECT id FROM vaccines WHERE id=$1 AND hospital_id=$2`, [req.params.id, req.user.hospitalId]);
    if (!v.rowCount) throw notFound('Vaccine not found');
    // doses that already have records keep their number, so only the ones above the last recorded dose can be removed
    const used = await client.query(`SELECT COALESCE(MAX(dose_no),0)::int AS m FROM patient_vaccinations WHERE vaccine_id=$1`, [req.params.id]);
    if (doses.length < used.rows[0].m) throw badRequest(`Patients already have dose ${used.rows[0].m} recorded, so at least ${used.rows[0].m} doses must stay in the schedule`);
    await client.query(`DELETE FROM vaccine_schedule WHERE vaccine_id=$1`, [req.params.id]);
    for (let i = 0; i < doses.length; i += 1) {
      const d = doses[i];
      await client.query(`INSERT INTO vaccine_schedule(hospital_id,vaccine_id,dose_no,label,due_age_days,min_age_days,min_gap_days) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.hospitalId, req.params.id, i + 1, d.label, d.dueAgeDays, d.minAgeDays, d.minGapDays]);
    }
    await markChanged(client, req.user.hospitalId);
  });
  const all = await loadCatalogue(pool, req.user.hospitalId);
  res.json(catalogueJson(all.find(v => v.id === Number(req.params.id))));
}));

// ---- one patient's vaccine record ----
async function patientBasics(db, hospitalId, patientId) {
  const q = await db.query(`SELECT id,full_name,mobile,to_char(date_of_birth,'YYYY-MM-DD') AS dob,dob_estimated FROM patients WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`, [patientId, hospitalId]);
  if (!q.rowCount) throw notFound('Patient not found');
  return q.rows[0];
}

router.get('/patient/:patientId', asyncHandler(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const settings = await readSettings(pool, hospitalId);
  const patient = await patientBasics(pool, hospitalId, req.params.patientId);
  if (!settings.enabled) return res.json({ ...settings, items: [], summary: null, patient: { id: Number(patient.id) } });
  const [catalogue, recs, open] = await Promise.all([
    loadCatalogue(pool, hospitalId, { activeOnly: false }),
    recordsOf(pool, hospitalId, [patient.id]),
    pool.query(`SELECT id,status,doctor_id,daily_number,to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day FROM visits WHERE hospital_id=$1 AND patient_id=$2 AND status=ANY($3::text[]) ORDER BY id DESC LIMIT 1`, [hospitalId, patient.id, OPEN_FOR_STAFF]),
  ]);
  const records = recs.get(String(patient.id)) || [];
  const worked = workOutSchedule({ dob: patient.dob, vaccines: catalogue, records });
  // until the schedule is approved, dates are not shown: records only
  const items = settings.approved ? worked.items : worked.items.filter(i => i.kind === 'RECORD');
  res.json({
    ...settings, patient: { id: Number(patient.id), name: patient.full_name, dob: patient.dob, dobEstimated: patient.dob_estimated },
    items: items.map(i => i.kind === 'RECORD' ? { ...i, record: { id: i.record.id, status: i.record.status, givenOn: i.record.given_on, recordedOn: i.record.recorded_on, batchNo: i.record.batch_no, expiry: i.record.expiry_on, site: i.record.site, brand: i.record.brand, note: i.record.note, visitId: i.record.visit_id, price: i.record.price_charged === null ? null : Number(i.record.price_charged), billed: Boolean(i.record.charge_id), recordedBy: i.record.recorded_by_name } } : i),
    summary: settings.approved ? worked.summary : null,
    vaccines: catalogue.filter(v => v.is_active).map(v => ({ id: v.id, name: v.name, group: v.group_key, price: v.price, doses: v.doses.length })),
    openVisit: open.rowCount ? { id: Number(open.rows[0].id), status: open.rows[0].status, doctorId: Number(open.rows[0].doctor_id), token: open.rows[0].daily_number, day: open.rows[0].day } : null,
  });
}));

const doseBody = z.object({
  visitId: z.coerce.number().int().positive(),
  vaccineId: z.coerce.number().int().positive(),
  doseNo: z.coerce.number().int().min(1).max(20),
  givenOn: z.string().date().optional(),
  batchNo: z.string().trim().max(60).optional().default(''),
  expiry: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  site: z.string().trim().max(40).optional().default(''),
  brand: z.string().trim().max(80).optional().default(''),
  note: z.string().trim().max(300).optional().default(''),
});

// A dose is always recorded inside an open visit, so that the bill and the audit trail stay together.
router.post('/patient/:patientId/doses', asyncHandler(async (req, res) => {
  const d = doseBody.parse(req.body);
  const hospitalId = req.user.hospitalId;
  const result = await withTransaction(async (client) => {
    const settings = await readSettings(client, hospitalId);
    if (!settings.enabled) throw badRequest('Vaccination is not switched on for this hospital');
    const patient = await patientBasics(client, hospitalId, req.params.patientId);
    const visit = (await client.query(`SELECT id,patient_id,status,doctor_id FROM visits WHERE id=$1 AND hospital_id=$2 FOR UPDATE`, [d.visitId, hospitalId])).rows[0];
    if (!visit || Number(visit.patient_id) !== Number(patient.id)) throw badRequest('This visit does not belong to this patient');
    if (req.user.role === 'DOCTOR') {
      if (Number(visit.doctor_id) !== Number(req.user.id)) throw forbidden('This visit is assigned to another doctor');
      if (visit.status !== 'WITH_DOCTOR') throw badRequest('Start the consultation before recording a vaccine');
    } else if (!OPEN_FOR_STAFF.includes(visit.status)) throw badRequest('Doses are recorded inside an open visit. Create a visit for the patient first.');
    const vaccine = (await client.query(`SELECT id,name,price,is_active FROM vaccines WHERE id=$1 AND hospital_id=$2`, [d.vaccineId, hospitalId])).rows[0];
    if (!vaccine || !vaccine.is_active) throw badRequest('This vaccine is not available');
    const today = todayIst();
    const givenOn = d.givenOn || today;
    if (givenOn > today) throw badRequest('The date given cannot be in the future');
    if (patient.dob && givenOn < patient.dob) throw badRequest('The date given is before the patient was born');
    if (d.expiry && `${d.expiry}-28` < givenOn) throw badRequest('This batch has expired. Check the expiry date.');
    const existing = await client.query(`SELECT 1 FROM patient_vaccinations WHERE patient_id=$1 AND vaccine_id=$2 AND dose_no=$3`, [patient.id, vaccine.id, d.doseNo]);
    if (existing.rowCount) throw badRequest(`Dose ${d.doseNo} of ${vaccine.name} is already recorded for this patient`);
    const price = Number(vaccine.price);
    const label = `Vaccine: ${vaccine.name} (dose ${d.doseNo})`;
    let chargeId = null; let charged = 'NONE';
    if (price > 0 && visit.status === 'PAYMENT_PENDING') {
      const c = await client.query(
        `INSERT INTO visit_charges(hospital_id,visit_id,billing_item_id,description,amount,source,added_by,doctor_id,is_locked) VALUES($1,$2,NULL,$3,$4,'RECEPTION',$5,NULL,FALSE) RETURNING id`,
        [hospitalId, visit.id, label, price, req.user.id]);
      chargeId = c.rows[0].id; charged = 'ADDED';
    } else if (price > 0) charged = 'DRAFT'; // before the visit is finished the charge joins the draft bill on the visit page
    const ins = await client.query(
      `INSERT INTO patient_vaccinations(hospital_id,patient_id,vaccine_id,dose_no,status,given_on,batch_no,expiry_on,site,brand,note,visit_id,charge_id,price_charged,recorded_by)
       VALUES($1,$2,$3,$4,'GIVEN',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [hospitalId, patient.id, vaccine.id, d.doseNo, givenOn, d.batchNo, d.expiry ? `${d.expiry}-01` : null, d.site, d.brand, d.note, visit.id, chargeId, price > 0 ? price : null, req.user.id]);
    return { id: Number(ins.rows[0].id), charged, draftCharge: charged === 'DRAFT' ? { description: label, amount: price } : null, price };
  });
  res.status(201).json(result);
}));

// Given elsewhere or skipped: a doctor or the Admin marks a dose that will not be given here. No visit and no bill.
router.post('/patient/:patientId/history', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const d = z.object({
    vaccineId: z.coerce.number().int().positive(), doseNo: z.coerce.number().int().min(1).max(20),
    status: z.enum(['GIVEN_ELSEWHERE', 'SKIPPED']), givenOn: z.string().date().optional(), note: z.string().trim().max(300).optional().default(''),
  }).parse(req.body);
  const hospitalId = req.user.hospitalId;
  const patient = await patientBasics(pool, hospitalId, req.params.patientId);
  const vaccine = (await pool.query(`SELECT id,name FROM vaccines WHERE id=$1 AND hospital_id=$2`, [d.vaccineId, hospitalId])).rows[0];
  if (!vaccine) throw badRequest('This vaccine is not available');
  // the date is optional: a dose given elsewhere often has none, and a skipped dose never has one
  const today = todayIst();
  const givenOn = d.status === 'SKIPPED' ? null : (d.givenOn || null);
  if (givenOn && givenOn > today) throw badRequest('The date cannot be in the future');
  if (givenOn && patient.dob && givenOn < patient.dob) throw badRequest('The date is before the patient was born');
  try {
    const q = await pool.query(
      `INSERT INTO patient_vaccinations(hospital_id,patient_id,vaccine_id,dose_no,status,given_on,note,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [hospitalId, patient.id, vaccine.id, d.doseNo, d.status, givenOn, d.note, req.user.id]);
    res.status(201).json({ id: Number(q.rows[0].id) });
  } catch (e) {
    if (e?.code === '23505') throw badRequest(`Dose ${d.doseNo} of ${vaccine.name} is already recorded for this patient`);
    throw e;
  }
}));

router.post('/patient/:patientId/history-bulk', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const d = z.object({
    doses: z.array(z.object({ vaccineId: z.coerce.number().int().positive(), doseNo: z.coerce.number().int().min(1).max(20) })).min(1).max(80),
    status: z.enum(['GIVEN_ELSEWHERE', 'SKIPPED']), givenOn: z.string().date().optional(), note: z.string().trim().max(300).optional().default(''),
  }).parse(req.body);
  const hospitalId = req.user.hospitalId;
  const patient = await patientBasics(pool, hospitalId, req.params.patientId);
  const today = todayIst();
  const givenOn = d.status === 'SKIPPED' ? null : (d.givenOn || null);
  if (givenOn && givenOn > today) throw badRequest('The date cannot be in the future');
  if (givenOn && patient.dob && givenOn < patient.dob) throw badRequest('The date is before the patient was born');
  const saved = await withTransaction(async (client) => {
    let n = 0;
    for (const x of d.doses) {
      const ok = await client.query(`SELECT 1 FROM vaccines WHERE id=$1 AND hospital_id=$2`, [x.vaccineId, hospitalId]);
      if (!ok.rowCount) continue;
      const r = await client.query(
        `INSERT INTO patient_vaccinations(hospital_id,patient_id,vaccine_id,dose_no,status,given_on,note,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (patient_id,vaccine_id,dose_no) DO NOTHING`,
        [hospitalId, patient.id, x.vaccineId, x.doseNo, d.status, givenOn, d.note, req.user.id]);
      n += r.rowCount;
    }
    return n;
  });
  res.status(201).json({ saved });
}));

// Correct the details of a dose that is already recorded (date, batch, expiry, site, brand, note). The vaccine, dose number and bill are not changed.
// A doctor or the Admin can do this at any time; Reception only while the visit the dose belongs to is still open.
router.patch('/patient/:patientId/doses/:doseId', asyncHandler(async (req, res) => {
  const d = z.object({
    givenOn: z.string().date().nullable().optional(),
    batchNo: z.string().trim().max(60).optional(),
    expiry: z.union([z.string().regex(/^\d{4}-\d{2}$/), z.literal(''), z.null()]).optional(),
    site: z.string().trim().max(40).optional(),
    brand: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const hospitalId = req.user.hospitalId;
  const result = await withTransaction(async (client) => {
    const dose = (await client.query(`SELECT id,patient_id,visit_id,status,to_char(given_on,'YYYY-MM-DD') AS given_on FROM patient_vaccinations WHERE id=$1 AND patient_id=$2 AND hospital_id=$3 FOR UPDATE`, [req.params.doseId, req.params.patientId, hospitalId])).rows[0];
    if (!dose) throw notFound('Dose not found');
    const patient = await patientBasics(client, hospitalId, req.params.patientId);
    if (req.user.role === 'RECEPTIONIST') {
      const v = dose.visit_id ? (await client.query(`SELECT status FROM visits WHERE id=$1 AND hospital_id=$2`, [dose.visit_id, hospitalId])).rows[0] : null;
      if (!v || !OPEN_FOR_STAFF.includes(v.status)) throw forbidden('Only a doctor or the Admin can change a dose after the visit is closed');
    }
    const today = todayIst();
    const givenOn = dose.status === 'SKIPPED' ? null : (d.givenOn === undefined ? dose.given_on : (d.givenOn || null));
    if (dose.status === 'GIVEN' && !givenOn) throw badRequest('Enter the date the dose was given');
    if (givenOn && givenOn > today) throw badRequest('The date given cannot be in the future');
    if (givenOn && patient.dob && givenOn < patient.dob) throw badRequest('The date given is before the patient was born');
    const expiry = d.expiry === undefined ? undefined : (d.expiry ? d.expiry : null);
    if (expiry && givenOn && `${expiry}-28` < givenOn) throw badRequest('This batch has expired. Check the expiry date.');
    await client.query(
      `UPDATE patient_vaccinations SET given_on=$2::date,batch_no=COALESCE($3,batch_no),expiry_on=CASE WHEN $4::boolean THEN $5::date ELSE expiry_on END,site=COALESCE($6,site),brand=COALESCE($7,brand),note=COALESCE($8,note) WHERE id=$1`,
      [dose.id, givenOn, d.batchNo ?? null, expiry !== undefined, expiry ? `${expiry}-01` : null, d.site ?? null, d.brand ?? null, d.note ?? null]);
    return { id: Number(dose.id) };
  });
  res.json(result);
}));

router.delete('/patient/:patientId/doses/:doseId', asyncHandler(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const result = await withTransaction(async (client) => {
    const dose = (await client.query(`SELECT id,visit_id,charge_id,price_charged,status,recorded_by FROM patient_vaccinations WHERE id=$1 AND patient_id=$2 AND hospital_id=$3 FOR UPDATE`, [req.params.doseId, req.params.patientId, hospitalId])).rows[0];
    if (!dose) throw notFound('Dose not found');
    let draft = false;
    if (dose.visit_id) {
      const visit = (await client.query(`SELECT status,doctor_id FROM visits WHERE id=$1 AND hospital_id=$2 FOR UPDATE`, [dose.visit_id, hospitalId])).rows[0];
      if (!OPEN_FOR_STAFF.includes(visit.status)) throw badRequest('This visit is already closed, so the dose can no longer be removed here');
      if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== Number(req.user.id)) throw forbidden('This visit is assigned to another doctor');
      if (dose.charge_id) await client.query(`UPDATE visit_charges SET is_voided=TRUE,updated_at=NOW() WHERE id=$1 AND hospital_id=$2 AND is_locked=FALSE`, [dose.charge_id, hospitalId]);
      draft = !dose.charge_id && dose.price_charged !== null && ['WAITING_FOR_DOCTOR', 'WITH_DOCTOR'].includes(visit.status);
    } else if (!['ADMIN', 'DOCTOR'].includes(req.user.role)) throw forbidden('Only a doctor or the Admin can remove this entry');
    await client.query(`DELETE FROM patient_vaccinations WHERE id=$1`, [dose.id]);
    return { removed: true, removedDraft: draft, amount: dose.price_charged === null ? 0 : Number(dose.price_charged) };
  });
  res.json(result);
}));

// ---- the call list: who is overdue or due soon ----
router.get('/due', asyncHandler(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const settings = await readSettings(pool, hospitalId);
  if (!settings.enabled || !settings.approved) return res.json({ ...settings, rows: [], totals: { overdue: 0, week: 0, soon: 0 } });
  const today = todayIst();
  const params = [hospitalId, addDays(today, -19 * 365)];
  let doctorSql = '';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); doctorSql = ` AND EXISTS (SELECT 1 FROM visit_doctors vd WHERE vd.hospital_id=p.hospital_id AND vd.doctor_id=$3 AND vd.visit_id IN (SELECT v.id FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id))`; }
  const people = await pool.query(
    `SELECT p.id,p.full_name,p.mobile,COALESCE(p.whatsapp_mobile,p.mobile) AS whatsapp,to_char(p.date_of_birth,'YYYY-MM-DD') AS dob,p.dob_estimated FROM patients p
     WHERE p.hospital_id=$1 AND p.deleted_at IS NULL AND p.date_of_birth IS NOT NULL AND p.date_of_birth >= $2::date${doctorSql}`, params);
  const [catalogue, recs] = await Promise.all([loadCatalogue(pool, hospitalId, { activeOnly: true }), recordsOf(pool, hospitalId, people.rows.map(p => Number(p.id)))]);
  const rows = [];
  const totals = { overdue: 0, week: 0, soon: 0 };
  for (const p of people.rows) {
    const { items } = workOutSchedule({ dob: p.dob, vaccines: catalogue, records: recs.get(String(p.id)) || [], today });
    const due = items.filter(i => i.kind === 'PENDING' && (i.status === 'OVERDUE' || i.daysLeft <= days));
    if (!due.length) continue;
    const worst = Math.min(...due.map(i => i.daysLeft));
    if (worst < 0) totals.overdue += 1; else if (worst <= 7) totals.week += 1; else totals.soon += 1;
    rows.push({ patientId: Number(p.id), name: p.full_name, mobile: p.mobile, whatsapp: p.whatsapp, dob: p.dob, dobEstimated: p.dob_estimated, worst,
      doses: due.sort((a, b) => a.daysLeft - b.daysLeft).map(i => ({ vaccineId: i.vaccineId, name: i.name, label: i.label, doseNo: i.doseNo, status: i.status, dueOn: i.dueOn, daysLeft: i.daysLeft })) });
  }
  rows.sort((a, b) => a.worst - b.worst || a.name.localeCompare(b.name));
  // a reminder counts as sent for the earliest due date; a newly due dose is a new reminder
  const sent = await sentMap(pool, hospitalId, 'VACCINE', rows.map(r => r.patientId));
  for (const r of rows) { r.reminderRef = r.doses[0].dueOn; r.reminder = sent.get(`${r.patientId}:${r.reminderRef}`) || null; }
  res.json({ ...settings, days, totals, total: rows.length, rows: rows.slice(0, 500) });
}));

export default router;
