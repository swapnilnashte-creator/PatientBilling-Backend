BEGIN;

ALTER TABLE visits
  DROP CONSTRAINT IF EXISTS visits_status_check;

ALTER TABLE visits
  ADD CONSTRAINT visits_status_check CHECK (status IN (
    'WAITING_FOR_DOCTOR',
    'WITH_DOCTOR',
    'PAYMENT_PENDING',
    'COMPLETED',
    'CANCELLED',
    'LEFT_BEFORE_DOCTOR',
    'LEFT_WITHOUT_PAYMENT'
  ));

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS left_by BIGINT,
  ADD COLUMN IF NOT EXISTS left_note VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'visits_left_by_fkey'
      AND conrelid = 'visits'::regclass
  ) THEN
    ALTER TABLE visits
      ADD CONSTRAINT visits_left_by_fkey
      FOREIGN KEY (hospital_id, left_by)
      REFERENCES users(hospital_id, id);
  END IF;
END $$;

COMMIT;
