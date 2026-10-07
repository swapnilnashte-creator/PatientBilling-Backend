import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultInputPath = path.resolve(scriptDirectory, '..', 'medicine_data.csv');
const inputPath = path.resolve(process.argv[2] || defaultInputPath);
const batchSize = 250;
const expectedColumns = [
  'sub_category',
  'product_name',
  'salt_composition',
  'product_price',
  'product_manufactured',
  'medicine_desc',
  'side_effects',
  'drug_interactions',
];

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function parsePrice(rawPrice, rowNumber) {
  const text = String(rawPrice ?? '').trim();
  if (!text) return null;

  const price = Number(text.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`Invalid product price at CSV row ${rowNumber + 1}`);
  }
  return price;
}

function parseInteractions(rawInteractions, rowNumber) {
  const text = String(rawInteractions ?? '').trim();
  if (!text) return {};

  try {
    const interactions = JSON.parse(text);
    if (!interactions || Array.isArray(interactions) || typeof interactions !== 'object') {
      throw new Error('value is not a JSON object');
    }
    return interactions;
  } catch (error) {
    throw new Error(`Invalid drug interactions JSON at CSV row ${rowNumber + 1}: ${error.message}`);
  }
}

function normalizeRecord(record, rowNumber) {
  const productName = String(record.product_name ?? '').trim();
  if (!productName) {
    throw new Error(`Missing product name at CSV row ${rowNumber + 1}`);
  }

  return [
    rowNumber,
    String(record.sub_category ?? '').trim(),
    productName,
    String(record.salt_composition ?? '').trim(),
    parsePrice(record.product_price, rowNumber),
    String(record.product_manufactured ?? '').trim(),
    String(record.medicine_desc ?? '').trim(),
    String(record.side_effects ?? '').trim(),
    JSON.stringify(parseInteractions(record.drug_interactions, rowNumber)),
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
      INSERT INTO medicine_product_catalog (
        source_row_number, sub_category, product_name, salt_composition,
        product_price, manufacturer_name, medicine_description, side_effects,
        drug_interactions
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (source_row_number) DO UPDATE SET
        sub_category = EXCLUDED.sub_category,
        product_name = EXCLUDED.product_name,
        salt_composition = EXCLUDED.salt_composition,
        product_price = EXCLUDED.product_price,
        manufacturer_name = EXCLUDED.manufacturer_name,
        medicine_description = EXCLUDED.medicine_description,
        side_effects = EXCLUDED.side_effects,
        drug_interactions = EXCLUDED.drug_interactions,
        updated_at = NOW()
    `,
    values,
  };
}

async function main() {
  const client = await pool.connect();
  let imported = 0;
  let batch = [];

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS medicine_product_catalog (
        source_row_number INTEGER PRIMARY KEY CHECK (source_row_number > 0),
        sub_category TEXT NOT NULL DEFAULT '',
        product_name TEXT NOT NULL,
        salt_composition TEXT NOT NULL DEFAULT '',
        product_price NUMERIC(12, 2) CHECK (product_price >= 0),
        manufacturer_name TEXT NOT NULL DEFAULT '',
        medicine_description TEXT NOT NULL DEFAULT '',
        side_effects TEXT NOT NULL DEFAULT '',
        drug_interactions JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const parser = createReadStream(inputPath).pipe(parse({
      bom: true,
      columns(header) {
        const columns = header.map(column => column.trim());
        if (columns.length !== expectedColumns.length || columns.some((column, index) => column !== expectedColumns[index])) {
          throw new Error(`Unexpected CSV columns: ${columns.join(', ')}`);
        }
        return columns;
      },
      skip_empty_lines: true,
    }));

    for await (const record of parser) {
      const sourceRowNumber = imported + 1;
      batch.push(normalizeRecord(record, sourceRowNumber));
      imported += 1;

      if (batch.length === batchSize) {
        await client.query(buildUpsert(batch));
        batch = [];
      }
      if (imported % 25_000 === 0) {
        console.log(`Imported ${imported.toLocaleString()} medicine products`);
      }
    }

    if (batch.length) {
      await client.query(buildUpsert(batch));
    }

    await client.query('DELETE FROM medicine_product_catalog WHERE source_row_number > $1', [imported]);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicine_product_catalog_name_search_idx
      ON medicine_product_catalog (LOWER(product_name) text_pattern_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicine_product_catalog_salt_search_idx
      ON medicine_product_catalog (LOWER(salt_composition) text_pattern_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicine_product_catalog_category_search_idx
      ON medicine_product_catalog (LOWER(sub_category) text_pattern_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS medicine_product_catalog_interactions_idx
      ON medicine_product_catalog USING GIN (drug_interactions)
    `);

    await client.query('COMMIT');
    const result = await client.query('SELECT COUNT(*)::integer AS count FROM medicine_product_catalog');
    console.log(`Medicine product import complete. Table contains ${result.rows[0].count.toLocaleString()} rows.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('Medicine product import failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
