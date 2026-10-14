// The standard certificate types. The wording uses {{placeholders}}:
//   patient details  {{patient}} {{age}} {{sex}} {{he_she}} {{He_She}} {{his_her}} {{today}} {{doctor}}
//   the fields below by their key, with an optional fallback: {{diagnosis|an illness}}
//   {{days}} is worked out from the "from" and "to" dates.
// A hospital can save its own wording for any type; the fields stay as defined here.
export const CERTIFICATE_TYPES = [
  {
    key: 'sick', code: 'MC', name: 'Medical (sick) leave', description: 'Rest advised for a number of days',
    title: 'Medical Certificate',
    fields: [
      { key: 'from', label: 'From', kind: 'date', offset: 0, required: true },
      { key: 'to', label: 'To', kind: 'date', offset: 2, required: true },
      { key: 'diagnosis', label: 'Diagnosis (optional)', kind: 'textarea' },
      { key: 'resume', label: 'Fit to resume duties on', kind: 'date', offset: 3, required: true },
    ],
    body: 'This is to certify that {{patient}}, aged {{age}}, was examined by me on {{today}} and is suffering from {{diagnosis|an illness}}. {{He_She}} has been advised complete rest from {{from}} to {{to}} ({{days}} days). {{He_She}} is fit to resume duties from {{resume}}.',
  },
  {
    key: 'fit', code: 'FC', name: 'Fitness certificate', description: 'Fit for work, school, sports or travel',
    title: 'Fitness Certificate',
    fields: [
      { key: 'fit_for', label: 'Fit for', kind: 'select', options: ['work', 'school', 'sports', 'travel', 'general activity'], required: true },
      { key: 'valid_until', label: 'Valid until', kind: 'date', offset: 365, required: true },
      { key: 'remarks', label: 'Remarks (optional)', kind: 'textarea' },
    ],
    body: 'This is to certify that {{patient}}, aged {{age}}, has been examined by me on {{today}} and is found to be physically and mentally fit for {{fit_for}}. {{remarks}} This certificate is valid until {{valid_until}}.',
  },
  {
    key: 'treat', code: 'TC', name: 'Treatment certificate', description: 'Confirms the illness and treatment given',
    title: 'Treatment Certificate',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis', kind: 'textarea', required: true },
      { key: 'since', label: 'Under treatment since', kind: 'date', offset: 0, required: true },
      { key: 'treatment', label: 'Treatment given (optional)', kind: 'textarea' },
    ],
    body: 'This is to certify that {{patient}}, aged {{age}}, is under my treatment since {{since}} for {{diagnosis}}. Treatment given: {{treatment|medication and rest}}.',
  },
  {
    key: 'ext', code: 'MC', name: 'Rest / leave extension', description: 'Extends an earlier leave certificate',
    title: 'Medical Certificate (Extension)',
    fields: [
      { key: 'prev_no', label: 'Earlier certificate number', kind: 'text', required: true },
      { key: 'upto', label: 'Extended up to', kind: 'date', offset: 5, required: true },
      { key: 'reason', label: 'Reason', kind: 'textarea', required: true },
    ],
    body: 'This is to certify that {{patient}}, aged {{age}}, who was granted leave by certificate {{prev_no}}, needs further rest up to {{upto}} due to {{reason}}.',
  },
  {
    key: 'vac', code: 'VC', name: 'Vaccination certificate', description: 'Vaccine, dose and date given',
    title: 'Vaccination Certificate',
    fields: [
      { key: 'vaccine', label: 'Vaccine', kind: 'text', required: true },
      { key: 'dose', label: 'Dose', kind: 'text', required: true },
      { key: 'given', label: 'Given on', kind: 'date', offset: 0, required: true },
      { key: 'batch', label: 'Batch number (optional)', kind: 'text' },
    ],
    body: 'This is to certify that {{patient}}, aged {{age}}, was administered {{vaccine}} ({{dose}}) on {{given}}. Batch number: {{batch|not recorded}}.',
  },
];

export const typeByKey = (key) => CERTIFICATE_TYPES.find(t => t.key === key);
