-- Optional demo tenant only. Create users through the application so passwords are bcrypt-hashed.
INSERT INTO hospitals (name, mobile, address)
SELECT 'Demo Care Clinic', '9999999999', 'Pune, Maharashtra'
WHERE NOT EXISTS (SELECT 1 FROM hospitals WHERE name = 'Demo Care Clinic');

WITH h AS (
  SELECT id FROM hospitals WHERE name = 'Demo Care Clinic' ORDER BY id LIMIT 1
)
INSERT INTO billing_items (hospital_id, name, default_price)
SELECT h.id, x.name, x.price
FROM h
CROSS JOIN (VALUES
  ('General Consultation', 500.00::numeric),
  ('Follow-up Consultation', 300.00::numeric),
  ('Dressing', 250.00::numeric),
  ('Injection', 150.00::numeric),
  ('Minor Procedure', 700.00::numeric)
) AS x(name, price)
ON CONFLICT (hospital_id, name) DO NOTHING;
