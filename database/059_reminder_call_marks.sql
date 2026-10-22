-- The Call button on Follow-ups and Vaccines due is now remembered too (who tapped it, and when), in the same table as the WhatsApp marks.
-- kind FOLLOW_UP_CALL (ref = the visit id) and VACCINE_CALL (ref = the due date), next to FOLLOW_UP and VACCINE. No new table, so no new grants are needed.
ALTER TABLE reminder_sends DROP CONSTRAINT IF EXISTS reminder_sends_kind_check;
ALTER TABLE reminder_sends ADD CONSTRAINT reminder_sends_kind_check CHECK (kind IN ('FOLLOW_UP','VACCINE','FOLLOW_UP_CALL','VACCINE_CALL'));
