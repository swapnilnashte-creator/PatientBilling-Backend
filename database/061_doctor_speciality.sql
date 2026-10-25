-- A doctor's speciality, chosen when the doctor is added (and editable by the Admin). It decides what the doctor sees:
-- for now, the Vaccines tab is for paediatricians. Doctors added before this existed stay empty and keep seeing everything until the Admin sets one.
-- One new column, so no new grants are needed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS speciality VARCHAR(30);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_speciality_check;
ALTER TABLE users ADD CONSTRAINT users_speciality_check CHECK (speciality IS NULL OR speciality IN
  ('GENERAL_PHYSICIAN','PAEDIATRICIAN','DENTIST','GYNAECOLOGIST','ORTHOPAEDIC','ENT','DERMATOLOGIST','OTHER'));
