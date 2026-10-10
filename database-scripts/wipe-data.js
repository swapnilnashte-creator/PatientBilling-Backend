// Wipes all hospital and activity data and keeps only the master data.
//
//   npm run wipe-data                 shows what would be deleted (nothing is changed)
//   npm run wipe-data -- --yes        saves a JSON backup, then deletes
//   npm run wipe-data -- --yes --no-backup
//   npm run wipe-data -- --yes --allow-production     (required when NODE_ENV=production)
//
// KEPT (master data): the medicine catalogue, rate plans, Super Admin logins, platform company / payment details.
// DELETED: every other table - hospitals, users, patients, visits, prescriptions, bills, payments, expenses,
// subscription invoices, audit logs. Ids start again from 1 and the invoice number counter restarts.
// After a wipe, register hospitals again (or create the Super Admin with `npm run create-superuser` if it was removed).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const KEEP = new Set([
  'medicines',
  'medicine_product_catalog',
  'platform_rate_plans',
  'platform_superusers',
  'platform_billing_company',
]);

const args = new Set(process.argv.slice(2));
const confirmed = args.has('--yes');
const backup = !args.has('--no-backup');
const here = path.dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV === 'production' && !args.has('--allow-production')) {
  console.error('Refusing to run with NODE_ENV=production. Add --allow-production if you really mean it.');
  process.exit(1);
}

const client = await pool.connect();
try {
  const all = (await client.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`)).rows.map(r => r.name);
  const missing = [...KEEP].filter(t => !all.includes(t));
  if (missing.length) console.log(`Note: master tables not present in this database: ${missing.join(', ')}`);
  const wipe = all.filter(t => !KEEP.has(t));
  const keep = all.filter(t => KEEP.has(t));

  // a kept table must never point at a wiped one, or the cascade would delete master data
  const fk = await client.query(`
    SELECT con.conrelid::regclass::text AS from_table, con.confrelid::regclass::text AS to_table
    FROM pg_constraint con WHERE con.contype='f' AND con.connamespace='public'::regnamespace`);
  const bad = fk.rows.filter(r => keep.includes(r.from_table.replace(/"/g, '')) && wipe.includes(r.to_table.replace(/"/g, '')));
  if (bad.length) { console.error('Stopped: master tables reference tables that would be wiped:', JSON.stringify(bad)); process.exit(1); }

  const count = async (t) => (await client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)).rows[0].n;
  console.log('\nWill DELETE:');
  let total = 0;
  for (const t of wipe) { const n = await count(t); total += n; console.log(`  ${t.padEnd(32)} ${String(n).padStart(8)} rows`); }
  console.log('\nWill KEEP:');
  for (const t of keep) console.log(`  ${t.padEnd(32)} ${String(await count(t)).padStart(8)} rows`);
  console.log(`\n${total} rows in ${wipe.length} tables will be deleted.`);

  if (!confirmed) { console.log('\nDry run only. Nothing was changed. Run again with --yes to wipe.'); process.exit(0); }

  if (backup) {
    const dir = path.join(here, '..', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    for (const t of wipe) {
      const rows = (await client.query(`SELECT * FROM "${t}"`)).rows;
      if (rows.length) fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows, null, 1));
    }
    console.log(`\nBackup of the deleted data saved in ${dir}`);
    console.log('It holds patient data: keep it private and delete it when you no longer need it.');
  }

  await client.query('BEGIN');
  await client.query(`TRUNCATE ${wipe.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // counters that are not owned by a column (for example the invoice number)
  const seqs = await client.query(`
    SELECT s.relname AS name FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
    WHERE s.relkind='S' AND n.nspname='public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=s.oid AND d.deptype IN ('a','i'))`);
  for (const s of seqs.rows) await client.query(`ALTER SEQUENCE "${s.name}" RESTART WITH 1`);
  await client.query('COMMIT');

  console.log('\nDone. Remaining rows:');
  for (const t of all) console.log(`  ${t.padEnd(32)} ${String(await count(t)).padStart(8)}`);
  if (seqs.rows.length) console.log(`\nReset counters: ${seqs.rows.map(s => s.name).join(', ')}`);
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* not in a transaction */ }
  console.error('\nFailed, nothing was deleted:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
