-- Blood pressure taken for a visit (mmHg), optional. Separate from the heart rate, which is in beats per minute.
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS bp_systolic SMALLINT,
  ADD COLUMN IF NOT EXISTS bp_diastolic SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_bp_check' AND conrelid = 'visits'::regclass) THEN
    ALTER TABLE visits ADD CONSTRAINT visits_bp_check CHECK (
      (bp_systolic IS NULL OR bp_systolic BETWEEN 50 AND 300)
      AND (bp_diastolic IS NULL OR bp_diastolic BETWEEN 30 AND 200)
    );
  END IF;
END $$;
