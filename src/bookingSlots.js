// Slot arithmetic for online appointments. Every day and time here is India time (Asia/Kolkata, no daylight saving, +05:30).
import { pool } from './db.js';
import { addDays, todayIst } from './vaccination.js';

export const SLOT_ZONE = 'Asia/Kolkata';

const pad = (n) => String(n).padStart(2, '0');
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

// 0 = Sunday ... 6 = Saturday, for a calendar day written as YYYY-MM-DD
export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

export const slotInstant = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);

// The India day and time of a moment
export const istDay = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: SLOT_ZONE });
export const istTime = (date) => new Date(date).toLocaleTimeString('en-GB', { timeZone: SLOT_ZONE, hour12: false, hour: '2-digit', minute: '2-digit' });

// The hospital's own clinic hours (Hospital Settings > Timings): weekly off days and up to two sessions, [{ from, to }] as "HH:MM".
// Online booking stays inside them: no slot on a closed day, and none outside the open sessions (when sessions are set).
export async function hospitalHours(hospitalId, db = pool) {
  const q = await db.query('SELECT weekly_off,timings FROM hospitals WHERE id=$1', [hospitalId]);
  const row = q.rows[0] || {};
  const sessions = (Array.isArray(row.timings?.sessions) ? row.timings.sessions : []).filter(x => x?.from && x?.to);
  return { weeklyOff: (row.weekly_off || []).map(Number), sessions };
}
export const hospitalOpenOn = (weekday, hours) => !hours.weeklyOff.includes(Number(weekday));
// does a timing (start, end as "HH:MM") on this weekday sit inside the hospital's hours?
export function insideHospital(weekday, start, end, hours) {
  if (!hospitalOpenOn(weekday, hours)) return false;
  if (!hours.sessions.length) return true;
  return hours.sessions.some(x => start >= x.from && end <= x.to);
}

// schedule rows: [{ weekday, start, end, slotMinutes, perSlot }] with start/end as "HH:MM".
// Returns the slots of one day: [{ time: "09:15", perSlot }]
export function slotsOfDay(day, schedules, hours = null) {
  const out = new Map();
  if (hours && !hospitalOpenOn(weekdayOf(day), hours)) return [];
  for (const row of schedules.filter(s => Number(s.weekday) === weekdayOf(day))) {
    const step = Number(row.slotMinutes);
    for (let t = minutesOf(row.start); t + step <= minutesOf(row.end); t += step) {
      const time = hhmmOf(t);
      if (hours && !insideHospital(weekdayOf(day), time, hhmmOf(t + step), hours)) continue;
      out.set(time, { time, perSlot: Math.max(Number(row.perSlot) || 1, out.get(time)?.perSlot || 0) });
    }
  }
  return [...out.values()].sort((a, b) => a.time.localeCompare(b.time));
}

// The days a patient may book, today first
export function bookableDays(advanceDays) {
  const today = todayIst();
  return Array.from({ length: advanceDays }, (_, i) => addDays(today, i));
}
