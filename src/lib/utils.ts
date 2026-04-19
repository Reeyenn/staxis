import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string, fmt = 'yyyy-MM-dd'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, fmt);
}

// Hard-code Central time so "today" on the HK page matches what the Texas
// scraper writes, regardless of whose phone or laptop is opening the page.
// en-CA gives us the ISO YYYY-MM-DD format directly.
const APP_TIMEZONE = 'America/Chicago';

export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(new Date());
}

export function yesterdayStr(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(d);
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatPercent(n: number): string {
  return `${Math.round(n)}%`;
}

export const FLOOR_LABELS: Record<string, string> = {
  '1': 'Floor 1',
  '2': 'Floor 2',
  '3': 'Floor 3',
  '4': 'Floor 4',
  'exterior': 'Exterior',
};

export const FLOOR_LABELS_ES: Record<string, string> = {
  '1': 'Piso 1',
  '2': 'Piso 2',
  '3': 'Piso 3',
  '4': 'Piso 4',
  'exterior': 'Exterior',
};

export function getFloorLabel(floor: string, lang: 'en' | 'es' = 'en'): string {
  return lang === 'es' ? FLOOR_LABELS_ES[floor] ?? floor : FLOOR_LABELS[floor] ?? floor;
}

export function timeAgo(date: Date | null | undefined): string {
  if (!date) return '';
  const now = Date.now();
  const d = date instanceof Date ? date.getTime() : new Date(date as unknown as string).getTime();
  const seconds = Math.floor((now - d) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Validate YYYY-MM-DD date string */
export function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}
