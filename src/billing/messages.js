// WhatsApp messages (Meta API) on hospital invoices.
// Each message keeps the rate in force when it was sent, so a rate change never re-prices messages already sent.
// A period invoice charges every message of the hospital that is not on an invoice yet and was sent on or before the cut-off day:
// the end of the billing period, or yesterday if the period has not ended (annual invoices are raised at the start of the year).
// Failed messages are never charged. Cancelling an invoice frees its messages for the next one.
import { pool } from '../db.js';
import { addDays, round2, todayString } from './pricing.js';

export async function currentMessageRate(db = pool) {
  const q = await db.query(`SELECT id,rate,reason,created_at FROM platform_message_rates ORDER BY created_at DESC,id DESC LIMIT 1`);
  return q.rows[0] ? Number(q.rows[0].rate) : 0.125;
}

export const messagesCutoff = (periodEnd, today = todayString()) => {
  const yesterday = addDays(today, -1);
  return periodEnd < yesterday ? periodEnd : yesterday;
};

// [{ rate, count }] → count and amount
const sum = (groups) => ({
  count: groups.reduce((s, g) => s + g.count, 0),
  amount: round2(groups.reduce((s, g) => s + g.rate * g.count, 0)),
  detail: groups,
});

/** Messages the hospital has not been billed for, up to the cut-off day (India time). A draft being edited counts its own messages too. */
export async function messagesToBill(db, hospitalId, upto, invoiceId = null) {
  const q = await db.query(
    `SELECT rate::float8 AS rate,COUNT(*)::int AS count FROM whatsapp_messages
     WHERE hospital_id=$1 AND status<>'FAILED' AND (sent_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
       AND (invoice_id IS NULL OR invoice_id=$3::bigint)
     GROUP BY rate ORDER BY rate`, [hospitalId, upto, invoiceId]);
  return { upto, ...sum(q.rows.map(r => ({ rate: Number(r.rate), count: r.count }))) };
}

/** Puts the messages on the invoice (inside the invoice's transaction) and returns what was charged. */
export async function attachMessages(client, invoiceId, hospitalId, upto) {
  await client.query(`UPDATE whatsapp_messages SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
  const q = await client.query(
    `UPDATE whatsapp_messages SET invoice_id=$1
     WHERE hospital_id=$2 AND status<>'FAILED' AND invoice_id IS NULL AND (sent_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
     RETURNING rate::float8 AS rate`, [invoiceId, hospitalId, upto]);
  const groups = new Map();
  for (const r of q.rows) groups.set(Number(r.rate), (groups.get(Number(r.rate)) || 0) + 1);
  return { upto, ...sum([...groups].sort((a, b) => a[0] - b[0]).map(([rate, count]) => ({ rate, count }))) };
}

export async function releaseMessages(client, invoiceId) {
  await client.query(`UPDATE whatsapp_messages SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
}
