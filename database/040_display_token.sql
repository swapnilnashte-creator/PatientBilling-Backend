-- The private link of the waiting room display (a TV in the waiting area). Empty means the display is off.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS display_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hospitals_display_token ON hospitals(display_token) WHERE display_token IS NOT NULL;
