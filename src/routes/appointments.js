// Online appointments, for the hospital's staff: the booking settings (Admin) and the list of bookings (Admin, Reception, Doctor).
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { todayIst } from '../vaccination.js';
import { hospitalHours, hospitalOpenOn, insideHospital, weekdayOf } from '../bookingSlots.js';
import { createVisitTx } from './visits.js';
import { ensureDoctorCodes, hospitalReasons } from './booking.js';

const router = Router();

const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3 to 40 letters, numbers or dashes (for example sunrise-clinic)');
const suggestSlug = (name) => String(name || 'clinic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'clinic';

// Two clinics can share a name, so a suggested address is checked against the others. When the plain name is taken, the pincode from the
// address is added, then a short random ending.
async function freeSlug(name, address, hospitalId) {
  const base = suggestSlug(name);
  const pin = (String(address || '').match(/\b\d{6}\b/) || [])[0];
  const tries = [base, ...(pin ? [`${base}-${pin}`.slice(0, 40)] : [])];
  for (let i = 0; i < 6; i += 1) tries.push(`${base.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`);
  for (const slug of tries) {
    const taken = await pool.query('SELECT 1 FROM hospitals WHERE lower(booking_slug)=$1 AND id<>$2', [slug, hospitalId]);
    if (!taken.rowCount) return slug;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

async function readSettings(hospitalId) {
  const h = (await pool.query(
    `SELECT name,address,booking_slug,booking_enabled,booking_advance_days FROM hospitals WHERE id=$1`, [hospitalId])).rows[0];
  await ensureDoctorCodes(hospitalId);
  const doctors = (await pool.query(
    `SELECT id,name,online_booking,booking_code FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL ORDER BY name`, [hospitalId])).rows;
  const schedules = (await pool.query(
    `SELECT doctor_id,weekday,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS "end",slot_minutes,per_slot
     FROM doctor_schedules WHERE hospital_id=$1 ORDER BY doctor_id,weekday,start_time`, [hospitalId])).rows;
  const off = (await pool.query(
    `SELECT id,doctor_id,to_char(day,'YYYY-MM-DD') AS day,note FROM doctor_days_off WHERE hospital_id=$1 AND day >= $2 ORDER BY day`, [hospitalId, todayIst()])).rows;
  return {
    enabled: h.booking_enabled,
    slug: h.booking_slug || '',
    suggestedSlug: await freeSlug(h.name, h.address, hospitalId),
    advanceDays: h.booking_advance_days,
    hospitalHours: await hospitalHours(hospitalId),
    reasonCount: (await hospitalReasons(hospitalId)).length,
    doctors: doctors.map(d => ({
      id: Number(d.id), code: d.booking_code, name: d.name, onlineBooking: d.online_booking,
      schedules: schedules.filter(s => Number(s.doctor_id) === Number(d.id)).map(s => ({ weekday: s.weekday, start: s.start, end: s.end, slotMinutes: s.slot_minutes, perSlot: s.per_slot })),
      daysOff: off.filter(o => Number(o.doctor_id) === Number(d.id)).map(o => ({ id: Number(o.id), day: o.day, note: o.note || '' })),
    })),
  };
}

router.get('/settings', allow('ADMIN'), asyncHandler(async (req, res) => { res.json(await readSettings(req.user.hospitalId)); }));

router.put('/settings', allow('ADMIN'), asyncHandler(async (req, res) => {
  const d = z.object({ enabled: z.boolean(), slug: slugSchema, advanceDays: z.coerce.number().int().min(1).max(60) }).parse(req.body);
  const taken = await pool.query(`SELECT 1 FROM hospitals WHERE lower(booking_slug)=$1 AND id<>$2`, [d.slug, req.user.hospitalId]);
  if (taken.rowCount) {
    const h = (await pool.query('SELECT name,address FROM hospitals WHERE id=$1', [req.user.hospitalId])).rows[0];
    throw badRequest(`The address "${d.slug}" is already used by another hospital. Please choose a different one, for example "${await freeSlug(d.slug, h.address, req.user.hospitalId)}".`);
  }
  await pool.query(`UPDATE hospitals SET booking_slug=$2,booking_enabled=$3,booking_advance_days=$4 WHERE id=$1`, [req.user.hospitalId, d.slug, d.enabled, d.advanceDays]);
  res.json(await readSettings(req.user.hospitalId));
}));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30');
const scheduleSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6), start: hhmm, end: hhmm,
  slotMinutes: z.coerce.number().int().min(5).max(120), perSlot: z.coerce.number().int().min(1).max(20),
});
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

async function ownDoctor(hospitalId, id) {
  const q = await pool.query(`SELECT id FROM users WHERE hospital_id=$1 AND id=$2 AND role='DOCTOR' AND deleted_at IS NULL`, [hospitalId, id]);
  if (!q.rowCount) throw notFound('Doctor not found');
}

// switch a doctor on or off, and replace their weekly timings
router.put('/doctors/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const d = z.object({ onlineBooking: z.boolean(), schedules: z.array(scheduleSchema).max(28) }).parse(req.body);
  await ownDoctor(req.user.hospitalId, id);
  for (const s of d.schedules) {
    if (minutes(s.end) - minutes(s.start) < s.slotMinutes) throw badRequest('Each timing must be at least one slot long');
  }
  for (let wd = 0; wd < 7; wd += 1) {
    const rows = d.schedules.filter(s => s.weekday === wd).sort((a, b) => minutes(a.start) - minutes(b.start));
    for (let i = 1; i < rows.length; i += 1) if (minutes(rows[i].start) < minutes(rows[i - 1].end)) throw badRequest('Timings on the same day cannot overlap');
  }
  const hours = await hospitalHours(req.user.hospitalId);
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const s of d.schedules) {
    if (!hospitalOpenOn(s.weekday, hours)) throw badRequest(`The hospital is closed on ${DAY[s.weekday]}s (weekly off), so a doctor cannot take bookings that day. Change the weekly off in Hospital Settings > Timings first.`);
    if (!insideHospital(s.weekday, s.start, s.end, hours)) throw badRequest(`${DAY[s.weekday]} ${s.start}–${s.end} is outside the hospital's open hours (${hours.sessions.map(x => `${x.from}–${x.to}`).join(' and ')}). Choose times inside them.`);
  }
  if (d.onlineBooking && !d.schedules.length) throw badRequest('Add at least one timing before switching online booking on for this doctor');
  await withTransaction(async (client) => {
    await client.query(`UPDATE users SET online_booking=$3 WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, id, d.onlineBooking]);
    await client.query(`DELETE FROM doctor_schedules WHERE hospital_id=$1 AND doctor_id=$2`, [req.user.hospitalId, id]);
    for (const s of d.schedules) {
      await client.query(
        `INSERT INTO doctor_schedules(hospital_id,doctor_id,weekday,start_time,end_time,slot_minutes,per_slot) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.hospitalId, id, s.weekday, s.start, s.end, s.slotMinutes, s.perSlot]);
    }
  });
  res.json(await readSettings(req.user.hospitalId));
}));

router.post('/doctors/:id/days-off', allow('ADMIN'), asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const d = z.object({ day: z.string().date(), note: z.string().trim().max(120).optional() }).parse(req.body);
  await ownDoctor(req.user.hospitalId, id);
  if (d.day < todayIst()) throw badRequest('Choose today or a later date');
  const hours = await hospitalHours(req.user.hospitalId);
  if (!hospitalOpenOn(weekdayOf(d.day), hours)) throw badRequest('The hospital is closed that day (weekly off), so a day off is not needed.');
  const works = await pool.query('SELECT 1 FROM doctor_schedules WHERE hospital_id=$1 AND doctor_id=$2 AND weekday=$3 LIMIT 1', [req.user.hospitalId, id, weekdayOf(d.day)]);
  if (!works.rowCount) throw badRequest('This doctor has no online timings on that weekday, so there is nothing to switch off.');
  await pool.query(`INSERT INTO doctor_days_off(hospital_id,doctor_id,day,note) VALUES($1,$2,$3,$4) ON CONFLICT (hospital_id,doctor_id,day) DO UPDATE SET note=EXCLUDED.note`, [req.user.hospitalId, id, d.day, d.note || null]);
  const booked = await pool.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE hospital_id=$1 AND doctor_id=$2 AND slot_day=$3 AND status='BOOKED'`, [req.user.hospitalId, id, d.day]);
  res.json({ ...(await readSettings(req.user.hospitalId)), alreadyBooked: booked.rows[0].n });
}));

router.delete('/days-off/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  await pool.query(`DELETE FROM doctor_days_off WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id]);
  res.json(await readSettings(req.user.hospitalId));
}));

// ---- the reasons patients choose from ----
router.get('/reasons', allow('ADMIN'), asyncHandler(async (req, res) => { res.json(await hospitalReasons(req.user.hospitalId)); }));
router.put('/reasons', allow('ADMIN'), asyncHandler(async (req, res) => {
  const d = z.object({ reasons: z.array(z.object({ name: z.string().trim().min(2, 'A reason needs at least 2 letters').max(60), severity: z.enum(['LOW', 'MEDIUM', 'HIGH']) })).min(1, 'Keep at least one reason').max(30, 'At most 30 reasons') }).parse(req.body);
  const names = d.reasons.map(r => r.name.replace(/\s+/g, ' ').toLowerCase());
  if (new Set(names).size !== names.length) throw badRequest('Each reason can be listed only once');
  await withTransaction(async (client) => {
    await client.query('DELETE FROM booking_reasons WHERE hospital_id=$1', [req.user.hospitalId]);
    for (const [i, r] of d.reasons.entries()) await client.query('INSERT INTO booking_reasons(hospital_id,name,severity,position) VALUES($1,$2,$3,$4)', [req.user.hospitalId, r.name.replace(/\s+/g, ' '), r.severity, i + 1]);
  });
  res.json(await hospitalReasons(req.user.hospitalId));
}));

// ---- the bookings ----
const COLUMNS = `a.id,a.reference,a.doctor_id,u.name AS doctor_name,a.slot_at,to_char(a.slot_day,'YYYY-MM-DD') AS day,
  to_char(a.slot_at AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS time,a.patient_id,a.full_name,a.mobile,a.gender,
  to_char(a.date_of_birth,'YYYY-MM-DD') AS date_of_birth,a.dob_estimated,a.reasons,a.reason_note,a.severity,a.status,a.source,a.visit_id,a.created_at,
  v.daily_number AS token,
  (SELECT COUNT(*)::int FROM appointments n WHERE n.hospital_id=a.hospital_id AND n.mobile=a.mobile AND n.status='NO_SHOW' AND n.slot_day > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30) AS earlier_no_shows,
  EXISTS (SELECT 1 FROM blocked_mobiles bm WHERE bm.hospital_id=a.hospital_id AND bm.mobile=a.mobile) AS blocked,
  (a.status='ARRIVED' AND v.status='WAITING_FOR_DOCTOR'
    AND NOT EXISTS (SELECT 1 FROM visit_doctors vd WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id AND vd.status<>'WAITING')
    AND NOT EXISTS (SELECT 1 FROM payments py WHERE py.hospital_id=v.hospital_id AND py.visit_id=v.id)) AS can_undo`;

router.get('/', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const today = todayIst();
  const from = z.string().date().parse(String(req.query.dateFrom || today));
  const to = z.string().date().parse(String(req.query.dateTo || from));
  if (from > to) throw badRequest('From date cannot be after To date');
  const params = [req.user.hospitalId, from, to];
  let extra = '';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); extra += ` AND a.doctor_id=$${params.length}`; }
  else if (req.query.doctorId) { params.push(z.coerce.number().int().positive().parse(req.query.doctorId)); extra += ` AND a.doctor_id=$${params.length}`; }
  const q = await pool.query(
    `SELECT ${COLUMNS} FROM appointments a
     JOIN users u ON u.hospital_id=a.hospital_id AND u.id=a.doctor_id
     LEFT JOIN visits v ON v.hospital_id=a.hospital_id AND v.id=a.visit_id
     WHERE a.hospital_id=$1 AND a.slot_day BETWEEN $2 AND $3${extra}
     ORDER BY a.slot_at,a.id LIMIT 1000`, params);
  // each reason with the severity the hospital has set for it now (a reason removed since then counts as normal)
  const own = new Map((await hospitalReasons(req.user.hospitalId)).map(x => [x.name, x.severity]));
  res.json(q.rows.map(r => ({ ...r, id: Number(r.id), doctor_id: Number(r.doctor_id), visit_id: r.visit_id ? Number(r.visit_id) : null, reasonDetails: r.reasons.map(name => ({ name, severity: own.get(name) || 'LOW' })) })));
}));

// The patient shows the QR from their confirmation: it holds the booking number, and the staff open that booking.
router.get('/by-ref/:ref', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const ref = String(req.params.ref || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(ref)) throw notFound('Booking not found');
  const params = [req.user.hospitalId, ref];
  let extra = '';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); extra = ' AND doctor_id=$3'; }
  const q = await pool.query(`SELECT id,reference,to_char(slot_day,'YYYY-MM-DD') AS day,status FROM appointments WHERE hospital_id=$1 AND reference=$2${extra}`, params);
  if (!q.rowCount) throw notFound('This booking was not found in this hospital');
  res.json({ ...q.rows[0], id: Number(q.rows[0].id) });
}));

// Block a mobile number from booking online (and cancel what it still has booked). For spam, or a patient who keeps not coming.
router.post('/:id/block-mobile', allow('ADMIN', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const q = await client.query('SELECT mobile FROM appointments WHERE hospital_id=$1 AND id=$2', [req.user.hospitalId, req.params.id]);
    if (!q.rowCount) throw notFound('Appointment not found');
    const mobile = q.rows[0].mobile;
    await client.query('INSERT INTO blocked_mobiles(hospital_id,mobile,blocked_by) VALUES($1,$2,$3) ON CONFLICT (hospital_id,mobile) DO NOTHING', [req.user.hospitalId, mobile, req.user.id]);
    const c = await client.query(`UPDATE appointments SET status='CANCELLED',status_by=$3,status_at=NOW() WHERE hospital_id=$1 AND mobile=$2 AND status='BOOKED'`, [req.user.hospitalId, mobile, req.user.id]);
    return { mobile, cancelled: c.rowCount };
  });
  res.json(result);
}));
router.get('/blocked', allow('ADMIN'), asyncHandler(async (req, res) => {
  const q = await pool.query('SELECT id,mobile,created_at FROM blocked_mobiles WHERE hospital_id=$1 ORDER BY created_at DESC', [req.user.hospitalId]);
  res.json(q.rows.map(r => ({ ...r, id: Number(r.id) })));
}));
router.delete('/blocked/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM blocked_mobiles WHERE hospital_id=$1 AND id=$2', [req.user.hospitalId, req.params.id]);
  res.json({ ok: true });
}));
// shown as a warning on the Appointments page
router.get('/security', allow('ADMIN', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const q = await pool.query(`SELECT COUNT(*)::int AS n FROM booking_hits WHERE hospital_id=$1 AND kind='cap' AND created_at > NOW() - INTERVAL '1 day'`, [req.user.hospitalId]);
  res.json({ pausedCount: q.rows[0].n });
}));

// number of bookings still waiting today (for the menu)
router.get('/today-count', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const params = [req.user.hospitalId, todayIst()];
  let extra = '';
  if (req.user.role === 'DOCTOR') { params.push(req.user.id); extra = ' AND doctor_id=$3'; }
  const q = await pool.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE hospital_id=$1 AND slot_day=$2 AND status='BOOKED'${extra}`, params);
  res.json({ count: q.rows[0].n });
}));

async function lockBooked(client, hospitalId, id) {
  const q = await client.query(`SELECT * FROM appointments WHERE hospital_id=$1 AND id=$2 FOR UPDATE`, [hospitalId, id]);
  if (!q.rowCount) throw notFound('Appointment not found');
  if (q.rows[0].status !== 'BOOKED') throw badRequest(`This appointment is already marked ${q.rows[0].status.toLowerCase().replace('_', ' ')}`);
  return q.rows[0];
}

// ---- the patient has come ----
// Arriving follows the normal visit process. Before a visit is made, the booking is compared with the patients already registered:
//  EXACT          same mobile and same name: almost certainly the same person, so a second record must not be made
//  SAME_MOBILE    same mobile, another name: usually a family member sharing the phone, so this is a different patient
//  SAME_NAME_AGE  same name and birth date, another mobile: probably the same person with a new number
const OPEN_STATUSES = ['WAITING_FOR_DOCTOR', 'WITH_DOCTOR', 'PAYMENT_PENDING'];
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function arrivalCandidates(db, hospitalId, a) {
  const q = await db.query(
    `SELECT p.id,p.full_name,p.mobile,p.gender,to_char(p.date_of_birth,'YYYY-MM-DD') AS dob,p.dob_estimated,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id AND v.status<>'CANCELLED') AS visit_count,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS last_visit,
            (SELECT json_build_object('id',v.id,'token',v.daily_number,'status',v.status) FROM visits v
              WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id AND v.status=ANY($5::text[])
                AND (v.created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY v.id DESC LIMIT 1) AS open_visit
     FROM patients p
     WHERE p.hospital_id=$1 AND p.deleted_at IS NULL
       AND (p.mobile=$2 OR ($4::date IS NOT NULL AND p.date_of_birth=$4::date AND lower(trim(p.full_name))=lower(trim($3))) OR ($6::bigint IS NOT NULL AND p.id=$6))
     ORDER BY p.id`,
    [hospitalId, a.mobile, a.full_name, a.dob || null, OPEN_STATUSES, a.patient_id || null]);
  return q.rows.map(p => {
    const sameName = norm(p.full_name) === norm(a.full_name);
    const sameMobile = p.mobile === a.mobile;
    const match = a.patient_id && Number(p.id) === Number(a.patient_id) ? 'EXACT' : sameMobile && sameName ? 'EXACT' : sameMobile ? 'SAME_MOBILE' : 'SAME_NAME_AGE';
    return { id: Number(p.id), name: p.full_name, mobile: p.mobile, gender: p.gender, dob: p.dob, dobEstimated: p.dob_estimated, visitCount: p.visit_count, lastVisit: p.last_visit, openVisit: p.open_visit, match };
  }).sort((x, y) => ['EXACT', 'SAME_NAME_AGE', 'SAME_MOBILE'].indexOf(x.match) - ['EXACT', 'SAME_NAME_AGE', 'SAME_MOBILE'].indexOf(y.match));
}

const bookingForCheck = async (db, hospitalId, id) => {
  const q = await db.query(`SELECT *,to_char(date_of_birth,'YYYY-MM-DD') AS dob FROM appointments WHERE hospital_id=$1 AND id=$2`, [hospitalId, id]);
  if (!q.rowCount) throw notFound('Appointment not found');
  return q.rows[0];
};

router.get('/:id/arrival', allow('ADMIN', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const a = await bookingForCheck(pool, req.user.hospitalId, req.params.id);
  if (a.status !== 'BOOKED') throw badRequest(`This appointment is already marked ${a.status.toLowerCase().replace('_', ' ')}`);
  res.json({
    booking: { name: a.full_name, mobile: a.mobile, gender: a.gender, dob: a.dob, dobEstimated: a.dob_estimated, doctorId: Number(a.doctor_id), fromQr: Boolean(a.patient_id) },
    candidates: await arrivalCandidates(pool, req.user.hospitalId, a),
  });
}));

// body (all optional): { patientId } use that patient; { createNew: true } register a new one; { confirmOpen: true } add a visit even though
// the chosen patient already has an open visit today. With no body, an exact match is used, otherwise a new patient is registered.
router.post('/:id/arrive', allow('ADMIN', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  const d = z.object({ patientId: z.coerce.number().int().positive().optional(), createNew: z.boolean().optional(), confirmOpen: z.boolean().optional() }).parse(req.body || {});
  const result = await withTransaction(async (client) => {
    const locked = await lockBooked(client, req.user.hospitalId, req.params.id);
    const a = await bookingForCheck(client, req.user.hospitalId, locked.id);
    const found = await arrivalCandidates(client, req.user.hospitalId, a);
    const exact = found.find(c => c.match === 'EXACT');
    let patientId = null; let created = false;
    if (a.patient_id) patientId = Number(a.patient_id);
    else if (d.patientId) {
      if (!found.some(c => c.id === d.patientId)) {
        const ok = await client.query('SELECT id FROM patients WHERE hospital_id=$1 AND id=$2 AND deleted_at IS NULL', [req.user.hospitalId, d.patientId]);
        if (!ok.rowCount) throw badRequest('That patient was not found');
      }
      patientId = d.patientId;
    } else if (d.createNew) {
      if (exact) throw badRequest(`${exact.name} is already registered with this mobile number. Choose the existing patient instead of adding a second record.`);
    } else if (exact) patientId = exact.id;

    if (patientId) {
      const chosen = found.find(c => c.id === patientId);
      if (chosen?.openVisit && !d.confirmOpen) {
        throw Object.assign(new Error(`${chosen.name} already has an open visit today (token ${chosen.openVisit.token}). Open that visit, or confirm to add another one.`), { status: 409, openVisit: chosen.openVisit });
      }
      // the visit rules: a patient needs an age or birth date and a gender; fill in what the booking knows
      await client.query(
        `UPDATE patients SET gender=COALESCE(gender,$3),date_of_birth=COALESCE(date_of_birth,$4::date),dob_estimated=CASE WHEN date_of_birth IS NULL THEN $5 ELSE dob_estimated END WHERE hospital_id=$1 AND id=$2`,
        [req.user.hospitalId, patientId, a.gender, a.dob, a.dob_estimated]);
    } else {
      const ins = await client.query(
        `INSERT INTO patients(hospital_id,full_name,mobile,gender,date_of_birth,dob_estimated,created_by,updated_by) VALUES($1,$2,$3,$4,$5::date,$6,$7,$7) RETURNING id`,
        [req.user.hospitalId, a.full_name, a.mobile, a.gender, a.dob, a.dob_estimated, req.user.id]);
      patientId = Number(ins.rows[0].id); created = true;
    }
    const ready = await client.query('SELECT (date_of_birth IS NOT NULL) AS age_ok,(gender IS NOT NULL) AS gender_ok FROM patients WHERE hospital_id=$1 AND id=$2', [req.user.hospitalId, patientId]);
    if (!ready.rows[0].age_ok) throw badRequest('This patient has no age or date of birth. Add it in the patient details first.');
    if (!ready.rows[0].gender_ok) throw badRequest('This patient has no gender. Add it in the patient details first.');
    const visit = await createVisitTx(client, req.user.hospitalId, req.user.id, patientId, [Number(a.doctor_id)]);
    await client.query(`UPDATE appointments SET status='ARRIVED',patient_id=$3,visit_id=$4,status_by=$5,status_at=NOW(),arrived_new_patient=$6 WHERE hospital_id=$1 AND id=$2`,
      [req.user.hospitalId, a.id, patientId, visit.id, req.user.id, created]);
    return { visitId: Number(visit.id), token: visit.daily_number, patientId, newPatient: created };
  });
  res.json(result);
}));

// Marked arrived by mistake: while the patient is still waiting (the doctor has not started, nothing is paid), the booking goes back to Booked
// and the visit is cancelled. A patient that this arrival registered is removed again if nothing else belongs to them.
router.post('/:id/undo-arrival', allow('ADMIN', 'RECEPTIONIST'), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const q = await client.query('SELECT * FROM appointments WHERE hospital_id=$1 AND id=$2 FOR UPDATE', [req.user.hospitalId, req.params.id]);
    if (!q.rowCount) throw notFound('Appointment not found');
    const a = q.rows[0];
    if (a.status !== 'ARRIVED' || !a.visit_id) throw badRequest('This appointment is not marked as arrived');
    const v = await client.query('SELECT id,status FROM visits WHERE hospital_id=$1 AND id=$2 FOR UPDATE', [req.user.hospitalId, a.visit_id]);
    const started = await client.query(`SELECT 1 FROM visit_doctors WHERE hospital_id=$1 AND visit_id=$2 AND status<>'WAITING'`, [req.user.hospitalId, a.visit_id]);
    const paid = await client.query('SELECT 1 FROM payments WHERE hospital_id=$1 AND visit_id=$2', [req.user.hospitalId, a.visit_id]);
    if (v.rows[0]?.status !== 'WAITING_FOR_DOCTOR' || started.rowCount || paid.rowCount) {
      throw badRequest('The doctor has already started this visit, so the arrival cannot be undone here. Cancel or finish the visit from Visits instead.');
    }
    await client.query(`UPDATE visits SET status='CANCELLED',cancelled_by=$3,cancelled_at=NOW(),updated_at=NOW() WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, a.visit_id, req.user.id]);
    await client.query(`UPDATE appointments SET status='BOOKED',visit_id=NULL,status_by=NULL,status_at=NULL,arrived_new_patient=FALSE,patient_id=CASE WHEN source='QR' THEN patient_id ELSE NULL END WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, a.id]);
    if (a.arrived_new_patient && a.patient_id) {
      const other = await client.query(`SELECT 1 FROM visits WHERE hospital_id=$1 AND patient_id=$2 AND status<>'CANCELLED' LIMIT 1`, [req.user.hospitalId, a.patient_id]);
      if (!other.rowCount) await client.query('UPDATE patients SET deleted_at=NOW() WHERE hospital_id=$1 AND id=$2 AND deleted_at IS NULL', [req.user.hospitalId, a.patient_id]);
    }
  });
  res.json({ ok: true });
}));

const mark = (status) => asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const a = await lockBooked(client, req.user.hospitalId, req.params.id);
    await client.query(`UPDATE appointments SET status=$3,status_by=$4,status_at=NOW() WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, a.id, status, req.user.id]);
  });
  res.json({ ok: true });
});
router.post('/:id/cancel', allow('ADMIN', 'RECEPTIONIST'), mark('CANCELLED'));
router.post('/:id/no-show', allow('ADMIN', 'RECEPTIONIST'), mark('NO_SHOW'));

export default router;
