import type { AppRole } from '@/lib/roles';

const MAX_WAGE = 10000;

export interface WageCaller {
  role: AppRole;
  propertyAccess: string[];
}

export function callerManagesProperty(caller: WageCaller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

export function validateWage(value: unknown): { error?: string; value?: number | null } {
  if (value === null || value === undefined) return { value: null };
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) return { error: 'hourlyWage must be a number or null' };
  if (numeric < 0) return { error: 'hourlyWage cannot be negative' };
  if (numeric > MAX_WAGE) return { error: `hourlyWage cannot exceed ${MAX_WAGE}` };
  return { value: Math.round(numeric * 100) / 100 };
}
