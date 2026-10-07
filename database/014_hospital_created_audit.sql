-- Audit: Super Admin can create hospitals.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='super_admin_audit_logs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%IMPERSONATE_ADMIN%'
  LOOP
    EXECUTE format('ALTER TABLE super_admin_audit_logs DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE super_admin_audit_logs ADD CONSTRAINT super_admin_audit_logs_action_check CHECK (action IN (
    'LOGIN','IMPERSONATE_ADMIN','IMPERSONATE_USER','DEACTIVATE_HOSPITAL','ACTIVATE_HOSPITAL',
    'RATE_SCHEDULED','RATE_UPDATED','RATE_CANCELLED','HOSPITAL_BILLING_UPDATED',
    'INVOICE_CREATED','INVOICE_ISSUED','INVOICE_PAID','INVOICE_CANCELLED','COMPANY_DETAILS_UPDATED',
    'HOSPITAL_CREATED'));
END $$;
