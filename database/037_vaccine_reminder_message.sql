-- The WhatsApp message sent to families whose vaccines are due. Empty means the standard wording is used.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS vaccine_reminder_message TEXT;
