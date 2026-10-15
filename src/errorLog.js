// Daily error log: every unexpected server error is appended to logs/error-YYYY-MM-DD.log (Indian date).
// A new file starts each day and files older than LOG_RETENTION_DAYS (default 30) are removed.
// Folder: LOG_DIR, or "logs" next to the backend. Request bodies are never written, so passwords stay out of the log.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(here, '..', 'logs');
const keepDays = Number(process.env.LOG_RETENTION_DAYS || 30);
const FILE = /^error-(\d{4}-\d{2}-\d{2})\.log$/;

const indiaDate = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const indiaTime = (date = new Date()) => date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

function describe(error) {
  if (!error) return 'Unknown error';
  const lines = [error.stack || `${error.name || 'Error'}: ${error.message || '(no message)'}`];
  if (error.code) lines.push(`code: ${error.code}`);
  // some errors (for example a database that cannot be reached) carry no message of their own, only inner errors
  if (Array.isArray(error.errors)) for (const inner of error.errors) lines.push(`  caused by: ${inner?.code || ''} ${inner?.message || inner}`.trimEnd());
  if (error.cause) lines.push(`  cause: ${error.cause?.stack || error.cause}`);
  return lines.join('\n');
}

// Writes one entry and returns a short reference that the person who saw the error can quote.
export function logError(error, context = {}) {
  const ref = randomBytes(3).toString('hex').toUpperCase();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const head = [`[${indiaTime(now)} IST] ref ${ref}`];
    if (context.method || context.url) head.push(`${context.method || ''} ${context.url || ''}`.trim());
    if (context.status) head.push(`status ${context.status}`);
    if (context.user) head.push(`user ${context.user}`);
    if (context.source) head.push(context.source);
    fs.appendFileSync(path.join(dir, `error-${indiaDate(now)}.log`), `${head.join(' | ')}\n${describe(error)}\n\n`);
  } catch (writeError) {
    console.error('Could not write the error log:', writeError.message);
  }
  return ref;
}

// Removes log files older than the retention period (run once at start-up and then every day).
export function cleanOldLogs() {
  try {
    if (!fs.existsSync(dir)) return;
    const oldest = indiaDate(new Date(Date.now() - keepDays * 864e5));
    for (const name of fs.readdirSync(dir)) {
      const match = FILE.exec(name);
      if (match && match[1] < oldest) fs.unlinkSync(path.join(dir, name));
    }
  } catch (error) {
    console.error('Could not clean old error logs:', error.message);
  }
}

// Also catch errors that happen outside a request (a crash, a rejected promise nobody handled).
export function watchProcessErrors() {
  process.on('unhandledRejection', (reason) => { logError(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' }); });
  process.on('uncaughtException', (error) => { logError(error, { source: 'uncaughtException' }); console.error(error); process.exit(1); });
}
