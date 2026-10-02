import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

export async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ message: 'Authentication required' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const id = Number(String(payload.sub).replace(/^super:/, ''));
    if (payload.role === 'SUPER_ADMIN') {
      const q = await pool.query(`SELECT id,name FROM platform_superusers WHERE id=$1 AND is_active=TRUE`, [id]);
      if (!q.rowCount) return res.status(401).json({ message: 'Account is inactive' });
      req.user = { id, hospitalId: null, role: 'SUPER_ADMIN', name: q.rows[0].name };
      return next();
    }
    const q = await pool.query(
      `SELECT u.id,u.hospital_id,u.name,u.role
       FROM users u JOIN hospitals h ON h.id=u.hospital_id
       WHERE u.id=$1 AND u.hospital_id=$2 AND u.is_active=TRUE AND u.deleted_at IS NULL AND h.is_active=TRUE`,
      [id, Number(payload.hospitalId)]
    );
    if (!q.rowCount) return res.status(401).json({ message: 'Account or hospital is inactive' });
    req.user = {
      id,
      hospitalId: Number(q.rows[0].hospital_id),
      role: q.rows[0].role,
      name: q.rows[0].name,
      impersonatedBySuperuserId: payload.impersonatedBySuperuserId ? Number(payload.impersonatedBySuperuserId) : null,
    };
    next();
  } catch (error) {
    if (error?.code) return next(error);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

export function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Not allowed for this role' });
    next();
  };
}
