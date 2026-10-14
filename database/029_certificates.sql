-- Medical certificates issued by doctors, per-hospital wording templates and running numbers.
BEGIN;

CREATE TABLE IF NOT EXISTS certificates (
  id BIGSERIAL PRIMARY KEY,
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  visit_id BIGINT NOT NULL REFERENCES visits(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason TEXT,
  UNIQUE (hospital_id, number)
);
CREATE INDEX IF NOT EXISTS certificates_hospital_issued_idx ON certificates (hospital_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS certificates_visit_idx ON certificates (hospital_id, visit_id);

-- Running number per hospital, certificate code (MC, FC, TC, VC) and year.
CREATE TABLE IF NOT EXISTS certificate_counters (
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  year INTEGER NOT NULL,
  next_number INTEGER NOT NULL CHECK (next_number > 0),
  PRIMARY KEY (hospital_id, code, year)
);

-- A hospital's own wording for a standard certificate type (absent = the standard wording).
CREATE TABLE IF NOT EXISTS certificate_templates (
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hospital_id, type_key)
);

COMMIT;
