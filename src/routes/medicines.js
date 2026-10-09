import { Router } from 'express';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler } from '../utils.js';

const router = Router();

const likeEscape = text => text.replace(/[\\%_]/g, ch => `\\${ch}`);
const joinComposition = (a, b) => [a, b].map(part => String(part || '').trim()).filter(Boolean).join(' + ');
const shape = (row, matched) => ({
  id: Number(row.source_id),
  name: row.name,
  composition: joinComposition(row.short_composition1, row.short_composition2),
  manufacturer: row.manufacturer_name,
  packSize: row.pack_size_label,
  price: Number(row.price),
  matched,
});
// Custom medicines (typed in by a doctor, not in the catalogue) are shared with the whole hospital:
// anything already used on a prescription at this hospital is offered to every doctor there.
const CUSTOM_LIMIT = 4;
const customShape = row => ({ id: null, name: row.name, composition: '', manufacturer: '', packSize: '', price: null, matched: 'custom', custom: true });
const COLUMNS = 'source_id,name,price,manufacturer_name,pack_size_label,short_composition1,short_composition2';

// Type-ahead over the global medicine catalogue: names that start with the text come first,
// then medicines whose name or ingredient contains it. Discontinued medicines are left out.
router.get('/search', asyncHandler(async (req, res) => {
  const text = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 15);
  if (text.length < 2) return res.json({ items: [], prefixTotal: 0 });
  const prefix = `${likeEscape(text)}%`;
  const contains = `%${likeEscape(text)}%`;

  const customRows = await pool.query(
    `SELECT name FROM (
       SELECT DISTINCT ON (lower(name)) name,lower(name) AS lname,id
       FROM visit_prescription_items
       WHERE hospital_id=$1 AND medicine_id IS NULL AND lower(name) LIKE $2
       ORDER BY lower(name),id DESC
     ) x ORDER BY (lname LIKE $3) DESC,length(name),name LIMIT $4`,
    [req.user.hospitalId, contains, prefix, CUSTOM_LIMIT]
  );
  const customItems = customRows.rows.map(customShape);

  const [starts, total] = await Promise.all([
    pool.query(
      `SELECT ${COLUMNS} FROM medicines
       WHERE lower(name) LIKE $1 AND NOT is_discontinued
       ORDER BY length(name), name LIMIT $2`,
      [prefix, limit]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM medicines WHERE lower(name) LIKE $1 AND NOT is_discontinued`, [prefix]),
  ]);
  const items = starts.rows.map(row => shape(row, 'name'));
  if (items.length < limit && text.length >= 3) {
    const more = await pool.query(
      `SELECT ${COLUMNS} FROM medicines
       WHERE NOT is_discontinued AND lower(name) NOT LIKE $1
         AND (lower(name) LIKE $2 OR lower(short_composition1 || ' ' || short_composition2) LIKE $2)
       ORDER BY (lower(short_composition1) LIKE $1) DESC, length(name), name LIMIT $3`,
      [prefix, contains, limit - items.length]
    );
    items.push(...more.rows.map(row => shape(row, 'ingredient')));
  }
  res.json({ items: [...customItems, ...items].slice(0, limit), prefixTotal: total.rows[0].n });
}));

// The doctor's own most-used medicines (the admin sees the hospital's), with the dose / timing / duration they used last time.
router.get('/frequent', allow('ADMIN','DOCTOR'), asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (key) key,medicine_id,name,composition,manufacturer,pack_size,dose,timing,duration_days,id,
              COUNT(*) OVER (PARTITION BY key)::int AS uses
       FROM (SELECT *,COALESCE(medicine_id::text,lower(name)) AS key
             FROM visit_prescription_items WHERE hospital_id=$1 AND ($2::bigint IS NULL OR doctor_id=$2)) x
       ORDER BY key,id DESC
     ) y ORDER BY uses DESC,id DESC LIMIT 6`,
    [req.user.hospitalId, req.user.role === 'DOCTOR' ? req.user.id : null]
  );
  res.json(q.rows.map(row => ({
    medicineId: row.medicine_id ? Number(row.medicine_id) : null, name: row.name, composition: row.composition,
    manufacturer: row.manufacturer, packSize: row.pack_size, dose: row.dose, timing: row.timing, durationDays: row.duration_days, uses: row.uses,
  })));
}));

export default router;
