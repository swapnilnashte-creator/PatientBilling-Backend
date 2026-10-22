-- In the follow-up WhatsApp message, {when} is now just the date (it used to be "on 5 Oct" or "around 5 Oct").
-- A hospital's own saved wording keeps reading the same way: "{when}" becomes "around {when}". No new table, so no grants are needed.
UPDATE hospitals SET follow_up_reminder_message = REPLACE(follow_up_reminder_message, '{when}', 'around {when}')
WHERE follow_up_reminder_message LIKE '%{when}%' AND follow_up_reminder_message NOT LIKE '%around {when}%' AND follow_up_reminder_message NOT LIKE '%on {when}%';
