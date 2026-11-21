-- A diet client can enter today's weight on the public "My diet" page (mobile number + captcha). Such a weight is marked by_client;
-- the dietitian can change or remove it, and a weight entered by the staff for that day replaces it (by_client goes back to FALSE).
-- Column only: no new grant is needed.
ALTER TABLE weight_log ADD COLUMN IF NOT EXISTS by_client BOOLEAN NOT NULL DEFAULT FALSE;
