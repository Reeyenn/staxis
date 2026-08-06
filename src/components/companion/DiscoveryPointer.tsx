'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The companion, pointing at one thing the first time somebody is on a screen.
//
// WHY THIS IS THE COMPANION AND NOT THE PAGE
// The sentence comes from src/lib/companion/copy.ts, the "shown / not now /
// never" bookkeeping goes through /api/companion into the same topics blob
// every other companion moment writes to, and the housekeeper exclusion is the
// companion's own mount rule, imported rather than re-stated. The page it is
// mounted on contributes exactly one thing: a `data-staxis-anchor` attribute
// on the control being pointed at.
//
// THE RULES IT KEEPS
//   • one pointer per visit, ever, even when two are unanswered
//   • three seconds in, so it arrives after the screen the person came for
//   • never on a housekeeper screen, and never for a role with no companion
//   • "Not now" means today. "Do not show this again" means never.
//   • USING THE CONTROL means never, too. Somebody who has just tapped the
//     button has found the button, and a hint about it the following week
//     would be the app talking over a person who is ahead of it.
//   • nothing to point at means nothing is shown AND nothing is spent. A
//     pointer burned on a screen too narrow to hold the control would be a
//     tip nobody ever got.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

import { readEnvelope } from '@/lib/api-envelope';
import { companionMounts } from '@/lib/companion/mount';
import {
  POINTER_DELAY_MS,
  pickPointer,
  pointersForPage,
  type PointerCandidate,
  type PointerMemoryView,
} from '@/lib/companion/pointers';
import type { PointerAnswer } from '@/lib/companion/copy';
import type { CompanionPageKey } from '@/lib/companion/pages';
import type { AppRole } from '@/lib/roles';

import { PointerPopup } from './PointerPopup';

interface CompanionBootstrap {
  hotel: { today: string };
  memory: PointerMemoryView;
  availability: { awake: boolean };
}

export interface DiscoveryPointerProps {
  pid: string | null;
  role: AppRole | null;
  /** Which screen's pointers to consider. */
  page: CompanionPageKey;
  /**
   * A product gate on top of the companion's own.
   *
   * The companion mount rule answers "may this person be spoken to here". This
   * answers "can this person actually use the thing being pointed at" — an
   * importer nobody is allowed to open is not a discovery, it is a tease.
   * Defaults to true so the common case needs no argument.
   */
  enabled?: boolean;
}

export function DiscoveryPointer({ pid, role, page, enabled = true }: DiscoveryPointerProps) {
  const pathname = usePathname() ?? '/';
  const [pointer, setPointer] = useState<PointerCandidate | null>(null);
  const startedRef = useRef(false);

  const allowed = enabled && role !== null && companionMounts({ pathname, role }).mounts;

  useEffect(() => {
    if (!pid || !allowed || startedRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const res = await fetch(`/api/companion?pid=${encodeURIComponent(pid)}`, { cache: 'no-store' });
        const env = await readEnvelope<CompanionBootstrap>(res);
        if (env.error !== undefined || cancelled) return;
        if (!env.data.availability?.awake) return;
        const next = pickPointer(pointersForPage(page), env.data.memory, env.data.hotel?.today ?? '');
        if (!next || cancelled) return;
        timer = setTimeout(() => {
          if (cancelled) return;
          startedRef.current = true;
          setPointer(next);
        }, POINTER_DELAY_MS);
      } catch { /* a pointer is never worth an error on somebody's screen */ }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pid, allowed, page]);

  /** Stamped when it actually DREW, not when it was chosen. A pointer that
   *  never found its control has not been offered and must come back. */
  const onShown = useCallback(() => {
    if (pid && pointer) void post(pid, 'spoke', pointer.topic);
  }, [pid, pointer]);

  const onNoTarget = useCallback(() => {
    // Nothing on this screen to point at. Say nothing, write nothing, and let
    // the next visit try again on a window that can hold it.
    setPointer(null);
  }, []);

  const onAnswer = useCallback((answer: PointerAnswer) => {
    if (answer === 'never' && pid && pointer) void post(pid, 'dropped', pointer.topic);
    // "later" writes nothing: the topic was stamped with today when it drew,
    // so it is already quiet until the hotel's next day.
    setPointer(null);
  }, [pid, pointer]);

  const onTargetUsed = useCallback(() => {
    if (pid && pointer) void post(pid, 'dropped', pointer.topic);
    setPointer(null);
  }, [pid, pointer]);

  if (!pointer) return null;

  return (
    <PointerPopup
      anchor={pointer.anchor}
      paragraphs={pointer.paragraphs}
      buttons={pointer.buttons}
      onAnswer={onAnswer}
      onTargetUsed={onTargetUsed}
      onShown={onShown}
      onNoTarget={onNoTarget}
    />
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
