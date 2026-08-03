'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The companion, pointing at one thing on the Inventory screen.
//
// WHY THIS LIVES HERE AND NOT IN THE BUBBLE
// It is the companion's voice and the companion's memory: the sentence comes
// from src/lib/companion/copy.ts, the "shown / not now / never" bookkeeping
// goes through /api/companion into the same topics blob every other companion
// moment writes to, and the housekeeper exclusion is the companion's own mount
// rule, imported rather than re-stated. What it does NOT do is take over the
// bubble, which somebody else is rebuilding this week.
//
// THE RULES IT KEEPS
//   • one pointer per visit, ever, even when two are unanswered
//   • three seconds in, so it arrives after the screen the person came for
//   • never on a housekeeper screen, and never for a role with no chat
//   • "Not now" means today; "Do not show again" means never
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { T, fonts } from './tokens';
import { readEnvelope } from '@/lib/api-envelope';
import { companionMounts } from '@/lib/companion/mount';
import {
  POINTER_DELAY_MS,
  inventoryPointers,
  pickPointer,
  type PointerCandidate,
  type PointerMemoryView,
} from '@/lib/companion/pointers';
import type { CompanionPointerKey } from '@/lib/companion/copy';
import type { AppRole } from '@/lib/roles';

interface CompanionBootstrap {
  hotel: { today: string };
  memory: PointerMemoryView;
  availability: { awake: boolean };
}

interface InventoryPointerProps {
  pid: string | null;
  role: AppRole | null;
  /**
   * Opens the thing the pointer just described. A pointer that names a control
   * and then cannot take you to it is worse than saying nothing, so every key
   * the copy defines is routed by the caller.
   */
  onShow: (key: CompanionPointerKey) => void;
}

export function InventoryPointer({ pid, role, onShow }: InventoryPointerProps) {
  const pathname = usePathname() ?? '/inventory';
  const [pointer, setPointer] = useState<PointerCandidate | null>(null);
  const [visible, setVisible] = useState(false);
  const shownRef = useRef(false);

  const allowed = role !== null && companionMounts({ pathname, role }).mounts;

  useEffect(() => {
    if (!pid || !allowed || shownRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const res = await fetch(`/api/companion?pid=${encodeURIComponent(pid)}`, { cache: 'no-store' });
        const env = await readEnvelope<CompanionBootstrap>(res);
        if (env.error !== undefined || cancelled) return;
        if (!env.data.availability?.awake) return;
        const next = pickPointer(inventoryPointers(), env.data.memory, env.data.hotel?.today ?? '');
        if (!next || cancelled) return;
        timer = setTimeout(() => {
          if (cancelled) return;
          shownRef.current = true;
          setPointer(next);
          setVisible(true);
          // Stamped when SHOWN, not when answered. Walking away is an answer.
          void post(pid, 'spoke', next.topic);
        }, POINTER_DELAY_MS);
      } catch { /* a pointer is never worth an error on somebody's screen */ }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pid, allowed]);

  const dismissForever = useCallback(() => {
    if (pid && pointer) void post(pid, 'dropped', pointer.topic);
    setVisible(false);
  }, [pid, pointer]);

  const remindLater = useCallback(() => {
    // Nothing to write: the topic was stamped with today when it was shown, so
    // it is already quiet until the hotel's next day.
    setVisible(false);
  }, []);

  const act = useCallback(() => {
    if (!pointer) return;
    if (pid) void post(pid, 'accepted', pointer.topic);
    setVisible(false);
    onShow(pointer.key);
  }, [pid, pointer, onShow]);

  if (!visible || !pointer) return null;

  return (
    <div
      data-testid="inventory-pointer"
      role="status"
      style={{
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '14px 16px',
        background: T.bg,
        marginBottom: 16,
        maxWidth: 560,
      }}
    >
      <p style={{ fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.55, color: T.ink, margin: 0 }}>
        {pointer.text}
      </p>
      <p style={{ fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.55, color: T.ink2, margin: '6px 0 0' }}>
        {pointer.question}
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={act} style={primaryBtn}>Show me</button>
        <button type="button" onClick={remindLater} style={ghostBtn}>Not now</button>
        <button type="button" onClick={dismissForever} style={ghostBtn}>Do not show this again</button>
      </div>
    </div>
  );
}

async function post(pid: string, event: string, topic: string): Promise<void> {
  try {
    await fetch('/api/companion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, event, topic }),
    });
  } catch { /* memory is best effort; the next page load reads the truth */ }
}

const primaryBtn: React.CSSProperties = {
  height: 32, padding: '0 14px', borderRadius: 999, cursor: 'pointer',
  background: T.ink, color: T.bg, border: 'none',
  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
};
const ghostBtn: React.CSSProperties = {
  height: 32, padding: '0 14px', borderRadius: 999, cursor: 'pointer',
  background: 'transparent', color: T.ink2, border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500,
};
