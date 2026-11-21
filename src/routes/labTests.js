import { Router } from 'express';
import { pool } from '../db.js';
import { allow } from '../middleware/auth.js';
import { asyncHandler } from '../utils.js';
import { LAB_TESTS } from '../labTests.js';

const router = Router();

// Everything the "Tests advised" box needs, in one go (the screen searches it itself, so typing never waits for the server):
// the list of common tests, the tests this hospital's doctors typed in themselves, and the signed-in doctor's most advised tests
// (an Admin running the consultation screen sees the hospital's).
router.get('/', allow('ADMIN', 'DOCTOR'), asyncHandler(async (req, res) => {
  const [custom, frequent] = await Promise.all([
    pool.query(
      `SELECT name FROM (SELECT DISTINCT ON (lower(name)) name,id FROM visit_test_items WHERE hospital_id=$1 AND test_code IS NULL ORDER BY lower(name),id DESC) x
       ORDER BY id DESC LIMIT 300`, [req.user.hospitalId]),
    pool.query(
      `SELECT test_code,name,uses FROM (
         SELECT DISTINCT ON (lower(name)) test_code,name,id,COUNT(*) OVER (PARTITION BY lower(name))::int AS uses
         FROM visit_test_items WHERE hospital_id=$1 AND ($2::bigint IS NULL OR doctor_id=$2) ORDER BY lower(name),id DESC
       ) x ORDER BY uses DESC,id DESC LIMIT 8`, [req.user.hospitalId, req.user.role === 'DOCTOR' ? req.user.id : null]),
  ]);
  res.json({
    tests: LAB_TESTS,
    custom: custom.rows.map(r => r.name),
    frequent: frequent.rows.map(r => ({ code: r.test_code || null, name: r.name })),
  });
}));

export default router;
