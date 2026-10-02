import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const name = String(args.name || '').trim();
const email = String(args.email || '').trim().toLowerCase();
const password = String(args.password || '');

if (name.length < 2 || !email.includes('@') || password.length < 6) {
  console.error("Usage: npm run create-superuser -- --name \"Platform Admin\" --email admin@example.com --password \"minimum-6-characters\"");
  process.exit(1);
}

try {
  const conflict = await pool.query(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [email]);
  if (conflict.rowCount) throw new Error('This email is already used by a hospital user; choose a separate platform email');
  const hash = await bcrypt.hash(password, 12);
  const q = await pool.query(
    `INSERT INTO platform_superusers(name,email,password_hash)
     VALUES($1,$2,$3)
     ON CONFLICT (email) DO UPDATE
       SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,is_active=TRUE,updated_at=NOW()
     RETURNING id,name,email,is_active`,
    [name, email, hash]
  );
  console.log('Super Admin ready:', q.rows[0].email);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
