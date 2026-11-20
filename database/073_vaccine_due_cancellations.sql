-- Cancelling doses on the Vaccines due list (Admin, Receptionist, or a doctor who has treated the patient), for example when the parent
-- declined or the doctor advised to wait. The vaccination record (patient_vaccinations) is not changed: the dose is still pending on the
-- patient's Vaccines tab. This only records that the reminder for that dose is cancelled, by whom, when and why. A cancelled dose is not
-- listed and gets no automatic WhatsApp vaccination reminder. The patient's other doses are listed as usual when they come due.
CREATE TABLE IF NOT EXISTS vaccine_due_cancellations (
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id),
  patient_id BIGINT NOT NULL,
  vaccine_id BIGINT NOT NULL,
  dose_no SMALLINT NOT NULL,
  reason VARCHAR(300),
  cancelled_by BIGINT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hospital_id, patient_id, vaccine_id, dose_no),
  FOREIGN KEY (hospital_id, patient_id) REFERENCES patients(hospital_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id, cancelled_by) REFERENCES users(hospital_id, id)
);

-- New table: where migrations run as an admin and the app connects as another user, also run (use your app user name):
-- GRANT SELECT, INSERT, UPDATE, DELETE ON vaccine_due_cancellations TO <app_user>;
