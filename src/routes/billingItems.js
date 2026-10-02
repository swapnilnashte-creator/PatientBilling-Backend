import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, money, notFound } from '../utils.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const onlyActive = req.query.all !== '1';
  const q = await pool.query(
    `SELECT id,name,default_price,is_active,created_at
     FROM billing_items
     WHERE hospital_id=$1 AND deleted_at IS NULL ${onlyActive ? 'AND is_active=TRUE' : ''}
     ORDER BY name`,
    [req.user.hospitalId]
  );
  res.json(q.rows);
}));

router.post('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(1).max(140),
    defaultPrice: z.coerce.number().min(0),
  }).parse(req.body);
  const q = await pool.query(
    `INSERT INTO billing_items(hospital_id,name,default_price,created_by,updated_by)
     VALUES($1,$2,$3,$4,$4)
     RETURNING id,name,default_price,is_active`,
    [req.user.hospitalId, data.name, money(data.defaultPrice), req.user.id]
  );
  res.status(201).json(q.rows[0]);
}));

router.put('/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(1).max(140),
    defaultPrice: z.coerce.number().min(0),
    isActive: z.boolean(),
  }).parse(req.body);
  const q = await pool.query(
    `UPDATE billing_items SET name=$1,default_price=$2,is_active=$3,updated_by=$4,updated_at=NOW()
     WHERE id=$5 AND hospital_id=$6 AND deleted_at IS NULL
     RETURNING id,name,default_price,is_active`,
    [data.name, money(data.defaultPrice), data.isActive, req.user.id, req.params.id, req.user.hospitalId]
  );
  if (!q.rowCount) throw notFound('Billing item not found');
  res.json(q.rows[0]);
}));

export default router;
