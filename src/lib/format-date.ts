// Shared date/time formatters (staff-pages overhaul, F10).
//
// Each function is a FAITHFUL port of private helpers duplicated across
// src/app pages — outputs are call-for-call identical to the originals.
// Variants are deliberately NOT normalized: some originals parse YYYY-MM-DD
// as UTC, some render with 'es-US' vs 'es-ES' vs bare 'es' locales, one even
// renders a UTC instant in local time (a latent-but-shipped quirk we keep).
// Where two originals genuinely differ, options reproduce each exactly.
//
// Nothing here is imported by feature pages yet — consumers migrate in a
// later wave. The comment on each function lists the exact call sites it is
// meant to replace.
//
// Related pre-existing shared helpers (NOT duplicated here):
//   src/lib/schedule-board.ts — fmtTime('HH:MM' → '8a'), ymdOf/parseYmd/
//   addDaysYmd/daysBetween ('en-CA' local-YMD family).

import { format } from 'date-fns';
import type { Language } from './translations';

// ─── YYYY-MM-DD → local Date ────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string as a LOCAL date (never UTC — `new Date('2026-05-12')`
 * would parse as UTC and render as May 11 west of Greenwich).
 *
 * Replaces the two identical private copies:
 *   - housekeeping/_components/QualityTab.tsx   parseLocalDate()
 *   - housekeeping/_components/DeepCleanTab.tsx parseLocalDate()
 */
export function parseLocalDate(ymd: string | null | undefined): Date | null {
  if (!ymd) return null;
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// ─── shortDate ──────────────────────────────────────────────────────────────

export interface ShortDateOptions {
  /** 'month-day' → "JUL 4" style; 'month-year' → "Jul 2026" style. */
  fields: 'month-day' | 'month-year';
  /** Uppercase the result (CheckbookTab's ledger stamp look). */
  uppercase?: boolean;
}

/**
 * YYYY-MM-DD → short label, parsed AND rendered in UTC (timeZone: 'UTC'),
 * locale 'es-US' / 'en-US'. Non-matching input echoes back unchanged;
 * null/undefined → ''.
 *
 * Replaces (each with the exact options shown):
 *   - financials/_components/CheckbookTab.tsx shortDate()
 *       → shortDateFromYmd(ymd, lang, { fields: 'month-day', uppercase: true })  // "JUL 4"
 *   - financials/_components/CapexTab.tsx shortDate()
 *       → shortDateFromYmd(ymd, lang, { fields: 'month-year' })                  // "Jul 2026"
 * (CheckbookTab's original took a non-null string; passing null/'' returns ''
 *  — identical to what its regex fallback produced for ''.)
 */
export function shortDateFromYmd(
  ymd: string | null | undefined,
  lang: Language,
  opts: ShortDateOptions,
): string {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const label = d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    ...(opts.fields === 'month-day' ? { day: 'numeric' as const } : { year: 'numeric' as const }),
    timeZone: 'UTC',
  });
  return opts.uppercase ? label.toUpperCase() : label;
}

/**
 * Date object → "Jan 5" / "5 ene", rendered in LOCAL time with the
 * 'es-ES' / 'en-US' locale pair (inv-i18n's dateLocale()).
 *
 * Replaces:
 *   - inventory/_components/overlays/HistoryPanel.tsx shortDate()
 */
export function shortDateFromDate(d: Date, lang: Language): string {
  return d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric' });
}

// ─── fmtWhen ────────────────────────────────────────────────────────────────

/**
 * ISO timestamp → relative age: "today"/"hoy", "yesterday"/"ayer",
 * "3d ago"/"hace 3d" (< 7 days), else a LOCAL "Mar 5"/"5 mar" date
 * ('es-US' / 'en-US'). Invalid/null input → ''.
 *
 * Replaces the two byte-identical private copies:
 *   - front-desk/_components/LostFoundTab.tsx fmtWhen()
 *   - front-desk/_components/PackagesTab.tsx  fmtWhen()
 *
 * `now` defaults to Date.now() exactly like the originals; it is injectable
 * only so tests can pin it.
 */
export function fmtWhenAgo(iso: string | null | undefined, lang: Language, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return tr2(lang, 'today', 'hoy');
  if (days === 1) return tr2(lang, 'yesterday', 'ayer');
  if (days < 7) return tr2(lang, `${days}d ago`, `hace ${days}d`);
  return new Date(ms).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// Local copy of the EN/ES ternary so this module doesn't pull in i18n-utils
// (keeps the two foundation modules independently importable).
function tr2(lang: Language, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

/**
 * ISO timestamp → LOCAL "Mar 5, 3:30 PM" / "5 mar, 15:30" using the bare
 * 'es' / 'en' locales (note: NOT es-US/en-US — the original used the bare
 * tags and they can differ in hour-cycle). Invalid date → ''.
 *
 * Replaces:
 *   - dashboard/_components/LogBookCard.tsx fmtWhen(iso, es: boolean)
 *     (the boolean second arg becomes lang: es === true → 'es')
 */
export function fmtWhenDateTime(iso: string, lang: Language): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'es' ? 'es' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ─── fmtTime family ─────────────────────────────────────────────────────────

/**
 * Minutes → compact duration: 45 → "45m", 120 → "2h", 130 → "2h 10m",
 * 0 → "0m".
 *
 * Replaces:
 *   - housekeeping/_components/ForecastDayCard.tsx fmtTime(mins, lang)
 *     (the original's lang param was unused — output is language-neutral —
 *      so it is dropped here; every existing call renders identically)
 */
export function fmtDurationMins(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * ISO timestamp → "2:05 PM" if it falls on today's LOCAL calendar date,
 * otherwise "May 3" (date-fns 'h:mm a' / 'MMM d', English month names —
 * the original was not language-aware). Null/invalid → ''.
 *
 * Replaces:
 *   - housekeeper/[id]/_components/redesign/MessagesTab.tsx fmtTime()
 *
 * `now` defaults to `new Date()` exactly like the original; injectable only
 * for tests.
 */
export function fmtTimeOrDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? format(d, 'h:mm a') : format(d, 'MMM d');
  } catch {
    return '';
  }
}

/**
 * ISO timestamp → clock label rendered in an EXPLICIT IANA timezone,
 * always 'en-US' 12-hour: "12:30 PM".
 *
 * Replaces:
 *   - housekeeping/_components/TimelineView.tsx fmtTimeLabel()
 */
export function fmtTimeInZone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

// ─── Month labels ───────────────────────────────────────────────────────────

/**
 * "YYYY-MM" → "July 2026" / "julio de 2026", parsed AND rendered in UTC,
 * locale 'es-US' / 'en-US'. (Malformed input yields "Invalid Date", exactly
 * like the originals — they did no validation.)
 *
 * Replaces the two identical private copies:
 *   - financials/page.tsx                    monthDisplay()
 *   - financials/_components/CapexTab.tsx    monthName()
 */
export function monthLabelFromYm(ym: string, lang: Language): string {
  const [y, mm] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Long LOCAL month name for "now": "July" / "julio" ('es-ES' / 'en-US').
 *
 * Replaces:
 *   - inventory/_components/overlays/ReportsPanel.tsx currentMonthLabel()
 *
 * `now` defaults to `new Date()` exactly like the original; injectable only
 * for tests.
 */
export function currentMonthLabel(lang: Language, now: Date = new Date()): string {
  return now.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'long' });
}

/**
 * "YYYY-MM" / "YYYY-MM-DD" → short month name: "Jul" / "jul".
 *
 * Month keys describe calendar buckets, not instants. Always format them in
 * UTC so viewers west of Greenwich cannot see the preceding month.
 */
export function shortMonthFromYmd(s: string, lang: Language): string {
  const match = /^\d{4}-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(s);
  if (!match) return '—';
  const m = Number(match[1]);
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}
