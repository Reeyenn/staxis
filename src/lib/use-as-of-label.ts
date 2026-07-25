'use client';

/**
 * useAsOfLabel — the client half of the "as of 6:40 AM" stamp.
 *
 * Pairs with useFeedStatus: that hook says WHAT the numbers are and how much
 * to trust them, this one turns the freshness on the same payload into the
 * chip a manager reads. All of the honesty rules (no label for a manual
 * hotel, no label over a never-synced feed) live in the pure builder —
 * src/lib/pms/as-of-label.ts — so they are testable; this file only supplies
 * the two things a hook can supply: the user's language and a ticking clock.
 *
 * Why the clock ticks: the age ("4 hr ago") is computed from `now` at render
 * time, never stored. Without a tick a tab left open overnight would still be
 * insisting the report is "22 min ago" at 4 AM. 60s is the coarsest cadence
 * the wording can change on (formatAge's smallest unit is a minute), and it
 * pauses while the tab is hidden so a backgrounded dashboard costs nothing.
 */

import { useEffect, useState } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { buildAsOfLabel, type AsOfLabel } from '@/lib/pms/as-of-label';
import type { FeedKey, PropertyFeedStatus } from '@/lib/pms/feed-status';

const TICK_MS = 60_000;

/** A "now" that advances once a minute. One timer per label — a handful of
 *  60s intervals is far cheaper than the coordination a shared clock needs. */
function useMinuteClock(): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setNow(new Date());
    }, TICK_MS);
    // A tab that comes back after hours must not show the age it froze at.
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(new Date());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

export function useAsOfLabel(args: {
  status: PropertyFeedStatus | null | undefined;
  /** The feed(s) backing the number being stamped. */
  feeds: readonly FeedKey[];
  timezone: string | null | undefined;
}): AsOfLabel | null {
  const { lang } = useLang();
  const now = useMinuteClock();
  return buildAsOfLabel({
    status: args.status,
    feeds: args.feeds,
    timezone: args.timezone,
    lang,
    now,
  });
}
