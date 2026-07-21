import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';

/**
 * Inventory can run as a standalone hotel section. Money-bearing inventory
 * evidence follows the Financials section gate in addition to the caller's
 * capability; otherwise an Inventory-only hotel would repeatedly call
 * finance-gated routes and misreport their expected 403s as load failures.
 */
export function inventoryFinancialDataEnabled(args: {
  contextReady: boolean;
  hasCapability: boolean;
  enabledSections: EnabledSections | undefined;
}): boolean {
  return args.contextReady
    && args.hasCapability
    && isSectionEnabled(args.enabledSections, 'financials');
}

/** Empty arrays are successful inventory snapshots, not connection failures. */
export function inventoryOperationalDetailsFailed(results: readonly unknown[]): boolean {
  return results.some((value) => value == null);
}
