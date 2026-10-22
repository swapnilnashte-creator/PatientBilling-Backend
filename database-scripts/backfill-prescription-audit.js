import 'dotenv/config';
import { pool } from '../src/db.js';

// One-off: give prescriptions written BEFORE the audit existed an "Added" entry each, so their history is not empty.
// They are dated when the medicine was first saved and credited to the consulting doctor (the real author of an old edit is not known).
//   npm run backfill-prescription-audit              (every hospital)         npm run backfill-prescription-audit -- 42      (one hospital)
// Safe to run again: a visit that already has audit entries is skipped.
const only = process.argv[2] ? Number(process.argv[2]) : null;
try {
  const q = await pool.query(
    `INSERT INTO prescription_audit(hospital_id,visit_id,patient_id,doctor_id,action,item_key,medicine_id,name,after_data,changed_fields,changed_by,changed_by_name,changed_by_role,by_support,visit_status,created_at,updated_at)
     SELECT pi.hospital_id,pi.visit_id,v.patient_id,pi.doctor_id,'ADDED',COALESCE('m'||pi.medicine_id::text,'n'||lower(btrim(pi.name))),pi.medicine_id,pi.name,
            jsonb_build_object('name',pi.name,'composition',pi.composition,'dose',pi.dose,'timing',pi.timing,'durationDays',pi.duration_days,'note',pi.note),
            '{}',pi.doctor_id,u.name,u.role,FALSE,v.status,pi.created_at,pi.created_at
     FROM visit_prescription_items pi
     JOIN visits v ON v.hospital_id=pi.hospital_id AND v.id=pi.visit_id
     JOIN users u ON u.hospital_id=pi.hospital_id AND u.id=pi.doctor_id
     WHERE ($1::bigint IS NULL OR pi.hospital_id=$1)
       AND NOT EXISTS (SELECT 1 FROM prescription_audit a WHERE a.hospital_id=pi.hospital_id AND a.visit_id=pi.visit_id)`, [only]);
  console.log(`Added ${q.rowCount} history entries for existing prescriptions.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
