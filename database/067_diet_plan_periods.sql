-- A plan covers any From and To dates the dietitian chooses (not always 7 days from the programme start).
-- Existing plans keep their 7 days: week_end = week_start + 6. Plans of one programme must not overlap (checked by the server).
ALTER TABLE diet_plan_weeks ADD COLUMN IF NOT EXISTS week_end DATE;
UPDATE diet_plan_weeks SET week_end = week_start + 6 WHERE week_end IS NULL;
ALTER TABLE diet_plan_weeks ALTER COLUMN week_end SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diet_plan_weeks_range') THEN
    ALTER TABLE diet_plan_weeks ADD CONSTRAINT diet_plan_weeks_range CHECK (week_end >= week_start);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_diet_plan_weeks_range ON diet_plan_weeks (hospital_id, programme_id, week_start, week_end);

-- The dietitian's default plan length in days, used to suggest the To date of a new plan (7 when empty).
ALTER TABLE users ADD COLUMN IF NOT EXISTS diet_plan_days SMALLINT CHECK (diet_plan_days IS NULL OR diet_plan_days BETWEEN 1 AND 60);

-- Production: nothing to grant (new columns of tables the app user already has).
