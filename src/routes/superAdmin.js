import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import bcrypt from 'bcryptjs';
import { ensureDefaultBillingItems } from '../config/defaultBillingItems.js';
import { mobileSchema } from '../mobile.js';
import { addDays, todayString } from '../billing/pricing.js';
import billingRoutes from './superAdminBilling.js';

const router = Router();
router.use(allow('SUPER_ADMIN'));
router.use('/billing', billingRoutes);

router.get('/hospitals', asyncHandler(async (_req, res) => {
  const q = await pool.query(
    `SELECT h.id,h.name,h.mobile,h.address,h.is_active,h.created_at,h.updated_at,h.deactivated_at,
            admin_user.id AS admin_id,admin_user.name AS admin_name,admin_user.mobile AS admin_mobile,admin_user.email AS admin_email,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.deleted_at IS NULL) AS users,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL) AS doctors,
            (SELECT COUNT(*)::int FROM patients p WHERE p.hospital_id=h.id AND p.deleted_at IS NULL) AS patients,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=h.id) AS visits,
            (SELECT COALESCE(SUM(p.amount),0)::numeric(14,2) FROM payments p WHERE p.hospital_id=h.id) AS revenue,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=h.id) AS last_visit_at
     FROM hospitals h
     LEFT JOIN LATERAL (
       SELECT u.id,u.name,u.mobile,u.email FROM users u
       WHERE u.hospital_id=h.id AND u.role='ADMIN' AND u.is_active=TRUE AND u.deleted_at IS NULL
       ORDER BY u.id LIMIT 1
     ) admin_user ON TRUE
     ORDER BY h.created_at DESC,h.id DESC`
  );
  res.json(q.rows);
}));

// Create a hospital together with its first Admin. The Super Admin hands the Admin the temporary password.
const createHospitalSchema = z.object({
  hospitalName: z.string().trim().min(2).max(160),
  hospitalMobile: z.union([z.literal(''), mobileSchema]).optional().default(''),
  hospitalAddress: z.string().trim().max(500).optional().default(''),
  adminName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email().max(180),
  adminMobile: mobileSchema,
  password: z.string().min(6).max(100),
  billingStartDate: z.string().date().optional(),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('ANNUAL'),
});
router.post('/hospitals', asyncHandler(async (req, res) => {
  const data = createHospitalSchema.parse(req.body);
  const today = todayString();
  const start = data.billingStartDate || today;
  if (start < '2020-01-01' || start > addDays(today, 90)) throw badRequest('Choose a billing start date between 2020 and the next 3 months');
  if ((await pool.query(`SELECT 1 FROM platform_superusers WHERE mobile=$1`, [data.adminMobile])).rowCount) throw badRequest('This mobile number is reserved for a platform account');
  const sharedMobile = (await pool.query(`SELECT 1 FROM users WHERE mobile=$1 AND deleted_at IS NULL LIMIT 1`, [data.adminMobile])).rowCount > 0; // one person can run several firms; they pick the firm at login
  const hash = await bcrypt.hash(data.password, 12);
  const result = await withTransaction(async (client) => {
    const h = await client.query(
      `INSERT INTO hospitals(name,mobile,address,billing_start_date,billing_cycle) VALUES($1,$2,$3,$4,$5) RETURNING id,name`,
      [data.hospitalName, data.hospitalMobile || null, data.hospitalAddress || null, start, data.billingCycle]
    );
    const u = await client.query(
      `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'ADMIN') RETURNING id,name,mobile,email`,
      [h.rows[0].id, data.adminName, data.adminMobile, data.adminEmail.toLowerCase(), hash]
    );
    await ensureDefaultBillingItems(client, h.rows[0].id, u.rows[0].id);
    await client.query(
      `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,metadata) VALUES($1,'HOSPITAL_CREATED',$2,$3)`,
      [req.user.id, h.rows[0].id, JSON.stringify({ admin: data.adminName, adminMobile: data.adminMobile, billingStartDate: start, billingCycle: data.billingCycle })]
    );
    return { hospital: h.rows[0], admin: u.rows[0], billingStartDate: start, billingCycle: data.billingCycle, sharedMobile };
  });
  res.status(201).json(result);
}));

router.patch('/hospitals/:id/status', asyncHandler(async (req, res) => {
  const data = z.object({
    isActive: z.boolean(),
    reason: z.string().trim().min(5).max(500),
  }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const q = await client.query(
      `UPDATE hospitals
       SET is_active=$1,updated_at=NOW(),
           deactivated_at=CASE WHEN $1 THEN NULL ELSE NOW() END,
           deactivated_by_superuser=CASE WHEN $1 THEN NULL ELSE $2::bigint END
       WHERE id=$3
       RETURNING id,name,is_active,deactivated_at`,
      [data.isActive, req.user.id, req.params.id]
    );
    if (!q.rowCount) throw notFound('Hospital not found');
    await client.query(
      `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,metadata)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, data.isActive ? 'ACTIVATE_HOSPITAL' : 'DEACTIVATE_HOSPITAL', req.params.id, JSON.stringify({ reason: data.reason })]
    );
    return q.rows[0];
  });
  res.json(result);
}));

async function startImpersonation(req, res, hospitalId, userId) {
  const hospitalQ = await pool.query(
    `SELECT id,name FROM hospitals WHERE id=$1 AND is_active=TRUE`,
    [hospitalId]
  );
  if (!hospitalQ.rowCount) throw badRequest('Hospital is inactive or does not exist');
  const targetQ = userId
    ? await pool.query(
      `SELECT id,hospital_id,name,mobile,email,role FROM users
       WHERE id=$1 AND hospital_id=$2 AND is_active=TRUE AND deleted_at IS NULL`,
      [userId, hospitalId]
    )
    : await pool.query(
      `SELECT id,hospital_id,name,mobile,email,role FROM users
       WHERE hospital_id=$1 AND role='ADMIN' AND is_active=TRUE AND deleted_at IS NULL
       ORDER BY id LIMIT 1`,
      [hospitalId]
    );
  if (!targetQ.rowCount) throw badRequest(userId ? 'User is inactive or does not belong to this hospital' : 'Hospital has no active Admin account');
  const hospital = hospitalQ.rows[0];
  const target = targetQ.rows[0];
  const token = jwt.sign(
    { hospitalId: target.hospital_id, role: target.role, name: target.name, impersonatedBySuperuserId: req.user.id },
    process.env.JWT_SECRET,
    { subject: String(target.id), expiresIn: '2h' }
  );
  await pool.query(
    `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,target_user_id,metadata)
     VALUES($1,$2,$3,$4,$5)`,
    [req.user.id, target.role === 'ADMIN' ? 'IMPERSONATE_ADMIN' : 'IMPERSONATE_USER', hospital.id, target.id, JSON.stringify({ role: target.role, name: target.name, mobile: target.mobile })]
  );
  res.json({
    token,
    user: {
      id: Number(target.id), hospitalId: Number(target.hospital_id), name: target.name,
      mobile: target.mobile, email: target.email, role: target.role, hospitalName: hospital.name,
      impersonatedBy: { superuserId: req.user.id, superuserName: req.user.name },
    },
  });
}

router.get('/hospitals/:id/users', asyncHandler(async (req, res) => {
  const hospitalId = z.coerce.number().int().positive().parse(req.params.id);
  const q = await pool.query(
    `SELECT id,name,mobile,email,role,is_active FROM users
     WHERE hospital_id=$1 AND deleted_at IS NULL
     ORDER BY CASE role WHEN 'ADMIN' THEN 1 WHEN 'DOCTOR' THEN 2 ELSE 3 END,name`,
    [hospitalId]
  );
  res.json(q.rows);
}));

router.post('/hospitals/:id/login-as-admin', asyncHandler(async (req, res) => {
  await startImpersonation(req, res, req.params.id, null);
}));

router.post('/hospitals/:id/login-as/:userId', asyncHandler(async (req, res) => {
  const ids = z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() }).parse(req.params);
  await startImpersonation(req, res, ids.id, ids.userId);
}));

router.get('/audit', asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT l.id,l.action,l.hospital_id,h.name AS hospital_name,l.target_user_id,u.name AS target_user_name,l.metadata,l.created_at
     FROM super_admin_audit_logs l
     LEFT JOIN hospitals h ON h.id=l.hospital_id
     LEFT JOIN users u ON u.id=l.target_user_id
     WHERE l.superuser_id=$1 ORDER BY l.created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json(q.rows);
}));

export default router;
