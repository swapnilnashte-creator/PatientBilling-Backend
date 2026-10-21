-- A patient's WhatsApp number, when it is not the same as their mobile number. NULL means "the same as the mobile number", so changing the mobile
-- number also changes where WhatsApp messages go. Column only, so no new grants are needed.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS whatsapp_mobile VARCHAR(10);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_whatsapp_mobile_check') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_whatsapp_mobile_check CHECK (whatsapp_mobile IS NULL OR whatsapp_mobile ~ '^[0-9]{10}$');
  END IF;
END $$;
