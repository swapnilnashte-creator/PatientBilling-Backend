-- Dietitians: the client's height (cm), asked when a programme is started, so the BMI can be worked out from the daily weight.
-- Programmes started before this have no height until the dietitian adds it on the Programme tab.
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS height_cm NUMERIC(4,1);
ALTER TABLE diet_programmes DROP CONSTRAINT IF EXISTS diet_programmes_height_check;
ALTER TABLE diet_programmes ADD CONSTRAINT diet_programmes_height_check CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 250);
-- No new table, so no new grant is needed.
