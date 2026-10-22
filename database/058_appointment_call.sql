-- Who tapped Call on a booking, and when (the same idea as the WhatsApp "sent" mark). Two new columns on appointments, so no new grants are needed.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS called_by BIGINT;
