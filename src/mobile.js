import { z } from 'zod';

export function normalizeMobile(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export const mobileSchema = z.string()
  .trim()
  .transform(normalizeMobile)
  .refine(value => /^\d{10}$/.test(value), 'Mobile number must be exactly 10 digits');
