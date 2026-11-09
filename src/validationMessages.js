// What a person reads when a form is refused for a field that is missing, too short or not valid.
// zod's own wording ("Too small: expected string to have >=2 characters") is turned into a plain sentence with the field's name.
// A message written on purpose in a schema (for example "Enter the height in cm") is kept as it is.

const LABELS = {
  name: 'Name', fullName: 'Name', mobile: 'Mobile number', whatsappMobile: 'WhatsApp number', whatsapp_mobile: 'WhatsApp number',
  email: 'Email', password: 'Password', confirmPassword: 'Confirm password', currentPassword: 'Current password', newPassword: 'New password',
  role: 'Role', speciality: 'Speciality', qualification: 'Qualification', registrationNo: 'Registration number',
  hospitalName: 'Hospital name', address: 'Address', city: 'City', state: 'State', pincode: 'Pincode', gender: 'Gender', age: 'Age', dateOfBirth: 'Date of birth', dob: 'Date of birth',
  amount: 'Amount', total: 'Total', price: 'Price', quantity: 'Quantity', description: 'Description', notes: 'Notes', reason: 'Reason', title: 'Title', category: 'Category',
  patientId: 'Patient', doctorId: 'Doctor', visitId: 'Visit', date: 'Date', startDate: 'Start date', endDate: 'End date', time: 'Time',
  weightKg: 'Weight', heightCm: 'Height', goalWeightKg: 'Goal weight', startWeightKg: 'Weight today',
};

const humanize = (key) => {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'This field';
};

export function fieldLabel(path) {
  const last = [...(path || [])].reverse().find(p => typeof p === 'string');
  if (!last) return 'This field';
  return LABELS[last] || humanize(last);
}

// zod's built-in messages all start like this; anything else was written by a person on purpose
const BUILT_IN = /^(Too small|Too big|Invalid input|Invalid string|Invalid option|Invalid number|Invalid (?:email|url|uuid|date|format)|Unrecognized key|Input not instance)/i;

export function friendlyIssue(issue) {
  if (!issue) return 'Invalid input';
  if (issue.message && !BUILT_IN.test(issue.message)) return issue.message;
  const label = fieldLabel(issue.path);
  const lower = label.toLowerCase();
  const missing = /received (undefined|null)/i.test(issue.message || '');
  switch (issue.code) {
    case 'too_small': {
      const n = Number(issue.minimum);
      if (issue.origin === 'string') return n <= 1 ? `${label} is required` : `${label} must be at least ${n} characters`;
      if (issue.origin === 'array' || issue.origin === 'set') return n <= 1 ? `Add at least one ${lower}` : `Add at least ${n} ${lower} items`;
      return issue.inclusive === false ? `${label} must be more than ${n}` : `${label} must be at least ${n}`;
    }
    case 'too_big': {
      const n = Number(issue.maximum);
      if (issue.origin === 'string') return `${label} is too long (at most ${n} characters)`;
      if (issue.origin === 'array' || issue.origin === 'set') return `${label} has too many items (at most ${n})`;
      return issue.inclusive === false ? `${label} must be less than ${n}` : `${label} must not be more than ${n}`;
    }
    case 'invalid_type': return missing ? `${label} is required` : `${label} is not valid`;
    case 'invalid_format': return issue.format === 'email' ? 'Enter a valid email address' : `${label} is not valid`;
    case 'invalid_value': return `Choose a valid ${lower}`;
    case 'unrecognized_keys': return 'Some of the details sent are not recognised';
    default: return `${label} is not valid`;
  }
}

export const friendlyZod = (err) => friendlyIssue(err?.issues?.[0]);
