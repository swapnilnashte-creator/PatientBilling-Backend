import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const q = await pool.query(`SELECT id,name,mobile,address FROM hospitals WHERE id=$1`, [req.user.hospitalId]);
  if (!q.rowCount) throw notFound('Hospital not found');
  res.json(q.rows[0]);
}));

router.put('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2).max(160),
    mobile: z.string().max(20).optional().default(''),
    address: z.string().max(1000).optional().default(''),
  }).parse(req.body);
  const q = await pool.query(
    `UPDATE hospitals SET name=$1,mobile=$2,address=$3,updated_at=NOW() WHERE id=$4 RETURNING id,name,mobile,address`,
    [data.name, data.mobile || null, data.address || null, req.user.hospitalId]
  );
  res.json(q.rows[0]);
}));

export default router;
