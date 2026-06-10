/**
 * Test-only WebSocket shim (fix/mapper-field-contract).
 *
 * supabase-js v2 constructs a RealtimeClient inside createClient(), and
 * @supabase/realtime-js throws at construction under Node 20 ("Node.js 20
 * detected without native WebSocket support"). Several worker modules build
 * the Supabase client at MODULE LOAD (src/supabase.ts → createClient), so any
 * unit test that imports them — even just to exercise a pure function like
 * validateRows or evaluatePromotionGate — crashes on import.
 *
 * We never open a realtime socket in a unit test, so a no-op constructor is
 * enough to satisfy realtime-js's getWebSocketConstructor() guard. Import this
 * module FIRST in a test file (ESM evaluates imports in source order) so the
 * shim is in place before the supabase client is constructed.
 *
 * NB: this file is intentionally NOT named `*.test.ts`, so the node:test glob
 * (`src/__tests__/*.test.ts`) never runs it as a test.
 *
 * (The reconcile-source-filter test sidesteps the same issue by importing an
 * isolated config file; this shim instead lets a test load the REAL
 * supabase-importing module so the assertions cover production code paths.)
 */
const g = globalThis as unknown as { WebSocket?: unknown };
if (typeof g.WebSocket === 'undefined') {
  g.WebSocket = class {
    close(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
}
