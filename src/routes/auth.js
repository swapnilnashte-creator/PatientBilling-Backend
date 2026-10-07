import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { asyncHandler, badRequest } from '../utils.js';
import { ensureDefaultBillingItems } from '../config/defaultBillingItems.js';
import { mobileSchema } from '../mobile.js';

const router = Router();

const registerSchema = z.object({
  hospitalName: z.string().min(2).max(160),
  hospitalMobile: z.union([z.literal(''), mobileSchema]).optional().default(''),
  hospitalAddress: z.string().max(500).optional().default(''),
  adminName: z.string().min(2).max(120),
  adminEmail: z.string().email().max(180),
  adminMobile: mobileSchema,
  password: z.string().min(6).max(100),
});

router.post('/register-hospital', asyncHandler(async (req, res) => {
  const data = registerSchema.parse(req.body);
  const reservedMobile = await pool.query(`SELECT id FROM platform_superusers WHERE mobile=$1`, [data.adminMobile]);
  if (reservedMobile.rowCount) throw badRequest('This mobile number is reserved for a platform account');
  const hash = await bcrypt.hash(data.password, 12);

  const result = await withTransaction(async (client) => {
    const h = await client.query(
      `INSERT INTO hospitals(name,mobile,address) VALUES($1,$2,$3) RETURNING id,name`,
      [data.hospitalName, data.hospitalMobile || null, data.hospitalAddress || null]
    );
    const hospitalId = h.rows[0].id;
    const u = await client.query(
      `INSERT INTO users(hospital_id,name,mobile,email,password_hash,role)
       VALUES($1,$2,$3,$4,$5,'ADMIN') RETURNING id,name,mobile,email,role`,
      [hospitalId, data.adminName, data.adminMobile, data.adminEmail.toLowerCase(), hash]
    );
    await ensureDefaultBillingItems(client, hospitalId, u.rows[0].id);
    return { hospital: h.rows[0], user: u.rows[0] };
  });
  res.status(201).json(result);
}));

const loginSchema = z.object({
  mobile: mobileSchema,
  password: z.string().min(1),
});

const firmSelectionSchema = z.object({
  selectionToken: z.string().min(1),
  hospitalId: z.coerce.number().int().positive(),
});

function sessionFor(user) {
  const token = jwt.sign(
    { hospitalId: user.hospital_id, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { subject: String(user.id), expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
  return {
    token,
    user: {
      id: Number(user.id), hospitalId: Number(user.hospital_id), name: user.name,
      mobile: user.mobile, email: user.email, role: user.role, hospitalName: user.hospital_name,
    },
  };
}

router.post('/login', asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const superQ = await pool.query(
    `SELECT id,name,mobile,email,password_hash FROM platform_superusers
     WHERE mobile=$1 AND is_active=TRUE`,
    [data.mobile]
  );
  if (superQ.rowCount === 1) {
    const superuser = superQ.rows[0];
    const ok = await bcrypt.compare(data.password, superuser.password_hash);
    if (!ok) throw badRequest('Invalid mobile number or password');
    const token = jwt.sign(
      { role: 'SUPER_ADMIN', name: superuser.name },
      process.env.JWT_SECRET,
      { subject: `super:${superuser.id}`, expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );
    await pool.query(`UPDATE platform_superusers SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1`, [superuser.id]);
    await pool.query(`INSERT INTO super_admin_audit_logs(superuser_id,action,metadata) VALUES($1,'LOGIN',$2)`, [superuser.id, JSON.stringify({ mobile: superuser.mobile })]);
    return res.json({ token, user: { id: Number(superuser.id), name: superuser.name, mobile: superuser.mobile, email: superuser.email, role: 'SUPER_ADMIN' } });
  }
  const q = await pool.query(
    `SELECT u.id,u.hospital_id,u.name,u.mobile,u.email,u.password_hash,u.role,h.name AS hospital_name
     FROM users u JOIN hospitals h ON h.id=u.hospital_id
     WHERE u.mobile=$1 AND u.is_active=TRUE AND u.deleted_at IS NULL AND h.is_active=TRUE
     ORDER BY lower(h.name),u.id`,
    [data.mobile]
  );
  const validatedUsers = [];
  for (const user of q.rows) {
    if (await bcrypt.compare(data.password, user.password_hash)) validatedUsers.push(user);
  }
  if (!validatedUsers.length) throw badRequest('Invalid mobile number or password');
  if (validatedUsers.length === 1) return res.json(sessionFor(validatedUsers[0]));

  const selectionToken = jwt.sign(
    { purpose: 'FIRM_SELECTION', userIds: validatedUsers.map(user => Number(user.id)) },
    process.env.JWT_SECRET,
    { audience: 'firm-selection', expiresIn: '5m' }
  );
  res.json({
    requiresFirmSelection: true,
    selectionToken,
    firms: validatedUsers.map(user => ({ hospitalId: Number(user.hospital_id), hospitalName: user.hospital_name, role: user.role })),
  });
}));

router.post('/select-firm', asyncHandler(async (req, res) => {
  const data = firmSelectionSchema.parse(req.body);
  let selection;
  try { selection = jwt.verify(data.selectionToken, process.env.JWT_SECRET, { audience: 'firm-selection' }); }
  catch { throw badRequest('Firm selection expired. Please log in again.'); }
  if (selection.purpose !== 'FIRM_SELECTION' || !Array.isArray(selection.userIds)) throw badRequest('Invalid firm selection');
  const q = await pool.query(
    `SELECT u.id,u.hospital_id,u.name,u.mobile,u.email,u.role,h.name AS hospital_name
     FROM users u JOIN hospitals h ON h.id=u.hospital_id
     WHERE u.id=ANY($1::bigint[]) AND u.hospital_id=$2
       AND u.is_active=TRUE AND u.deleted_at IS NULL AND h.is_active=TRUE`,
    [selection.userIds, data.hospitalId]
  );
  if (q.rowCount !== 1) throw badRequest('You do not have access to this firm');
  res.json(sessionFor(q.rows[0]));
}));

export default router;
