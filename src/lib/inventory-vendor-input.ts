import { isValidEmail, validateString } from '@/lib/api-validate';
import type { VendorInput } from '@/lib/ordering/db';

export function parseInventoryVendorFields(
  body: Record<string, unknown>,
  requireName: boolean,
): { input?: VendorInput; error?: string } {
  const input: Partial<VendorInput> = {};
  if (requireName || body.name !== undefined) {
    const candidate = typeof body.name === 'string' ? body.name.trim() : body.name;
    const nameV = validateString(candidate, { label: 'name', max: 120, min: 1 });
    if (nameV.error) return { error: nameV.error };
    input.name = nameV.value;
  }
  if (body.email !== undefined) {
    const email = body.email;
    if (email === null || email === '') input.email = null;
    else if (typeof email !== 'string' || !isValidEmail(email.trim())) return { error: 'invalid email' };
    else input.email = email.trim();
  }

  const optionalText = (
    key: 'phone' | 'accountNumber' | 'notes',
    max: number,
  ): string | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null || value === '') {
      input[key] = null;
      return undefined;
    }
    if (typeof value !== 'string') return `${key} must be a string or null`;
    const trimmed = value.trim();
    if (trimmed.length > max) return `${key} too long (max ${max} chars)`;
    input[key] = trimmed || null;
    return undefined;
  };
  const phoneError = optionalText('phone', 40);
  if (phoneError) return { error: phoneError };
  const accountError = optionalText('accountNumber', 80);
  if (accountError) return { error: accountError };
  const notesError = optionalText('notes', 1000);
  if (notesError) return { error: notesError };

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'isActive must be a boolean' };
    input.isActive = body.isActive;
  }
  return { input: input as VendorInput };
}
