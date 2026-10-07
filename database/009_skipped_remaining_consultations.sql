BEGIN;

ALTER TABLE visit_doctors DROP CONSTRAINT IF EXISTS visit_doctors_status_check;
ALTER TABLE visit_doctors
  ADD CONSTRAINT visit_doctors_status_check
  CHECK (status IN ('WAITING','IN_PROGRESS','COMPLETED','SKIPPED'));

ALTER TABLE visit_doctors
  ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skipped_by BIGINT,
  ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='visit_doctors_skipped_by_fkey' AND conrelid='visit_doctors'::regclass
  ) THEN
    ALTER TABLE visit_doctors
      ADD CONSTRAINT visit_doctors_skipped_by_fkey
      FOREIGN KEY (hospital_id,skipped_by) REFERENCES users(hospital_id,id);
  END IF;
END $$;

COMMIT;
