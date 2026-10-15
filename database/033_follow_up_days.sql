-- Follow-up chosen by the doctor during the consultation (number of days), printed on the prescription pad.
ALTER TABLE visit_doctors ADD COLUMN IF NOT EXISTS follow_up_days SMALLINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='visit_doctors'::regclass AND conname='visit_doctors_follow_up_days_check') THEN
    ALTER TABLE visit_doctors ADD CONSTRAINT visit_doctors_follow_up_days_check CHECK (follow_up_days IS NULL OR follow_up_days BETWEEN 1 AND 365);
  END IF;
END $$;
