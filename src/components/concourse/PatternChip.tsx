// ─── "Staxis sees a pattern here →" ──────────────────────────────────────────
//
// One line, on the thing itself. Mount it inside a view that is already about
// ONE room or ONE inventory item — a work order's detail modal, an item's edit
// sheet — never on a board, a list, or the top of a tab. See target-chip.ts for
// why that boundary is the whole feature.
//
// It renders NOTHING at all until it knows there is something to point at, and
// nothing forever if there is not: no skeleton, no placeholder, no "checked, all
// clear". A room with nothing wrong looks exactly as it did before this shipped.
// A failed lookup also renders nothing — the route logs it; the screen does not
// invent a reassurance it cannot support.

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

import { fetchWithAuth } from '@/lib/api-fetch';
import type { FindingTargetKind } from '@/lib/findings/types';
import { chipFor, patternChipUrl, type Lang } from './target-chip';

interface PatternChipProps {
  propertyId: string | null | undefined;
  kind: FindingTargetKind;
  /** The room number, or the inventory item's id. Null → nothing renders. */
  value: string | null | undefined;
  lang: Lang;
  /**
   * SPACING ONLY — margins, for hosts whose layout is not a gapped flex column.
   * It lives on the chip rather than on a wrapper the host renders, because a
   * wrapper would reserve its margin on every screen where there is no pattern,
   * and this component's first promise is that it costs nothing when silent.
   */
  style?: Pick<React.CSSProperties, 'margin' | 'marginTop' | 'marginBottom'>;
}

export function PatternChip({ propertyId, kind, value, lang, style }: PatternChipProps) {
  const [findingIds, setFindingIds] = useState<string[]>([]);

  useEffect(() => {
    // Cleared on every input change so a slow answer for the PREVIOUS room can
    // never land on this one — the chip is an assertion about the thing on
    // screen, and pointing it at the wrong card is worse than not pointing.
    setFindingIds([]);
    const url = patternChipUrl(propertyId, kind, value);
    if (!url) return;
    let live = true;

    // fetchWithAuth, not bare fetch: it attaches the session bearer and does the
    // refresh-and-retry dance on a 401. A plain fetch would render "no pattern"
    // — a claim about this room — on any expired-token blip.
    fetchWithAuth(url, { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { ok?: boolean; data?: { findingIds?: unknown } } | null) => {
        if (!live || !body?.ok) return;
        const ids = body.data?.findingIds;
        setFindingIds(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
      })
      .catch(() => { /* silent: no chip is the honest render of a failed check */ });

    return () => { live = false; };
  }, [propertyId, kind, value]);

  const chip = chipFor(findingIds, lang);
  if (!chip) return null;

  return (
    <Link
      href={chip.href}
      data-pattern-chip={kind}
      style={{
        display: 'block',
        textDecoration: 'none',
        padding: '9px 13px',
        borderRadius: 10,
        // The queue's "worth a look" caramel, dimmed. Loud enough to notice
        // while reading the thing, quiet enough that it never competes with
        // what the manager opened this screen to do.
        background: 'rgba(176,124,60,0.10)',
        border: '1px solid rgba(176,124,60,0.28)',
        color: '#8A5A22',
        fontFamily: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1.35,
        ...style,
      }}
    >
      {chip.text}
    </Link>
  );
}
