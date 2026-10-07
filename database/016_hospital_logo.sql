-- Hospital logo (printed on patient bills). Stored already compressed (client resizes to <= 512px and re-encodes).
ALTER TABLE hospitals
  ADD COLUMN IF NOT EXISTS logo_data BYTEA,
  ADD COLUMN IF NOT EXISTS logo_mime VARCHAR(20),
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
