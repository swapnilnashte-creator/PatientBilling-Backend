-- Emergency access: a Super Admin who cannot get the hospital's support code (for example the hospital cannot sign in at all) can choose "Emergency access"
-- instead. It needs a written reason, opens a support session that the hospital can see (red banner, a line with the reason in its Support history) and
-- lasts one hour. Columns only, so no new grants are needed.
ALTER TABLE support_access ADD COLUMN IF NOT EXISTS emergency BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE support_access ADD COLUMN IF NOT EXISTS emergency_reason VARCHAR(300);
