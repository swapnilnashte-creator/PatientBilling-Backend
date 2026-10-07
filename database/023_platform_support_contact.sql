-- CareBill's support contact, shown to hospitals on their invoices and in the Subscription help.
ALTER TABLE platform_billing_company ADD COLUMN IF NOT EXISTS support_phone VARCHAR(30);
ALTER TABLE platform_billing_company ADD COLUMN IF NOT EXISTS support_email VARCHAR(120);
