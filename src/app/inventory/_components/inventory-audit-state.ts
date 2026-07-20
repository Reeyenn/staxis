import type { EffectiveInventoryDelivery } from '@/types';

/** Audit rows are safe to paint only when they were loaded for the property
 * that is active in this render. Effects clear the cache too, but this
 * synchronous check closes the one-render gap before an effect can run. */
export function inventoryAuditMatchesProperty(
  activePropertyId: string | null | undefined,
  auditPropertyId: string | null | undefined,
): boolean {
  return Boolean(activePropertyId) && activePropertyId === auditPropertyId;
}

/** Accept an on-demand delivery lookup only if every tenant/root identity still
 * matches. A hotel switch while the request is in flight therefore resolves to
 * null instead of opening the previous hotel's correction sheet. */
export function inventoryAuditDeliveryForActiveProperty(
  requestedPropertyId: string,
  activePropertyId: string | null | undefined,
  requestedRootOrderId: string,
  delivery: EffectiveInventoryDelivery | null,
): EffectiveInventoryDelivery | null {
  if (
    !delivery
    || requestedPropertyId !== activePropertyId
    || delivery.original.propertyId !== requestedPropertyId
    || delivery.rootOrderId !== requestedRootOrderId
  ) return null;
  return delivery;
}
