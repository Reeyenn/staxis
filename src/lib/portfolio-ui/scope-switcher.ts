/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SWITCHER ROWS — one list, two kinds of row.
 *
 * The avatar menu used to be `properties.map(...)`: every row was a hotel, so
 * there was nowhere for "the whole company" to live and company people had the
 * list hidden from them entirely. A company row is now a first-class member of
 * the same list, which is what retires the separate /portfolio/choose screen:
 * picking a company is the same gesture as picking a hotel.
 *
 * One company row PER COMPANY the person belongs to. A person who works for two
 * management companies gets two rows, so the old company picker has no job left.
 *
 * Pure: no React, no navigation. The bar turns a row into a scope change and a
 * link; this module decides what the rows are and which one is on.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { AppScope } from './acting-scope';

export type ScopeSwitcherRow =
  | {
      kind: 'company';
      /** Opaque list key. Never parsed; resolved back through this same list. */
      key: string;
      organizationId: string;
      label: string;
      active: boolean;
    }
  | {
      kind: 'hotel';
      key: string;
      propertyId: string;
      label: string;
      active: boolean;
    };

export interface ScopeSwitcherCompany {
  organizationId: string;
  organizationName: string | null;
}

export interface ScopeSwitcherHotel {
  id: string;
  name: string;
}

/** "Gulf Coast Hotels · All hotels" — the company, and that it means all of it. */
export function companyRowLabel(organizationName: string | null | undefined): string {
  const name = typeof organizationName === 'string' && organizationName.trim() !== ''
    ? organizationName.trim()
    : 'Your company';
  return `${name} · All hotels`;
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, 'en-US', { sensitivity: 'base' });
}

/**
 * Build the switcher list. Company rows come first because a company person
 * reads down from the whole company into one building, then the hotels in the
 * order coverage handed them over.
 */
export function buildScopeSwitcherRows(input: {
  companies: readonly ScopeSwitcherCompany[] | null | undefined;
  hotels: readonly ScopeSwitcherHotel[] | null | undefined;
  activeScope: AppScope;
}): ScopeSwitcherRow[] {
  const activeCompanyId = input.activeScope.kind === 'company'
    ? input.activeScope.scope.organizationId.toLowerCase()
    : null;
  const activeHotelId = input.activeScope.kind === 'hotel'
    ? input.activeScope.propertyId.toLowerCase()
    : null;

  const seenCompanies = new Set<string>();
  const companyRows: ScopeSwitcherRow[] = [];
  for (const company of input.companies ?? []) {
    const organizationId = typeof company?.organizationId === 'string'
      ? company.organizationId.toLowerCase()
      : '';
    if (organizationId === '' || seenCompanies.has(organizationId)) continue;
    seenCompanies.add(organizationId);
    companyRows.push({
      kind: 'company',
      key: `company:${organizationId}`,
      organizationId,
      label: companyRowLabel(company.organizationName),
      active: activeCompanyId === organizationId,
    });
  }
  companyRows.sort((left, right) => compareLabels(left.label, right.label));

  const seenHotels = new Set<string>();
  const hotelRows: ScopeSwitcherRow[] = [];
  for (const hotel of input.hotels ?? []) {
    const propertyId = typeof hotel?.id === 'string' ? hotel.id.toLowerCase() : '';
    if (propertyId === '' || seenHotels.has(propertyId)) continue;
    seenHotels.add(propertyId);
    hotelRows.push({
      kind: 'hotel',
      key: `hotel:${propertyId}`,
      propertyId: hotel.id,
      label: typeof hotel.name === 'string' && hotel.name.trim() !== ''
        ? hotel.name.trim()
        : 'Hotel',
      active: activeHotelId === propertyId,
    });
  }

  return [...companyRows, ...hotelRows];
}

/** The row currently on, for a `<select>` that can only speak in strings. */
export function activeScopeSwitcherKey(rows: readonly ScopeSwitcherRow[]): string | null {
  return rows.find((row) => row.active)?.key ?? null;
}

/** Resolve an opaque key back to its row. Unknown keys are refused, not parsed. */
export function scopeSwitcherRowForKey(
  rows: readonly ScopeSwitcherRow[],
  key: string,
): ScopeSwitcherRow | null {
  return rows.find((row) => row.key === key) ?? null;
}
