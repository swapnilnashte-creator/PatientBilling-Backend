-- A dose marked "given elsewhere" often has no known date, and a skipped dose has none: the date may now be empty.
-- Doses given in this hospital always have a date (the application requires it).
ALTER TABLE patient_vaccinations ALTER COLUMN given_on DROP NOT NULL;
