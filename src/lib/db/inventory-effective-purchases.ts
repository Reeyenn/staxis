import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/supabase-paginate';
import {
  summarizeEffectivePurchases,
  type EffectivePurchaseCorrectionInput,
  type EffectivePurchaseOrderInput,
  type EffectivePurchaseSummary,
} from '@/lib/inventory-effective-purchases';

const CORRECTION_COLUMNS = [
  'id',
  'original_order_id',
  'prior_correction_id',
  'correction_kind',
  'corrected_item_id',
  'corrected_quantity',
  'corrected_total_cost',
].join(',');

/** Keep `.in(...)` URLs bounded and below the correction RPC's 500-root guard. */
const ROOT_CHUNK_SIZE = 200;

export async function summarizeEffectivePurchasesForProperty(
  client: SupabaseClient,
  propertyId: string,
  orders: readonly EffectivePurchaseOrderInput[],
): Promise<EffectivePurchaseSummary> {
  const correctedRootIds = [...new Set(orders.flatMap((order) =>
    order.entry_kind === 'correction' && order.corrects_order_id ? [order.corrects_order_id] : []
  ))];
  if (correctedRootIds.length === 0) return summarizeEffectivePurchases(orders, []);

  const corrections: EffectivePurchaseCorrectionInput[] = [];
  for (let index = 0; index < correctedRootIds.length; index += ROOT_CHUNK_SIZE) {
    const rootIds = correctedRootIds.slice(index, index + ROOT_CHUNK_SIZE);
    corrections.push(...await fetchAllRows<EffectivePurchaseCorrectionInput>(async (from, to) => {
      const { data, error } = await client
        .from('inventory_delivery_corrections')
        .select(CORRECTION_COLUMNS)
        .eq('property_id', propertyId)
        .in('original_order_id', rootIds)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      return { data: data as unknown as EffectivePurchaseCorrectionInput[] | null, error };
    }));
  }
  return summarizeEffectivePurchases(orders, corrections);
}
