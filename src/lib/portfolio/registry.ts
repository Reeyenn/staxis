/**
 * Portfolio adapter registry. One singleton map keyed by moduleId, holds
 * every adapter that has registered itself.
 *
 * Why a registry and not a hard-coded list: when a new module ships, the
 * page should NOT need editing. The module ships an adapter and either
 * imports `registerAdapter` directly or relies on the side-effecting
 * import in src/lib/portfolio/index.ts to wire itself in. The page reads
 * the registry and renders whatever's there.
 *
 * Singleton scope: the registry is module-scoped, which on Next.js means
 * one instance per server runtime + one per client bundle. That's the
 * right scope — register-on-first-use semantics work the same in both
 * places because `index.ts` runs both server- and client-side on any
 * file that touches the portfolio.
 */

import type { PortfolioModuleId, PortfolioTileAdapter, PortfolioTileData } from './types';

// Adapters store concrete `PortfolioTileData` variants. We accept any
// subtype at registration time and re-narrow at read time on the
// discriminated union so each consumer gets the right shape.
type AnyAdapter = PortfolioTileAdapter<PortfolioTileData>;

const registry = new Map<PortfolioModuleId, AnyAdapter>();

/**
 * Register an adapter. Idempotent: registering the same moduleId twice
 * with the SAME adapter object is a no-op. Registering a DIFFERENT
 * adapter against the same id throws — a hard failure at boot is the
 * right signal that two modules accidentally claimed the same id.
 */
export function registerAdapter(adapter: AnyAdapter): void {
  const existing = registry.get(adapter.moduleId);
  if (existing && existing !== adapter) {
    throw new Error(
      `Portfolio: two different adapters tried to register against moduleId="${adapter.moduleId}". ` +
      `Check for duplicate imports or a typo in a module's adapter export.`,
    );
  }
  registry.set(adapter.moduleId, adapter);
}

/** Lookup. Returns undefined if no adapter registered for the id. */
export function getAdapter(moduleId: PortfolioModuleId): AnyAdapter | undefined {
  return registry.get(moduleId);
}

/**
 * All currently-registered adapters. Order is registration order;
 * callers that need a stable display order should sort explicitly.
 */
export function listAdapters(): ReadonlyArray<AnyAdapter> {
  return Array.from(registry.values());
}

/**
 * Test hook — wipe the registry. Used by unit tests so each test can
 * register a clean set of adapters and assert on it without bleeding
 * state between tests. NOT for production use.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
