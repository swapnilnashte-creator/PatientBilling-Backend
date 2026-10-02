import app from './app.js';
import { pool } from './db.js';
import 'dotenv/config';

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

pool.query('SELECT 1')
  .then(() => {
    app.listen(port, host, () => console.log(`API listening on ${host}:${port}`));
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });
