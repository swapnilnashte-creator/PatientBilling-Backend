-- Doctor's medical registration number (printed under the name on the letterhead, bills and pads).
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_no VARCHAR(40);
