-- Daily token: each visit also gets a number that restarts at 1 every day (India time) for its hospital.
-- The running visit_number stays as the permanent reference.
BEGIN;

ALTER TABLE visits ADD COLUMN IF NOT EXISTS daily_number INTEGER;

UPDATE visits v SET daily_number = n.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY hospital_id, (created_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY created_at, id) AS rn
  FROM visits
) n
WHERE n.id = v.id AND v.daily_number IS NULL;

ALTER TABLE visits ALTER COLUMN daily_number SET NOT NULL;

CREATE TABLE IF NOT EXISTS hospital_daily_visit_counters (
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  next_number INTEGER NOT NULL CHECK (next_number > 0),
  PRIMARY KEY (hospital_id, day)
);

INSERT INTO hospital_daily_visit_counters(hospital_id, day, next_number)
SELECT hospital_id, (created_at AT TIME ZONE 'Asia/Kolkata')::date, MAX(daily_number) + 1
FROM visits
GROUP BY hospital_id, (created_at AT TIME ZONE 'Asia/Kolkata')::date
ON CONFLICT (hospital_id, day) DO UPDATE SET next_number = GREATEST(hospital_daily_visit_counters.next_number, EXCLUDED.next_number);

COMMIT;
