-- A visit can be entered with an earlier date (up to 30 days back) by the Admin or Reception, for a patient who was seen but not registered at the time.
-- visits.created_at holds the visit's date; entered_late_at is the real time it was entered (empty for a normal visit).
-- visit_now(visit_id) is "now" for that visit: the real time for a normal visit, and for an earlier-dated visit the same moment counted from the visit's own day
-- (the time since it was entered, kept inside that day), so the start, finish, charges and payment all land on the visit's date and reports show them there.
-- A new column and a function on existing tables, so no new grants are needed.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS entered_late_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION visit_now(p_visit BIGINT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT LEAST(v.created_at + (NOW() - v.entered_late_at),
                  (date_trunc('day', v.created_at AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day' - INTERVAL '1 minute') AT TIME ZONE 'Asia/Kolkata')
     FROM visits v WHERE v.id = p_visit AND v.entered_late_at IS NOT NULL),
    NOW());
$$;
