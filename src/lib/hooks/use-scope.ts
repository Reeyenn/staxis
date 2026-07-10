'use client';

// ─── useScope: the (uid, pid, ready) selector every staff page needs ────────
// Thin selector over AuthContext + PropertyContext. Replaces the ~40
// hand-typed guards of the form
//
//   const { user } = useAuth();
//   const { activePropertyId } = useProperty();
//   ...
//   if (!user || !activePropertyId) return;
//
// with
//
//   const { uid, pid, ready } = useScope();
//   ...
//   if (!ready) return;   // narrows uid + pid to `string` (see scope-core.ts)
//
// No new state, no new effects — just a memoized projection of the two
// existing contexts. `ready` = user loaded AND an active property id is
// present. The returned object is referentially stable across renders while
// (uid, pid) are unchanged, so it is safe to use `scope` itself in a
// dependency array — though preferring the primitives (`uid`, `pid`) keeps
// effects immune to any future shape changes here.
//
// Pure logic lives in ./scope-core.ts (unit-tested there; the test runner's
// react-server condition can't import this file — see that file's header).

import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { computeScope, type Scope } from './scope-core';

export type { Scope };

export function useScope(): Scope {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const uid = user?.uid ?? null;
  return useMemo(() => computeScope(uid, activePropertyId), [uid, activePropertyId]);
}
