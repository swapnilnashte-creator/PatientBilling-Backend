BEGIN;

-- Backfill the standard V1 price list for every existing hospital.
-- Existing custom prices are preserved because ON CONFLICT does nothing.
WITH defaults(name, default_price) AS (
  VALUES
    ('General Consultation'::varchar, 500.00::numeric),
    ('Follow-up Consultation'::varchar, 300.00::numeric),
    ('Dressing'::varchar, 250.00::numeric),
    ('Injection'::varchar, 150.00::numeric),
    ('Minor Procedure'::varchar, 700.00::numeric)
), admin_user AS (
  SELECT DISTINCT ON (hospital_id) hospital_id, id
  FROM users
  WHERE role = 'ADMIN' AND is_active = TRUE AND deleted_at IS NULL
  ORDER BY hospital_id, id
)
INSERT INTO billing_items(hospital_id, name, default_price, created_by, updated_by)
SELECT h.id, d.name, d.default_price, a.id, a.id
FROM hospitals h
CROSS JOIN defaults d
LEFT JOIN admin_user a ON a.hospital_id = h.id
WHERE h.is_active = TRUE
ON CONFLICT (hospital_id, name) DO NOTHING;

COMMIT;

-- Verification queries (safe to run after migration):
-- SELECT hospital_id, COUNT(*) AS billing_item_count
-- FROM billing_items
-- WHERE deleted_at IS NULL
-- GROUP BY hospital_id
-- ORDER BY hospital_id;
--
-- SELECT hospital_id, id, name, email, role, is_active
-- FROM users
-- WHERE deleted_at IS NULL
-- ORDER BY hospital_id, id;
