// Automatic WhatsApp reminders through Meta: appointment, follow-up and vaccination.
// When: DhaCare's default times (Super Admin, Pricing > WhatsApp messages), or the hospital's own (Hospital Settings > Subscription >
// WhatsApp), where each reminder is off until the hospital turns it on. Who: only hospitals with WhatsApp messages on (all switches, see whatsappApi.js).
// A timer checks every 10 minutes, between 7 AM and 9 PM India time only. Each reminder is sent once (whatsapp_messages.ref).
import { z } from 'zod';
import { pool } from './db.js';
import { logError } from './errorLog.js';
import { sendWhatsApp, waClock, waDay, whatsappConfigured, whatsappPlatformOn } from './whatsappApi.js';
import { addDays, workOutSchedule } from './vaccination.js';
import { cancelledDoses, loadCatalogue, readSettings as vaccinationSettings, recordsOf } from './routes/vaccines.js';

export const KINDS = ['appointment', 'followUp', 'vaccination'];
export const QUIET = { from: 21, to: 7 }; // nothing is sent from 9 PM to 7 AM
const FALLBACK = { appointment: { hours: 24 }, followUp: { days: 1, hour: 10 }, vaccination: { days: 2, hour: 10 } };

// The times: appointment = hours before (1 hour to 7 days); follow-up and vaccination = days before (0 = on the day), at an hour from 7 AM to 8 PM.
const dayTimes = z.object({ days: z.number().int().min(0).max(14), hour: z.number().int().min(QUIET.to).max(QUIET.from - 1) });
export const timesSchema = z.object({ appointment: z.object({ hours: z.number().int().min(1).max(168) }), followUp: dayTimes, vaccination: dayTimes });

export async function reminderDefaults(db = pool) {
  let d = null;
  try { d = (await db.query(`SELECT reminder_defaults FROM platform_whatsapp WHERE id=1`)).rows[0]?.reminder_defaults; } catch { /* the table is missing: built-in times */ }
  const ok = timesSchema.safeParse(d);
  return ok.success ? ok.data : FALLBACK;
}

// The hospital's reminders as they apply: each is off until the hospital turns it on; its own times where it chose them, DhaCare's defaults otherwise.
export function effectiveReminders(own, defaults) {
  const o = own || {};
  const out = {};
  for (const k of KINDS) {
    const mine = o[k] || {};
    const times = Object.fromEntries(Object.keys(defaults[k]).map(f => [f, Number.isInteger(mine[f]) ? mine[f] : defaults[k][f]]));
    out[k] = { on: mine.on === true, ...times, own: Object.keys(defaults[k]).some(f => Number.isInteger(mine[f])) };
  }
  return out;
}

// What a hospital saves: the reminders it turned on, and only the times that differ from DhaCare's defaults (so a later default change still applies).
export function remindersToStore(input, defaults) {
  const out = {};
  for (const k of KINDS) {
    const o = {};
    if (input[k].on === true) o.on = true;
    for (const f of Object.keys(defaults[k])) if (input[k][f] !== defaults[k][f]) o[f] = input[k][f];
    if (Object.keys(o).length) out[k] = o;
  }
  return Object.keys(out).length ? out : null;
}

const istHour = (now) => Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })) % 24;
const istDay = (now) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const phoneOf = (h) => h.mobile || h.name;

async function alreadySent(hospitalId, kind, keys) {
  if (!keys.length) return new Set();
  const q = await pool.query(`SELECT patient_id,ref FROM whatsapp_messages WHERE hospital_id=$1 AND kind=$2 AND ref=ANY($3::text[])`, [hospitalId, kind, [...new Set(keys.map(k => k.ref))]]);
  return new Set(q.rows.map(r => `${r.patient_id}:${r.ref}`));
}
// a patient who has already booked a visit does not need to be reminded to book one
async function alreadyBooked(hospitalId, today, people) {
  if (!people.length) return new Set();
  const q = await pool.query(
    `SELECT patient_id,mobile FROM appointments WHERE hospital_id=$1 AND status='BOOKED' AND slot_day >= $2::date AND (patient_id=ANY($3::bigint[]) OR mobile=ANY($4::text[]))`,
    [hospitalId, today, people.map(p => p.patientId), people.map(p => p.mobile)]);
  return new Set(q.rows.flatMap(r => [`p${r.patient_id}`, `m${r.mobile}`]));
}

// Booked appointments starting within the next `hours`. Not when the confirmation itself went out inside that time (booked or moved late),
// and not in the last half hour. A moved appointment is reminded again for its new time.
async function appointmentReminders(h, hours, now) {
  const q = await pool.query(
    `SELECT a.id,a.patient_id,a.full_name,a.mobile,a.reference,a.view_code,to_char(a.slot_day,'YYYY-MM-DD') AS day,
            to_char(a.slot_at AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS time,u.name AS doctor_name,to_char(a.slot_at AT TIME ZONE 'UTC','YYYYMMDDHH24MI') AS ref
     FROM appointments a JOIN users u ON u.id=a.doctor_id
     WHERE a.hospital_id=$1 AND a.status='BOOKED' AND a.slot_at > $2::timestamptz + INTERVAL '30 minutes' AND a.slot_at <= $2::timestamptz + make_interval(hours => $3::int)
       AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.appointment_id=a.id AND m.kind='APPOINTMENT_REMINDER' AND m.ref=to_char(a.slot_at AT TIME ZONE 'UTC','YYYYMMDDHH24MI'))
       AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.appointment_id=a.id AND m.kind='APPOINTMENT_CONFIRMATION' AND m.status<>'FAILED' AND m.sent_at >= a.slot_at - make_interval(hours => $3::int))
     ORDER BY a.slot_at LIMIT 300`, [h.id, now.toISOString(), hours]);
  let sent = 0;
  for (const a of q.rows) {
    const r = await sendWhatsApp({ hospitalId: h.id, appointmentId: a.id, patientId: a.patient_id, ref: a.ref, kind: 'APPOINTMENT_REMINDER', toMobile: a.mobile,
      body: [a.full_name, h.name, a.doctor_name, waDay(a.day), waClock(a.time), a.reference, phoneOf(h)], button: a.view_code });
    if (r === 'SENT') sent += 1;
  }
  return sent;
}

// Patients a doctor asked to come back (same list as the Follow-ups page, so not cancelled ones), from `days` before the follow-up date until the date itself.
async function followUpReminders(h, set, today) {
  const q = await pool.query(
    `SELECT v.id AS visit_id,p.id AS patient_id,p.full_name,COALESCE(p.whatsapp_mobile,p.mobile) AS mobile,p.qr_code,
            to_char(v.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_on,MIN(vd.follow_up_days) AS follow_up_days,
            (ARRAY_AGG(u.name ORDER BY vd.follow_up_days,vd.position))[1] AS doctor_name
     FROM visits v
     JOIN visit_doctors vd ON vd.hospital_id=v.hospital_id AND vd.visit_id=v.id AND vd.follow_up_days IS NOT NULL
     JOIN users u ON u.hospital_id=vd.hospital_id AND u.id=vd.doctor_id
     JOIN patients p ON p.hospital_id=v.hospital_id AND p.id=v.patient_id AND p.deleted_at IS NULL
     WHERE v.hospital_id=$1 AND v.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR') AND v.created_at > NOW() - INTERVAL '380 days'
       AND NOT EXISTS (SELECT 1 FROM visits v2 WHERE v2.hospital_id=v.hospital_id AND v2.patient_id=v.patient_id AND v2.id>v.id AND v2.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR'))
       AND NOT EXISTS (SELECT 1 FROM follow_up_cancellations fc WHERE fc.hospital_id=v.hospital_id AND fc.visit_id=v.id)
     GROUP BY v.id,p.id`, [h.id]);
  const due = [];
  for (const r of q.rows) {
    const dueOn = addDays(r.visit_on, Number(r.follow_up_days));
    if (!r.mobile || today < addDays(dueOn, -set.days) || today > dueOn) continue;
    due.push({ ...r, patientId: Number(r.patient_id), dueOn, ref: `visit:${r.visit_id}` });
  }
  return sendEach(h, 'FOLLOWUP_REMINDER', due, today, (r) => [r.full_name, r.doctor_name, h.name, waDay(r.dueOn), phoneOf(h)]);
}

// Children and teenagers with a dose coming up (same working-out as the Vaccines due page, so not cancelled doses), from `days` before the due date until it.
// The template says "upcoming", so a dose already overdue is not sent. Never names the vaccine or the dose.
async function vaccinationReminders(h, set, today) {
  const vs = await vaccinationSettings(pool, h.id);
  if (!vs.enabled || !vs.approved) return 0;
  const people = await pool.query(
    `SELECT p.id,p.full_name,COALESCE(p.whatsapp_mobile,p.mobile) AS mobile,p.qr_code,to_char(p.date_of_birth,'YYYY-MM-DD') AS dob FROM patients p
     WHERE p.hospital_id=$1 AND p.deleted_at IS NULL AND p.date_of_birth IS NOT NULL AND p.date_of_birth >= $2::date`, [h.id, addDays(today, -19 * 365)]);
  if (!people.rowCount) return 0;
  const ids = people.rows.map(p => Number(p.id));
  const [catalogue, recs, cancelled] = await Promise.all([loadCatalogue(pool, h.id, { activeOnly: true }), recordsOf(pool, h.id, ids), cancelledDoses(pool, h.id, ids)]);
  const due = [];
  for (const p of people.rows) {
    if (!p.mobile) continue;
    const { items } = workOutSchedule({ dob: p.dob, vaccines: catalogue, records: recs.get(String(p.id)) || [], today });
    const next = items.filter(i => i.kind === 'PENDING' && i.daysLeft >= 0 && !cancelled.has(`${p.id}:${i.vaccineId}:${i.doseNo}`)).sort((a, b) => a.daysLeft - b.daysLeft)[0];
    if (!next || today < addDays(next.dueOn, -set.days)) continue;
    const adult = addDays(p.dob, 18 * 365 + 4) <= today;
    due.push({ ...p, patientId: Number(p.id), dueOn: next.dueOn, ref: `due:${next.dueOn}`, greeting: adult ? p.full_name : 'Parent / Guardian' });
  }
  return sendEach(h, 'VACCINATION_REMINDER', due, today, (r) => [r.greeting, h.name, r.full_name, waDay(r.dueOn), phoneOf(h)]);
}

async function sendEach(h, kind, due, today, body) {
  if (!due.length) return 0;
  const [sentBefore, booked] = await Promise.all([alreadySent(h.id, kind, due), alreadyBooked(h.id, today, due)]);
  let sent = 0;
  for (const r of due) {
    if (sentBefore.has(`${r.patientId}:${r.ref}`) || booked.has(`p${r.patientId}`) || booked.has(`m${r.mobile}`)) continue;
    const res = await sendWhatsApp({ hospitalId: h.id, patientId: r.patientId, ref: r.ref, kind, toMobile: r.mobile, body: body(r), button: r.qr_code });
    if (res === 'SENT') sent += 1;
  }
  return sent;
}

// Follow-up and vaccination lists are worked out once a day per hospital, at the first check after its chosen hour.
// Saving reminder times (the hospital's own, or DhaCare's defaults) makes the next check look again the same day.
const doneToday = new Map();
export const forgetReminderDays = (hospitalId = null) => { if (hospitalId === null) doneToday.clear(); else for (const k of KINDS) doneToday.delete(`${hospitalId}:${k}`); };

// One check. now and onlyHospital are for tests. Answers what was sent; never throws.
export async function runReminders({ now = new Date(), onlyHospital = null } = {}) {
  const result = { appointment: 0, followUp: 0, vaccination: 0 };
  const hour = istHour(now);
  if (hour >= QUIET.from || hour < QUIET.to) return { ...result, quiet: true };
  if (!whatsappConfigured() || !(await whatsappPlatformOn())) return { ...result, paused: true };
  const lock = await pool.connect();
  try {
    // with more than one backend process, one checks and the others skip
    if (!(await lock.query(`SELECT pg_try_advisory_lock(hashtext('whatsapp-reminders')) AS ok`)).rows[0].ok) return { ...result, busy: true };
    try {
      const today = istDay(now);
      const defaults = await reminderDefaults();
      const hospitals = await pool.query(
        `SELECT id,name,mobile,whatsapp_reminders FROM hospitals
         WHERE whatsapp_api_enabled=TRUE AND whatsapp_api_hospital_on=TRUE AND is_active=TRUE AND deactivated_at IS NULL${onlyHospital ? ' AND id=$1' : ''} ORDER BY id`,
        onlyHospital ? [onlyHospital] : []);
      for (const h of hospitals.rows) {
        const set = effectiveReminders(h.whatsapp_reminders, defaults);
        for (const [kind, run] of [['appointment', () => appointmentReminders(h, set.appointment.hours, now)],
          ['followUp', () => followUpReminders(h, set.followUp, today)], ['vaccination', () => vaccinationReminders(h, set.vaccination, today)]]) {
          if (!set[kind].on) continue;
          const daily = kind !== 'appointment';
          if (daily && (hour < set[kind].hour || doneToday.get(`${h.id}:${kind}`) === today)) continue;
          try {
            result[kind] += await run();
            if (daily) doneToday.set(`${h.id}:${kind}`, today);
          } catch (err) { logError(err, { source: `whatsapp ${kind} reminders hospital ${h.id}` }); }
        }
      }
    } finally { await lock.query(`SELECT pg_advisory_unlock(hashtext('whatsapp-reminders'))`).catch(() => {}); }
  } catch (err) {
    logError(err, { source: 'whatsapp reminders' });
  } finally { lock.release(); }
  return result;
}

export function startReminderTimer() {
  const tick = () => runReminders().then(r => {
    const n = r.appointment + r.followUp + r.vaccination;
    if (n) console.log(`WhatsApp reminders sent: ${r.appointment} appointment, ${r.followUp} follow-up, ${r.vaccination} vaccination`);
  }).catch(err => logError(err, { source: 'whatsapp reminders' }));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}
