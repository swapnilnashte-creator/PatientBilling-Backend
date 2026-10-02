import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

const router = Router();
router.use(allow('SUPER_ADMIN'));

router.get('/hospitals', asyncHandler(async (_req, res) => {
  const q = await pool.query(
    `SELECT h.id,h.name,h.mobile,h.address,h.is_active,h.created_at,h.updated_at,h.deactivated_at,
            admin_user.id AS admin_id,admin_user.name AS admin_name,admin_user.email AS admin_email,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.deleted_at IS NULL) AS users,
            (SELECT COUNT(*)::int FROM users u WHERE u.hospital_id=h.id AND u.role='DOCTOR' AND u.is_active=TRUE AND u.deleted_at IS NULL) AS doctors,
            (SELECT COUNT(*)::int FROM patients p WHERE p.hospital_id=h.id AND p.deleted_at IS NULL) AS patients,
            (SELECT COUNT(*)::int FROM visits v WHERE v.hospital_id=h.id) AS visits,
            (SELECT COALESCE(SUM(p.amount),0)::numeric(14,2) FROM payments p WHERE p.hospital_id=h.id) AS revenue,
            (SELECT MAX(v.created_at) FROM visits v WHERE v.hospital_id=h.id) AS last_visit_at
     FROM hospitals h
     LEFT JOIN LATERAL (
       SELECT u.id,u.name,u.email FROM users u
       WHERE u.hospital_id=h.id AND u.role='ADMIN' AND u.is_active=TRUE AND u.deleted_at IS NULL
       ORDER BY u.id LIMIT 1
     ) admin_user ON TRUE
     ORDER BY h.created_at DESC,h.id DESC`
  );
  res.json(q.rows);
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

router.post('/hospitals/:id/login-as-admin', asyncHandler(async (req, res) => {
  const hospitalQ = await pool.query(
    `SELECT id,name FROM hospitals WHERE id=$1 AND is_active=TRUE`,
    [req.params.id]
  );
  if (!hospitalQ.rowCount) throw badRequest('Hospital is inactive or does not exist');
  const adminQ = await pool.query(
    `SELECT id,hospital_id,name,email,role FROM users
     WHERE hospital_id=$1 AND role='ADMIN' AND is_active=TRUE AND deleted_at IS NULL
     ORDER BY id LIMIT 1`,
    [req.params.id]
  );
  if (!adminQ.rowCount) throw badRequest('Hospital has no active Admin account');
  const hospital = hospitalQ.rows[0];
  const admin = adminQ.rows[0];
  const token = jwt.sign(
    { hospitalId: admin.hospital_id, role: 'ADMIN', name: admin.name, impersonatedBySuperuserId: req.user.id },
    process.env.JWT_SECRET,
    { subject: String(admin.id), expiresIn: '2h' }
  );
  await pool.query(
    `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,target_user_id,metadata)
     VALUES($1,'IMPERSONATE_ADMIN',$2,$3,$4)`,
    [req.user.id, hospital.id, admin.id, JSON.stringify({ adminEmail: admin.email })]
  );
  res.json({
    token,
    user: {
      id: Number(admin.id), hospitalId: Number(admin.hospital_id), name: admin.name,
      email: admin.email, role: 'ADMIN', hospitalName: hospital.name,
      impersonatedBy: { superuserId: req.user.id, superuserName: req.user.name },
    },
  });
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
