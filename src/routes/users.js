import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

const router = Router();
router.use(allow('ADMIN'));

router.get('/', asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT id,name,mobile,email,role,is_active,created_at
     FROM users WHERE hospital_id=$1 AND deleted_at IS NULL ORDER BY role,name`,
    [req.user.hospitalId]
  );
  res.json(q.rows);
}));

const userSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: z.string().max(20).optional().default(''),
  email: z.string().email().max(180),
  password: z.string().min(6).max(100),
  role: z.enum(['ADMIN','DOCTOR','RECEPTIONIST']),
});

router.post('/', asyncHandler(async (req, res) => {
  const data = userSchema.parse(req.body);
  const reservedEmail = await pool.query(
    `SELECT id FROM platform_superusers WHERE lower(email)=lower($1)`,
    [data.email]
  );
  if (reservedEmail.rowCount) throw badRequest('This email is reserved for a platform account');
  const hash = await bcrypt.hash(data.password, 12);
  const q = await pool.query(
    `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING id,name,mobile,email,role,is_active,created_at`,
    [req.user.hospitalId, data.name, data.mobile || null, data.email.toLowerCase(), hash, data.role]
  );
  res.status(201).json(q.rows[0]);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const active = z.object({ isActive: z.boolean() }).parse(req.body).isActive;
  const result = await withTransaction(async (client) => {
    const targetQ = await client.query(
      `SELECT id,role,is_active FROM users
       WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.user.hospitalId]
    );
    if (!targetQ.rowCount) throw notFound('User not found');
    const target = targetQ.rows[0];
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
    return q.rows[0];
  });
  res.json(result);
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

export default router;
