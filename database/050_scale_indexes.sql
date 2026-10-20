-- Speed at scale. Looking up one visit's doctor row was reading the doctor's whole queue and filtering it, because the existing
-- indexes start with (hospital, doctor) or (visit, doctor) only. This index finds the row directly. No new table, so no grants are needed.
CREATE INDEX IF NOT EXISTS idx_visit_doctors_visit_doctor ON visit_doctors (hospital_id, visit_id, doctor_id);
