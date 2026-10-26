-- A doctor can add themselves to a patient's open, unpaid visit (instead of a second visit with a second token and a second bill).
-- visit_doctors remembers that the doctor was not chosen at reception, and who added them. Two new columns, so no new grants are needed.
ALTER TABLE visit_doctors ADD COLUMN IF NOT EXISTS self_added BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE visit_doctors ADD COLUMN IF NOT EXISTS added_by BIGINT;
