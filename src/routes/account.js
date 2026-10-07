import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

const router = Router();

router.post('/change-password', asyncHandler(async (req, res) => {
  const data = z.object({
    newPassword: z.string().min(6).max(100),
  }).parse(req.body);

  const userQ = await pool.query(
    `SELECT password_hash FROM users
     WHERE id=$1 AND hospital_id=$2 AND is_active=TRUE AND deleted_at IS NULL`,
    [req.user.id, req.user.hospitalId]
  );
  if (!userQ.rowCount) throw notFound('User not found');
  const samePassword = await bcrypt.compare(data.newPassword, userQ.rows[0].password_hash);
  if (samePassword) throw badRequest('New password must be different from the current password');

  const hash = await bcrypt.hash(data.newPassword, 12);
  await pool.query(
    `UPDATE users SET password_hash=$1,updated_at=NOW()
     WHERE id=$2 AND hospital_id=$3`,
    [hash, req.user.id, req.user.hospitalId]
  );
  res.json({ message: 'Password changed successfully' });
}));

export default router;
