BEGIN;

ALTER TABLE visits ADD COLUMN IF NOT EXISTS visit_number BIGINT;

WITH numbered AS (
  SELECT id,ROW_NUMBER() OVER (PARTITION BY hospital_id ORDER BY created_at,id) AS visit_number
  FROM visits
)
UPDATE visits v SET visit_number=n.visit_number
FROM numbered n
WHERE n.id=v.id AND v.visit_number IS NULL;

ALTER TABLE visits ALTER COLUMN visit_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='visits_hospital_id_visit_number_key' AND conrelid='visits'::regclass
  ) THEN
    ALTER TABLE visits
      ADD CONSTRAINT visits_hospital_id_visit_number_key UNIQUE (hospital_id,visit_number);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hospital_visit_counters (
  hospital_id BIGINT PRIMARY KEY REFERENCES hospitals(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL CHECK (next_number > 0)
);

INSERT INTO hospital_visit_counters(hospital_id,next_number)
SELECT h.id,COALESCE(MAX(v.visit_number),0)+1
FROM hospitals h LEFT JOIN visits v ON v.hospital_id=h.id
GROUP BY h.id
ON CONFLICT (hospital_id) DO UPDATE
SET next_number=GREATEST(hospital_visit_counters.next_number,EXCLUDED.next_number);

COMMIT;
