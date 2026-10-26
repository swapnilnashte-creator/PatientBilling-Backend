import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils.js';
import { STARTER_FINDINGS } from '../starterFindings.js';

const router = Router();

const medicineSchema = z.object({
  medicineId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  composition: z.string().trim().max(300).optional().default(''),
  manufacturer: z.string().trim().max(200).optional().default(''),
  packSize: z.string().trim().max(120).optional().default(''),
  dose: z.string().trim().min(1, 'Choose when to take each medicine').max(40),
  timing: z.enum(['BEFORE_FOOD', 'AFTER_FOOD', 'ANY']).optional().default('ANY'),
  durationDays: z.coerce.number().int().min(1, 'Enter the number of days for each medicine').max(365),
  note: z.string().trim().max(200).optional().default(''),
});
const templateBody = z.object({
  name: z.string().trim().min(2).max(80),
  group: z.string('Choose a group, or add a new one').trim().min(1, 'Choose a group, or add a new one').max(60),
  findings: z.string().trim().max(2000).optional().default(''),
  advice: z.string().trim().max(1000).optional().default(''),
  isActive: z.boolean().optional().default(true),
  medicines: z.array(medicineSchema).max(15),
});

// A template with its medicines in order.
const shape = (row, meds) => ({
  id: row.id, scope: row.owner_doctor_id ? 'MINE' : 'HOSPITAL', ownerDoctorId: row.owner_doctor_id, name: row.name, group: row.group_name, findings: row.findings, advice: row.advice,
  isActive: row.is_active, sortOrder: row.sort_order, updatedAt: row.updated_at,
  medicines: meds.map(x => ({ id: x.id, medicineId: x.medicine_id ? Number(x.medicine_id) : null, name: x.name, composition: x.composition, manufacturer: x.manufacturer, packSize: x.pack_size, dose: x.dose, timing: x.timing, durationDays: x.duration_days, note: x.note })),
});
async function load(client, hospitalId, where, params) {
  const t = await client.query(`SELECT * FROM finding_templates WHERE hospital_id=$1 ${where} ORDER BY sort_order,lower(name)`, [hospitalId, ...params]);
  if (!t.rowCount) return [];
  const m = await client.query(`SELECT * FROM finding_template_medicines WHERE hospital_id=$1 AND template_id=ANY($2::bigint[]) ORDER BY template_id,position,id`, [hospitalId, t.rows.map(r => r.id)]);
  const by = new Map();
  for (const x of m.rows) { if (!by.has(String(x.template_id))) by.set(String(x.template_id), []); by.get(String(x.template_id)).push(x); }
  return t.rows.map(r => shape(r, by.get(String(r.id)) || []));
}

// Admin sees and manages the hospital's templates; a doctor sees the hospital's active ones and manages their own.
// ?manage=1 includes switched-off ones and only the templates the user can change.
router.get('/', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const manage = req.query.manage === '1';
  const hospitalId = req.user.hospitalId;
  if (req.user.role === 'ADMIN') {
    res.json(await load(pool, hospitalId, `AND owner_doctor_id IS NULL ${manage ? '' : 'AND is_active=TRUE'}`, []));
    return;
  }
  const where = manage
    ? 'AND (owner_doctor_id=$2 OR (owner_doctor_id IS NULL AND is_active=TRUE))'
    : 'AND is_active=TRUE AND (owner_doctor_id IS NULL OR owner_doctor_id=$2)';
  res.json(await load(pool, hospitalId, where, [req.user.id]));
}));

async function assertCanChange(client, req, id) {
  const q = await client.query(`SELECT id,owner_doctor_id FROM finding_templates WHERE hospital_id=$1 AND id=$2 FOR UPDATE`, [req.user.hospitalId, id]);
  if (!q.rowCount) throw notFound('Template not found');
  const owner = q.rows[0].owner_doctor_id;
  if (owner === null ? req.user.role !== 'ADMIN' : Number(owner) !== req.user.id) throw forbidden(owner === null ? 'Only an Admin can change the hospital’s templates. You can copy it to your own.' : 'This template belongs to another doctor');
  return q.rows[0];
}
async function writeMedicines(client, hospitalId, templateId, medicines) {
  await client.query(`DELETE FROM finding_template_medicines WHERE hospital_id=$1 AND template_id=$2`, [hospitalId, templateId]);
  const seen = new Set();
  for (const [i, x] of medicines.entries()) {
    const key = x.name.trim().toLowerCase();
    if (seen.has(key)) throw badRequest(`${x.name} is listed twice`);
    seen.add(key);
    await client.query(
      `INSERT INTO finding_template_medicines(hospital_id,template_id,position,medicine_id,name,composition,manufacturer,pack_size,dose,timing,duration_days,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [hospitalId, templateId, i + 1, x.medicineId || null, x.name, x.composition, x.manufacturer, x.packSize, x.dose, x.timing, x.durationDays, x.note]
    );
  }
}
const nameTaken = (e) => (e?.code === '23505' ? badRequest('You already have a template with this name') : e);

router.post('/', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const data = templateBody.parse(req.body);
  const owner = req.user.role === 'DOCTOR' ? req.user.id : null;
  try {
    const id = await withTransaction(async (client) => {
      const next = await client.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM finding_templates WHERE hospital_id=$1 AND COALESCE(owner_doctor_id,0)=COALESCE($2,0)`, [req.user.hospitalId, owner]);
      const ins = await client.query(
        `INSERT INTO finding_templates(hospital_id,owner_doctor_id,name,group_name,findings,advice,is_active,sort_order,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [req.user.hospitalId, owner, data.name, data.group, data.findings, data.advice, data.isActive, next.rows[0].n, req.user.id]
      );
      await writeMedicines(client, req.user.hospitalId, ins.rows[0].id, data.medicines);
      return ins.rows[0].id;
    });
    res.status(201).json((await load(pool, req.user.hospitalId, 'AND id=$2', [id]))[0]);
  } catch (e) { throw nameTaken(e); }
}));

router.put('/:id', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const data = templateBody.parse(req.body);
  try {
    await withTransaction(async (client) => {
      await assertCanChange(client, req, req.params.id);
      await client.query(
        `UPDATE finding_templates SET name=$3,group_name=$4,findings=$5,advice=$6,is_active=$7,updated_by=$8,updated_at=NOW() WHERE hospital_id=$1 AND id=$2`,
        [req.user.hospitalId, req.params.id, data.name, data.group, data.findings, data.advice, data.isActive, req.user.id]
      );
      await writeMedicines(client, req.user.hospitalId, req.params.id, data.medicines);
    });
    res.json((await load(pool, req.user.hospitalId, 'AND id=$2', [req.params.id]))[0]);
  } catch (e) { throw nameTaken(e); }
}));

// Quick on/off from the list.
router.put('/:id/active', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  await withTransaction(async (client) => {
    await assertCanChange(client, req, req.params.id);
    await client.query(`UPDATE finding_templates SET is_active=$3,updated_by=$4,updated_at=NOW() WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id, isActive, req.user.id]);
  });
  res.json((await load(pool, req.user.hospitalId, 'AND id=$2', [req.params.id]))[0]);
}));

router.delete('/:id', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    await assertCanChange(client, req, req.params.id);
    await client.query(`DELETE FROM finding_templates WHERE hospital_id=$1 AND id=$2`, [req.user.hospitalId, req.params.id]);
  });
  res.json({ ok: true });
}));

// A doctor copies a hospital template to their own list; an Admin copies one to make a variant.
router.post('/:id/copy', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const source = (await load(pool, req.user.hospitalId, 'AND id=$2 AND (owner_doctor_id IS NULL OR owner_doctor_id=$3)', [req.params.id, req.user.id]))[0];
  if (!source) throw notFound('Template not found');
  const owner = req.user.role === 'DOCTOR' ? req.user.id : null;
  const base = owner === null || source.scope === 'HOSPITAL' ? `${source.name} (copy)` : `${source.name} (copy)`;
  let name = base; let n = 2;
  for (;;) {
    const taken = await pool.query(`SELECT 1 FROM finding_templates WHERE hospital_id=$1 AND COALESCE(owner_doctor_id,0)=COALESCE($2,0) AND lower(name)=lower($3)`, [req.user.hospitalId, owner, name]);
    if (!taken.rowCount) break;
    name = `${base} ${n++}`;
  }
  const id = await withTransaction(async (client) => {
    const next = await client.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM finding_templates WHERE hospital_id=$1 AND COALESCE(owner_doctor_id,0)=COALESCE($2,0)`, [req.user.hospitalId, owner]);
    const ins = await client.query(
      `INSERT INTO finding_templates(hospital_id,owner_doctor_id,name,group_name,findings,advice,is_active,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$8) RETURNING id`,
      [req.user.hospitalId, owner, name, source.group, source.findings, source.advice, next.rows[0].n, req.user.id]
    );
    await writeMedicines(client, req.user.hospitalId, ins.rows[0].id, source.medicines);
    return ins.rows[0].id;
  });
  res.status(201).json((await load(pool, req.user.hospitalId, 'AND id=$2', [id]))[0]);
}));

// The starter list: added to the hospital's templates, skipping any name it already has. Admin only.
router.post('/starter', allow('ADMIN'), asyncHandler(async (req, res) => {
  const added = await withTransaction(async (client) => {
    let count = 0;
    const next = await client.query(`SELECT COALESCE(MAX(sort_order),0) AS n FROM finding_templates WHERE hospital_id=$1 AND owner_doctor_id IS NULL`, [req.user.hospitalId]);
    let order = Number(next.rows[0].n);
    for (const t of STARTER_FINDINGS) {
      const exists = await client.query(`SELECT 1 FROM finding_templates WHERE hospital_id=$1 AND owner_doctor_id IS NULL AND lower(name)=lower($2)`, [req.user.hospitalId, t.name]);
      if (exists.rowCount) continue;
      order += 1;
      const ins = await client.query(
        `INSERT INTO finding_templates(hospital_id,owner_doctor_id,name,group_name,findings,advice,is_active,sort_order,created_by,updated_by) VALUES($1,NULL,$2,$3,$4,$5,TRUE,$6,$7,$7) RETURNING id`,
        [req.user.hospitalId, t.name, t.group, t.findings, t.advice, order, req.user.id]
      );
      await writeMedicines(client, req.user.hospitalId, ins.rows[0].id, t.medicines.map(x => ({ ...x, medicineId: null, manufacturer: '', packSize: '' })));
      count += 1;
    }
    return count;
  });
  res.json({ added, templates: await load(pool, req.user.hospitalId, 'AND owner_doctor_id IS NULL', []) });
}));

export default router;
