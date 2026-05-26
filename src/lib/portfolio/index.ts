/**
 * Portfolio layer — barrel export + adapter auto-registration.
 *
 * Importing anything from `@/lib/portfolio` triggers the side-effecting
 * adapter imports below, which call `registerAdapter` at module load.
 * Once a future module ships (maintenance, inventory, …), add a line
 * here to import its adapter so it auto-registers the same way.
 *
 * ⚠️ This file is server-safe ONLY when imported from a server context.
 * The housekeeping adapter pulls `@/lib/supabase-admin`, which throws at
 * import time if SUPABASE_SERVICE_ROLE_KEY isn't set. Client bundles
 * should import types/aggregator/anomaly-detector directly from their
 * specific files, not from this barrel.
 */

export * from './types';
export * from './aggregator';
export * from './anomaly-detector';
export { registerAdapter, getAdapter, listAdapters, __resetRegistryForTests } from './registry';

// ── Built-in adapter registration ───────────────────────────────────────
//
// Importing the adapter triggers its top-level `registerAdapter(...)`
// call. Side-effecting imports are not idiomatic but they're the right
// shape for a plug-in registry like this — the alternative is asking the
// page to remember to register each module manually, which scales worse
// as modules multiply.
import './adapters/housekeeping-tile';
