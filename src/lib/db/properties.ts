// ═══════════════════════════════════════════════════════════════════════════
// Properties — the top-level entity. One row per hotel.
// ═══════════════════════════════════════════════════════════════════════════

import type { Property } from '@/types';
import { supabase, logErr, asRecordRows, asRecordRow } from './_common';
import { fromPropertyRow } from '../db-mappers';

// Explicit column list, in lock-step with fromPropertyRow() in db-mappers.ts.
// Replaces `.select('*')` per cost-hotpaths audit recommendation #5/#13 —
// the previous wide select returned every property column (including ML
// internals like dashboard_stale_minutes and scraper_window_* that the
// front-end never consumes) on every property fetch. Update both this
// constant and fromPropertyRow when adding a column the UI needs.
export const PROPERTY_COLS =
  'id, name, total_rooms, avg_occupancy, hourly_wage, checkout_minutes, ' +
  'stayover_minutes, stayover_day1_minutes, stayover_day2_minutes, ' +
  'prep_minutes_per_activity, shift_minutes, total_staff_on_roster, ' +
  'weekly_budget, morning_briefing_time, evening_forecast_time, ' +
  'pms_type, pms_url, pms_connected, last_synced_at, alert_phone, timezone, ' +
  'room_inventory, onboarding_completed_at, onboarding_state, onboarding_prompt_shown_at, enabled_sections, inventory_budget_mode, inventory_tab_layout, housekeeping_setup, is_test, created_at';

export async function getProperties(_uid: string): Promise<Property[]> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_COLS);
  if (error) { logErr('getProperties', error); throw error; }
  return asRecordRows(data).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_COLS).eq('id', pid).maybeSingle();
  if (error) { logErr('getProperty', error); throw error; }
  const row = asRecordRow(data);
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
