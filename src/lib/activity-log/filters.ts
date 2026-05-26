/**
 * URLSearchParams → ActivityQueryFilters parser.
 *
 * Pure module — intentionally has no side-effect imports (no team-auth,
 * no supabase-admin) so the filter tests boot in ~50ms instead of
 * pulling the whole API-auth chain through tsx.
 */

import { validateUuid } from '@/lib/api-validate';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_SOURCES,
  type ActivityCategory,
  type ActivityQueryFilters,
  type ActivitySource,
} from './types';

const CATEGORY_SET = new Set<string>(ACTIVITY_CATEGORIES);
const SOURCE_SET = new Set<string>(ACTIVITY_SOURCES);

export function parseActivityFilters(
  params: URLSearchParams,
): { ok: true; filters: ActivityQueryFilters } | { ok: false; error: string } {
  const propertyId = params.get('propertyId') ?? params.get('property_id') ?? '';
  const pidCheck = validateUuid(propertyId, 'propertyId');
  if (pidCheck.error || !pidCheck.value) {
    return { ok: false, error: pidCheck.error ?? 'propertyId required' };
  }

  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  if (from && Number.isNaN(Date.parse(from))) return { ok: false, error: 'Invalid `from` timestamp.' };
  if (to && Number.isNaN(Date.parse(to))) return { ok: false, error: 'Invalid `to` timestamp.' };

  const categories = parseMulti(params, 'category', 'categories')
    .filter((v): v is ActivityCategory => CATEGORY_SET.has(v));
  const sources = parseMulti(params, 'source', 'sources')
    .filter((v): v is ActivitySource => SOURCE_SET.has(v));

  const actorAccountId = params.get('actorAccountId') ?? undefined;
  if (actorAccountId) {
    const c = validateUuid(actorAccountId, 'actorAccountId');
    if (c.error) return { ok: false, error: c.error };
  }
  const targetType = params.get('targetType') ?? undefined;
  const targetId = params.get('targetId') ?? undefined;
  const search = params.get('search') ?? params.get('q') ?? undefined;

  const pageStr = params.get('page');
  const pageSizeStr = params.get('pageSize') ?? params.get('page_size');
  const page = pageStr ? Number.parseInt(pageStr, 10) : undefined;
  const pageSize = pageSizeStr ? Number.parseInt(pageSizeStr, 10) : undefined;

  return {
    ok: true,
    filters: {
      propertyId: pidCheck.value,
      from,
      to,
      categories: categories.length ? categories : undefined,
      sources: sources.length ? sources : undefined,
      actorAccountId,
      targetType,
      targetId,
      search: search?.trim() ? search.trim() : undefined,
      page,
      pageSize,
    },
  };
}

function parseMulti(params: URLSearchParams, singular: string, plural: string): string[] {
  const out: string[] = [];
  for (const v of params.getAll(singular)) {
    out.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
  }
  for (const v of params.getAll(plural)) {
    out.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}
