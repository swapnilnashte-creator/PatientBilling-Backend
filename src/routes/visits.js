import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, money, notFound } from '../utils.js';

const router = Router();

async function getVisit(client, hospitalId, visitId, lock = false) {
  const q = await client.query(
    `SELECT v.*, p.full_name,p.mobile,p.gender,p.date_of_birth,p.dob_estimated,p.address,p.qr_code AS patient_qr_code,
            d.name AS doctor_name,d.qualification AS doctor_qualification,d.registration_no AS doctor_registration_no
     FROM visits v
     JOIN patients p ON p.id=v.patient_id AND p.hospital_id=v.hospital_id
     JOIN users d ON d.id=v.doctor_id AND d.hospital_id=v.hospital_id
     WHERE v.id=$1 AND v.hospital_id=$2 ${lock ? 'FOR UPDATE OF v' : ''}`,
    [visitId, hospitalId]
  );
  if (!q.rowCount) throw notFound('Visit not found');
  return q.rows[0];
}

async function getCharges(client, hospitalId, visitId) {
  const q = await client.query(
    `SELECT vc.id,vc.billing_item_id,vc.description,vc.amount,vc.source,vc.added_by,vc.doctor_id,
            vc.is_locked,vc.is_voided,vc.created_at,u.name AS added_by_name,d.name AS doctor_name
     FROM visit_charges vc
     JOIN users u ON u.id=vc.added_by
     LEFT JOIN users d ON d.id=vc.doctor_id AND d.hospital_id=vc.hospital_id
     WHERE vc.hospital_id=$1 AND vc.visit_id=$2 ORDER BY vc.id`,
    [hospitalId, visitId]
  );
  return q.rows;
}

async function getSettlementBreakdown(client, hospitalId, visitId) {
  const doctorsQ = await client.query(
    `SELECT vd.doctor_id,d.name AS doctor_name,vd.position,
            COALESCE(SUM(vc.amount),0)::numeric(12,2) AS amount,
            MAX(pds.settled_at) AS settled_at
     FROM visit_doctors vd
     JOIN users d ON d.id=vd.doctor_id AND d.hospital_id=vd.hospital_id
     LEFT JOIN visit_charges vc ON vc.hospital_id=vd.hospital_id AND vc.visit_id=vd.visit_id
       AND vc.doctor_id=vd.doctor_id
     LEFT JOIN payment_doctor_settlements pds ON pds.hospital_id=vd.hospital_id
       AND pds.visit_id=vd.visit_id AND pds.doctor_id=vd.doctor_id
     WHERE vd.hospital_id=$1 AND vd.visit_id=$2 AND vd.status='COMPLETED'
     GROUP BY vd.doctor_id,d.name,vd.position
     ORDER BY vd.position`,
    [hospitalId, visitId]
  );
  const clinicQ = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS amount
     FROM visit_charges WHERE hospital_id=$1 AND visit_id=$2 AND doctor_id IS NULL`,
    [hospitalId, visitId]
  );
  const doctors = doctorsQ.rows;
  const clinicAmount = clinicQ.rows[0].amount;
  const total = money(doctors.reduce((sum, row) => sum + Number(row.amount), Number(clinicAmount)));
  return { doctors, clinicAmount, total };
}

async function recordDoctorSettlements(client, hospitalId, visitId, paymentId) {
  await client.query(
    `INSERT INTO payment_doctor_settlements(hospital_id,payment_id,visit_id,doctor_id,amount)
     SELECT vd.hospital_id,$3,vd.visit_id,vd.doctor_id,COALESCE(SUM(vc.amount),0)::numeric(12,2)
     FROM visit_doctors vd
     LEFT JOIN visit_charges vc ON vc.hospital_id=vd.hospital_id AND vc.visit_id=vd.visit_id
       AND vc.doctor_id=vd.doctor_id
     WHERE vd.hospital_id=$1 AND vd.visit_id=$2 AND vd.status='COMPLETED'
     GROUP BY vd.hospital_id,vd.visit_id,vd.doctor_id
     ON CONFLICT (hospital_id,payment_id,doctor_id) DO NOTHING`,
    [hospitalId, visitId, paymentId]
  );
}

async function getCorrections(client, hospitalId, visitId) {
  const q = await client.query(
    `SELECT c.id,c.visit_charge_id,c.action,c.description,c.old_amount,c.new_amount,
            c.old_total,c.new_total,c.recorded_payment_amount,c.reason,
            c.corrected_by,c.corrected_by_role,c.created_at,u.name AS corrected_by_name
     FROM visit_charge_corrections c
     JOIN users u ON u.id=c.corrected_by AND u.hospital_id=c.hospital_id
     WHERE c.hospital_id=$1 AND c.visit_id=$2
     ORDER BY c.created_at DESC,c.id DESC`,
    [hospitalId, visitId]
  );
  return q.rows;
}

async function getVisitDoctors(client, hospitalId, visitId) {
  const q = await client.query(
    `SELECT vd.id,vd.doctor_id,u.name AS doctor_name,u.qualification AS doctor_qualification,u.registration_no AS doctor_registration_no,vd.position,vd.status,
            vd.doctor_notes,vd.started_at,vd.completed_at,vd.skipped_at,vd.skipped_by,vd.skip_reason
     FROM visit_doctors vd
     JOIN users u ON u.id=vd.doctor_id AND u.hospital_id=vd.hospital_id
     WHERE vd.hospital_id=$1 AND vd.visit_id=$2
     ORDER BY vd.position`,
    [hospitalId, visitId]
  );
  return q.rows;
}

async function getPrescription(client, hospitalId, visitId) {
  const q = await client.query(
    `SELECT pi.id,pi.doctor_id,u.name AS doctor_name,pi.position,pi.medicine_id,pi.name,pi.composition,pi.manufacturer,
            pi.pack_size,pi.dose,pi.timing,pi.duration_days,pi.note
     FROM visit_prescription_items pi
     JOIN users u ON u.id=pi.doctor_id AND u.hospital_id=pi.hospital_id
     WHERE pi.hospital_id=$1 AND pi.visit_id=$2
     ORDER BY pi.doctor_id,pi.position`,
    [hospitalId, visitId]
  );
  return q.rows;
}

const doctorIdsSchema = z.array(z.coerce.number().int().positive()).min(1).max(10)
  .refine(ids => new Set(ids).size === ids.length, 'A doctor can be selected only once');

async function validateDoctors(client, hospitalId, doctorIds) {
  const q = await client.query(
    `SELECT id FROM users
     WHERE hospital_id=$1 AND id=ANY($2::bigint[]) AND role='DOCTOR'
       AND is_active=TRUE AND deleted_at IS NULL`,
    [hospitalId, doctorIds]
  );
  if (q.rowCount !== doctorIds.length) throw badRequest('One or more selected doctors are invalid or inactive');
}

router.get('/doctors', asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT id,name FROM users
     WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL ORDER BY name`,
    [req.user.hospitalId]
  );
  res.json(q.rows);
}));

router.post('/', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    patientId: z.coerce.number().int().positive(),
    doctorIds: doctorIdsSchema.optional(),
    doctorId: z.coerce.number().int().positive().optional(),
  }).parse(req.body);

  const doctorIds = data.doctorIds || (data.doctorId ? [data.doctorId] : []);
  if (!doctorIds.length) throw badRequest('Select at least one doctor');

  const check = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM patients WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL) AS patient_ok,
       EXISTS(SELECT 1 FROM patients WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL AND date_of_birth IS NOT NULL) AS has_age`,
    [data.patientId, req.user.hospitalId]
  );
  if (!check.rows[0].patient_ok) throw badRequest('Invalid patient');
  if (!check.rows[0].has_age) throw badRequest('Age or date of birth is required to register a visit');
  const visit = await withTransaction(async (client) => {
    await validateDoctors(client, req.user.hospitalId, doctorIds);
    const numberQ = await client.query(
      `INSERT INTO hospital_visit_counters(hospital_id,next_number)
       VALUES($1,2)
       ON CONFLICT (hospital_id) DO UPDATE
       SET next_number=hospital_visit_counters.next_number+1
       RETURNING next_number-1 AS visit_number`,
      [req.user.hospitalId]
    );
    const q = await client.query(
      `INSERT INTO visits(hospital_id,visit_number,patient_id,doctor_id,created_by)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.hospitalId, numberQ.rows[0].visit_number, data.patientId, doctorIds[0], req.user.id]
    );
    for (let index = 0; index < doctorIds.length; index += 1) {
      await client.query(
        `INSERT INTO visit_doctors(hospital_id,visit_id,doctor_id,position)
         VALUES($1,$2,$3,$4)`,
        [req.user.hospitalId, q.rows[0].id, doctorIds[index], index + 1]
      );
    }
    return q.rows[0];
  });
  res.status(201).json(visit);
}));

router.put('/:id/doctors', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({ doctorIds: doctorIdsSchema }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (visit.status !== 'WAITING_FOR_DOCTOR') throw badRequest('Doctors can be changed only while the patient is waiting for a doctor');
    const completed = await client.query(
      `SELECT doctor_id,position FROM visit_doctors
       WHERE hospital_id=$1 AND visit_id=$2 AND status='COMPLETED' ORDER BY position`,
      [req.user.hospitalId, req.params.id]
    );
    const completedIds = completed.rows.map(row => Number(row.doctor_id));
    if (completedIds.some((id, index) => Number(data.doctorIds[index]) !== id)) {
      throw badRequest('Doctors who already completed consultation cannot be removed or reordered');
    }
    await validateDoctors(client, req.user.hospitalId, data.doctorIds.slice(completedIds.length));
    await client.query(
      `DELETE FROM visit_doctors WHERE hospital_id=$1 AND visit_id=$2 AND status<>'COMPLETED'`,
      [req.user.hospitalId, req.params.id]
    );
    for (let index = completedIds.length; index < data.doctorIds.length; index += 1) {
      await client.query(
        `INSERT INTO visit_doctors(hospital_id,visit_id,doctor_id,position)
         VALUES($1,$2,$3,$4)`,
        [req.user.hospitalId, req.params.id, data.doctorIds[index], index + 1]
      );
    }
    const currentDoctorId = data.doctorIds[completedIds.length];
    if (!currentDoctorId) throw badRequest('At least one pending doctor is required');
    await client.query(
      `UPDATE visits SET doctor_id=$1,doctor_notes=NULL,doctor_notes_updated_at=NULL,
              doctor_notes_updated_by=NULL,updated_at=NOW()
       WHERE id=$2 AND hospital_id=$3`,
      [currentDoctorId, req.params.id, req.user.hospitalId]
    );
    return getVisitDoctors(client, req.user.hospitalId, req.params.id);
  });
  res.json({ doctors: result });
}));

router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const dateFrom = req.query.dateFrom ? z.string().date().parse(String(req.query.dateFrom)) : null;
  const dateTo = req.query.dateTo ? z.string().date().parse(String(req.query.dateTo)) : null;
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest('From date cannot be after To date');
  const params = [req.user.hospitalId];
  let where = 'v.hospital_id=$1';
  if (req.user.role === 'DOCTOR') {
    params.push(req.user.id); where += ` AND v.doctor_id=$${params.length}`;
  }
  if (status) {
    params.push(status); where += ` AND v.status=$${params.length}`;
  }
  if (dateFrom) {
    params.push(dateFrom); where += ` AND v.created_at >= $${params.length}::date`;
  }
  if (dateTo) {
    params.push(dateTo); where += ` AND v.created_at < ($${params.length}::date + INTERVAL '1 day')`;
  }
  const q = await pool.query(
    `SELECT v.id,v.visit_number,v.doctor_id,v.status,v.created_at,v.completed_at,v.doctor_billing_finalized,v.left_at,v.left_note,
            p.id AS patient_id,p.full_name,p.mobile,d.name AS doctor_name,
            (SELECT json_agg(json_build_object('id',vd.doctor_id,'name',du.name,'position',vd.position,'status',vd.status,'started_at',vd.started_at,'completed_at',vd.completed_at) ORDER BY vd.position)
             FROM visit_doctors vd JOIN users du ON du.id=vd.doctor_id AND du.hospital_id=vd.hospital_id
             WHERE vd.hospital_id=v.hospital_id AND vd.visit_id=v.id) AS doctors,
            (SELECT COUNT(*)::int FROM visits pv WHERE pv.hospital_id=v.hospital_id AND pv.patient_id=v.patient_id) AS patient_visit_count,
            (SELECT MAX(pv.created_at) FROM visits pv WHERE pv.hospital_id=v.hospital_id AND pv.patient_id=v.patient_id AND pv.id<>v.id AND pv.created_at<v.created_at) AS previous_visit_at,
            COUNT(vc.id)::int AS charge_count,v.updated_at,
            lb.name AS left_by_name,
            COALESCE(SUM(vc.amount),0)::numeric(12,2) AS total_amount,
            pay.payment_mode,pay.paid_at
     FROM visits v
     JOIN patients p ON p.id=v.patient_id
     JOIN users d ON d.id=v.doctor_id
     LEFT JOIN users lb ON lb.id=v.left_by AND lb.hospital_id=v.hospital_id
     LEFT JOIN visit_charges vc ON vc.visit_id=v.id AND vc.hospital_id=v.hospital_id
     LEFT JOIN payments pay ON pay.visit_id=v.id AND pay.hospital_id=v.hospital_id
     WHERE ${where}
     GROUP BY v.id,p.id,d.name,lb.name,pay.payment_mode,pay.paid_at
     ORDER BY v.created_at DESC LIMIT 1000`,
    params
  );
  res.json(q.rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const client = pool;
  const visit = await getVisit(client, req.user.hospitalId, req.params.id);
  if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) throw forbidden('This visit is assigned to another doctor');
  const charges = await getCharges(client, req.user.hospitalId, req.params.id);
  const payment = await client.query(
    `SELECT p.id,p.amount,p.payment_mode,p.reference_no,p.accepted_by,p.paid_at,u.name AS accepted_by_name
     FROM payments p LEFT JOIN users u ON u.id=p.accepted_by AND u.hospital_id=p.hospital_id
     WHERE p.hospital_id=$1 AND p.visit_id=$2`,
    [req.user.hospitalId, req.params.id]
  );
  const corrections = ['PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT','COMPLETED'].includes(visit.status) ? await getCorrections(client, req.user.hospitalId, req.params.id) : [];
  const doctors = await getVisitDoctors(client, req.user.hospitalId, req.params.id);
  const settlement = await getSettlementBreakdown(client, req.user.hospitalId, req.params.id);
  const prescription = await getPrescription(client, req.user.hospitalId, req.params.id);
  res.json({ visit, doctors, charges, payment: payment.rows[0] || null, corrections, settlement, prescription });
}));

// The most recent earlier prescription for this visit's patient (offered as "copy to this visit").
router.get('/:id/prescription/last', asyncHandler(async (req, res) => {
  const visit = await getVisit(pool, req.user.hospitalId, req.params.id);
  if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) throw forbidden('This visit is assigned to another doctor');
  const last = await pool.query(
    `SELECT v.id,v.created_at FROM visits v
     WHERE v.hospital_id=$1 AND v.patient_id=$2 AND v.id<>$3 AND v.created_at<=$4
       AND EXISTS (SELECT 1 FROM visit_prescription_items pi WHERE pi.hospital_id=v.hospital_id AND pi.visit_id=v.id)
     ORDER BY v.created_at DESC,v.id DESC LIMIT 1`,
    [req.user.hospitalId, visit.patient_id, visit.id, visit.created_at]
  );
  if (!last.rowCount) return res.json(null);
  const items = await getPrescription(pool, req.user.hospitalId, last.rows[0].id);
  res.json({ visitId: Number(last.rows[0].id), date: last.rows[0].created_at, doctorName: items[0]?.doctor_name, items });
}));

const prescriptionItemSchema = z.object({
  medicineId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  composition: z.string().trim().max(300).optional().default(''),
  manufacturer: z.string().trim().max(200).optional().default(''),
  packSize: z.string().trim().max(120).optional().default(''),
  dose: z.string().trim().max(40).optional().default(''),
  timing: z.enum(['BEFORE_FOOD', 'AFTER_FOOD', 'ANY']).optional().default('ANY'),
  durationDays: z.coerce.number().int().min(1).max(365).nullable().optional(),
  note: z.string().trim().max(200).optional().default(''),
});

// Replaces the consulting doctor's medicine list for this visit (the screen saves the whole list as it changes).
// The assigned doctor or the hospital admin (who runs the consultation screen in small clinics) can edit it; it is always stored under the consulting doctor.
router.put('/:id/prescription', allow('ADMIN','DOCTOR'), asyncHandler(async (req, res) => {
  const data = z.object({ items: z.array(prescriptionItemSchema).max(30) }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) throw forbidden('This visit is assigned to another doctor');
    if (!['WITH_DOCTOR','PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT','COMPLETED'].includes(visit.status)) throw badRequest('A prescription can be written once the patient has started seeing the doctor');
    // a medicine another doctor already prescribed on this visit cannot be prescribed again
    const others = await client.query(
      `SELECT pi.medicine_id,pi.name,u.name AS doctor_name FROM visit_prescription_items pi JOIN users u ON u.id=pi.doctor_id AND u.hospital_id=pi.hospital_id
       WHERE pi.hospital_id=$1 AND pi.visit_id=$2 AND pi.doctor_id<>$3`,
      [req.user.hospitalId, visit.id, visit.doctor_id]
    );
    for (const item of data.items) {
      const taken = others.rows.find(o => (o.medicine_id && item.medicineId && Number(o.medicine_id) === Number(item.medicineId)) || String(o.name).trim().toLowerCase() === item.name.trim().toLowerCase());
      if (taken) throw badRequest(`${item.name} is already prescribed by ${taken.doctor_name} in this visit, so it cannot be added again.`);
    }
    await client.query(`DELETE FROM visit_prescription_items WHERE hospital_id=$1 AND visit_id=$2 AND doctor_id=$3`, [req.user.hospitalId, visit.id, visit.doctor_id]);
    for (let index = 0; index < data.items.length; index += 1) {
      const item = data.items[index];
      await client.query(
        `INSERT INTO visit_prescription_items(hospital_id,visit_id,doctor_id,position,medicine_id,name,composition,manufacturer,pack_size,dose,timing,duration_days,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [req.user.hospitalId, visit.id, visit.doctor_id, index + 1, item.medicineId || null, item.name, item.composition, item.manufacturer, item.packSize, item.dose, item.timing, item.durationDays || null, item.note]
      );
    }
    return getPrescription(client, req.user.hospitalId, visit.id);
  });
  res.json({ prescription: result });
}));

router.post('/:id/start', allow('ADMIN','DOCTOR','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const q = await client.query(
      `UPDATE visits SET status='WITH_DOCTOR',updated_at=NOW()
       WHERE id=$1 AND hospital_id=$2 AND status='WAITING_FOR_DOCTOR'
         AND ($4<>'DOCTOR' OR doctor_id=$3)
       RETURNING *`,
      [req.params.id, req.user.hospitalId, req.user.id, req.user.role]
    );
    if (!q.rowCount) throw badRequest('Visit cannot be started');
    await client.query(
      `UPDATE visit_doctors SET status='IN_PROGRESS',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
       WHERE hospital_id=$1 AND visit_id=$2 AND doctor_id=$3 AND status='WAITING'`,
      [req.user.hospitalId, req.params.id, q.rows[0].doctor_id]
    );
    return q.rows[0];
  });
  res.json(result);
}));

router.put('/:id/doctor-notes', allow('ADMIN','DOCTOR','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({ notes: z.string().max(5000) }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (visit.status !== 'WITH_DOCTOR') throw badRequest('Findings can be edited only while the patient is with the doctor');
    if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) throw forbidden('This visit is assigned to another doctor');
    const q = await client.query(
      `UPDATE visits
       SET doctor_notes=NULLIF(trim($1),''),doctor_notes_updated_at=NOW(),doctor_notes_updated_by=$2,updated_at=NOW()
       WHERE id=$3 AND hospital_id=$4
       RETURNING id,doctor_notes,doctor_notes_updated_at,doctor_notes_updated_by`,
      [data.notes, req.user.id, req.params.id, req.user.hospitalId]
    );
    await client.query(
      `UPDATE visit_doctors SET doctor_notes=NULLIF(trim($1),''),updated_at=NOW()
       WHERE hospital_id=$2 AND visit_id=$3 AND doctor_id=$4 AND status='IN_PROGRESS'`,
      [data.notes, req.user.hospitalId, req.params.id, visit.doctor_id]
    );
    return q.rows[0];
  });
  res.json(result);
}));

const chargeSchema = z.object({
  billingItemId: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().min(1).max(180),
  amount: z.coerce.number().min(0),
});

const receptionChargeSchema = chargeSchema.extend({
  doctorId: z.coerce.number().int().positive().nullable().optional(),
});

async function validateReceptionChargeDoctor(client, hospitalId, visitId, doctorId) {
  if (!doctorId) return null;
  const q = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM visit_doctors WHERE hospital_id=$1 AND visit_id=$2 AND doctor_id=$3 AND status='COMPLETED') AS consulted,
       NOT EXISTS(SELECT 1 FROM visit_doctors WHERE hospital_id=$1 AND visit_id=$2 AND status IN ('WAITING','IN_PROGRESS')) AS all_finished`,
    [hospitalId, visitId, doctorId]
  );
  if (!q.rows[0].consulted) throw badRequest('Amounts can be allocated only to a doctor who completed consultation');
  if (!q.rows[0].all_finished) throw badRequest('An amount can be added on a doctor’s behalf only after all consultations are completed or skipped');
  return doctorId;
}

async function resolveCharge(client, hospitalId, charge) {
  if (charge.billingItemId) {
    const item = await client.query(
      `SELECT id,name,default_price FROM billing_items
       WHERE id=$1 AND hospital_id=$2 AND is_active=TRUE AND deleted_at IS NULL`,
      [charge.billingItemId, hospitalId]
    );
    if (!item.rowCount) throw badRequest('Invalid or inactive billing item');
    return {
      billingItemId: Number(item.rows[0].id),
      description: item.rows[0].name,
      amount: item.rows[0].default_price,
    };
  }
  return { billingItemId: null, description: charge.description, amount: money(charge.amount) };
}

router.post('/:id/doctor-complete', allow('ADMIN','DOCTOR','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    action: z.enum(['SEND_TO_RECEPTION','PAY_AND_COMPLETE']),
    charges: z.array(chargeSchema).max(50).default([]),
    paymentMode: z.enum(['CASH','UPI','CARD','OTHER']).optional(),
    referenceNo: z.string().max(120).optional().default(''),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) throw forbidden('This visit is assigned to another doctor');
    if (!['WAITING_FOR_DOCTOR','WITH_DOCTOR'].includes(visit.status)) throw badRequest('Visit is not in doctor stage');

    for (const c of data.charges) {
      const resolved = await resolveCharge(client, req.user.hospitalId, c);
      await client.query(
        `INSERT INTO visit_charges(hospital_id,visit_id,billing_item_id,description,amount,source,added_by,doctor_id,is_locked)
         VALUES($1,$2,$3,$4,$5,'DOCTOR',$6,$7,TRUE)`,
        [req.user.hospitalId, req.params.id, resolved.billingItemId, resolved.description, resolved.amount, req.user.id, visit.doctor_id]
      );
    }

    await client.query(
      `UPDATE visit_doctors
       SET status='COMPLETED',doctor_notes=$1,completed_at=NOW(),updated_at=NOW()
       WHERE hospital_id=$2 AND visit_id=$3 AND doctor_id=$4 AND status IN ('WAITING','IN_PROGRESS')`,
      [visit.doctor_notes, req.user.hospitalId, req.params.id, visit.doctor_id]
    );
    const nextDoctor = await client.query(
      `SELECT vd.doctor_id,u.name AS doctor_name
       FROM visit_doctors vd
       JOIN users u ON u.id=vd.doctor_id AND u.hospital_id=vd.hospital_id
       WHERE vd.hospital_id=$1 AND vd.visit_id=$2 AND vd.status='WAITING'
       ORDER BY vd.position LIMIT 1`,
      [req.user.hospitalId, req.params.id]
    );
    if (nextDoctor.rowCount) {
      const next = nextDoctor.rows[0];
      const v = await client.query(
        `UPDATE visits
         SET doctor_id=$1,status='WAITING_FOR_DOCTOR',doctor_notes=NULL,
             doctor_notes_updated_at=NULL,doctor_notes_updated_by=NULL,updated_at=NOW()
         WHERE id=$2 AND hospital_id=$3 RETURNING *`,
        [next.doctor_id, req.params.id, req.user.hospitalId]
      );
      return {
        visit: v.rows[0],
        charges: await getCharges(client, req.user.hospitalId, req.params.id),
        handedOff: true,
        nextDoctor: next,
      };
    }

    if (data.action === 'SEND_TO_RECEPTION') {
      const v = await client.query(
        `UPDATE visits SET status='PAYMENT_PENDING',doctor_billing_finalized=$1,updated_at=NOW()
         WHERE id=$2 AND hospital_id=$3 RETURNING *`,
        [data.charges.length > 0, req.params.id, req.user.hospitalId]
      );
      return { visit: v.rows[0], charges: await getCharges(client, req.user.hospitalId, req.params.id) };
    }

    if (!data.paymentMode) throw badRequest('Payment mode is required');
    const total = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM visit_charges WHERE hospital_id=$1 AND visit_id=$2`,
      [req.user.hospitalId, req.params.id]
    );
    const amount = total.rows[0].total;
    const paymentQ = await client.query(
      `INSERT INTO payments(hospital_id,visit_id,amount,payment_mode,reference_no,accepted_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.hospitalId, req.params.id, amount, data.paymentMode, data.referenceNo || null, req.user.id]
    );
    await recordDoctorSettlements(client, req.user.hospitalId, req.params.id, paymentQ.rows[0].id);
    await client.query(
      `UPDATE visit_charges SET is_locked=TRUE,updated_at=NOW() WHERE hospital_id=$1 AND visit_id=$2`,
      [req.user.hospitalId, req.params.id]
    );
    const v = await client.query(
      `UPDATE visits SET status='COMPLETED',doctor_billing_finalized=$1,completed_by=$2,completed_at=NOW(),updated_at=NOW()
       WHERE id=$3 AND hospital_id=$4 RETURNING *`,
      [data.charges.length > 0, req.user.id, req.params.id, req.user.hospitalId]
    );
    return { visit: v.rows[0], charges: await getCharges(client, req.user.hospitalId, req.params.id), payment: { amount, paymentMode: data.paymentMode } };
  });
  res.json(result);
}));

router.post('/:id/reception-charges', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const c = receptionChargeSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (!['PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT'].includes(visit.status)) throw badRequest('Charges can be added only before payment is collected');
    const resolved = await resolveCharge(client, req.user.hospitalId, c);
    const doctorId = await validateReceptionChargeDoctor(client, req.user.hospitalId, req.params.id, c.doctorId);
    const q = await client.query(
      `INSERT INTO visit_charges(hospital_id,visit_id,billing_item_id,description,amount,source,added_by,doctor_id,is_locked)
       VALUES($1,$2,$3,$4,$5,'RECEPTION',$6,$7,FALSE)
       RETURNING *`,
      [req.user.hospitalId, req.params.id, resolved.billingItemId, resolved.description, resolved.amount, req.user.id, doctorId]
    );
    return q.rows[0];
  });
  res.status(201).json(result);
}));

router.put('/:id/reception-charges/:chargeId', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const c = receptionChargeSchema.parse(req.body);
  const resolved = await resolveCharge(pool, req.user.hospitalId, c);
  const doctorId = await validateReceptionChargeDoctor(pool, req.user.hospitalId, req.params.id, c.doctorId);
  const q = await pool.query(
    `UPDATE visit_charges vc SET billing_item_id=$1,description=$2,amount=$3,doctor_id=$4,updated_at=NOW()
     FROM visits v
     WHERE vc.id=$5 AND vc.hospital_id=$6 AND vc.visit_id=v.id AND v.hospital_id=$6
       AND v.id=$7 AND v.status IN ('PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT') AND vc.source='RECEPTION' AND vc.is_locked=FALSE
     RETURNING vc.*`,
    [resolved.billingItemId, resolved.description, resolved.amount, doctorId, req.params.chargeId, req.user.hospitalId, req.params.id]
  );
  if (!q.rowCount) throw badRequest('Only unlocked reception charges can be edited');
  res.json(q.rows[0]);
}));

router.delete('/:id/reception-charges/:chargeId', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  throw badRequest('Use the audited charge correction action and provide a reason');
}));

router.post('/:id/pay', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    paymentMode: z.enum(['CASH','UPI','CARD','OTHER']),
    referenceNo: z.string().max(120).optional().default(''),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (!['PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT'].includes(visit.status)) throw badRequest('Visit is not awaiting payment');
    const totalQ = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM visit_charges WHERE hospital_id=$1 AND visit_id=$2`,
      [req.user.hospitalId, req.params.id]
    );
    const amount = totalQ.rows[0].total;
    const paymentQ = await client.query(
      `INSERT INTO payments(hospital_id,visit_id,amount,payment_mode,reference_no,accepted_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.hospitalId, req.params.id, amount, data.paymentMode, data.referenceNo || null, req.user.id]
    );
    await recordDoctorSettlements(client, req.user.hospitalId, req.params.id, paymentQ.rows[0].id);
    await client.query(`UPDATE visit_charges SET is_locked=TRUE,updated_at=NOW() WHERE hospital_id=$1 AND visit_id=$2`, [req.user.hospitalId, req.params.id]);
    const v = await client.query(
      `UPDATE visits SET status='COMPLETED',completed_by=$1,completed_at=NOW(),updated_at=NOW()
       WHERE id=$2 AND hospital_id=$3 RETURNING *`,
      [req.user.id, req.params.id, req.user.hospitalId]
    );
    return { visit: v.rows[0], amount, paymentMode: data.paymentMode };
  });
  res.json(result);
}));

router.patch('/:id/charge-corrections/:chargeId', allow('ADMIN','DOCTOR','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    action: z.enum(['REDUCE','REMOVE']),
    amount: z.coerce.number().min(0).optional(),
    reason: z.string().trim().min(5).max(500),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (!['PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT'].includes(visit.status)) throw badRequest('Charges can be corrected only before payment is collected');
    if (req.user.role === 'DOCTOR' && Number(visit.doctor_id) !== req.user.id) {
      throw forbidden('This visit is assigned to another doctor');
    }

    const chargeQ = await client.query(
      `SELECT id,description,amount,is_voided
       FROM visit_charges
       WHERE id=$1 AND hospital_id=$2 AND visit_id=$3
       FOR UPDATE`,
      [req.params.chargeId, req.user.hospitalId, req.params.id]
    );
    if (!chargeQ.rowCount) throw notFound('Charge not found');
    const charge = chargeQ.rows[0];
    if (charge.is_voided || Number(charge.amount) <= 0) throw badRequest('This charge has already been removed');

    const oldAmount = Number(charge.amount);
    let newAmount = 0;
    if (data.action === 'REDUCE') {
      if (data.amount === undefined || data.amount <= 0) throw badRequest('Reduced amount must be greater than zero');
      if (data.amount >= oldAmount) throw badRequest('Reduced amount must be lower than the current amount');
      newAmount = Number(money(data.amount));
    }

    const totalQ = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total
       FROM visit_charges WHERE hospital_id=$1 AND visit_id=$2`,
      [req.user.hospitalId, req.params.id]
    );
    const paymentQ = await client.query(
      `SELECT amount FROM payments WHERE hospital_id=$1 AND visit_id=$2`,
      [req.user.hospitalId, req.params.id]
    );
    const oldTotal = Number(totalQ.rows[0].total);
    const newTotal = Number(money(oldTotal - oldAmount + newAmount));
    const recordedPaymentAmount = paymentQ.rows[0]?.amount || null;

    await client.query(
      `UPDATE visit_charges
       SET amount=$1,is_voided=$2,is_locked=TRUE,updated_at=NOW()
       WHERE id=$3 AND hospital_id=$4 AND visit_id=$5`,
      [newAmount, data.action === 'REMOVE', req.params.chargeId, req.user.hospitalId, req.params.id]
    );
    await client.query(
      `INSERT INTO visit_charge_corrections(
         hospital_id,visit_id,visit_charge_id,action,description,old_amount,new_amount,
         old_total,new_total,recorded_payment_amount,reason,corrected_by,corrected_by_role
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        req.user.hospitalId, req.params.id, req.params.chargeId, data.action,
        charge.description, oldAmount, newAmount, oldTotal, newTotal, recordedPaymentAmount,
        data.reason, req.user.id, req.user.role,
      ]
    );

    return {
      charges: await getCharges(client, req.user.hospitalId, req.params.id),
      corrections: await getCorrections(client, req.user.hospitalId, req.params.id),
      recordedPaymentAmount,
      correctedTotal: newTotal,
    };
  });
  res.json(result);
}));

router.post('/:id/mark-left', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    outcome: z.enum(['BEFORE_DOCTOR','WITHOUT_PAYMENT']),
    note: z.string().trim().max(500).optional().default(''),
  }).parse(req.body);
  const expectedStatus = data.outcome === 'BEFORE_DOCTOR' ? 'WAITING_FOR_DOCTOR' : 'PAYMENT_PENDING';
  const nextStatus = data.outcome === 'BEFORE_DOCTOR' ? 'LEFT_BEFORE_DOCTOR' : 'LEFT_WITHOUT_PAYMENT';
  const q = await pool.query(
    `UPDATE visits
     SET status=$1,left_at=NOW(),left_by=$2,left_note=NULLIF($3,''),updated_at=NOW()
     WHERE id=$4 AND hospital_id=$5 AND status=$6
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.hospital_id=$5 AND p.visit_id=$4)
       AND ($6<>'WAITING_FOR_DOCTOR' OR NOT EXISTS (
         SELECT 1 FROM visit_doctors vd WHERE vd.hospital_id=$5 AND vd.visit_id=$4 AND vd.status='COMPLETED'
       ))
     RETURNING *`,
    [nextStatus, req.user.id, data.note, req.params.id, req.user.hospitalId, expectedStatus]
  );
  if (!q.rowCount) {
    throw badRequest(data.outcome === 'BEFORE_DOCTOR'
      ? 'Only a patient waiting for the doctor can be marked as left before consultation'
      : 'Only a payment-pending visit can be marked as left without payment');
  }
  res.json(q.rows[0]);
}));

router.post('/:id/stop-remaining-consultations', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const data = z.object({
    reason: z.string().trim().min(5).max(500),
    outcome: z.enum(['PAYMENT_PENDING','LEFT_WITHOUT_PAYMENT']).optional().default('PAYMENT_PENDING'),
  }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const visit = await getVisit(client, req.user.hospitalId, req.params.id, true);
    if (visit.status !== 'WAITING_FOR_DOCTOR') throw badRequest('Remaining consultations can be stopped only while the patient is waiting for the next doctor');
    const completedQ = await client.query(
      `SELECT doctor_id,doctor_notes FROM visit_doctors
       WHERE hospital_id=$1 AND visit_id=$2 AND status='COMPLETED'
       ORDER BY position DESC LIMIT 1`,
      [req.user.hospitalId, req.params.id]
    );
    if (!completedQ.rowCount) throw badRequest('No completed consultation was found');
    const skippedQ = await client.query(
      `UPDATE visit_doctors
       SET status='SKIPPED',skipped_at=NOW(),skipped_by=$1,skip_reason=$2,updated_at=NOW()
       WHERE hospital_id=$3 AND visit_id=$4 AND status='WAITING'
       RETURNING doctor_id`,
      [req.user.id, data.reason, req.user.hospitalId, req.params.id]
    );
    if (!skippedQ.rowCount) throw badRequest('There are no remaining doctor consultations to stop');
    const lastCompleted = completedQ.rows[0];
    const v = await client.query(
      `UPDATE visits
       SET doctor_id=$1,status=$5::varchar,doctor_notes=$2,
           doctor_billing_finalized=EXISTS(
             SELECT 1 FROM visit_charges vc WHERE vc.hospital_id=$3 AND vc.visit_id=$4 AND vc.doctor_id IS NOT NULL AND vc.amount>0
           ),left_at=CASE WHEN $5::text='LEFT_WITHOUT_PAYMENT' THEN NOW() ELSE left_at END,
           left_by=CASE WHEN $5::text='LEFT_WITHOUT_PAYMENT' THEN $6 ELSE left_by END,
           left_note=CASE WHEN $5::text='LEFT_WITHOUT_PAYMENT' THEN $7 ELSE left_note END,
           updated_at=NOW()
       WHERE id=$4 AND hospital_id=$3 RETURNING *`,
      [lastCompleted.doctor_id, lastCompleted.doctor_notes, req.user.hospitalId, req.params.id, data.outcome, req.user.id, data.reason]
    );
    return { visit: v.rows[0], skippedCount: skippedQ.rowCount, outcome: data.outcome, doctors: await getVisitDoctors(client, req.user.hospitalId, req.params.id) };
  });
  res.json(result);
}));

router.post('/:id/cancel', allow('ADMIN','RECEPTIONIST'), asyncHandler(async (req, res) => {
  const q = await pool.query(
    `UPDATE visits SET status='CANCELLED',cancelled_by=$1,cancelled_at=NOW(),updated_at=NOW()
     WHERE id=$2 AND hospital_id=$3 AND status IN ('WAITING_FOR_DOCTOR','WITH_DOCTOR','PAYMENT_PENDING')
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.hospital_id=$3 AND p.visit_id=$2)
       AND NOT EXISTS (SELECT 1 FROM visit_doctors vd WHERE vd.hospital_id=$3 AND vd.visit_id=$2 AND vd.status='COMPLETED')
     RETURNING *`,
    [req.user.id, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw badRequest('Visit cannot be cancelled');
  res.json(q.rows[0]);
}));

export default router;
