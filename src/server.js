import app from './app.js';
import { pool } from './db.js';
import 'dotenv/config';
import { cleanOldLogs, watchProcessErrors } from './errorLog.js';
import { sendingScope, whatsappConfigured, whatsappPlatformOn } from './whatsappApi.js';
import { startReminderTimer } from './whatsappReminders.js';

watchProcessErrors();
cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000).unref();

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
    const server = app.listen(port, host, () => {
      console.log(`API listening on ${host}:${port}`);
      whatsappPlatformOn().then(on => console.log(`WhatsApp messages (Meta): ${on ? 'on' : 'paused (Super Admin > Pricing)'}${whatsappConfigured() ? '' : ', WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing in .env'}. Real messages go to: ${sendingScope()}`));
    });
    // Keep idle connections open longer than a reverse proxy does (usually 60 s). Node's default is 5 s, so the proxy
    // would reuse a connection Node had just closed and the browser would show "Failed to fetch" on the first try.
    startReminderTimer(); // WhatsApp reminders through Meta: checks every 10 minutes, sends only for hospitals with messages on
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });
