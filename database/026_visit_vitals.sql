-- Vitals taken for a visit: weight, height, heart rate, SpO2 and temperature. All optional.
-- Temperature is kept with the unit it was entered in (Fahrenheit is the default).
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS heart_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS spo2 SMALLINT,
  ADD COLUMN IF NOT EXISTS temperature NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS temperature_unit CHAR(1) NOT NULL DEFAULT 'F',
  ADD COLUMN IF NOT EXISTS vitals_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_vitals_check' AND conrelid = 'visits'::regclass) THEN
    ALTER TABLE visits ADD CONSTRAINT visits_vitals_check CHECK (
      temperature_unit IN ('C', 'F')
      AND (weight_kg IS NULL OR weight_kg BETWEEN 1 AND 500)
      AND (height_cm IS NULL OR height_cm BETWEEN 30 AND 260)
      AND (heart_rate IS NULL OR heart_rate BETWEEN 20 AND 300)
      AND (spo2 IS NULL OR spo2 BETWEEN 30 AND 100)
      AND (temperature IS NULL OR (temperature_unit = 'C' AND temperature BETWEEN 30 AND 45) OR (temperature_unit = 'F' AND temperature BETWEEN 86 AND 113))
    );
  END IF;
END $$;
