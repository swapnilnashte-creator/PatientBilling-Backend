// Vaccination helpers: the starter schedule and the working-out of what is given, due, overdue or coming up for one patient.
// Dates are plain 'YYYY-MM-DD' strings in India time, so nothing depends on the server's time zone.

export const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const DAY = 864e5;
const ms = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const addDays = (iso, days) => new Date(ms(iso) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (fromIso, toIso) => Math.round((ms(toIso) - ms(fromIso)) / DAY);

// The standard WhatsApp reminder. {patient} {hospital} {vaccine} {dose} {status} {when} {vaccines} are filled in for each patient.
export const DEFAULT_REMINDER_MESSAGE = "Hello, this is {hospital}. {patient}'s vaccine is {status}: {vaccine} ({dose}), {when}. Please call us to book a visit.";

// A STARTER schedule for children, loaded as a draft. A doctor or the Admin must review and approve it before due dates are shown.
// [name, protects against, price, [[dose label, due age in days, earliest age in days, minimum gap after the previous dose]]]
const WEEK = 7; const MONTH = 30; const YEAR = 365;
export const STARTER_VACCINES = [
  ['BCG', 'Tuberculosis', [['Birth', 0, 0, 0]]],
  ['Hepatitis B', 'Hepatitis B', [['Birth', 0, 0, 0], ['6 weeks', 6 * WEEK, 6 * WEEK, 28], ['6 months', 6 * MONTH, 6 * MONTH, 60]]],
  ['OPV (oral polio)', 'Polio', [['Birth', 0, 0, 0], ['6 weeks', 6 * WEEK, 6 * WEEK, 28], ['10 weeks', 10 * WEEK, 10 * WEEK, 28], ['14 weeks', 14 * WEEK, 14 * WEEK, 28]]],
  ['DTwP / DTaP', 'Diphtheria, tetanus, pertussis', [['6 weeks', 6 * WEEK, 6 * WEEK, 0], ['10 weeks', 10 * WEEK, 10 * WEEK, 28], ['14 weeks', 14 * WEEK, 14 * WEEK, 28], ['Booster 1 (16–18 months)', 17 * MONTH, 15 * MONTH, 180], ['Booster 2 (4–6 years)', 5 * YEAR, 4 * YEAR, 180]]],
  ['IPV (injectable polio)', 'Polio', [['6 weeks', 6 * WEEK, 6 * WEEK, 0], ['14 weeks', 14 * WEEK, 14 * WEEK, 28], ['Booster (16–18 months)', 17 * MONTH, 15 * MONTH, 180]]],
  ['Hib', 'Haemophilus influenzae type b', [['6 weeks', 6 * WEEK, 6 * WEEK, 0], ['10 weeks', 10 * WEEK, 10 * WEEK, 28], ['14 weeks', 14 * WEEK, 14 * WEEK, 28], ['Booster (16–18 months)', 17 * MONTH, 15 * MONTH, 180]]],
  ['Rotavirus', 'Rotavirus diarrhoea', [['6 weeks', 6 * WEEK, 6 * WEEK, 0], ['10 weeks', 10 * WEEK, 10 * WEEK, 28], ['14 weeks', 14 * WEEK, 14 * WEEK, 28]]],
  ['PCV', 'Pneumococcal disease', [['6 weeks', 6 * WEEK, 6 * WEEK, 0], ['14 weeks', 14 * WEEK, 14 * WEEK, 28], ['Booster (9–12 months)', 12 * MONTH, 9 * MONTH, 60]]],
  ['MMR', 'Measles, mumps, rubella', [['9 months', 9 * MONTH, 9 * MONTH, 0], ['15 months', 15 * MONTH, 12 * MONTH, 28]]],
  ['Varicella', 'Chickenpox', [['15 months', 15 * MONTH, 12 * MONTH, 0], ['4–6 years', 5 * YEAR, 15 * MONTH, 90]]],
  ['Hepatitis A', 'Hepatitis A', [['12 months', 12 * MONTH, 12 * MONTH, 0], ['18 months', 18 * MONTH, 18 * MONTH, 180]]],
  ['Typhoid conjugate', 'Typhoid', [['12 months', 12 * MONTH, 6 * MONTH, 0]]],
  ['Influenza', 'Influenza (repeat every year)', [['6 months', 6 * MONTH, 6 * MONTH, 0], ['7 months', 7 * MONTH, 6 * MONTH, 28]]],
  ['HPV', 'Cervical cancer and others', [['9 years', 9 * YEAR, 9 * YEAR, 0], ['9 years + 6 months', 9 * YEAR + 180, 9 * YEAR, 150]]],
  ['Td / Tdap', 'Tetanus, diphtheria, pertussis', [['10 years', 10 * YEAR, 9 * YEAR, 0], ['16 years', 16 * YEAR, 15 * YEAR, 365]]],
];

const PENDING_HORIZON_DAYS = 730; // doses further away than this are not listed yet
const CHILD_UNTIL_DAYS = 18 * YEAR; // the child schedule stops being applied to a patient once they are 18

// What the patient's vaccine list looks like today.
// dob: 'YYYY-MM-DD'. vaccines: [{id,name,protects_against,group_key,price,is_active,doses:[{dose_no,label,due_age_days,min_age_days,min_gap_days}]}].
// records: rows of patient_vaccinations with given_on as 'YYYY-MM-DD'.
export function workOutSchedule({ dob, vaccines, records, today = todayIst() }) {
  const ageDays = dob ? daysBetween(dob, today) : null;
  const byKey = new Map(records.map(r => [`${r.vaccine_id}:${r.dose_no}`, r]));
  const items = [];
  for (const v of vaccines) {
    const doses = [...(v.doses || [])].sort((a, b) => a.dose_no - b.dose_no);
    const seen = new Set();
    let previousDate = null; // date of the latest dose given before this one
    for (const d of doses) {
      seen.add(d.dose_no);
      const rec = byKey.get(`${v.id}:${d.dose_no}`);
      if (rec) {
        items.push({ kind: 'RECORD', vaccineId: v.id, name: v.name, group: v.group_key, doseNo: d.dose_no, label: d.label, status: rec.status, record: rec });
        if (rec.status !== 'SKIPPED' && rec.given_on) previousDate = rec.given_on; // a dose with no known date does not move the next one
        continue;
      }
      if (!v.is_active || !dob || v.group_key !== 'CHILD') continue;
      if (ageDays !== null && ageDays >= CHILD_UNTIL_DAYS) continue;
      let due = addDays(dob, d.due_age_days);
      if (previousDate) { const gap = addDays(previousDate, d.min_gap_days); if (gap > due) due = gap; }
      const left = daysBetween(today, due);
      const status = left < 0 ? 'OVERDUE' : left <= 7 ? 'DUE_SOON' : 'UPCOMING';
      if (status === 'UPCOMING' && left > PENDING_HORIZON_DAYS) continue;
      items.push({ kind: 'PENDING', vaccineId: v.id, name: v.name, group: v.group_key, doseNo: d.dose_no, label: d.label, status, dueOn: due, daysLeft: left, earliestOn: addDays(dob, d.min_age_days) });
    }
    // doses recorded outside the schedule (for example an adult or travel vaccine)
    for (const r of records.filter(x => x.vaccine_id === v.id && !seen.has(x.dose_no)).sort((a, b) => a.dose_no - b.dose_no)) {
      items.push({ kind: 'RECORD', vaccineId: v.id, name: v.name, group: v.group_key, doseNo: r.dose_no, label: `Dose ${r.dose_no}`, status: r.status, record: r });
    }
  }
  const count = (s) => items.filter(i => i.status === s).length;
  return { items, summary: { given: count('GIVEN') + count('GIVEN_ELSEWHERE'), overdue: count('OVERDUE'), dueSoon: count('DUE_SOON'), upcoming: count('UPCOMING'), skipped: count('SKIPPED') } };
}
