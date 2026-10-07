-- UPI details of the platform company. Printed as a pay-by-scan QR on every open invoice.
ALTER TABLE platform_billing_company ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100);
ALTER TABLE platform_billing_company ADD COLUMN IF NOT EXISTS upi_name VARCHAR(100);
