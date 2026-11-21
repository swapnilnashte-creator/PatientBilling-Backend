-- The diet client's PIN for the public My diet page (mobile number + 4-digit PIN + robot check). The dietitian sets it when the programme
-- starts and can change it at any time; only a one-way hash is kept (DhaCare cannot show the PIN again, only set a new one).
-- DhaCare never sends the PIN: the dietitian tells the client directly.
-- Five wrong PINs in a row lock the page for that programme for 24 hours, or until the dietitian sets a new PIN.
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS client_pin_hash VARCHAR(100);
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS client_pin_set_at TIMESTAMPTZ;
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS client_pin_set_by BIGINT;
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS client_pin_fails SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE diet_programmes ADD COLUMN IF NOT EXISTS client_pin_locked_until TIMESTAMPTZ;

-- The wording of the click-to-chat message for a missing weight (staff send it from their own WhatsApp).
-- NULL = DhaCare's standard wording. Edited in Hospital Settings > WhatsApp > Diet messages.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS diet_weight_message TEXT;

-- The WhatsApp button for a missing weight on the Daily Tracker is remembered (who tapped it, and when): kind DIET_WEIGHT, ref = the last weight's date.
ALTER TABLE reminder_sends DROP CONSTRAINT IF EXISTS reminder_sends_kind_check;
ALTER TABLE reminder_sends ADD CONSTRAINT reminder_sends_kind_check CHECK (kind IN ('FOLLOW_UP','VACCINE','FOLLOW_UP_CALL','VACCINE_CALL','DIET_WEIGHT'));

-- Columns and a check only: no new grants are needed.
