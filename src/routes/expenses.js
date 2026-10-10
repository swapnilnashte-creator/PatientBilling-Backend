import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

// Hospital expenses. Admin: everything. Reception: see the list and add entries (no edit / delete, no totals of income).
// Doctors have no access. Paid DhaCare subscription invoices are listed automatically (admin only, read-only).
const router = Router();
router.use(allow('ADMIN', 'RECEPTIONIST'));

const SUBSCRIPTION = { id: 'subscription', name: 'DhaCare subscription', color: '#2e90fa' };
const DEFAULT_CATEGORIES = [
  ['Salaries', '#079455'], ['Rent', '#7a5af8'], ['Medical supplies', '#3f51b5'], ['Utilities', '#e77919'],
  ['Lab & outsourced', '#06aed4'], ['Equipment & repairs', '#667085'], ['Marketing', '#ee46bc'], ['Software', '#0e9384'], ['Other', '#98a2b3'],
];
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date').refine(v => !Number.isNaN(Date.parse(v)), 'Use a valid date');
const today = () => new Date().toISOString().slice(0, 10);
const notFuture = v => v <= new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const colorText = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a valid colour');

// first use: give the hospital the standard categories (they are ordinary rows the admin can rename or switch off)
async function ensureCategories(hospitalId) {
  const has = await pool.query('SELECT 1 FROM expense_categories WHERE hospital_id=$1 LIMIT 1', [hospitalId]);
  if (has.rowCount) return;
  for (const [name, color] of DEFAULT_CATEGORIES) {
    await pool.query('INSERT INTO expense_categories(hospital_id,name,color) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hospitalId, name, color]);
  }
}

const categoryJson = row => ({ id: String(row.id), name: row.name, color: row.color, isActive: row.is_active, uses: row.uses ?? 0 });

router.get('/categories', asyncHandler(async (req, res) => {
  await ensureCategories(req.user.hospitalId);
  const q = await pool.query(
    `SELECT c.*,(SELECT COUNT(*)::int FROM expenses e WHERE e.hospital_id=c.hospital_id AND e.category_id=c.id AND e.deleted_at IS NULL) AS uses
     FROM expense_categories c WHERE c.hospital_id=$1 ${req.user.role === 'ADMIN' ? '' : 'AND c.is_active'} ORDER BY lower(c.name)`,
    [req.user.hospitalId]
  );
  res.json(q.rows.map(categoryJson));
}));

router.post('/categories', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(40), color: colorText.optional() }).parse(req.body);
  await ensureCategories(req.user.hospitalId);
  if (data.name.toLowerCase() === SUBSCRIPTION.name.toLowerCase()) throw badRequest('That name is reserved');
  const q = await pool.query('INSERT INTO expense_categories(hospital_id,name,color) VALUES($1,$2,$3) RETURNING *', [req.user.hospitalId, data.name, data.color || '#667085']);
  res.status(201).json(categoryJson(q.rows[0]));
}));

router.put('/categories/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(40).optional(), color: colorText.optional(), isActive: z.boolean().optional() }).parse(req.body);
  if (data.name && data.name.toLowerCase() === SUBSCRIPTION.name.toLowerCase()) throw badRequest('That name is reserved');
  const q = await pool.query(
    `UPDATE expense_categories SET name=COALESCE($3,name),color=COALESCE($4,color),is_active=COALESCE($5,is_active)
     WHERE id=$1 AND hospital_id=$2 RETURNING *`,
    [req.params.id, req.user.hospitalId, data.name ?? null, data.color ?? null, data.isActive ?? null]
  );
  if (!q.rowCount) throw notFound('Category not found');
  res.json(categoryJson(q.rows[0]));
}));

const rangeOf = (query) => {
  const from = query.from ? dateText.parse(String(query.from)) : null;
  const to = query.to ? dateText.parse(String(query.to)) : null;
  if (from && to && from > to) throw badRequest('From date cannot be after To date');
  return { from, to };
};

const expenseJson = row => ({
  id: String(row.id), kind: 'EXPENSE', date: row.date, amount: Number(row.amount), categoryId: String(row.category_id), categoryName: row.category_name, color: row.color,
  paidTo: row.paid_to, paymentMode: row.payment_mode, note: row.note, createdByName: row.created_by_name,
});

router.get('/', asyncHandler(async (req, res) => {
  await ensureCategories(req.user.hospitalId);
  const { from, to } = rangeOf(req.query);
  const search = String(req.query.q || '').trim();
  const categoryId = req.query.categoryId ? String(req.query.categoryId) : '';
  const params = [req.user.hospitalId]; let where = 'e.hospital_id=$1 AND e.deleted_at IS NULL';
  if (from) { params.push(from); where += ` AND e.expense_date>=$${params.length}`; }
  if (to) { params.push(to); where += ` AND e.expense_date<=$${params.length}`; }
  if (categoryId && categoryId !== SUBSCRIPTION.id) { params.push(categoryId); where += ` AND e.category_id=$${params.length}`; }
  if (search) { params.push(`%${search}%`); where += ` AND (e.paid_to ILIKE $${params.length} OR e.note ILIKE $${params.length})`; }
  const manual = categoryId === SUBSCRIPTION.id ? { rows: [] } : await pool.query(
    `SELECT e.id,to_char(e.expense_date,'YYYY-MM-DD') AS date,e.amount,e.category_id,c.name AS category_name,c.color,e.paid_to,e.payment_mode,e.note,u.name AS created_by_name
     FROM expenses e JOIN expense_categories c ON c.id=e.category_id AND c.hospital_id=e.hospital_id JOIN users u ON u.id=e.created_by AND u.hospital_id=e.hospital_id
     WHERE ${where} ORDER BY e.expense_date DESC,e.id DESC LIMIT 1000`, params);
  let items = manual.rows.map(expenseJson);
  // paid subscription invoices count as spending only once they are paid
  if (req.user.role === 'ADMIN' && (!categoryId || categoryId === SUBSCRIPTION.id)) {
    const sp = [req.user.hospitalId]; let sw = `hospital_id=$1 AND status='PAID' AND paid_on IS NOT NULL`;
    if (from) { sp.push(from); sw += ` AND paid_on>=$${sp.length}`; }
    if (to) { sp.push(to); sw += ` AND paid_on<=$${sp.length}`; }
    if (search) { sp.push(`%${search}%`); sw += ` AND ('DhaCare subscription ' || invoice_no) ILIKE $${sp.length}`; }
    const inv = await pool.query(`SELECT id,invoice_no,to_char(paid_on,'YYYY-MM-DD') AS date,COALESCE(paid_amount,total) AS amount,payment_mode FROM platform_invoices WHERE ${sw} ORDER BY paid_on DESC,id DESC`, sp);
    items = items.concat(inv.rows.map(row => ({
      id: `inv-${row.id}`, kind: 'SUBSCRIPTION', date: row.date, amount: Number(row.amount), categoryId: SUBSCRIPTION.id, categoryName: SUBSCRIPTION.name, color: SUBSCRIPTION.color,
      paidTo: 'DhaCare', paymentMode: row.payment_mode || '', note: `Invoice ${row.invoice_no}`, createdByName: '', invoiceId: String(row.id),
    })));
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  res.json({ items, total: Math.round(total * 100) / 100, count: items.length });
}));

// Everyone this hospital has paid before, most used first, with the category and payment mode last used (powers "Paid to" suggestions).
router.get('/payees', asyncHandler(async (req, res) => {
  const q = await pool.query(
    `SELECT (array_agg(e.paid_to ORDER BY e.expense_date DESC,e.id DESC))[1] AS paid_to,
            (array_agg(e.category_id ORDER BY e.expense_date DESC,e.id DESC))[1] AS category_id,
            (array_agg(e.payment_mode ORDER BY e.expense_date DESC,e.id DESC))[1] AS payment_mode,
            COUNT(*)::int AS uses,to_char(MAX(e.expense_date),'YYYY-MM-DD') AS last_date
     FROM expenses e WHERE e.hospital_id=$1 AND e.deleted_at IS NULL AND e.paid_to<>''
     GROUP BY lower(e.paid_to) ORDER BY COUNT(*) DESC,MAX(e.expense_date) DESC LIMIT 200`,
    [req.user.hospitalId]
  );
  res.json(q.rows.map(r => ({ paidTo: r.paid_to, categoryId: String(r.category_id), paymentMode: r.payment_mode, uses: r.uses, lastDate: r.last_date })));
}));

const expenseSchema = z.object({
  date: dateText.refine(notFuture, 'The date cannot be in the future'),
  amount: z.number().positive('Enter an amount above zero').max(99999999),
  categoryId: z.coerce.number().int().positive(),
  paidTo: z.string().trim().max(160).optional().default(''),
  paymentMode: z.enum(['CASH', 'UPI', 'CARD', 'BANK']),
  note: z.string().trim().max(500).optional().default(''),
});

async function checkCategory(hospitalId, categoryId, allowInactiveId = null) {
  const q = await pool.query('SELECT is_active FROM expense_categories WHERE id=$1 AND hospital_id=$2', [categoryId, hospitalId]);
  if (!q.rowCount) throw badRequest('Choose a category');
  if (!q.rows[0].is_active && String(categoryId) !== String(allowInactiveId)) throw badRequest('That category is switched off');
}

router.post('/', asyncHandler(async (req, res) => {
  const data = expenseSchema.parse(req.body);
  await checkCategory(req.user.hospitalId, data.categoryId);
  const q = await pool.query(
    `INSERT INTO expenses(hospital_id,expense_date,amount,category_id,paid_to,payment_mode,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.user.hospitalId, data.date, data.amount, data.categoryId, data.paidTo, data.paymentMode, data.note, req.user.id]
  );
  res.status(201).json({ id: String(q.rows[0].id) });
}));

router.put('/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const data = expenseSchema.parse(req.body);
  const current = await pool.query('SELECT category_id FROM expenses WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.hospitalId]);
  if (!current.rowCount) throw notFound('Expense not found');
  await checkCategory(req.user.hospitalId, data.categoryId, current.rows[0].category_id);
  await pool.query(
    `UPDATE expenses SET expense_date=$3,amount=$4,category_id=$5,paid_to=$6,payment_mode=$7,note=$8,updated_at=NOW() WHERE id=$1 AND hospital_id=$2`,
    [req.params.id, req.user.hospitalId, data.date, data.amount, data.categoryId, data.paidTo, data.paymentMode, data.note]
  );
  res.json({ ok: true });
}));

router.delete('/:id', allow('ADMIN'), asyncHandler(async (req, res) => {
  const q = await pool.query('UPDATE expenses SET deleted_at=NOW() WHERE id=$1 AND hospital_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.hospitalId]);
  if (!q.rowCount) throw notFound('Expense not found');
  res.json({ ok: true });
}));

// Income vs expenses for a period, plus the last six months and spending by category (admin only)
router.get('/summary', allow('ADMIN'), asyncHandler(async (req, res) => {
  let { from, to } = rangeOf(req.query);
  if (!to) to = today();
  if (!from) from = `${to.slice(0, 8)}01`;
  const h = req.user.hospitalId;
  const [collected, spent, subs, byCat, months] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS v,COUNT(*)::int AS n FROM payments WHERE hospital_id=$1 AND paid_at::date>=$2 AND paid_at::date<=$3`, [h, from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS v,COUNT(*)::int AS n FROM expenses WHERE hospital_id=$1 AND deleted_at IS NULL AND expense_date>=$2 AND expense_date<=$3`, [h, from, to]),
    pool.query(`SELECT COALESCE(SUM(COALESCE(paid_amount,total)),0)::numeric(14,2) AS v,COUNT(*)::int AS n FROM platform_invoices WHERE hospital_id=$1 AND status='PAID' AND paid_on>=$2 AND paid_on<=$3`, [h, from, to]),
    pool.query(`SELECT c.name,c.color,SUM(e.amount)::numeric(14,2) AS v FROM expenses e JOIN expense_categories c ON c.id=e.category_id AND c.hospital_id=e.hospital_id
                WHERE e.hospital_id=$1 AND e.deleted_at IS NULL AND e.expense_date>=$2 AND e.expense_date<=$3 GROUP BY c.name,c.color ORDER BY SUM(e.amount) DESC`, [h, from, to]),
    pool.query(
      `WITH m AS (SELECT date_trunc('month', $2::date) - (n::text || ' months')::interval AS s FROM generate_series(0,5) n)
       SELECT to_char(m.s,'YYYY-MM') AS month,
              (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.hospital_id=$1 AND p.paid_at>=m.s AND p.paid_at<m.s+interval '1 month')::numeric(14,2) AS collected,
              ((SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.hospital_id=$1 AND e.deleted_at IS NULL AND e.expense_date>=m.s::date AND e.expense_date<(m.s+interval '1 month')::date)
              +(SELECT COALESCE(SUM(COALESCE(i.paid_amount,i.total)),0) FROM platform_invoices i WHERE i.hospital_id=$1 AND i.status='PAID' AND i.paid_on>=m.s::date AND i.paid_on<(m.s+interval '1 month')::date))::numeric(14,2) AS spent
       FROM m ORDER BY m.s`, [h, to]),
  ]);
  const subTotal = Number(subs.rows[0].v);
  const categories = byCat.rows.map(r => ({ name: r.name, color: r.color, amount: Number(r.v) }));
  if (subTotal > 0) categories.push({ name: SUBSCRIPTION.name, color: SUBSCRIPTION.color, amount: subTotal });
  categories.sort((a, b) => b.amount - a.amount);
  const spentTotal = Math.round((Number(spent.rows[0].v) + subTotal) * 100) / 100;
  const collectedTotal = Number(collected.rows[0].v);
  res.json({
    from, to, collected: collectedTotal, collectedCount: collected.rows[0].n, spent: spentTotal, spentCount: spent.rows[0].n + subs.rows[0].n,
    net: Math.round((collectedTotal - spentTotal) * 100) / 100, categories,
    months: months.rows.map(r => ({ month: r.month, collected: Number(r.collected), spent: Number(r.spent) })),
  });
}));

export default router;
