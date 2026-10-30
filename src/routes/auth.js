import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { loginGuard } from '../loginGuard.js';
import { isLoopback, overLimit } from '../hitLimiter.js';
import { pool, withTransaction } from '../db.js';
import { asyncHandler, badRequest } from '../utils.js';
import { ensureDefaultBillingItems } from '../config/defaultBillingItems.js';
import { mobileSchema } from '../mobile.js';
import { blockedMessage, currentMaintenance } from '../maintenance.js';
import { auth } from '../middleware/auth.js';
import { openSession } from '../supportAccess.js';

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

// Who to contact for help, as set by the platform Super Admin (Payment setup). Public, so the login page can show it.
router.get('/support', asyncHandler(async (_req, res) => {
  const q = await pool.query(`SELECT name,support_phone,support_email FROM platform_billing_company WHERE id=1`);
  const r = q.rows[0] || {};
  res.json({ name: r.name || 'DhaCare', phone: r.support_phone || '', email: r.support_email || '' });
}));

// Anyone can register a hospital, so a script could create thousands. Five an hour from one address, and forty an hour for the whole platform.
const registerGuard = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production' && isLoopback(req.ip)) return next();
  const wait = overLimit(`register:${req.ip}`, 5, 3600e3) || overLimit('register:all', 40, 3600e3);
  if (wait) { console.warn(`Hospital registration blocked for ${wait}s (address ${req.ip})`); res.set('Retry-After', String(wait)); return res.status(429).json({ message: 'Too many registrations from this address. Please try again later, or contact DhaCare.' }); }
  next();
};

router.post('/register-hospital', registerGuard, asyncHandler(async (req, res) => {
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
  role: z.enum(['ADMIN', 'DOCTOR', 'RECEPTIONIST']).optional(), // needed when the same mobile holds more than one role in that hospital
});

const switchRoleSchema = z.object({
  role: z.enum(['ADMIN', 'DOCTOR', 'RECEPTIONIST']).optional(), // the same person's other role
  userId: z.coerce.number().int().positive().optional(),      // or a chosen account (an Admin choosing a Doctor or Receptionist)
  password: z.string().optional(), // not needed in a support session
}).refine(d => d.role || d.userId, { message: 'Choose who to switch to' });

function sessionFor(user, fromAdminId = null) {
  const token = jwt.sign(
    { hospitalId: user.hospital_id, role: user.role, name: user.name, ...(fromAdminId ? { fromAdminId: Number(fromAdminId) } : {}) },
    process.env.JWT_SECRET,
    { subject: String(user.id), expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
  return {
    token,
    user: {
      id: Number(user.id), hospitalId: Number(user.hospital_id), name: user.name,
      mobile: user.mobile, email: user.email, role: user.role, hospitalName: user.hospital_name, speciality: user.speciality || null,
    },
  };
}

router.post('/login', loginGuard, asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const superQ = await pool.query(
    `SELECT id,name,mobile,email,password_hash FROM platform_superusers
     WHERE mobile=$1 AND is_active=TRUE`,
    [data.mobile]
  );
  if (superQ.rowCount === 1) {
    const superuser = superQ.rows[0];
    const ok = await bcrypt.compare(data.password, superuser.password_hash);
    if (!ok) { res.locals.loginFailed = true; throw badRequest('Invalid mobile number or password'); }
    const token = jwt.sign(
      { role: 'SUPER_ADMIN', name: superuser.name },
      process.env.JWT_SECRET,
      { subject: `super:${superuser.id}`, expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );
    await pool.query(`UPDATE platform_superusers SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1`, [superuser.id]);
    await pool.query(`INSERT INTO super_admin_audit_logs(superuser_id,action,metadata) VALUES($1,'LOGIN',$2)`, [superuser.id, JSON.stringify({ mobile: superuser.mobile })]);
    return res.json({ token, user: { id: Number(superuser.id), name: superuser.name, mobile: superuser.mobile, email: superuser.email, role: 'SUPER_ADMIN' } });
  }
  // during planned maintenance only the platform admin can sign in (checked above)
  const maintenance = await currentMaintenance();
  if (maintenance.blocking) return res.status(503).json({ message: blockedMessage(maintenance), maintenance });
  const q = await pool.query(
    `SELECT u.id,u.hospital_id,u.name,u.mobile,u.email,u.password_hash,u.role,u.speciality,h.name AS hospital_name
     FROM users u JOIN hospitals h ON h.id=u.hospital_id
     WHERE u.mobile=$1 AND u.is_active=TRUE AND u.deleted_at IS NULL AND h.is_active=TRUE
     ORDER BY lower(h.name),u.id`,
    [data.mobile]
  );
  const validatedUsers = [];
  for (const user of q.rows) {
    if (await bcrypt.compare(data.password, user.password_hash)) validatedUsers.push(user);
  }
  if (!validatedUsers.length) { res.locals.loginFailed = true; throw badRequest('Invalid mobile number or password'); }
  if (validatedUsers.length === 1) return res.json(sessionFor(validatedUsers[0]));

  const selectionToken = jwt.sign(
    { purpose: 'FIRM_SELECTION', userIds: validatedUsers.map(user => Number(user.id)) },
    process.env.JWT_SECRET,
    { audience: 'firm-selection', expiresIn: '5m' }
  );
  res.json({
    requiresFirmSelection: true,
    selectionToken,
    // one entry per account: the same mobile can hold more than one role in a hospital (a one-doctor clinic: Admin and Doctor)
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
    `SELECT u.id,u.hospital_id,u.name,u.mobile,u.email,u.role,u.speciality,h.name AS hospital_name
     FROM users u JOIN hospitals h ON h.id=u.hospital_id
     WHERE u.id=ANY($1::bigint[]) AND u.hospital_id=$2
       AND ($3::text IS NULL OR u.role=$3)
       AND u.is_active=TRUE AND u.deleted_at IS NULL AND h.is_active=TRUE`,
    [selection.userIds, data.hospitalId, data.role || null]
  );
  if (q.rowCount < 1) throw badRequest('You do not have access to this firm');
  if (q.rowCount > 1) throw badRequest('Choose the role to sign in with');
  res.json(sessionFor(q.rows[0]));
}));

// Moving to another account of this hospital without leaving, always with that account's own password:
//  - the same person's other role (Admin who is also the Doctor: same mobile), and
//  - for an Admin, any Doctor or Receptionist of the hospital, chosen from a list. The session then remembers which Admin it came from (fromAdminId, signed into the
//    token), so the list also offers a way back to that Admin, again with the Admin's password.
// A plain Doctor or Receptionist session never sees anyone else's name.
async function switchTargets(user) {
  const rows = new Map();
  const add = (r) => { if (Number(r.id) !== Number(user.id) && !rows.has(Number(r.id))) rows.set(Number(r.id), r); };
  const cols = `o.id,o.hospital_id,o.name,o.mobile,o.email,o.password_hash,o.role,o.speciality,h.name AS hospital_name`;
  const base = `FROM users o JOIN hospitals h ON h.id=o.hospital_id WHERE o.hospital_id=$1 AND o.is_active=TRUE AND o.deleted_at IS NULL AND h.is_active=TRUE`;
  const mine = await pool.query(`SELECT mobile FROM users WHERE id=$1`, [user.id]);
  (await pool.query(`SELECT ${cols} ${base} AND o.mobile=$2`, [user.hospitalId, mine.rows[0]?.mobile])).rows.forEach(r => add({ ...r, sameMobile: true }));
  // a support session (the hospital gave a support code) can move to anyone in that hospital, as the Super Admin panel's sign-in already could
  if (user.impersonatedBySuperuserId) {
    (await pool.query(`SELECT ${cols} ${base} ORDER BY o.role,lower(o.name)`, [user.hospitalId])).rows.forEach(add);
    return { rows: [...rows.values()], fromAdminId: null };
  }
  let fromAdminId = null;
  if (user.role === 'ADMIN') fromAdminId = Number(user.id);
  else if (user.switchedFromAdminId) {
    const adm = await pool.query(`SELECT ${cols} ${base} AND o.id=$2 AND o.role='ADMIN'`, [user.hospitalId, user.switchedFromAdminId]);
    if (adm.rowCount) { fromAdminId = Number(adm.rows[0].id); add(adm.rows[0]); }
  }
  if (fromAdminId) (await pool.query(`SELECT ${cols} ${base} AND o.role IN ('DOCTOR','RECEPTIONIST') ORDER BY o.role,lower(o.name)`, [user.hospitalId])).rows.forEach(add);
  return { rows: [...rows.values()], fromAdminId };
}

router.get('/my-roles', auth, asyncHandler(async (req, res) => {
  if (!req.user.hospitalId) return res.json({ roles: [], accounts: [] });
  const { rows } = await switchTargets(req.user);
  const ranked = rows.sort((x, y) => ['ADMIN', 'DOCTOR', 'RECEPTIONIST'].indexOf(x.role) - ['ADMIN', 'DOCTOR', 'RECEPTIONIST'].indexOf(y.role) || x.name.localeCompare(y.name));
  res.json({ roles: [...new Set(ranked.map(r => r.role))], accounts: ranked.map(r => ({ id: Number(r.id), name: r.name, role: r.role })) });
}));

// wrong passwords are counted against the signed-in person's mobile, like a sign-in
const withOwnMobile = asyncHandler(async (req, _res, next) => {
  const m = await pool.query(`SELECT mobile FROM users WHERE id=$1`, [req.user.id]);
  req.body = { ...req.body, mobile: m.rows[0]?.mobile };
  next();
});

// Inside a support session the new sign-in stays inside it: same Super Admin, same end time, and it is written to the hospital's support history and the platform audit log.
async function supportSwitch(req, target) {
  const session = await openSession(pool, target.hospital_id);
  if (!session || Number(session.superuser_id) !== Number(req.user.impersonatedBySuperuserId)) throw badRequest('The support session has ended');
  const exp = jwt.decode(req.headers.authorization.split(' ')[1])?.exp;
  const seconds = Math.max(60, Math.floor((exp * 1000 - Date.now()) / 1000));
  const token = jwt.sign({ hospitalId: target.hospital_id, role: target.role, name: target.name, impersonatedBySuperuserId: req.user.impersonatedBySuperuserId }, process.env.JWT_SECRET, { subject: String(target.id), expiresIn: seconds });
  await pool.query(`INSERT INTO support_access_events(support_id,hospital_id,action,target_user_id,target_name,target_role) VALUES($1,$2,'SIGN_IN_AS',$3,$4,$5)`, [session.id, target.hospital_id, target.id, target.name, target.role]);
  await pool.query(`INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,target_user_id,metadata) VALUES($1,$2,$3,$4,$5)`, [req.user.impersonatedBySuperuserId, target.role === 'ADMIN' ? 'IMPERSONATE_ADMIN' : 'IMPERSONATE_USER', target.hospital_id, target.id, JSON.stringify({ role: target.role, name: target.name, mobile: target.mobile, switchedInSession: true })]);
  const su = await pool.query(`SELECT name FROM platform_superusers WHERE id=$1`, [req.user.impersonatedBySuperuserId]);
  return { token, user: { id: Number(target.id), hospitalId: Number(target.hospital_id), name: target.name, mobile: target.mobile, email: target.email, role: target.role, hospitalName: target.hospital_name, speciality: target.speciality || null, impersonatedBy: { superuserId: req.user.impersonatedBySuperuserId, superuserName: su.rows[0]?.name || '' } } };
}

router.post('/switch-role', auth, withOwnMobile, loginGuard, asyncHandler(async (req, res) => {
  const data = switchRoleSchema.parse(req.body);
  if (!req.user.hospitalId) throw badRequest('Switching accounts is not available in this session');
  const { rows, fromAdminId } = await switchTargets(req.user);
  const target = data.userId ? rows.find(r => Number(r.id) === data.userId) : rows.find(r => r.role === data.role && r.sameMobile);
  if (!target) throw badRequest(data.userId ? 'You cannot switch to that account' : 'You do not have that role in this hospital');
  if (req.user.impersonatedBySuperuserId) return res.json(await supportSwitch(req, target));
  if (!data.password) throw badRequest('Enter the password');
  if (!(await bcrypt.compare(data.password, target.password_hash))) { res.locals.loginFailed = true; throw badRequest(`Wrong password for ${target.name} (${target.role.toLowerCase()})`); }
  res.json(sessionFor(target, target.role === 'ADMIN' ? null : fromAdminId));
}));

export default router;
