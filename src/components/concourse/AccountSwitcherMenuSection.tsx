'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The "Switch account" block inside the avatar menu.
//
// Hook-free and presentational on purpose: every decision it makes is a prop,
// so the render gating can be tested by mounting it directly (ConcourseBar
// itself carries ~10 hooks and a portal, and cannot be mounted in the test
// runners this repo uses).
//
// Two ways it renders:
//   • a platform admin sees the roster of demo people;
//   • a session that was switched INTO sees the way back FIRST, then the
//     roster (so hopping to the next person is one tap, not two).
// Anyone else sees nothing at all.
//
// The server decides both of those independently. `isPlatformAdmin` is the
// fresh session-authorization verdict, and `switchedBackTo` comes from a
// cosmetic cookie that carries a name and no authority: forging it only draws
// a button whose request is refused.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { ArrowLeft, UserRoundCog } from 'lucide-react';

export interface SwitchablePerson {
  accountId: string;
  displayName: string;
  roleLine: string;
}

/**
 * Name of the cosmetic cookie the switch endpoint sets alongside the real,
 * httpOnly return credential. Kept here, next to the only thing that reads it,
 * and deliberately free of any Supabase/server import so it stays testable.
 */
export const SWITCH_HINT_COOKIE = 'staxis_switch_hint';

/** Read the hint. Absent, empty, or undecodable all mean "not switched". */
export function readSwitchHint(cookieString: string): string | null {
  for (const part of cookieString.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName !== SWITCH_HINT_COOKIE) continue;
    const raw = rest.join('=');
    if (!raw) return null;
    try {
      const value = decodeURIComponent(raw);
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface AccountSwitcherMenuSectionProps {
  /** Fresh server verdict that this viewer is a platform admin. */
  isPlatformAdmin: boolean;
  /** Who to go back to, when this session is a switched one. Null otherwise. */
  switchedBackTo: string | null;
  /** Who this session is right now. */
  currentDisplayName: string;
  /** Demo people, decided by the server. */
  people: readonly SwitchablePerson[];
  /** Marked as the current one when it matches. */
  currentAccountId: string | null;
  /** A switch or a return is in flight. */
  busy: boolean;
  onSwitch(accountId: string): void;
  onReturn(): void;
}

export function AccountSwitcherMenuSection({
  isPlatformAdmin,
  switchedBackTo,
  currentDisplayName,
  people,
  currentAccountId,
  busy,
  onSwitch,
  onReturn,
}: AccountSwitcherMenuSectionProps): React.ReactElement | null {
  const switched = typeof switchedBackTo === 'string' && switchedBackTo.length > 0;
  if (!switched && !isPlatformAdmin) return null;

  return (
    <>
      {switched ? (
        <>
          <div className="cx-menu-switched" data-testid="account-switch-banner">
            {`You are ${currentDisplayName} (switched)`}
          </div>
          <button
            type="button"
            className="cx-menu-item cx-menu-return"
            data-testid="account-switch-return"
            disabled={busy}
            onClick={onReturn}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {`Back to ${switchedBackTo}`}
          </button>
        </>
      ) : null}

      {people.length > 0 ? (
        <>
          <div className="cx-menu-eyebrow">Switch account</div>
          {people.map((person) => (
            <button
              key={person.accountId}
              type="button"
              className={`cx-menu-item cx-menu-person${
                person.accountId === currentAccountId ? ' cx-on' : ''
              }`}
              data-testid={`account-switch-person-${person.accountId}`}
              disabled={busy || person.accountId === currentAccountId}
              onClick={() => onSwitch(person.accountId)}
            >
              <UserRoundCog size={16} aria-hidden="true" />
              <span className="cx-menu-person-text">
                <span className="cx-menu-person-name">{person.displayName}</span>
                <span className="cx-menu-person-role">{person.roleLine}</span>
              </span>
            </button>
          ))}
        </>
      ) : null}
    </>
  );
}
