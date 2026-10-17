-- The WhatsApp message sent to patients who are due for a follow-up. Empty means the standard wording is used.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS follow_up_reminder_message TEXT;
