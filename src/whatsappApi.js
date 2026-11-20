// WhatsApp messages sent automatically through the paid Meta WhatsApp Cloud API.
// Every sender must ask whatsappApiAllowed() first. Two switches must both be on: DhaCare's (Super Admin: Hospitals > Manage > WhatsApp
// messages) and the hospital's own (its Admin: Hospital Settings > Subscription). DhaCare's always wins: when it is off, nothing is
// sent and the hospital cannot turn it on. A hospital that is inactive never sends. Click-to-chat links (staff send from their own
// phone) do not go through here.
// Messages never carry a prescription, a bill or a reason for the visit (see the WhatsApp wording rules).
// Every message sent is recorded with recordWhatsAppMessage(): it keeps the rate per message in force at that moment, and the
// hospital is charged for it on its next DhaCare invoice (billing/messages.js). A failed message is recorded but never charged.
import { pool } from './db.js';
import { currentMessageRate } from './billing/messages.js';
import { logError } from './errorLog.js';

// The platform switch (table platform_whatsapp, set by the Super Admin on Pricing > WhatsApp messages). Off = nothing is sent for any
// hospital, whatever the hospital switches say: used to pause all Meta messages at once, for example while the account or a template
// is being fixed. Off when the row cannot be read.
export async function whatsappPlatformOn(db = pool) {
  try { return Boolean((await db.query(`SELECT sending_on FROM platform_whatsapp WHERE id=1`)).rows[0]?.sending_on); }
  catch { return false; }
}

// Sending also needs the Meta details in .env; without them nothing can go out even when the switch is on.
export const whatsappConfigured = () => Boolean(String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim() && String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim());

export async function whatsappApiAllowed(hospitalId, db = pool) {
  const q = await db.query(
    `SELECT 1 FROM hospitals WHERE id=$1 AND whatsapp_api_enabled=TRUE AND whatsapp_api_hospital_on=TRUE AND is_active=TRUE AND deactivated_at IS NULL
       AND EXISTS (SELECT 1 FROM platform_whatsapp WHERE id=1 AND sending_on)`, [hospitalId]);
  return q.rowCount > 0;
}

// m: { hospitalId, appointmentId?, patientId?, ref?, kind, template?, toMobile, status: 'SENT' | 'FAILED', metaMessageId?, error? }
export async function recordWhatsAppMessage(m, db = pool) {
  const rate = await currentMessageRate(db);
  const q = await db.query(
    `INSERT INTO whatsapp_messages(hospital_id,appointment_id,kind,template,to_mobile,status,meta_message_id,error,rate,patient_id,ref)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [m.hospitalId, m.appointmentId || null, m.kind, m.template || null, m.toMobile, m.status || 'SENT', m.metaMessageId || null, m.error ? String(m.error).slice(0, 300) : null, rate, m.patientId || null, m.ref || null]);
  return Number(q.rows[0].id);
}

// ---------- sending through Meta ----------
// The Meta details live in the server's .env only: WHATSAPP_ACCESS_TOKEN (system user, no expiry) and WHATSAPP_PHONE_NUMBER_ID.
// Optional: WHATSAPP_TEMPLATE_LANGUAGE (the language the templates were approved in, default en), WHATSAPP_GRAPH_VERSION.
const graphUrl = () => `${process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.WHATSAPP_GRAPH_VERSION || 'v23.0'}`;
const templateLanguage = () => String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en').trim();

// The templates approved on Meta. body = the {{1}}, {{2}}… values in order; button = the {{1}} at the end of the URL button.
export const TEMPLATES = {
  APPOINTMENT_CONFIRMATION: 'dhacare_appointment_confirmation', // patient, clinic, doctor, date, time, booking no., clinic phone; button: view_code
  APPOINTMENT_REMINDER: 'dhacare_appointment_reminder',         // same values and button as the confirmation
  FOLLOWUP_REMINDER: 'dhacare_followup_reminder',               // patient, doctor, clinic, date, clinic phone; button: patients.qr_code
  VACCINATION_REMINDER: 'dhacare_vaccination_reminder',         // greeting name, clinic, patient, due date, clinic phone; button: patients.qr_code
};

// Meta refuses a value with a line break, a tab or more than 4 spaces in a row, and an empty one. * _ ~ would change the bold in the text.
const value = (v, fallback = '-') => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[*_~`]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 300) || fallback;
// Indian mobile numbers are stored as 10 digits; WhatsApp wants the country code in front.
export const waNumber = (mobile) => { const d = String(mobile || '').replace(/\D/g, ''); return d.length === 10 ? `91${d}` : d; };
// Same look as the WhatsApp button's message: Thu, 20/11/2026 and 10:30 AM
export const waDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
export const waClock = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// !!! SAFETY: WHO MAY GET A REAL MESSAGE !!!
// Outside production, real Meta messages go ONLY to the numbers in WHATSAPP_TEST_NUMBERS (.env, the owner's own phone); with no list,
// NOTHING is sent. Development databases are full of test patients with real-looking numbers: they must never get a message.
// On production (NODE_ENV=production) patients get their messages; a list there would limit sending to it.
// The tests' stand-in Meta server (WHATSAPP_GRAPH_URL on this computer) never reaches a phone, so any number may go to it.
const last10 = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const testNumbers = () => String(process.env.WHATSAPP_TEST_NUMBERS || '').split(/[\s,]+/).map(last10).filter(x => x.length === 10);
const toLocalStandIn = () => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(String(process.env.WHATSAPP_GRAPH_URL || '').trim());
export function mayMessage(mobile) {
  if (toLocalStandIn()) return true;
  const list = testNumbers();
  if (list.length) return list.includes(last10(mobile));
  return process.env.NODE_ENV === 'production';
}
export const sendingScope = () => (toLocalStandIn() ? 'stand-in Meta on this computer (tests)' : testNumbers().length ? `ONLY these test numbers: ${testNumbers().join(', ')}` : process.env.NODE_ENV === 'production' ? 'all patients (production)' : 'NOBODY (not production and no WHATSAPP_TEST_NUMBERS)');

// One template message to one number. Answers { ok, id } or { ok: false, error }; never throws.
export async function sendTemplate({ to, template, body = [], button = null }) {
  if (!mayMessage(to)) return { ok: false, skipped: true, error: 'Not sent: only test numbers get messages outside production' };
  const components = [{ type: 'body', parameters: body.map(v => ({ type: 'text', text: value(v) })) }];
  if (button) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(button) }] });
  try {
    const r = await fetch(`${graphUrl()}/${String(process.env.WHATSAPP_PHONE_NUMBER_ID).trim()}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(process.env.WHATSAPP_ACCESS_TOKEN).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: waNumber(to), type: 'template', template: { name: template, language: { code: templateLanguage() }, components } }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    const id = data?.messages?.[0]?.id;
    if (r.ok && id) return { ok: true, id };
    const e = data?.error || {};
    return { ok: false, error: `${e.code ? `${e.code} ` : ''}${e.error_data?.details || e.message || `HTTP ${r.status}`}` };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'No answer from Meta in 15 seconds' : err.message };
  }
}

// A number the hospital blocked (Hospital Settings > WhatsApp > Blocked numbers, or Cancel and block on Appointments) gets no
// automatic message either. For a patient, their mobile and their WhatsApp number are both checked, so a blocked person is not
// reached on their other number.
export async function isBlockedNumber(hospitalId, toMobile, patientId = null, db = pool) {
  const q = await db.query(
    `SELECT EXISTS (SELECT 1 FROM blocked_mobiles b WHERE b.hospital_id=$1 AND (b.mobile=$2
       OR ($3::bigint IS NOT NULL AND b.mobile IN (SELECT right(regexp_replace(x,'\\D','','g'),10) FROM patients p, unnest(ARRAY[p.mobile,p.whatsapp_mobile]) AS x
                                                   WHERE p.hospital_id=$1 AND p.id=$3 AND x IS NOT NULL)))) AS blocked`,
    [hospitalId, last10(toMobile), patientId]);
  return q.rows[0].blocked;
}

// Checks the switches, sends, and records the message (charged if sent, not charged if failed).
// Answers 'SENT', 'FAILED' or 'SKIPPED' (switched off, the Meta details are missing, or the number is blocked). Never throws.
export async function sendWhatsApp({ hospitalId, appointmentId = null, patientId = null, ref = null, kind, toMobile, body, button }) {
  try {
    if (!whatsappConfigured() || !mayMessage(toMobile) || !(await whatsappApiAllowed(hospitalId))) return 'SKIPPED';
    if (await isBlockedNumber(hospitalId, toMobile, patientId)) return 'SKIPPED'; // blocked: nothing sent, nothing charged
    const template = TEMPLATES[kind];
    const r = await sendTemplate({ to: toMobile, template, body, button });
    await recordWhatsAppMessage({ hospitalId, appointmentId, patientId, ref, kind, template, toMobile, status: r.ok ? 'SENT' : 'FAILED', metaMessageId: r.id, error: r.error });
    if (!r.ok) logError(new Error(`WhatsApp ${kind} not sent: ${r.error}`), { source: `whatsapp hospital ${hospitalId}${appointmentId ? ` appointment ${appointmentId}` : ''}` });
    return r.ok ? 'SENT' : 'FAILED';
  } catch (err) {
    logError(err, { source: `whatsapp ${kind} hospital ${hospitalId}` });
    return 'FAILED';
  }
}

// The appointment confirmation: sent when a patient books online (also with their QR code), and again when they move it to another time.
export async function sendAppointmentConfirmation(appointmentId) {
  const q = await pool.query(
    `SELECT a.id,a.hospital_id,a.full_name,a.mobile,a.reference,a.view_code,to_char(a.slot_day,'YYYY-MM-DD') AS day,
            to_char(a.slot_at AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS time,a.status,u.name AS doctor_name,h.name AS hospital_name,h.mobile AS hospital_mobile
     FROM appointments a JOIN users u ON u.id=a.doctor_id JOIN hospitals h ON h.id=a.hospital_id WHERE a.id=$1`, [appointmentId]);
  const a = q.rows[0];
  if (!a || a.status !== 'BOOKED') return 'SKIPPED';
  return sendWhatsApp({
    hospitalId: a.hospital_id, appointmentId: a.id, kind: 'APPOINTMENT_CONFIRMATION', toMobile: a.mobile,
    body: [a.full_name, a.hospital_name, a.doctor_name, waDay(a.day), waClock(a.time), a.reference, a.hospital_mobile || a.hospital_name],
    button: a.view_code,
  });
}
