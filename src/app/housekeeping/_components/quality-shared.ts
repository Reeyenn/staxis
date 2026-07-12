// Pure helpers + shared types for the Quality & Performance tab, split out
// of QualityTab.tsx (June-2026 "Command" layout) so the Inspections and
// Performance modules can share them without a circular import through the
// orchestrator. NOTHING here changes behavior — every function is a verbatim
// move of the helper that used to live inline in QualityTab.tsx.
//
// parseLocalDate is intentionally NOT here: it's a documented faithful port
// in src/lib/format-date.ts, which QualityTab imports directly.

import type { InspectionItemSeverity } from '@/types/inspections';

// ─── Inspection drawer draft state ─────────────────────────────────────────

export type SeverityValue = InspectionItemSeverity | 'pass' | null;

export interface ItemDraft {
  state: SeverityValue;
  note: string;
  photoUrl: string | null;
  photoPath: string | null;
  uploading: boolean;
}

// ─── Performance leaderboard ───────────────────────────────────────────────

export interface StaffStats {
  staffId: string;
  name: string;
  total: number;
  avgMins: number;
  avgCheckout: number | null;
  avgS1: number | null;
  avgS2: number | null;
}

export type ViewMode = 'live' | '7d' | '30d' | '3mo' | '1yr';
export const VIEW_DAYS: Record<ViewMode, number> = { live: 1, '7d': 7, '30d': 30, '3mo': 90, '1yr': 365 };
export const LEADERBOARD_MIN_ROOMS = 3;

// Plan-v4 PMS rooms carry a synthetic composite id ("YYYY-MM-DD:roomNumber",
// see pms-rooms-server.composeRoomId), not a UUID. The inspections /start
// route validates roomId as a UUID and 400s on anything else, so only forward
// it when it's a real UUID — the flow otherwise keys on roomNumber, and the
// inspection row stores roomId=null harmlessly.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function tr(lang: 'en' | 'es', en: string, es: string): string {
  return lang === 'es' ? es : en;
}

// Decimal-minute format ("21.4m") — matches the design typography.
export function fmtDec(mins: number | null | undefined): string {
  if (mins == null || !isFinite(mins)) return '—';
  return `${mins.toFixed(1)}m`;
}

// Coerces startedAt/completedAt for the CSV export. The CleaningEvent type
// narrows to Date in TS, but Supabase row mappers occasionally forward an
// ISO string (legacy rows that bypass the mapper); .toISOString() on a
// string throws mid-export, so accept both (+ Firestore .toDate()).
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

// "12m" / "3h" / "2d" relative label from an ISO timestamp.
export function relAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return null; // → caller renders "just now"
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function categoryLabel(cat: string, lang: 'en' | 'es'): string {
  const map: Record<string, [string, string]> = {
    bathroom: ['Bathroom', 'Baño'],
    bedroom:  ['Bedroom', 'Dormitorio'],
    living:   ['Living', 'Sala'],
    kitchen:  ['Kitchen', 'Cocina'],
    welcome:  ['Welcome', 'Recepción'],
    other:    ['Other', 'Otro'],
  };
  const pair = map[cat] ?? [cat, cat];
  return lang === 'es' ? pair[1] : pair[0];
}
