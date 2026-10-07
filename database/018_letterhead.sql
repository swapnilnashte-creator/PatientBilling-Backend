-- Letterhead: which doctors are printed in "Our doctors", their order, the hospital's timings and weekly off.
ALTER TABLE hospitals
  ADD COLUMN IF NOT EXISTS weekly_off SMALLINT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS timings JSONB NOT NULL DEFAULT '{"show":true,"sessions":[]}'::jsonb;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS on_letterhead BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS letterhead_order INTEGER;

-- Existing hospitals keep showing their doctors: the first 6 active doctors go on the letterhead.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY hospital_id ORDER BY id) AS n
  FROM users WHERE role='DOCTOR' AND is_active=TRUE AND deleted_at IS NULL AND letterhead_order IS NULL
)
UPDATE users u SET on_letterhead = (r.n <= 6), letterhead_order = r.n FROM ranked r WHERE u.id = r.id;
