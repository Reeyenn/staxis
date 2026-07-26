// ═══════════════════════════════════════════════════════════════════════════
// Properties — the top-level entity. One row per hotel.
// ═══════════════════════════════════════════════════════════════════════════

import type { Property } from '@/types';
import { asRecordRows } from './_common';
import { fromPropertyRow, PROPERTY_COLS } from '../db-mappers';
import { fetchWithAuth } from '../api-fetch';

// PROPERTY_COLS moved next to fromPropertyRow in db-mappers.ts — the server
// route below is the only thing that selects those columns now, and it must not
// import this (browser) module to find them. Re-exported so nothing that
// already imports it from here breaks.
export { PROPERTY_COLS };

/**
 * ⚠️ THESE TWO READS GO THROUGH `/api/properties`, NOT THROUGH SUPABASE.
 *
 * They used to call `supabase.from('properties')` — the ANON browser client —
 * and that is what locked every company person out of the entire product. The
 * RLS policy on `properties` (0002, hardened by 0003) answers from
 * `accounts.property_access` and knows nothing about company hats (0364). A
 * company person's legacy array is EMPTY by design — every hotel they reach
 * comes from a hat — so Postgres returned zero rows with a 200 and no error.
 * `PropertyContext` set an empty hotel list, `activeProperty` stayed null,
 * `/home` bounced to `/company`, and `/company` said "No active access grant".
 * A dual-hat GM+VP could not open her own hotel, and the company rulebook panel
 * — the one screen that only she is supposed to edit — was unreachable.
 *
 * That is the RLS bug class in CLAUDE.md, one level up: browser client + an RLS
 * blind spot = a silent empty state. The house fix is the one applied here —
 * read past RLS on the server and scope in the app, through the company spine's
 * `accessibleProperties` (the legacy array UNION every live hat).
 *
 * Do not put `supabase.from('properties')` back.
 */

interface PropertiesEnvelope {
  ok?: boolean;
  data?: { properties?: unknown };
  error?: string;
}

async function readProperties(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetchWithAuth(`/api/properties${query}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Thrown, never swallowed into an empty list. PropertyContext's retry loop
    // depends on a failure being distinguishable from "you have no hotels",
    // and an empty hotel list is exactly the lie this route exists to stop
    // telling.
    throw new Error(`/api/properties ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as PropertiesEnvelope | null;
  if (!json?.ok || !Array.isArray(json.data?.properties)) {
    throw new Error(`/api/properties unexpected body: ${json?.error ?? 'no data'}`);
  }
  return asRecordRows(json.data.properties);
}

export async function getProperties(_uid: string): Promise<Property[]> {
  return (await readProperties('')).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const rows = await readProperties(`?propertyId=${encodeURIComponent(pid)}`);
  const row = rows.find((r) => String(r.id) === pid) ?? null;
  return row ? fromPropertyRow(row) : null;
}

/**
 * ⚠️ THERE IS DELIBERATELY NO `updateProperty` HERE. Don't add one back.
 *
 * A browser-side `updateProperty` existed until 2026-07-24 and SILENTLY SAVED
 * NOTHING for anyone but an admin. It wrote `properties` through the ANON
 * client, and UPDATE on `properties` is admin-only RLS (migration
 * 0002_auth_bridge.sql, tightened by 0161). For a general manager the policy
 * filtered the statement down to zero rows — and an UPDATE that matches zero
 * rows is NOT a Postgres error. No thrown error, no `error` object, nothing to
 * catch: the promise resolved, the success toast fired, the modal closed, and
 * the hotel's data was unchanged. The user had no way to tell. That is exactly
 * how the Housekeeping board's cleaning-time settings modal lied to managers
 * for months (removed 2026-07-24, fields moved to /settings/clean-times).
 *
 * It was deleted rather than documented because a documented footgun is still
 * a footgun. Writing a property setting? Add it to an `/api/...` route that
 * uses `supabaseAdmin`, gate it on the right capability, and have the route
 * `.select()` back the rows it touched so a zero-row write is a real failure.
 * Working examples: PUT /api/settings/clean-times, POST
 * /api/inventory/property-config.
 */
