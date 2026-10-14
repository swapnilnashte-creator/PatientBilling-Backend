-- Finding templates: a common finding (for example "Viral fever") with its findings text, advice and the medicines linked to it.
-- owner_doctor_id NULL = the hospital's own template (managed by Admin); a doctor's id = that doctor's personal template.
BEGIN;

CREATE TABLE IF NOT EXISTS finding_templates (
  id BIGSERIAL PRIMARY KEY,
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  owner_doctor_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '',
  advice TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS finding_templates_name_uq ON finding_templates (hospital_id, COALESCE(owner_doctor_id, 0), lower(name));
CREATE INDEX IF NOT EXISTS finding_templates_hospital_idx ON finding_templates (hospital_id, is_active);

CREATE TABLE IF NOT EXISTS finding_template_medicines (
  id BIGSERIAL PRIMARY KEY,
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  template_id BIGINT NOT NULL REFERENCES finding_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  medicine_id BIGINT,
  name TEXT NOT NULL,
  composition TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  pack_size TEXT NOT NULL DEFAULT '',
  dose TEXT NOT NULL DEFAULT '',
  timing TEXT NOT NULL DEFAULT 'ANY' CHECK (timing IN ('BEFORE_FOOD', 'AFTER_FOOD', 'ANY')),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS finding_template_medicines_template_idx ON finding_template_medicines (template_id, position);

-- The advice a doctor gives for this visit (filled from a template, editable), printed on the prescription pad.
ALTER TABLE visit_doctors ADD COLUMN IF NOT EXISTS advice TEXT;

COMMIT;
