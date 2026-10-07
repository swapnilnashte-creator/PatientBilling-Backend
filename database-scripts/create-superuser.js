import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { normalizeMobile } from '../src/mobile.js';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const name = String(args.name || '').trim();
const mobile = normalizeMobile(args.mobile);
const email = String(args.email || '').trim().toLowerCase();
const password = String(args.password || '');

if (name.length < 2 || !/^\d{10}$/.test(mobile) || !email.includes('@') || password.length < 6) {
  console.error("Usage: npm run create-superuser -- --name \"Platform Admin\" --mobile 9999999999 --email admin@example.com --password \"minimum-6-characters\"");
  process.exit(1);
}

try {
  const conflict = await pool.query(`SELECT 1 FROM users WHERE mobile=$1`, [mobile]);
  if (conflict.rowCount) throw new Error('This mobile number is already used by a hospital user; choose a separate platform mobile');
  const hash = await bcrypt.hash(password, 12);
  const q = await pool.query(
    `INSERT INTO platform_superusers(name,mobile,email,password_hash)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (mobile) DO UPDATE
       SET name=EXCLUDED.name,email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,is_active=TRUE,updated_at=NOW()
     RETURNING id,name,mobile,email,is_active`,
    [name, mobile, email, hash]
  );
  console.log('Super Admin ready:', q.rows[0].mobile);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
