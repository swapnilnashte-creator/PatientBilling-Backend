-- An Admin can issue a certificate on behalf of a doctor: doctor_id stays the signing doctor, issued_by is who entered it.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS issued_by BIGINT REFERENCES users(id);
UPDATE certificates SET issued_by = doctor_id WHERE issued_by IS NULL;
