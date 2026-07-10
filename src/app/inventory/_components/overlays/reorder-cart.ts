// Pure cart-state seeding for the ReorderPanel.
//
// Race fix: the panel is always mounted and the inventory realtime
// subscription refetches the whole list on ANY change, producing a
// fresh-identity recommendation array. The old effect rebuilt the cart from
// defaults every time that happened, so a housekeeper saving a count on
// another device silently reverted the GM's checked lines and typed
// quantities mid-order. Seeding is now additive while the panel stays open:
// existing line state (the user's edits) is always preserved; only lines the
// user hasn't touched get (re)seeded with defaults.

export type LineState = { checked: boolean; qty: number };

export interface SeedableRec {
  itemId: string;
  urgency: 'now' | 'soon' | 'ok';
  burnSource?: string;
  suggestQty: number;
}

/**
 * Build the next cart state.
 *  - `firstOpen` (panel just opened): rebuild from defaults, discarding stale
 *    state from a previous session.
 *  - otherwise: keep every existing line untouched and only add defaults for
 *    recs that don't have a line yet (e.g. data that finished loading, or an
 *    item that newly became urgent while the panel is open).
 *
 * Default check state (honesty-audit Phase 4): only pre-check items with REAL
 * signal (ML prediction or operator-configured rule) that are urgent NOW.
 */
export function seedCartState(
  recs: SeedableRec[],
  prev: Record<string, LineState>,
  firstOpen: boolean,
): Record<string, LineState> {
  const next: Record<string, LineState> = firstOpen ? {} : { ...prev };
  for (const r of recs) {
    if (!firstOpen && next[r.itemId]) continue; // preserve the user's edits
    const hasRealSignal = r.burnSource === 'ml' || r.burnSource === 'rule-occupancy';
    next[r.itemId] = { checked: r.urgency === 'now' && hasRealSignal, qty: r.suggestQty };
  }
  return next;
}
