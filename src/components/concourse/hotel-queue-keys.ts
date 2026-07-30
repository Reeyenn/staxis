/**
 * The React keys for the hotel queue's two hotel-scoped children.
 *
 * Pure and in its own file for the same reason finding-cards.ts and
 * one-list.ts are: QueueView cannot be imported by a test, because it reaches
 * next/font/google through LogbookPopup. The invariant below is load-bearing
 * enough to be worth exercising against a real renderer, so it lives where a
 * test can reach it.
 *
 * ─── why the keys are NAMESPACED, and the outage that made it matter ───────
 * Both StaxisList and DripQuestionCard are keyed on the hotel so that
 * switching hotels rebuilds them from scratch. When both keys were the bare
 * propertyId the two SIBLINGS carried the SAME key, and the Staxis tab bled
 * DOM until the tab died: over a thousand stacked copies of the page chrome on
 * a long-lived tab, and /api/worklist, /api/feed/prefs and /api/findings
 * re-read roughly twice every two and a half seconds, forever.
 *
 * The mechanism, because it is not obvious and it is completely silent:
 *
 * React reconciles a static JSX child list positionally, but only while every
 * slot matches. HotelQueue's `{backLabel && …}` slot is `false` on an ordinary
 * load, and a false slot makes React abandon the positional walk and match the
 * REMAINING children through a Map built from the current tree. That Map is
 * keyed by `key ?? index` and filled in sibling order, so when two siblings
 * share one key the LATER one wins and the earlier one is simply not in it.
 *
 * Two things then happen on every re-render of HotelQueue. StaxisList looks
 * itself up, finds DripQuestionCard's fiber under its key, sees a different
 * component type, and MOUNTS ITSELF FRESH. And its previous fiber, absent from
 * that Map, is never added to React's deletion list, so its DOM is never
 * removed. Mount, orphan, repeat.
 *
 * That is self-sustaining, which is what turned a latent defect into an
 * outage: a freshly mounted StaxisList reports readState 'loading' back up to
 * HotelQueue's setState, which re-renders HotelQueue, which mounts another
 * fresh StaxisList. It is invisible in production because React's duplicate
 * key warning is development only, and nothing ever throws.
 *
 * So these two keys must be distinct BY CONSTRUCTION, not by coincidence.
 * The prefixes lead rather than trail so that a hotel id which happens to look
 * like the other namespace still cannot collide.
 */
export function hotelQueueChildKeys(propertyId?: string | null): {
  list: string;
  drip: string;
} {
  const hotel = propertyId ?? 'no-property';
  return {
    list: `staxis-list:${hotel}`,
    drip: `drip-question:${hotel}`,
  };
}
