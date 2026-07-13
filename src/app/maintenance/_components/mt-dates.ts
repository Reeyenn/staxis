// Pure date / cadence helpers for the Maintenance boards. No React — kept in
// a plain .ts module (re-exported through _mt-snow) so src/lib/__tests__ can
// exercise the logic directly.
//
// Bilingual: every formatter takes an `es` flag (default false — the previous
// hardcoded-English behavior) so the Spanish UI stops rendering mixed-language
// lines like "Abierta · enviada May 11 · 1d ago".

const localeOf = (es: boolean) => (es ? 'es-ES' : 'en-US');

export function fmtDate(d: Date, es = false): string {
  return d.toLocaleDateString(localeOf(es), { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateShort(d: Date, es = false): string {
  return d.toLocaleDateString(localeOf(es), { month: 'short', day: 'numeric' });
}

// Days between two dates ignoring time-of-day. Positive = b is later.
export function daysBetween(a: Date, b: Date): number {
  const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb.getTime() - aa.getTime()) / (24 * 60 * 60 * 1000));
}

// Add N calendar days in LOCAL time — DST-safe. Raw `getTime() + N * 86400000`
// lands one hour short across the November fall-back, which shifts
// midnight-anchored dates (backfilled "last completed" dates stored at local
// 00:00) to 23:00 the PREVIOUS day: the due date then displays and bands a
// full day early.
export function addDaysLocal(d: Date, days: number): Date {
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + days,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
  );
}

// "7:51 AM · today" / "May 11 · 1d ago" — used in the detail modal byline.
// Days-ago counts CALENDAR days (via daysBetween), not elapsed 24h blocks:
// last night at 11pm viewed at 7am is "1d ago", not the old nonsense "0d ago".
export function fmtSubmittedAt(d: Date | null, es = false, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    const time = d.toLocaleTimeString(localeOf(es), { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${time} · ${es ? 'hoy' : 'today'}`;
  }
  const daysAgo = Math.max(1, daysBetween(d, now));
  if (daysAgo < 7) {
    return es ? `${fmtDateShort(d, es)} · hace ${daysAgo}d` : `${fmtDateShort(d, es)} · ${daysAgo}d ago`;
  }
  return fmtDate(d, es);
}

// Compact byline for the board cards: time-only for today, "May 11 · 1d" for
// the last week. Replaces the old `.replace(' · today', '').replace(/ ago$/,
// '')` string surgery on fmtSubmittedAt output (which broke silently for the
// Spanish strings).
export function fmtSubmittedAtCompact(d: Date | null, es = false, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(localeOf(es), { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  const daysAgo = Math.max(1, daysBetween(d, now));
  if (daysAgo < 7) return `${fmtDateShort(d, es)} · ${daysAgo}d`;
  return fmtDate(d, es);
}

// Due-relative string from "days until due" (negative = overdue). Used on the
// Preventive board cards. Spanish variants for the bilingual UI.
export function relDue(days: number, es = false): string {
  if (days === 0)  return es ? 'vence hoy'    : 'due today';
  if (days < 0)    return es ? `${-days}d vencido` : `${-days}d overdue`;
  if (days === 1)  return es ? 'vence mañana' : 'due tomorrow';
  if (days <= 7)   return es ? `en ${days}d`  : `in ${days}d`;
  if (days <= 60)  return es ? `en ${Math.round(days / 7)}sem` : `in ${Math.round(days / 7)}w`;
  return es ? `en ${Math.round(days / 30)}mes` : `in ${Math.round(days / 30)}mo`;
}

// Cadence text for a stored frequency-in-days. Exact-divisibility only: the
// old `days >= 30 → round(days / 30)` branch made a 45-day cadence read
// "every 2 mo" and a 12-week (84-day) cadence read "every 3 mo". Preference
// order mirrors daysToCountUnit (years > months > weeks > days), so anything
// entered through the frequency editor round-trips to its own label.
export function cadenceLabel(days: number, es: boolean): string {
  if (days >= 365 && days % 365 === 0) { const n = days / 365; return es ? `cada ${n} año${n > 1 ? 's' : ''}` : `every ${n} yr`; }
  if (days >= 30 && days % 30 === 0)   { const n = days / 30;  return es ? `cada ${n} mes${n > 1 ? 'es' : ''}` : `every ${n} mo`; }
  if (days >= 7 && days % 7 === 0)     { const n = days / 7;   return es ? `cada ${n} sem` : `every ${n} wk`; }
  if (days === 1) return es ? 'cada día' : 'every day';
  return es ? `cada ${days} días` : `every ${days} days`;
}

// Format a location for display: bare room numbers get a "Rm " prefix; named
// areas ("Lobby", "Pool Deck") pass through verbatim.
export function displayLoc(loc: string, es = false): string {
  const t = (loc || '').trim();
  return /^\d{1,4}$/.test(t) ? `${es ? 'Hab' : 'Rm'} ${t}` : t;
}
