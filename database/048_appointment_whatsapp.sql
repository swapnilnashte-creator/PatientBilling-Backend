-- WhatsApp message for online appointments: the hospital's own wording, and who sent it to a booking and when.
-- Empty wording means the standard text is used. No new table, so no new grants are needed.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS appointment_message TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS whatsapp_sent_by BIGINT;
