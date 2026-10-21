import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden } from '../utils.js';
import { CODE_MINUTES, SESSION_CHOICES, closeStale, hashCode, makeCode, openSession } from '../supportAccess.js';

// The hospital's side of support access. The Admin creates a code and reads it out to DhaCare support; everyone in the hospital can see
// when a support person is signed in, and the Admin can end it at any moment.
const router = Router();

// Is a support person signed in right now? Every hospital user can see this (it feeds the banner).
router.get('/status', asyncHandler(async (req, res) => {
  const s = await openSession(pool, req.user.hospitalId);
  res.json({ session: s ? { by: s.superuser_name || 'DhaCare support', startedAt: s.session_started_at, endsAt: s.session_ends_at } : null });
}));

// The Admin's box in Hospital Settings: the open code or session, and the history.
router.get('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const h = req.user.hospitalId;
  await closeStale(pool, h);
  const open = await pool.query(
    `SELECT s.id,s.status,s.code_expires_at,s.attempts,s.session_minutes,s.session_started_at,s.session_ends_at,p.name AS superuser_name
     FROM support_access s LEFT JOIN platform_superusers p ON p.id=s.superuser_id
     WHERE s.hospital_id=$1 AND s.status IN ('CODE','SESSION')`, [h]);
  const hist = await pool.query(
    `SELECT s.id,s.status,s.created_at,s.session_started_at,s.session_ends_at,s.ended_at,s.ended_reason,s.session_minutes,p.name AS superuser_name,u.name AS created_by_name,
            COALESCE((SELECT json_agg(json_build_object('action',e.action,'name',e.target_name,'role',e.target_role,'at',e.created_at) ORDER BY e.created_at)
                      FROM support_access_events e WHERE e.support_id=s.id AND e.action='SIGN_IN_AS'),'[]'::json) AS signins
     FROM support_access s LEFT JOIN platform_superusers p ON p.id=s.superuser_id LEFT JOIN users u ON u.id=s.created_by
     WHERE s.hospital_id=$1 ORDER BY s.created_at DESC LIMIT 15`, [h]);
  const row = open.rows[0] || null;
  res.json({
    choices: SESSION_CHOICES, codeMinutes: CODE_MINUTES,
    code: row && row.status === 'CODE' ? { expiresAt: row.code_expires_at, attemptsLeft: Math.max(0, 5 - row.attempts), sessionMinutes: row.session_minutes } : null,
    session: row && row.status === 'SESSION' ? { by: row.superuser_name || 'DhaCare support', startedAt: row.session_started_at, endsAt: row.session_ends_at } : null,
    history: hist.rows,
  });
}));

// Create a code. A new code replaces an old one that was not used. It is shown once, here, and never again.
router.post('/code', allow('ADMIN'), asyncHandler(async (req, res) => {
  if (req.user.impersonatedBySuperuserId) throw forbidden('A support session cannot create a support code');
  const body = z.object({ sessionMinutes: z.coerce.number().int().refine(n => SESSION_CHOICES.includes(n), 'Choose how long support may stay signed in') }).parse(req.body);
  const h = req.user.hospitalId;
  const result = await withTransaction(async (client) => {
    await closeStale(client, h);
    const open = await client.query(`SELECT id,status FROM support_access WHERE hospital_id=$1 AND status IN ('CODE','SESSION') FOR UPDATE`, [h]);
    if (open.rows.some(r => r.status === 'SESSION')) throw badRequest('A support person is signed in now. End that access first, then create a new code.');
    await client.query(`UPDATE support_access SET status='CANCELLED',ended_at=NOW(),ended_reason='REPLACED' WHERE hospital_id=$1 AND status='CODE'`, [h]);
    const code = makeCode();
    const row = await client.query(
      `INSERT INTO support_access(hospital_id,code_hash,code_expires_at,session_minutes,created_by)
       VALUES($1,$2,NOW()+make_interval(mins=>$3),$4,$5) RETURNING id,code_expires_at`,
      [h, hashCode(code, h), CODE_MINUTES, body.sessionMinutes, req.user.id]);
    await client.query(`INSERT INTO support_access_events(support_id,hospital_id,action) VALUES($1,$2,'CODE_CREATED')`, [row.rows[0].id, h]);
    return { code, expiresAt: row.rows[0].code_expires_at, sessionMinutes: body.sessionMinutes, codeMinutes: CODE_MINUTES };
  });
  res.status(201).json(result);
}));

// Cancel the code, or end the support session now.
router.delete('/', allow('ADMIN'), asyncHandler(async (req, res) => {
  const h = req.user.hospitalId;
  await closeStale(pool, h);
  const q = await pool.query(
    `UPDATE support_access SET status=CASE WHEN status='SESSION' THEN 'ENDED' ELSE 'CANCELLED' END,ended_at=NOW(),
            ended_reason=CASE WHEN status='SESSION' THEN CASE WHEN $2::boolean THEN 'SUPPORT' ELSE 'HOSPITAL' END ELSE 'CANCELLED' END
     WHERE hospital_id=$1 AND status IN ('CODE','SESSION') RETURNING id,status`, [h, Boolean(req.user.impersonatedBySuperuserId)]);
  res.json({ ended: q.rowCount > 0 });
}));

export default router;
