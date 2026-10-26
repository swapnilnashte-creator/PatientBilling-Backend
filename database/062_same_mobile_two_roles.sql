-- In a one-doctor clinic the same person is the Admin and the Doctor. One mobile number may now hold more than one role
-- in a hospital (one account per role, so each role keeps its own visits, settlements and billing), and the person
-- picks the role at sign-in. Two accounts with the same role and the same mobile are still not allowed.
-- Only indexes change on an existing table, so no new grants are needed.
DROP INDEX IF EXISTS users_hospital_mobile_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_hospital_mobile_role_key ON users(hospital_id, mobile, role);
DROP INDEX IF EXISTS users_hospital_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_hospital_email_role_key ON users(hospital_id, lower(email), role) WHERE email IS NOT NULL;
