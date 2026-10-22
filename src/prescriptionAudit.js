// A record of every change to a prescription (table prescription_audit). The screen saves the whole medicine list as it changes, so the changes are found
// by comparing the list that was stored with the list that arrives. Several quick edits of the same medicine by the same person (typing a note letter by
// letter, then choosing a dose) become one entry instead of dozens.
const FIELDS = ['dose', 'timing', 'durationDays', 'note', 'composition'];
const MERGE_MINUTES = 2;

const keyOf = (medicineId, name) => (medicineId ? `m${medicineId}` : `n${String(name).trim().toLowerCase()}`);
const fromRow = (r) => ({ key: keyOf(r.medicine_id, r.name), medicineId: r.medicine_id ? Number(r.medicine_id) : null, name: r.name, composition: r.composition || '', dose: r.dose || '', timing: r.timing || 'ANY', durationDays: r.duration_days || null, note: r.note || '' });
const fromItem = (i) => ({ key: keyOf(i.medicineId, i.name), medicineId: i.medicineId || null, name: i.name, composition: i.composition || '', dose: i.dose || '', timing: i.timing || 'ANY', durationDays: i.durationDays || null, note: i.note || '' });
const snap = (s) => ({ name: s.name, composition: s.composition, dose: s.dose, timing: s.timing, durationDays: s.durationDays, note: s.note });
const differ = (a, b) => FIELDS.filter(f => (a[f] ?? '') !== (b[f] ?? ''));

// before: the rows stored now (database rows); after: the new list (validated items). Both for the consulting doctor of the visit.
export async function recordPrescriptionChanges(client, { hospitalId, visit, user, before, after }) {
  const old = new Map(before.map(fromRow).map(s => [s.key, s]));
  const next = new Map(after.map(fromItem).map(s => [s.key, s]));
  const who = [user.id, user.name || 'Unknown', user.role, Boolean(user.impersonatedBySuperuserId)];
  const base = [hospitalId, visit.id, visit.patient_id, visit.doctor_id];

  const insert = (action, s, beforeData, afterData, fields) => client.query(
    `INSERT INTO prescription_audit(hospital_id,visit_id,patient_id,doctor_id,action,item_key,medicine_id,name,before_data,after_data,changed_fields,changed_by,changed_by_name,changed_by_role,by_support,visit_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [...base, action, s.key, s.medicineId, s.name, beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null, fields, ...who, visit.status]);

  for (const [key, s] of old) if (!next.has(key)) await insert('REMOVED', s, snap(s), null, []);

  for (const [key, s] of next) {
    const was = old.get(key);
    if (!was) { await insert('ADDED', s, null, snap(s), []); continue; }
    const fields = differ(was, s);
    if (!fields.length) continue;
    // the latest entry about this medicine in this visit: if it is the same person's and is a minute or two old, it is updated instead of adding another
    const last = await client.query(
      `SELECT id,action,before_data,after_data,changed_by FROM prescription_audit
       WHERE hospital_id=$1 AND visit_id=$2 AND item_key=$3 ORDER BY id DESC LIMIT 1`, [hospitalId, visit.id, key]);
    const l = last.rows[0];
    const recent = l && Number(l.changed_by) === Number(user.id) && l.action !== 'REMOVED'
      && (await client.query(`SELECT 1 FROM prescription_audit WHERE id=$1 AND updated_at > NOW() - make_interval(mins=>$2::int)`, [l.id, MERGE_MINUTES])).rowCount > 0;
    if (recent && l.action === 'ADDED') {
      await client.query(`UPDATE prescription_audit SET after_data=$2,name=$3,updated_at=NOW() WHERE id=$1`, [l.id, JSON.stringify(snap(s)), s.name]);
    } else if (recent && l.action === 'CHANGED') {
      const original = l.before_data;
      const net = differ({ ...original }, snap(s));
      if (!net.length) await client.query(`DELETE FROM prescription_audit WHERE id=$1`, [l.id]); // changed back to what it was: nothing to show
      else await client.query(`UPDATE prescription_audit SET after_data=$2,changed_fields=$3,name=$4,updated_at=NOW() WHERE id=$1`, [l.id, JSON.stringify(snap(s)), net, s.name]);
    } else {
      await insert('CHANGED', s, snap(was), snap(s), fields);
    }
  }
}
