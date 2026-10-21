import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { allow } from '../middleware/auth.js';
import { mobileSchema } from '../mobile.js';
import { addDays, daysBetween, todayIst } from '../vaccination.js';

const router = Router();

const patientSchema = z.object({
  fullName: z.string().min(2).max(160),
  mobile: mobileSchema,
  // WhatsApp number when it differs from the mobile number; empty or the same number means "same as the mobile"
  whatsappMobile: z.union([mobileSchema, z.literal(''), z.null()]).optional(),
  gender: z.enum(['MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY']).nullable().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  age: z.number().int().min(0).max(365).nullable().optional(),
  ageUnit: z.enum(['YEARS', 'MONTHS', 'DAYS']).optional(), // a baby's age is given in months or days
  address: z.string().max(1000).nullable().optional(),
})
  // an exact birth date, or just the age in years (stored as an estimated birth date)
  .refine(d => d.dateOfBirth || (d.age !== null && d.age !== undefined), { message: 'Age or date of birth is required', path: ['age'] })
  .refine(d => d.age === null || d.age === undefined || d.age <= ({ YEARS: 120, MONTHS: 59, DAYS: 365 })[d.ageUnit || 'YEARS'], { message: 'Age is too high for the chosen unit', path: ['age'] })
  .refine(d => !d.dateOfBirth || d.dateOfBirth <= new Date(Date.now() + 864e5).toISOString().slice(0, 10), { message: 'Date of birth cannot be in the future', path: ['dateOfBirth'] });

// the WhatsApp number to store: nothing when it is empty or the same as the mobile number (then WhatsApp simply follows the mobile)
const whatsappToStore = (data) => (data.whatsappMobile && data.whatsappMobile !== data.mobile ? data.whatsappMobile : null);

// date_of_birth = the given date, or today minus the age when only an age was given
const dobSql = (dobParam, ageParam, unitParam) => `COALESCE($${dobParam}::date,(CURRENT_DATE-($${ageParam}::int*CASE $${unitParam}::text WHEN 'MONTHS' THEN INTERVAL '1 month' WHEN 'DAYS' THEN INTERVAL '1 day' ELSE INTERVAL '1 year' END))::date)`;

// The Patients page: patients who had a visit in the chosen dates (or everyone for all time), with their visit count, last visit and
// money figures. A doctor sees only patients they have seen, and no money figures.
router.get('/', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const isDoctor = req.user.role === 'DOCTOR';
  const allTime = String(req.query.allTime || '') === '1';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const from = allTime ? null : z.string().date().parse(String(req.query.dateFrom || today));
  const to = allTime ? null : z.string().date().parse(String(req.query.dateTo || today));
  if (from && to && from > to) throw badRequest('From date cannot be after To date');
  const term = String(req.query.q || '').trim().slice(0, 80);
  const owes = String(req.query.owes || '') === '1' && !isDoctor;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 5000);
  // sorting is done here (not in the browser) because the list is shown a page at a time; the keys are fixed, never typed into the query
  const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const flip = dir === 'ASC' ? 'DESC' : 'ASC';
  const orderBy = ({
    name: `lower(t.full_name) ${dir}`,
    age: `t.date_of_birth ${flip} NULLS LAST`, // an older patient has an earlier birth date
    visits: `t.total_visits ${dir}`,
    last: `t.last_visit_at ${dir} NULLS LAST`,
    billed: isDoctor ? 'lower(t.full_name) ASC' : `t.billed ${dir}`,
    owes: isDoctor ? 'lower(t.full_name) ASC' : `t.outstanding ${dir}`,
  })[String(req.query.sort || 'last')] || 't.last_visit_at DESC NULLS LAST';
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const params = [req.user.hospitalId];
  let rangeSql = '';
  if (!allTime) {
    params.push(from); rangeSql += ` AND v.created_at >= $${params.length}::date`;
    params.push(to); rangeSql += ` AND v.created_at < ($${params.length}::date + INTERVAL '1 day')`;
  }
  let doctorParam = 0;
  let doctorJoin = '';
  if (isDoctor) {
    params.push(req.user.id); doctorParam = params.length;
    // this doctor's visits are joined once, as a list; a per-visit lookup made a large hospital take about a minute
    doctorJoin = ` JOIN (SELECT vd.visit_id FROM visit_doctors vd WHERE vd.hospital_id=$1 AND vd.doctor_id=$${doctorParam}) mine ON mine.visit_id=v.id`;
  }
  let searchSql = '';
  let searchVisitsSql = '';
  if (term) {
    params.push(`%${term}%`);
    searchSql = ` AND (p.full_name ILIKE $${params.length} OR p.mobile ILIKE $${params.length})`;
    searchVisitsSql = ` AND v.patient_id IN (SELECT p2.id FROM patients p2 WHERE p2.hospital_id=$1 AND p2.deleted_at IS NULL AND (p2.full_name ILIKE $${params.length} OR p2.mobile ILIKE $${params.length}))`;
  }
  params.push(limit); const limitParam = params.length;
  params.push(offset); const offsetParam = params.length;
  // with all dates and no doctor filter, patients who never visited are listed too; otherwise only those with a visit in range
  const includeNoVisits = allTime && !isDoctor;
  // The slow per-patient figures (visit count, amount owed, last finding, follow-up) are worked out only for the patients on the page being shown,
  // unless the list is sorted or filtered by one of them. Doing them for every patient first made big hospitals take many seconds.
  const heavyFirst = owes || ['visits', 'owes'].includes(String(req.query.sort || ''));
  const totalVisitsSql = (a) => `(SELECT COUNT(*)::int FROM visits a WHERE a.hospital_id=${a}.hospital_id AND a.patient_id=${a}.id AND a.status<>'CANCELLED') AS total_visits`;
  const outstandingSql = (a) => `COALESCE((SELECT SUM(vc.amount) FROM visit_charges vc JOIN visits a ON a.id=vc.visit_id AND a.hospital_id=vc.hospital_id
                        WHERE a.hospital_id=${a}.hospital_id AND a.patient_id=${a}.id AND a.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT')),0)::numeric(12,2) AS outstanding`;
  const q = await pool.query(
    `WITH base AS (
       SELECT p.hospital_id,p.id,p.full_name,p.mobile,p.whatsapp_mobile,p.gender,p.date_of_birth,p.dob_estimated,COALESCE(s.visits,0)::int AS visits,s.last_visit_at,
              COALESCE(s.billed,0)::numeric(12,2) AS billed,COALESCE(s.paid,0)::numeric(12,2) AS paid${heavyFirst ? `,
              ${totalVisitsSql('p')},
              ${outstandingSql('p')}` : ''}
       FROM patients p
       LEFT JOIN (
         SELECT v.patient_id,COUNT(*)::int AS visits,MAX(v.created_at) AS last_visit_at,
                SUM((SELECT COALESCE(SUM(vc.amount),0) FROM visit_charges vc WHERE vc.hospital_id=v.hospital_id AND vc.visit_id=v.id)) AS billed,
                SUM((SELECT COALESCE(SUM(py.amount),0) FROM payments py WHERE py.hospital_id=v.hospital_id AND py.visit_id=v.id)) AS paid
         FROM visits v${doctorJoin}
         WHERE v.hospital_id=$1 AND v.status<>'CANCELLED'${rangeSql}${searchVisitsSql}
         GROUP BY v.patient_id
       ) s ON s.patient_id=p.id
       WHERE p.hospital_id=$1 AND p.deleted_at IS NULL${searchSql}
     ), page AS (
       SELECT t.*,COUNT(*) OVER()::int AS total FROM base t
       WHERE (t.visits>0${includeNoVisits ? ' OR TRUE' : ''})${owes ? ' AND t.outstanding>0' : ''}
       ORDER BY ${orderBy},lower(t.full_name),t.id
       LIMIT $${limitParam} OFFSET $${offsetParam}
     )
     SELECT t.*${heavyFirst ? '' : `,
            ${totalVisitsSql('t')},
            ${outstandingSql('t')}`},
            ${isDoctor ? `(SELECT left(translate(vd.doctor_notes, chr(10) || chr(13) || chr(9), '   '), 120) FROM visit_doctors vd JOIN visits a ON a.hospital_id=vd.hospital_id AND a.id=vd.visit_id
              WHERE a.hospital_id=t.hospital_id AND a.patient_id=t.id AND vd.doctor_id=$${doctorParam} AND COALESCE(btrim(vd.doctor_notes),'')<>'' ORDER BY a.created_at DESC LIMIT 1)` : 'NULL::text'} AS last_finding,
            ${isDoctor ? `(SELECT json_build_object('days', vd.follow_up_days, 'visitOn', to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'), 'visitId', a.id) FROM visit_doctors vd JOIN visits a ON a.hospital_id=vd.hospital_id AND a.id=vd.visit_id
              WHERE a.hospital_id=t.hospital_id AND a.patient_id=t.id AND vd.doctor_id=$${doctorParam} AND vd.follow_up_days IS NOT NULL AND a.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR')
                AND NOT EXISTS (SELECT 1 FROM visits b WHERE b.hospital_id=a.hospital_id AND b.patient_id=a.patient_id AND b.id>a.id AND b.status NOT IN ('CANCELLED','LEFT_BEFORE_DOCTOR'))
              ORDER BY a.created_at DESC LIMIT 1)` : 'NULL::json'} AS follow_up
     FROM page t
     ORDER BY ${orderBy},lower(t.full_name),t.id`,
    params
  );
  const todayDay = todayIst();
  const rows = q.rows.map(({ total, hospital_id, last_finding, follow_up, ...row }) => {
    if (!isDoctor) return row;
    let followUp = null;
    if (follow_up && follow_up.days) { const dueOn = addDays(follow_up.visitOn, Number(follow_up.days)); followUp = { dueOn, daysLeft: daysBetween(todayDay, dueOn), days: Number(follow_up.days), visitId: Number(follow_up.visitId) }; }
    return { ...row, billed: null, paid: null, outstanding: null, lastFinding: last_finding || null, followUp };
  });
  res.json({ patients: rows, total: q.rows[0]?.total ?? 0, range: { dateFrom: from, dateTo: to, allTime } });
}));

router.get('/search', asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json([]);
  const q = await pool.query(
    `SELECT p.id,p.full_name,p.mobile,p.whatsapp_mobile,p.gender,p.date_of_birth,p.dob_estimated,p.address,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS visit_count,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS last_visit_at
     FROM patients p
     WHERE p.hospital_id=$1 AND p.deleted_at IS NULL
       AND (p.mobile ILIKE $2 OR p.full_name ILIKE $2)
     ORDER BY p.updated_at DESC LIMIT 20`,
    [req.user.hospitalId, `%${term}%`]
  );
  res.json(q.rows);
}));

// Reception scans the QR printed on a returning patient's bill, pad or prescription: the code resolves to the patient of THIS hospital only.
router.get('/by-code/:code', allow('ADMIN','RECEPTIONIST','DOCTOR'), asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(code)) throw notFound('Patient not found');
  const q = await pool.query(
    `SELECT p.id,p.full_name,p.mobile,p.whatsapp_mobile,p.gender,p.date_of_birth,p.dob_estimated,p.address,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS visit_count,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id) AS last_visit_at,
            (SELECT v.status FROM visits v WHERE v.hospital_id=p.hospital_id AND v.patient_id=p.id AND v.status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR','PAYMENT_PENDING') ORDER BY v.id DESC LIMIT 1) AS open_visit_status
     FROM patients p WHERE p.hospital_id=$1 AND p.qr_code=$2 AND p.deleted_at IS NULL`,
    [req.user.hospitalId, code]
  );
  if (!q.rowCount) throw notFound('Patient not found');
  const row = q.rows[0];
  if (req.user.role === 'DOCTOR') {
    // a doctor scans to open this patient's visit with them: only visits assigned to this doctor, from the last two days (the screen keeps today's)
    const visits = await pool.query(
      `SELECT id,status,created_at FROM visits WHERE hospital_id=$1 AND patient_id=$2 AND doctor_id=$3 AND created_at >= NOW() - INTERVAL '2 days' ORDER BY id DESC`,
      [req.user.hospitalId, row.id, req.user.id]
    );
    row.recent_visits = visits.rows;
  }
  res.json(row);
}));

// The same person is never registered twice: same mobile and same name (any capitals) in this hospital.
// Family members sharing a phone are fine because their names differ.
async function assertNotDuplicate(hospitalId, mobile, fullName, exceptId = null) {
  const q = await pool.query(
    `SELECT id FROM patients WHERE hospital_id=$1 AND mobile=$2 AND lower(trim(full_name))=lower(trim($3)) AND deleted_at IS NULL AND ($4::bigint IS NULL OR id<>$4) LIMIT 1`,
    [hospitalId, mobile, fullName, exceptId]
  );
  if (q.rowCount) throw badRequest(`${fullName.trim()} is already registered with this mobile number. Select the existing patient instead of adding a new one.`);
}

router.post('/', allow('ADMIN','RECEPTIONIST','DOCTOR'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  await assertNotDuplicate(req.user.hospitalId, data.mobile, data.fullName);
  const q = await pool.query(
    `INSERT INTO patients(hospital_id,full_name,mobile,gender,date_of_birth,dob_estimated,address,created_by,updated_by,whatsapp_mobile)
     VALUES($1,$2,$3,$4,${dobSql(5, 6, 9)},$5::date IS NULL,$7,$8,$8,$10)
     RETURNING id,full_name,mobile,whatsapp_mobile,gender,date_of_birth,dob_estimated,address`,
    [req.user.hospitalId, data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.age ?? null, data.address || null, req.user.id, data.ageUnit || 'YEARS', whatsappToStore(data)]
  );
  res.status(201).json(q.rows[0]);
}));

router.put('/:id', allow('ADMIN','RECEPTIONIST','DOCTOR'), asyncHandler(async (req, res) => {
  const data = patientSchema.parse(req.body);
  await assertNotDuplicate(req.user.hospitalId, data.mobile, data.fullName, req.params.id);
  const q = await pool.query(
    `UPDATE patients SET full_name=$1,mobile=$2,gender=$3,date_of_birth=${dobSql(4, 5, 10)},dob_estimated=$4::date IS NULL,address=$6,updated_by=$7,whatsapp_mobile=$11,updated_at=NOW()
     WHERE id=$8 AND hospital_id=$9 AND deleted_at IS NULL
     RETURNING id,full_name,mobile,whatsapp_mobile,gender,date_of_birth,dob_estimated,address`,
    [data.fullName, data.mobile, data.gender || null, data.dateOfBirth || null, data.age ?? null, data.address || null, req.user.id, req.params.id, req.user.hospitalId, data.ageUnit || 'YEARS', whatsappToStore(data)]
  );
  if (!q.rowCount) throw notFound('Patient not found');
  res.json(q.rows[0]);
}));

// Everything about one patient, visit by visit: vitals, findings, advice, follow-up, prescription, the itemised bill and payment, and
// certificates. What is included depends on the role: the Admin sees all, a doctor sees the clinical part (no money), and
// Reception sees bills, payments and certificates (no findings, prescription or vitals).
router.get('/:id/overview', allow('ADMIN', 'RECEPTIONIST', 'DOCTOR'), asyncHandler(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const role = req.user.role;
  const clinical = role !== 'RECEPTIONIST';
  const money = role !== 'DOCTOR';
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const patientQ = await pool.query(
    `SELECT id,full_name,mobile,whatsapp_mobile,gender,to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth,dob_estimated,address,created_at FROM patients WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`,
    [id, hospitalId]
  );
  if (!patientQ.rowCount) throw notFound('Patient not found');
  const visitsQ = await pool.query(
    `SELECT v.id,v.visit_number,v.daily_number,v.status,v.created_at,v.completed_at,v.left_at,v.left_note,
            v.weight_kg,v.height_cm,v.heart_rate,v.spo2,v.temperature,v.temperature_unit,v.bp_systolic,v.bp_diastolic
     FROM visits v WHERE v.hospital_id=$1 AND v.patient_id=$2 ORDER BY v.created_at DESC LIMIT 300`,
    [hospitalId, id]
  );
  const visits = visitsQ.rows;
  const ids = visits.map(v => v.id);
  const by = (rows) => { const m = new Map(); for (const r of rows) { const k = String(r.visit_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const none = { rows: [] };
  const [doctorsQ, rxQ, chargesQ, payQ, certQ] = ids.length ? await Promise.all([
    pool.query(
      `SELECT vd.visit_id,vd.doctor_id,u.name AS doctor_name,u.qualification,vd.position,vd.status,vd.doctor_notes,vd.advice,vd.follow_up_days,vd.completed_at
       FROM visit_doctors vd JOIN users u ON u.id=vd.doctor_id AND u.hospital_id=vd.hospital_id
       WHERE vd.hospital_id=$1 AND vd.visit_id=ANY($2::bigint[]) ORDER BY vd.visit_id,vd.position`, [hospitalId, ids]),
    clinical ? pool.query(
      `SELECT pi.visit_id,pi.doctor_id,u.name AS doctor_name,pi.name,pi.composition,pi.dose,pi.timing,pi.duration_days,pi.note
       FROM visit_prescription_items pi JOIN users u ON u.id=pi.doctor_id AND u.hospital_id=pi.hospital_id
       WHERE pi.hospital_id=$1 AND pi.visit_id=ANY($2::bigint[]) ORDER BY pi.visit_id,pi.doctor_id,pi.position`, [hospitalId, ids]) : none,
    money ? pool.query(
      `SELECT vc.visit_id,vc.description,vc.amount,du.name AS doctor_name,vc.source
       FROM visit_charges vc LEFT JOIN users du ON du.id=vc.doctor_id AND du.hospital_id=vc.hospital_id
       WHERE vc.hospital_id=$1 AND vc.visit_id=ANY($2::bigint[]) AND vc.is_voided=FALSE ORDER BY vc.visit_id,vc.id`, [hospitalId, ids]) : none,
    money ? pool.query(
      `SELECT py.visit_id,py.amount,py.payment_mode,py.reference_no,py.paid_at,au.name AS accepted_by
       FROM payments py LEFT JOIN users au ON au.id=py.accepted_by AND au.hospital_id=py.hospital_id
       WHERE py.hospital_id=$1 AND py.visit_id=ANY($2::bigint[])`, [hospitalId, ids]) : none,
    pool.query(
      `SELECT c.visit_id,c.number,c.title,c.type_key,c.status,c.issued_at,c.cancel_reason,du.name AS doctor_name
       FROM certificates c LEFT JOIN users du ON du.id=c.doctor_id AND du.hospital_id=c.hospital_id
       WHERE c.hospital_id=$1 AND c.visit_id=ANY($2::bigint[]) ORDER BY c.issued_at`, [hospitalId, ids]),
  ]) : [none, none, none, none, none];
  const doctors = by(doctorsQ.rows); const rx = by(rxQ.rows); const charges = by(chargesQ.rows); const pays = by(payQ.rows); const certs = by(certQ.rows);

  const out = visits.map((v, vi) => {
    const k = String(v.id);
    const items = (charges.get(k) || []).map(c => ({ description: c.description, amount: Number(c.amount), doctorName: c.doctor_name }));
    const billed = items.reduce((n, c) => n + c.amount, 0);
    const pay = (pays.get(k) || [])[0] || null;
    const unpaid = !pay && ['PAYMENT_PENDING', 'LEFT_WITHOUT_PAYMENT'].includes(v.status);
    const row = {
      id: v.id, visitNumber: v.visit_number, dailyNumber: v.daily_number, status: v.status, createdAt: v.created_at, completedAt: v.completed_at, leftAt: v.left_at, leftNote: v.left_note,
      doctors: (doctors.get(k) || []).map(d => ({ id: d.doctor_id, name: d.doctor_name, qualification: d.qualification, status: d.status, completedAt: d.completed_at,
        followUpDays: d.follow_up_days, // when to come back is not clinical detail, so reception sees it too
        ...(clinical ? { notes: d.doctor_notes, advice: d.advice } : {}) })),
      // true once the patient has had any later visit (the visits are newest first)
      cameBackSince: visits.slice(0, vi).some(x => !['CANCELLED', 'LEFT_BEFORE_DOCTOR'].includes(x.status)),
      certificates: (certs.get(k) || []).map(c => ({ number: c.number, title: c.title, typeKey: c.type_key, status: c.status, issuedAt: c.issued_at, cancelReason: c.cancel_reason, doctorName: c.doctor_name })),
    };
    if (clinical) {
      row.vitals = { weight_kg: v.weight_kg, height_cm: v.height_cm, heart_rate: v.heart_rate, spo2: v.spo2, temperature: v.temperature, temperature_unit: v.temperature_unit, bp_systolic: v.bp_systolic, bp_diastolic: v.bp_diastolic };
      row.prescription = (rx.get(k) || []).map(r => ({ name: r.name, composition: r.composition, dose: r.dose, timing: r.timing, days: r.duration_days, note: r.note, doctorName: r.doctor_name }));
    }
    if (money) {
      row.bill = { items, total: Math.round(billed * 100) / 100, unpaid, payment: pay ? { amount: Number(pay.amount), mode: pay.payment_mode, reference: pay.reference_no, paidAt: pay.paid_at, acceptedBy: pay.accepted_by } : null };
    }
    return row;
  });

  const counted = out.filter(v => v.status !== 'CANCELLED');
  const summary = {
    visits: counted.length,
    firstVisitAt: counted.length ? counted[counted.length - 1].createdAt : null,
    lastVisitAt: counted.length ? counted[0].createdAt : null,
    certificates: out.reduce((n, v) => n + v.certificates.filter(c => c.status === 'ISSUED').length, 0),
  };
  if (money) {
    summary.billed = Math.round(counted.reduce((n, v) => n + v.bill.total, 0) * 100) / 100;
    summary.paid = Math.round(counted.reduce((n, v) => n + (v.bill.payment ? v.bill.payment.amount : 0), 0) * 100) / 100;
    summary.outstanding = Math.round(counted.filter(v => v.bill.unpaid).reduce((n, v) => n + v.bill.total, 0) * 100) / 100;
  }
  res.json({ patient: patientQ.rows[0], summary, visits: out, access: { clinical, money } });
}));

router.get('/:id/history', asyncHandler(async (req, res) => {
  const patient = await pool.query(
    `SELECT id,full_name,mobile,gender,date_of_birth,dob_estimated,address FROM patients
     WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`,
    [req.params.id, req.user.hospitalId]
  );
  if (!patient.rowCount) throw notFound('Patient not found');

  const visits = await pool.query(
    `SELECT v.id,v.visit_number,v.daily_number,v.status,v.created_at,v.completed_at,
            COALESCE((SELECT json_agg(json_build_object('name',pi.name,'dose',pi.dose,'days',pi.duration_days) ORDER BY pi.doctor_id,pi.position) FROM visit_prescription_items pi WHERE pi.hospital_id=v.hospital_id AND pi.visit_id=v.id),'[]'::json) AS medicines,
            COALESCE((SELECT string_agg(CASE WHEN vd.doctor_notes IS NOT NULL THEN du.name || ': ' || vd.doctor_notes END,E'\n\n' ORDER BY vd.position)
                      FROM visit_doctors vd JOIN users du ON du.id=vd.doctor_id AND du.hospital_id=vd.hospital_id
                      WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id),v.doctor_notes) AS doctor_notes,
            v.left_at,v.left_note,
            COALESCE((SELECT string_agg(du.name,', ' ORDER BY vd.position)
                      FROM visit_doctors vd JOIN users du ON du.id=vd.doctor_id AND du.hospital_id=vd.hospital_id
                      WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id AND vd.status<>'SKIPPED'),u.name) AS doctor_name,
            COALESCE(SUM(vc.amount),0)::numeric(12,2) AS total_amount,
            p.payment_mode,p.paid_at,
            CASE
              WHEN p.id IS NOT NULL THEN 'PAID'
              WHEN v.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT') THEN 'UNPAID'
              WHEN v.status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR') THEN 'NOT_FINALIZED'
              ELSE 'NO_BILL'
            END AS bill_status
     FROM visits v
     JOIN users u ON u.id=v.doctor_id
     LEFT JOIN visit_charges vc ON vc.visit_id=v.id AND vc.hospital_id=v.hospital_id
     LEFT JOIN payments p ON p.visit_id=v.id AND p.hospital_id=v.hospital_id
     WHERE v.hospital_id=$1 AND v.patient_id=$2
     GROUP BY v.id,u.name,p.id,p.payment_mode,p.paid_at
     ORDER BY v.created_at DESC LIMIT 50`,
    [req.user.hospitalId, req.params.id]
  );
  res.json({ patient: patient.rows[0], visits: visits.rows });
}));

export default router;
