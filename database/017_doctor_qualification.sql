-- Doctors' education / qualifications (printed under their name on bills).
ALTER TABLE users ADD COLUMN IF NOT EXISTS qualification VARCHAR(160);
