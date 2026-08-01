import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * Resolve the signed-in account's operational identity at one hotel.
 *
 * `accounts.staff_id` is a legacy account-wide pointer and cannot represent an
 * account linked to a different staff profile at each hotel. The canonical
 * source is account_property_staff_links, keyed by (account, property).
 */
export async function activeStaffIdForAccountAtProperty(
  accountId: string,
  propertyId: string,
): Promise<string | null> {
  const { data: link, error: linkError } = await supabaseAdmin
    .from('account_property_staff_links')
    .select('staff_id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (linkError) throw linkError;
  if (!link?.staff_id) return null;

  const { data: staff, error: staffError } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', link.staff_id)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (staffError) throw staffError;
  return staff?.id ? String(staff.id) : null;
}
