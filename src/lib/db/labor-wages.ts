// Client-side data helpers for the Labor Cost % widget + wage settings.
//
// Mirrors src/lib/db/compliance.ts: thin fetch wrappers around the /api/*
// routes via fetchWithAuth (NEVER the browser supabase client — labor_wage_
// settings is service-role-only, RLS bug class). The API gates everything to
// the management trio, so these only ever resolve for managers.

import { fetchWithAuth } from '@/lib/api-fetch';
import type { LaborStatus, LaborRole } from '@/lib/labor-cost';

interface Envelope<T> { ok?: boolean; data?: T; error?: string }

async function parse<T>(res: Response): Promise<{ ok: boolean; data?: T; error?: string }> {
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `http ${res.status}` };
  return { ok: true, data: json.data };
}

// ─── Dashboard tile ──────────────────────────────────────────────────────────

/** Camel-cased view of /api/dashboard/labor-cost's snake_case payload. */
export interface LaborCostSummary {
  laborCostCents: number;
  revenueCents: number | null;
  pct: number | null;
  status: LaborStatus | null;
  missingWages: boolean;
  schedulePublished: boolean;
  targetPct: number;
  scheduledStaffCount: number;
  today: string;
}

interface LaborCostApiShape {
  labor_cost_cents: number;
  revenue_cents: number | null;
  pct: number | null;
  status: LaborStatus | null;
  missing_wages: boolean;
  schedule_published: boolean;
  target_pct: number;
  scheduled_staff_count: number;
  today: string;
}

export async function fetchLaborCost(pid: string): Promise<LaborCostSummary | null> {
  const res = await fetchWithAuth(`/api/dashboard/labor-cost?pid=${encodeURIComponent(pid)}`);
  const { ok, data } = await parse<LaborCostApiShape>(res);
  if (!ok || !data) return null;
  return {
    laborCostCents: data.labor_cost_cents,
    revenueCents: data.revenue_cents,
    pct: data.pct,
    status: data.status,
    missingWages: data.missing_wages,
    schedulePublished: data.schedule_published,
    targetPct: data.target_pct,
    scheduledStaffCount: data.scheduled_staff_count,
    today: data.today,
  };
}

// ─── Wage settings ───────────────────────────────────────────────────────────

export interface WageStaffRow {
  id: string;
  name: string;
  department: LaborRole | null;
  hourlyWageCents: number | null;
  isActive: boolean;
}

export interface WageSettingsData {
  roleDefaults: Record<LaborRole, number | null>;
  overrides: Array<{ staffId: string; hourlyWageCents: number }>;
  staff: WageStaffRow[];
  defaultWageCents: number;
}

export interface WageSavePayload {
  roleDefaults: Partial<Record<LaborRole, number | null>>;
  overrides: Array<{ staffId: string; hourlyWageCents: number | null }>;
}

export async function fetchWageSettings(pid: string): Promise<WageSettingsData | null> {
  const res = await fetchWithAuth(`/api/settings/wages?pid=${encodeURIComponent(pid)}`);
  const { ok, data } = await parse<WageSettingsData>(res);
  return ok && data ? data : null;
}

export async function saveWageSettings(
  pid: string,
  payload: WageSavePayload,
): Promise<{ ok: boolean; data?: WageSettingsData; error?: string }> {
  const res = await fetchWithAuth('/api/settings/wages', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, ...payload }),
  });
  return parse<WageSettingsData>(res);
}
