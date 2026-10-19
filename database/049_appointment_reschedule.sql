-- A patient can move their own booking to another time. We keep how many times, and where it was before, for the staff.
-- Columns only, so no new grants are needed.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reschedule_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS previous_slot_at TIMESTAMPTZ;
