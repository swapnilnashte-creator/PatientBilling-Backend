-- Insert 1,000 deterministic synthetic patients for local development/testing.
--
-- Default target: Hospital1 (hospital_id = 2)
-- Override when needed:
--   psql -d patient_visit_billing -v hospital_id=3 -f database-scripts/seed_1000_patients.sql
--
-- This script is idempotent for each hospital. It uses the reserved synthetic
-- mobile range 7000000001-7000001000 and skips any row already present.

\set ON_ERROR_STOP on

\if :{?hospital_id}
\else
\set hospital_id 2
\endif

BEGIN;

WITH target AS (
  SELECT
    h.id AS hospital_id,
    (
      SELECT u.id
      FROM users u
      WHERE u.hospital_id = h.id
        AND u.is_active = TRUE
        AND u.deleted_at IS NULL
      ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.id
      LIMIT 1
    ) AS actor_id
  FROM hospitals h
  WHERE h.id = :hospital_id
    AND h.is_active = TRUE
),
synthetic_patients AS (
  SELECT
    t.hospital_id,
    t.actor_id,
    n,
    'Synthetic Patient ' || LPAD(n::text, 4, '0') AS full_name,
    '700000' || LPAD(n::text, 4, '0') AS mobile,
    (ARRAY['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'])[((n - 1) % 4) + 1] AS gender,
    DATE '1945-01-01' + ((n * 37) % 27000)::int AS date_of_birth,
    'Test Address ' || n || ', Pune, Maharashtra' AS address
  FROM target t
  CROSS JOIN generate_series(1, 1000) AS n
),
inserted AS (
  INSERT INTO patients (
    hospital_id,
    full_name,
    mobile,
    gender,
    date_of_birth,
    address,
    created_by,
    updated_by
  )
  SELECT
    s.hospital_id,
    s.full_name,
    s.mobile,
    s.gender,
    s.date_of_birth,
    s.address,
    s.actor_id,
    s.actor_id
  FROM synthetic_patients s
  WHERE NOT EXISTS (
    SELECT 1
    FROM patients p
    WHERE p.hospital_id = s.hospital_id
      AND p.mobile = s.mobile
      AND p.deleted_at IS NULL
  )
  RETURNING id
)
SELECT COUNT(*) AS patients_inserted_this_run FROM inserted;

COMMIT;

SELECT COUNT(*) AS synthetic_patients_now_present
FROM patients
WHERE hospital_id = :hospital_id
  AND mobile BETWEEN '7000000001' AND '7000001000'
  AND deleted_at IS NULL;
