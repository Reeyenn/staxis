// ─── Pure scope resolution (no React, no contexts) ──────────────────────────
// The logic behind useScope(), factored out so it can be unit-tested under
// the node:test runner. The test suite runs with `--conditions=react-server`,
// where React's `createContext` doesn't exist — so tests must never import
// the context-backed hook module (use-scope.ts). They import this file
// instead. Keep this module dependency-free.

/**
 * The signed-in user + active hotel pair that nearly every staff-facing page
 * scopes its reads and writes by.
 *
 * Discriminated on `ready` so a single early-return guard narrows the types:
 *
 *   const { uid, pid, ready } = useScope();
 *   ...
 *   if (!ready) return;          // from here on, uid and pid are `string`
 *
 * (TypeScript narrows destructured discriminated unions since 4.6, so the
 * destructured form above narrows too — no need to keep the object whole.)
 */
export type Scope =
  | { readonly ready: true; readonly uid: string; readonly pid: string }
  | { readonly ready: false; readonly uid: string | null; readonly pid: string | null };

/**
 * Resolve a Scope from the raw context values.
 *
 * `ready` mirrors the truthiness semantics of the hand-typed guards this
 * replaces (`if (!user || !activePropertyId) return`): empty strings,
 * `null`, and `undefined` all count as "not present". Empty strings are
 * normalized to `null` so consumers only ever deal with `string | null`.
 */
export function computeScope(
  uid: string | null | undefined,
  pid: string | null | undefined,
): Scope {
  const u = uid || null;
  const p = pid || null;
  if (u !== null && p !== null) {
    return { ready: true, uid: u, pid: p };
  }
  return { ready: false, uid: u, pid: p };
}
