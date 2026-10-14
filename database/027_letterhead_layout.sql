-- Hospital-chosen layout of the letterhead / bill / pad header: position, which blocks show and in what order, a tagline and a footer note.
-- NULL means the original look (left band, every block shown).
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS letterhead_layout JSONB;
