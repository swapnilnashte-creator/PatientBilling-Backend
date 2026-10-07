BEGIN;

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS doctor_notes TEXT,
  ADD COLUMN IF NOT EXISTS doctor_notes_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS doctor_notes_updated_by BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'visits_doctor_notes_updated_by_fkey'
      AND conrelid = 'visits'::regclass
  ) THEN
    ALTER TABLE visits
      ADD CONSTRAINT visits_doctor_notes_updated_by_fkey
      FOREIGN KEY (hospital_id, doctor_notes_updated_by)
      REFERENCES users(hospital_id, id);
  END IF;
END $$;

COMMIT;
