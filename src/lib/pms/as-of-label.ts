// ═══════════════════════════════════════════════════════════════════════════
// pms/as-of-label — the UI half of data-age honesty (D4 follow-up).
//
// THE RULE THIS EXISTS TO ENFORCE: when a hotel's PMS report runs late, the
// screen keeps showing the last real number and stamps it with when it was
// taken — "42 in-house · as of 6:40 AM" — instead of blanking the tile. A
// four-hour-old occupancy figure is useful to a manager; an empty square is
// not. The stamp is the entire reason showing it stays honest.
//
// The copilot already does this in words (src/lib/agent/context.ts asOfLine).
// This module is the same decision for pixels, and it is deliberately PURE —
// no React, no I/O, `now` injected — so the three suppression rules below are
// unit-testable rather than discovered on a customer's dashboard.
//
// ── WHEN THERE MUST BE NO LABEL AT ALL ────────────────────────────────────
//  1. mode !== 'live' (a manual / no_pms hotel, or one still onboarding).
//     Staxis IS the system of record for those hotels: their numbers really
//     are live, and stamping an age on them would invent a doubt that does
//     not exist. This is the honesty rule that runs BACKWARDS from the rest
//     of the module and it is the easiest one to break by accident.
//  2. The connection has never delivered anything (isDataPending). The
//     surface already says "still syncing / connecting" and every pms_* row
//     is empty — an "as of" over a fake zero is worse than no number.
//  3. The feed backing this particular number has no real source at all
//     ('learning' / 'unavailable'). There is no number to stamp; the tile
//     shows "—" and its own reason.
//
// Everything else gets a label, fresh included. A stamp that only appears
// when something is wrong teaches people that its absence means "live" —
// which is exactly the assumption the report era invalidates.
// ═══════════════════════════════════════════════════════════════════════════

import {
  feedHasRealSource,
  formatAsOfClock,
  freshnessTier,
  isDataPending,
  PMS_STALE_MAX_MINUTES,
  type AsOfLang,
  type FeedKey,
  type FreshnessTier,
  type PropertyFeedStatus,
} from '@/lib/pms/feed-status';

export interface AsOfLabel {
  /** The chip text. Short by design — it sits under a tile value.
   *  e.g. "as of 6:40 AM · 4 hr ago" / "a las 6:40 AM · hace 4 h" */
  text: string;
  /** The full sentence, for `title` + screen readers: includes the timezone
   *  and says plainly what the age means. */
  detail: string;
  /**
   * - 'quiet'   — the number is current (or the feed only reports changes).
   *               Muted; must not read as an alarm.
   * - 'caution' — older than one report cycle, or the age is unknown. Amber,
   *               never red: the number is still real and still usable.
   */
  tone: 'quiet' | 'caution';
  tier: FreshnessTier;
}

export interface AsOfLabelInput {
  /** From useFeedStatus / the server helper. `null` = not loaded yet → no
   *  label (this layer may only ever ADD honesty, never block data). */
  status: PropertyFeedStatus | null | undefined;
  /**
   * Which feed(s) the stamped number came from. The label is suppressed
   * unless at least one of them has a real source — same predicate the server
   * uses to decide whether to fetch the number in the first place.
   */
  feeds: readonly FeedKey[];
  /** The property's IANA zone. Null → the clock falls back to UTC and says so. */
  timezone: string | null | undefined;
  lang: AsOfLang;
  now: Date;
}

const COPY = {
  en: {
    asOf: (t: string) => `as of ${t}`,
    asOfAged: (t: string, age: string) => `as of ${t} · ${age}`,
    lastChanged: (t: string) => `last changed ${t}`,
    unknown: 'update time unknown',
    detailFresh: (t: string, z: string, age: string) =>
      `From your PMS as of ${t} (${z}) — ${age}.`,
    detailStale: (t: string, z: string, age: string) =>
      `From your PMS as of ${t} (${z}) — ${age}. That is older than one report cycle, so this number describes ${t}, not right now.`,
    detailVeryStale: (t: string, z: string, age: string, hours: number) =>
      `From your PMS as of ${t} (${z}) — ${age}. No report has arrived in over ${hours} hours, so the connection looks stuck. This number is the last one that landed.`,
    detailChangeOnly: (t: string, z: string, age: string) =>
      `This number last changed at ${t} (${z}) — ${age}. Your PMS connection does not report when it last checked, so it may be newer than that.`,
    detailUnknown:
      'Staxis cannot tell how old this number is — this hotel’s PMS feed carries no capture time.',
  },
  es: {
    asOf: (t: string) => `a las ${t}`,
    asOfAged: (t: string, age: string) => `a las ${t} · ${age}`,
    lastChanged: (t: string) => `último cambio a las ${t}`,
    unknown: 'hora de actualización desconocida',
    detailFresh: (t: string, z: string, age: string) =>
      `De tu PMS, a las ${t} (${z}) — ${age}.`,
    detailStale: (t: string, z: string, age: string) =>
      `De tu PMS, a las ${t} (${z}) — ${age}. Es más de un ciclo de reportes, así que este número describe las ${t}, no este momento.`,
    detailVeryStale: (t: string, z: string, age: string, hours: number) =>
      `De tu PMS, a las ${t} (${z}) — ${age}. No llega ningún reporte desde hace más de ${hours} horas, así que la conexión parece atascada. Este es el último número que llegó.`,
    detailChangeOnly: (t: string, z: string, age: string) =>
      `Este número cambió por última vez a las ${t} (${z}) — ${age}. Tu conexión al PMS no informa cuándo revisó por última vez, así que podría ser más reciente.`,
    detailUnknown:
      'Staxis no puede saber qué tan antiguo es este número — el PMS de este hotel no envía la hora de captura.',
  },
} as const;

/** PMS_STALE_MAX_MINUTES stated in whole hours, for the copy. */
const STALE_HOURS = Math.round(PMS_STALE_MAX_MINUTES / 60);

/**
 * Build the as-of chip for one number, or null when this hotel/feed must not
 * carry one. See the module header for the three suppression rules — they are
 * the honesty contract, not an optimisation.
 */
export function buildAsOfLabel(input: AsOfLabelInput): AsOfLabel | null {
  const { status, feeds, timezone, lang, now } = input;
  if (!status) return null;
  // (1) A manual / onboarding hotel: Staxis is the record, the numbers ARE live.
  if (status.mode !== 'live') return null;
  // (2) Nothing has ever arrived — "still syncing" owns this tile.
  if (isDataPending(status)) return null;
  // (3) No real number behind this tile to stamp.
  if (!feeds.some((k) => feedHasRealSource(status.feeds[k]))) return null;

  const copy = COPY[lang] ?? COPY.en;
  const capturedAt = status.freshness?.capturedAt ?? null;
  const source = status.freshness?.source ?? 'none';
  const tier = freshnessTier(capturedAt, source, now);
  const clock = capturedAt ? formatAsOfClock(capturedAt, timezone ?? null, now, lang) : null;

  // Unusable / absent capture time. Say so rather than implying "now" — the
  // number stays on screen, the claim about its age does not.
  if (tier === 'unknown' || !clock) {
    return {
      text: copy.unknown,
      detail: copy.detailUnknown,
      tone: 'caution',
      tier: 'unknown',
    };
  }

  switch (tier) {
    case 'fresh':
      return {
        text: copy.asOf(clock.time),
        detail: copy.detailFresh(clock.time, clock.zone, clock.age),
        tone: 'quiet',
        tier,
      };
    case 'stale':
      return {
        text: copy.asOfAged(clock.time, clock.age),
        detail: copy.detailStale(clock.time, clock.zone, clock.age),
        tone: 'caution',
        tier,
      };
    case 'very_stale':
      return {
        text: copy.asOfAged(clock.time, clock.age),
        detail: copy.detailVeryStale(clock.time, clock.zone, clock.age, STALE_HOURS),
        tone: 'caution',
        tier,
      };
    case 'change_only':
      // A change stamp cannot tell "nothing happened" from "nothing arrived",
      // so it never escalates to a caution — it just words itself honestly.
      return {
        text: copy.lastChanged(clock.time),
        detail: copy.detailChangeOnly(clock.time, clock.zone, clock.age),
        tone: 'quiet',
        tier,
      };
    default:
      return null;
  }
}
