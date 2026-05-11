'use client';

import { useEffect, useState } from 'react';
import { todayStr, APP_TIMEZONE } from './utils';

/**
 * Reactive version of `todayStr()` that re-renders the consumer when the
 * property's local-timezone date rolls over (midnight in `tz`).
 *
 * Why this exists: every page that subscribes to today's rooms used to do
 *
 *   const today = todayStr();
 *   useEffect(() => subscribeToRooms(uid, pid, today, setRooms),
 *             [user, activePropertyId]);
 *
 * That captures `today` at mount. If the dashboard is left open past
 * midnight (which managers do — it lives on the wall TV), the subscription
 * silently keeps listening to YESTERDAY'S room set forever. Stayover rooms
 * for the new day never appear, the morning shift starts and the page just
 * shows zero rooms.
 *
 * With this hook, `today` is a state value. We schedule a one-shot timeout
 * for the next APP_TIMEZONE midnight (plus a 1s buffer to be safe), and
 * when it fires we update state to the new date string. React re-runs any
 * effect that depends on `today` and the realtime subscription is recreated
 * for the new day's bucket. After firing we schedule the next midnight,
 * forever, until unmount.
 *
 * `setTimeout` with a 24h+ delay is reliable in modern browsers — but we
 * also belt-and-suspenders by re-checking on `visibilitychange` (returning
 * to a backgrounded tab) and `focus`. Backgrounded mobile Safari can throttle
 * timers, so when the user reopens the tab we recompute the date string and
 * resync if needed.
 */
export function useTodayStr(tz: string = APP_TIMEZONE): string {
  const [today, setToday] = useState<string>(() => todayStr(tz));

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      // Compute ms until next midnight in the property's timezone.
      // We do this by formatting "now" in en-CA (yyyy-mm-dd HH:mm:ss) for
      // the target timezone, parsing back the wall-clock components, and
      // computing how many ms remain until 00:00:00.001 of the next day.
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date());

      const get = (t: string) => Number(fmt.find(p => p.type === t)?.value ?? 0);
      const h = get('hour');
      const m = get('minute');
      const s = get('second');

      // Intl can return "24" for hour at midnight on some engines; normalize.
      const hourNorm = h === 24 ? 0 : h;
      const msSinceMidnight = ((hourNorm * 60 + m) * 60 + s) * 1000;
      const msUntilMidnight = 24 * 60 * 60 * 1000 - msSinceMidnight;

      // +2s buffer so we land cleanly past midnight rather than micro-early
      // due to clock drift between the browser and the timezone calculation.
      const delay = Math.max(msUntilMidnight + 2000, 1000);

      timeoutId = setTimeout(() => {
        setToday(todayStr(tz));
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    // Mobile Safari throttles setTimeout in backgrounded tabs, so a full
    // overnight in the background can miss the midnight tick. Every time
    // the tab comes back to the foreground (or window regains focus), we
    // recompute the date and resync if it advanced.
    const resync = () => {
      const now = todayStr(tz);
      setToday(prev => (prev === now ? prev : now));
    };
    const onVisibility = () => { if (!document.hidden) resync(); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', resync);

    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', resync);
    };
  }, [tz]);

  return today;
}
