-- Nutrition of a food or drink in the dietitian's list, for one serving, so a plan adds up what the client is given.
-- kind: FOOD (food or drink) or ACTIVITY (a walk, yoga: no nutrition). serving says what one serving is ("1 roti, 30 g atta").
-- All values are optional and per serving: kcal, grams of protein, carbs, fat, fibre and sugar, and mg of sodium.
-- A row whose name matches one of DhaCare's built-in items holds the clinic's own values for it (removing the row goes back to DhaCare's).
-- Plans keep their own copy of the values (inside diet_plan_weeks.meals / diet_plan_templates.meals), so changing an item never changes a plan already given.
-- Columns only: no new grant needed.
BEGIN;

ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'FOOD';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diet_items_kind_check') THEN
    ALTER TABLE diet_items ADD CONSTRAINT diet_items_kind_check CHECK (kind IN ('FOOD','ACTIVITY'));
  END IF;
END $$;
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS serving VARCHAR(80);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS kcal NUMERIC(6,1) CHECK (kcal IS NULL OR kcal BETWEEN 0 AND 3000);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS protein_g NUMERIC(5,1) CHECK (protein_g IS NULL OR protein_g BETWEEN 0 AND 500);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS carbs_g NUMERIC(5,1) CHECK (carbs_g IS NULL OR carbs_g BETWEEN 0 AND 500);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS fat_g NUMERIC(5,1) CHECK (fat_g IS NULL OR fat_g BETWEEN 0 AND 500);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS fibre_g NUMERIC(5,1) CHECK (fibre_g IS NULL OR fibre_g BETWEEN 0 AND 500);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS sugar_g NUMERIC(5,1) CHECK (sugar_g IS NULL OR sugar_g BETWEEN 0 AND 500);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS sodium_mg NUMERIC(6,0) CHECK (sodium_mg IS NULL OR sodium_mg BETWEEN 0 AND 20000);
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE diet_items ADD COLUMN IF NOT EXISTS updated_by BIGINT;

COMMIT;
