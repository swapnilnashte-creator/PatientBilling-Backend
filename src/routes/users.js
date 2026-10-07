import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { mobileSchema } from '../mobile.js';
import { autoTopUp, deactivationImpact, doctorImpact } from '../billing/doctors.js';

const router = Router();
router.use(allow('ADMIN'));

router.get('/', asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT id,name,mobile,email,role,is_active,created_at,qualification,registration_no
     FROM users WHERE hospital_id=$1 AND deleted_at IS NULL ORDER BY role,name`,
    [req.user.hospitalId]
  );
  res.json(q.rows);
}));

async function assertMobileNotReserved(mobile) {
  const reserved = await pool.query(`SELECT id FROM platform_superusers WHERE mobile=$1`, [mobile]);
  if (reserved.rowCount) throw badRequest('This mobile number is reserved for a platform account');
}

const userSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: mobileSchema,
  email: z.string().trim().max(180).optional().default('').transform(value => value.toLowerCase()).pipe(z.union([z.literal(''), z.string().email()])),
  password: z.string().min(6).max(100),
  role: z.enum(['ADMIN','DOCTOR','RECEPTIONIST']),
  qualification: z.string().trim().max(160).optional().default(''),
  registrationNo: z.string().trim().max(40).optional().default(''),
  acknowledgeBilling: z.boolean().optional().default(false),
});

// Adding (or re-activating) a doctor can raise the clinic's bill. The Admin must confirm it first.
const billingConfirmation = async (hospitalId, candidateId = null) => {
  const impact = await doctorImpact(pool, hospitalId, { candidateId });
  return impact.requiresConfirm ? impact : null;
};
const needsConfirm = (res, impact) => res.status(409).json({ code: 'BILLING_CONFIRM_REQUIRED', message: 'This change affects your CareBill charges. Please confirm.', impact });

router.get('/doctor-impact', asyncHandler(async (req, res) => {
  const candidateId = req.query.candidateId ? z.coerce.number().int().positive().parse(req.query.candidateId) : null;
  const removeId = req.query.removeId ? z.coerce.number().int().positive().parse(req.query.removeId) : null;
  res.json(removeId ? await deactivationImpact(pool, req.user.hospitalId, removeId) : await doctorImpact(pool, req.user.hospitalId, { candidateId }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = userSchema.parse(req.body);
  await assertMobileNotReserved(data.mobile);
  if (data.role === 'DOCTOR' && !data.acknowledgeBilling) {
    const impact = await billingConfirmation(req.user.hospitalId);
    if (impact) return needsConfirm(res, impact);
  }
  const hash = await bcrypt.hash(data.password, 12);
  const created = await withTransaction(async (client) => {
    const q = await client.query(
      `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role,qualification,registration_no)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,name,mobile,email,role,is_active,created_at,qualification,registration_no`,
      [req.user.hospitalId, data.name, data.mobile, data.email || null, hash, data.role, data.role === 'DOCTOR' ? (data.qualification || null) : null, data.role === 'DOCTOR' ? (data.registrationNo || null) : null]
    );
    if (data.role === 'DOCTOR') {
      // a new doctor joins the letterhead automatically while there is room (Settings can change it)
      await client.query(`UPDATE users SET on_letterhead=((SELECT COUNT(*) FROM users WHERE hospital_id=$1 AND role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL AND on_letterhead=TRUE AND id<>$2) < 6),
         letterhead_order=COALESCE((SELECT MAX(letterhead_order) FROM users WHERE hospital_id=$1),0)+1 WHERE id=$2`, [req.user.hospitalId, q.rows[0].id]);
    }
    const topUp = data.role === 'DOCTOR' ? await autoTopUp(client, req.user.hospitalId) : null;
    return { ...q.rows[0], topUp: topUp && { invoiceNo: topUp.invoiceNo, total: topUp.total, doctors: topUp.doctors } };
  });
  res.status(201).json(created);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { isActive: active, acknowledgeBilling } = z.object({ isActive: z.boolean(), acknowledgeBilling: z.boolean().optional().default(false) }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const targetQ = await client.query(
      `SELECT id,role,is_active FROM users
       WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.user.hospitalId]
    );
    if (!targetQ.rowCount) throw notFound('User not found');
    const target = targetQ.rows[0];
    const reactivatingDoctor = active && target.role === 'DOCTOR' && !target.is_active;
    if (!active && target.role === 'DOCTOR' && target.is_active && !acknowledgeBilling) {
      const impact = await deactivationImpact(client, req.user.hospitalId, target.id);
      if (impact.requiresConfirm) return { confirm: impact };
    }
    if (reactivatingDoctor && !acknowledgeBilling) {
      const impact = await billingConfirmation(req.user.hospitalId, target.id);
      if (impact) return { confirm: impact };
    }
    if (!active && target.role === 'ADMIN' && target.is_active) {
      const adminsQ = await client.query(
        `SELECT id FROM users
         WHERE hospital_id=$1 AND role='ADMIN' AND is_active=TRUE AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
        [req.user.hospitalId]
      );
      if (adminsQ.rowCount <= 1) throw badRequest('The last active admin cannot be deactivated');
    }
    const q = await client.query(
      `UPDATE users SET is_active=$1,updated_at=NOW()
       WHERE id=$2 AND hospital_id=$3 AND deleted_at IS NULL
       RETURNING id,name,email,role,is_active`,
      [active, req.params.id, req.user.hospitalId]
    );
    const topUp = reactivatingDoctor ? await autoTopUp(client, req.user.hospitalId) : null;
    return { ...q.rows[0], topUp: topUp && { invoiceNo: topUp.invoiceNo, total: topUp.total, doctors: topUp.doctors } };
  });
  if (result.confirm) return needsConfirm(res, result.confirm);
  res.json(result);
}));

router.patch('/:id/profile', asyncHandler(async (req, res) => {
  const { qualification, registrationNo } = z.object({ qualification: z.string().trim().max(160), registrationNo: z.string().trim().max(40).optional().default('') }).parse(req.body);
  const q = await pool.query(
    `UPDATE users SET qualification=$1,registration_no=$2,updated_at=NOW() WHERE id=$3 AND hospital_id=$4 AND role='DOCTOR' AND deleted_at IS NULL RETURNING id,name,qualification,registration_no`,
    [qualification || null, registrationNo || null, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('Doctor not found');
  res.json(q.rows[0]);
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  const { password } = z.object({ password: z.string().min(6).max(100) }).parse(req.body);
  const hash = await bcrypt.hash(password, 12);
  const q = await pool.query(
    `UPDATE users SET password_hash=$1,updated_at=NOW()
     WHERE id=$2 AND hospital_id=$3 AND deleted_at IS NULL RETURNING id`,
    [hash, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('User not found');
  res.json({ message: 'Password updated' });
}));

router.patch('/:id/mobile', asyncHandler(async (req, res) => {
  const mobile = z.object({ mobile: mobileSchema }).parse(req.body).mobile;
  await assertMobileNotReserved(mobile);
  const q = await pool.query(
    `UPDATE users SET mobile=$1,updated_at=NOW()
     WHERE id=$2 AND hospital_id=$3 AND deleted_at IS NULL
     RETURNING id,name,mobile,email,role,is_active`,
    [mobile, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('User not found');
  res.json(q.rows[0]);
}));

export default router;
