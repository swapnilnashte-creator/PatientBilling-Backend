-- Marking a booking as arrived can be undone while the patient is still waiting. If the arrival registered a new patient, the undo removes
-- that patient again (when nothing else has been recorded for them).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS arrived_new_patient BOOLEAN NOT NULL DEFAULT FALSE;
