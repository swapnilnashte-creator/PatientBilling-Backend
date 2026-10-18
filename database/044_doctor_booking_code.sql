-- A private code for each doctor, used in the public booking link and QR instead of the doctor's database number.
ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_code VARCHAR(16);
UPDATE users SET booking_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) WHERE booking_code IS NULL AND role = 'DOCTOR';
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_booking_code ON users(booking_code) WHERE booking_code IS NOT NULL;
