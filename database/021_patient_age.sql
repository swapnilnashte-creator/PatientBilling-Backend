-- A patient's age is mandatory at registration, but many patients only know their age, not their birth date.
-- The age is then stored as an estimated date of birth (today minus the age) so every screen keeps working,
-- and dob_estimated stops the app from presenting that estimate as a real birth date.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS dob_estimated BOOLEAN NOT NULL DEFAULT FALSE;
