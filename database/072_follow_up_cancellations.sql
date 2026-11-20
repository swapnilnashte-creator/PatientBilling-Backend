-- Cancelling a follow-up from the Follow-ups list (Admin, Receptionist, or the doctor who advised it), for example when the patient will
-- not come back or has gone elsewhere. The doctor's visit record (visit_doctors.follow_up_days) is not changed; this only records that the
-- follow-up is cancelled, by whom, when and why. A cancelled follow-up is not listed and gets no automatic WhatsApp follow-up reminder.
CREATE TABLE IF NOT EXISTS follow_up_cancellations (
  hospital_id BIGINT NOT NULL REFERENCES hospitals(id),
  visit_id BIGINT NOT NULL,
  reason VARCHAR(300),
  cancelled_by BIGINT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hospital_id, visit_id),
  FOREIGN KEY (hospital_id, visit_id) REFERENCES visits(hospital_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id, cancelled_by) REFERENCES users(hospital_id, id)
);

-- New table: where migrations run as an admin and the app connects as another user, also run (use your app user name):
-- GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_cancellations TO <app_user>;
