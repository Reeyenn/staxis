import 'server-only';

import { hashToRateLimitKey } from '@/lib/api-ratelimit';

/**
 * One stable limiter scope for every selector request made by an account.
 *
 * The `api_limits.property_id` name is legacy: migration 0309 made it an
 * opaque UUID-shaped scope, so an account hash is valid here. Keeping the
 * selected organization and property out of this key prevents a multi-company
 * caller from rotating choices to buy another catalog-fan-out budget.
 */
export function propertySelectorRateLimitKey(accountId: string): string {
  return hashToRateLimitKey(`property-selector-account:${accountId}`);
}
