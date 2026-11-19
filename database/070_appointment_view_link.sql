-- A private link for each online booking: https://dhacare.com/booking/<view_code>. The patient opens it from WhatsApp (click-to-chat
-- message, or the Meta template's URL button where {{1}} = view_code) to see the appointment. 12 random letters and digits, so it
-- cannot be guessed or confused with the 8-character booking number. Bookings made before this get a code now.
-- Columns only, so no new grants are needed.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS view_code VARCHAR(16);
UPDATE appointments SET view_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) WHERE view_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_view_code ON appointments(view_code) WHERE view_code IS NOT NULL;
