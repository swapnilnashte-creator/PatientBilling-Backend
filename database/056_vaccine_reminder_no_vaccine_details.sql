-- The vaccine WhatsApp reminder no longer names a vaccine or a dose (only {patient}, {hospital}, {hospitalPhone}, {when} and {status}).
-- A hospital's own saved wording that still uses the removed fields ({vaccine}, {vaccines}, {dose}) goes back to the standard wording. No new table, so no grants are needed.
UPDATE hospitals SET vaccine_reminder_message = NULL
WHERE vaccine_reminder_message ~* '\{(vaccine|vaccines|dose)\}';
