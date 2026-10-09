-- Every patient has a private, random code. It is printed as a QR on the bill, the doctor's pad and the prescription,
-- so reception can scan it when the patient returns. The code carries no personal details and only works for logged-in staff of the same hospital.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS qr_code VARCHAR(24);
UPDATE patients SET qr_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) WHERE qr_code IS NULL;
ALTER TABLE patients ALTER COLUMN qr_code SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
ALTER TABLE patients ALTER COLUMN qr_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_qr_code ON patients(qr_code);
