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
import { exportHospital, purgeHospital } from '../hospitalPurge.js';
import { networkReport } from '../proxyCheck.js';
import { describe, invalidateMaintenance, maintenanceRow } from '../maintenance.js';
import { MAX_ATTEMPTS, closeStale, hashCode, openSession, sameHash } from '../supportAccess.js';

const router = Router();
router.use(allow('SUPER_ADMIN'));
router.use('/billing', billingRoutes);

// Does the server see each visitor's own address? (the booking and sign-in limits depend on it)
router.get('/network-check', (req, res) => { res.json(networkReport(req, req.app)); });

router.get('/hospitals', asyncHandler(async (_req, res) => {
  const q = await pool.query(
    `SELECT h.id,h.name,h.mobile,h.address,h.is_active,h.created_at,h.updated_at,h.deactivated_at,
            admin_user.id AS admin_id,admin_user.name AS admin_name,admin_user.mobile AS admin_mobile,admin_user.email AS admin_email,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.deleted_at IS NULL) AS users,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL) AS doctors,
            (SELECT COUNT(*)::int FROM patients p WHERE p.hospital_id=h.id AND p.deleted_at IS NULL) AS patients,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=h.id) AS visits,
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

// Backup file of everything one hospital owns (offered before a delete)
router.get('/hospitals/:id/export', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const client = await pool.connect();
  try {
    const data = await exportHospital(client, id);
    if (!data) throw notFound('Hospital not found');
    res.json(data);
  } finally { client.release(); }
}));

// Permanent delete of a hospital and all its data. Only a deactivated hospital with no open platform invoice, and only
// when the hospital's exact name is typed.
router.delete('/hospitals/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = z.object({ confirmName: z.string(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
  const result = await withTransaction(async (client) => {
    const h = (await client.query('SELECT id,name,is_active FROM hospitals WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!h) throw notFound('Hospital not found');
    if (h.is_active) throw badRequest('Deactivate the hospital first. Only a deactivated hospital can be deleted.');
    if (data.confirmName.trim() !== h.name) throw badRequest('The name typed does not match the hospital name.');
    const open = await client.query(`SELECT COUNT(*)::int AS n FROM platform_invoices WHERE hospital_id=$1 AND status IN ('DRAFT','ISSUED')`, [id]);
    if (open.rows[0].n) throw badRequest(`This hospital has ${open.rows[0].n} open invoice(s). Cancel or settle them first.`);
    return purgeHospital(client, id, { superuserId: req.user.id, reason: data.reason });
  });
  res.json({ deleted: true, name: result.name });
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
  // The hospital must have given a code first (Hospital Settings > Support access). Without an open session nobody signs in to a hospital.
  const session = await openSession(pool, hospital.id);
  if (!session || Number(session.superuser_id) !== Number(req.user.id)) {
    throw Object.assign(new Error('The hospital has not given support access. Ask its Admin to create a support code in Hospital Settings, then enter it here.'), { status: 403, needCode: true });
  }
  const seconds = Math.max(60, Math.min(2 * 3600, Math.floor((new Date(session.session_ends_at) - Date.now()) / 1000)));
  const token = jwt.sign(
    { hospitalId: target.hospital_id, role: target.role, name: target.name, impersonatedBySuperuserId: req.user.id },
    process.env.JWT_SECRET,
    { subject: String(target.id), expiresIn: seconds }
  );
  await pool.query(
    `INSERT INTO support_access_events(support_id,hospital_id,action,target_user_id,target_name,target_role) VALUES($1,$2,'SIGN_IN_AS',$3,$4,$5)`,
    [session.id, hospital.id, target.id, target.name, target.role]
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

// Type in the code the hospital's Admin read out. Right: a support session opens for the time the hospital chose. Wrong: a try is used up; after 5 the code is cancelled.
router.post('/hospitals/:id/support/verify', asyncHandler(async (req, res) => {
  const hospitalId = z.coerce.number().int().positive().parse(req.params.id);
  const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits') }).parse(req.body);
  const outcome = await withTransaction(async (client) => {
    await closeStale(client, hospitalId);
    const q = await client.query(`SELECT id,code_hash,attempts,session_minutes FROM support_access WHERE hospital_id=$1 AND status='CODE' FOR UPDATE`, [hospitalId]);
    if (!q.rowCount) return { none: true };
    const row = q.rows[0];
    if (!sameHash(hashCode(code, hospitalId), row.code_hash)) {
      const attempts = row.attempts + 1;
      const locked = attempts >= MAX_ATTEMPTS;
      await client.query(
        `UPDATE support_access SET attempts=$2,status=CASE WHEN $3::boolean THEN 'CANCELLED' ELSE status END,ended_at=CASE WHEN $3::boolean THEN NOW() END,ended_reason=CASE WHEN $3::boolean THEN 'TOO_MANY_TRIES' END WHERE id=$1`,
        [row.id, attempts, locked]);
      await client.query(`INSERT INTO support_access_events(support_id,hospital_id,action) VALUES($1,$2,'CODE_WRONG')`, [row.id, hospitalId]);
      return { wrong: true, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), locked };
    }
    const done = await client.query(
      `UPDATE support_access SET status='SESSION',superuser_id=$2,session_started_at=NOW(),session_ends_at=NOW()+make_interval(mins=>session_minutes) WHERE id=$1 RETURNING session_ends_at`,
      [row.id, req.user.id]);
    await client.query(`INSERT INTO support_access_events(support_id,hospital_id,action) VALUES($1,$2,'CODE_OK')`, [row.id, hospitalId]);
    return { ok: true, endsAt: done.rows[0].session_ends_at };
  });
  if (outcome.none) throw Object.assign(new Error('This hospital has no valid support code. Ask its Admin to create one in Hospital Settings > Support access.'), { status: 400, needCode: true });
  if (outcome.wrong) throw Object.assign(new Error(outcome.locked ? 'That code is not correct and the code is now cancelled. Ask the hospital Admin for a new one.' : `That code is not correct. ${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? 'try' : 'tries'} left.`), { status: 400, attemptsLeft: outcome.attemptsLeft });
  res.json({ endsAt: outcome.endsAt });
}));

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

// ---- Planned maintenance: a notice before it starts, the maintenance page while it runs (see maintenance.js) ----
const maintenanceState = async () => {
  const row = await maintenanceRow();
  const m = describe(row);
  return { ...m, blockAccess: row ? row.block_access : true, updatedAt: row?.updated_at || null, updatedBy: row?.updated_by_name || null };
};
const maintenanceSchema = z.object({
  startNow: z.boolean().default(false),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }),
  message: z.string().trim().max(400).default(''),
  blockAccess: z.boolean().default(true),
});
router.get('/maintenance', asyncHandler(async (_req, res) => { res.json(await maintenanceState()); }));
router.put('/maintenance', asyncHandler(async (req, res) => {
  const body = maintenanceSchema.parse(req.body);
  const now = new Date();
  const starts = body.startNow ? now : (body.startsAt ? new Date(body.startsAt) : null);
  if (!starts) throw badRequest('Choose when the maintenance starts, or use Start now');
  const ends = new Date(body.endsAt);
  if (!body.startNow && starts.getTime() < now.getTime() - 2 * 60 * 1000) throw badRequest('The start time has already passed. Choose a later time, or use Start now');
  if (starts.getTime() > now.getTime() + 60 * 24 * 3600e3) throw badRequest('The start time is more than 60 days away');
  if (ends <= now) throw badRequest('The end time must be in the future');
  if (ends <= starts) throw badRequest('The end time must be after the start time');
  if (ends.getTime() - starts.getTime() > 72 * 3600e3) throw badRequest('Maintenance can last at most 72 hours');
  await pool.query(
    `UPDATE platform_maintenance SET starts_at=$1,ends_at=$2,message=$3,block_access=$4,updated_by=$5,updated_at=NOW() WHERE id=1`,
    [starts, ends, body.message, body.blockAccess, req.user.id]
  );
  invalidateMaintenance();
  res.json(await maintenanceState());
}));
// cancel a planned maintenance, or end one that is running
router.delete('/maintenance', asyncHandler(async (req, res) => {
  await pool.query(`UPDATE platform_maintenance SET starts_at=NULL,ends_at=NULL,message='',updated_by=$1,updated_at=NOW() WHERE id=1`, [req.user.id]);
  invalidateMaintenance();
  res.json(await maintenanceState());
}));

export default router;
