import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultInputPath = path.resolve(scriptDirectory, '..', 'indian_medicine_data.txt');
const inputPath = path.resolve(process.argv[2] || defaultInputPath);
const batchSize = 1_000;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function parseMedicine(raw, position) {
  const sourceId = Number(raw.id);
  const price = Number(raw['price(₹)']);
  const discontinued = String(raw.Is_discontinued).trim().toUpperCase();
  const name = String(raw.name ?? '').trim();

  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error(`Invalid medicine id at array position ${position}`);
  }
  if (!name) {
    throw new Error(`Missing medicine name for id ${sourceId}`);
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`Invalid price for medicine id ${sourceId}`);
  }
  if (discontinued !== 'TRUE' && discontinued !== 'FALSE') {
    throw new Error(`Invalid discontinued status for medicine id ${sourceId}`);
  }

  return [
    sourceId,
    name,
    price,
    discontinued === 'TRUE',
    String(raw.manufacturer_name ?? '').trim(),
    String(raw.type ?? '').trim(),
    String(raw.pack_size_label ?? '').trim(),
    String(raw.short_composition1 ?? '').trim(),
    String(raw.short_composition2 ?? '').trim(),
  ];
}

function buildUpsert(rows) {
  const columnsPerRow = 9;
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    values.push(...row);
    const offset = rowIndex * columnsPerRow;
    return `(${Array.from({ length: columnsPerRow }, (_, columnIndex) => `$${offset + columnIndex + 1}`).join(',')})`;
  });

  return {
    text: `
      INSERT INTO medicines (
        source_id, name, price, is_discontinued, manufacturer_name,
        medicine_type, pack_size_label, short_composition1, short_composition2
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (source_id) DO UPDATE SET
        name = EXCLUDED.name,
        price = EXCLUDED.price,
        is_discontinued = EXCLUDED.is_discontinued,
        manufacturer_name = EXCLUDED.manufacturer_name,
        medicine_type = EXCLUDED.medicine_type,
        pack_size_label = EXCLUDED.pack_size_label,
        short_composition1 = EXCLUDED.short_composition1,
        short_composition2 = EXCLUDED.short_composition2,
        updated_at = NOW()
    `,
    values,
  };
}

async function main() {
  const contents = await fs.readFile(inputPath, 'utf8');
  const sourceRows = JSON.parse(contents);
  if (!Array.isArray(sourceRows)) {
    throw new Error('Medicine data must be a JSON array');
  }

  const medicines = sourceRows.map(parseMedicine);
  const uniqueIds = new Set(medicines.map(row => row[0]));
  if (uniqueIds.size !== medicines.length) {
    throw new Error('Medicine data contains duplicate ids');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS medicines (
        source_id BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
        is_discontinued BOOLEAN NOT NULL DEFAULT FALSE,
        manufacturer_name TEXT NOT NULL DEFAULT '',
        medicine_type TEXT NOT NULL DEFAULT '',
        pack_size_label TEXT NOT NULL DEFAULT '',
        short_composition1 TEXT NOT NULL DEFAULT '',
        short_composition2 TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicines_name_search_idx
      ON medicines (LOWER(name) text_pattern_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicines_manufacturer_search_idx
      ON medicines (LOWER(manufacturer_name) text_pattern_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicines_composition1_search_idx
      ON medicines (LOWER(short_composition1) text_pattern_ops)
    `);

    for (let start = 0; start < medicines.length; start += batchSize) {
      const batch = medicines.slice(start, start + batchSize);
      await client.query(buildUpsert(batch));
      const completed = Math.min(start + batch.length, medicines.length);
      if (completed % 25_000 === 0 || completed === medicines.length) {
        console.log(`Imported ${completed.toLocaleString()} of ${medicines.length.toLocaleString()} medicines`);
      }
    }

    await client.query('COMMIT');
    const result = await client.query('SELECT COUNT(*)::integer AS count FROM medicines');
    console.log(`Medicine import complete. Table contains ${result.rows[0].count.toLocaleString()} rows.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('Medicine import failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
