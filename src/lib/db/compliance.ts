// Client-side data helpers for engineering compliance.
//
// Mirrors src/lib/db/housekeeper-helpers.ts: thin fetch wrappers around the
// /api/* routes (NEVER the browser supabase client — the compliance tables are
// service-role-only, RLS bug class). Manager helpers send the auth token via
// fetchWithAuth; the engineer mobile page is public so its helpers use plain
// fetch with the pid+staffId capability params.

import { fetchWithAuth } from '@/lib/api-fetch';
import { withStaffLinkToken, withStaffLinkTokenBody } from '@/lib/staff-link-client';
import type {
  ComplianceOverview,
  ComplianceSummary,
  ComplianceReport,
} from '@/lib/compliance/types';

interface Envelope<T> { ok?: boolean; data?: T; error?: string }

async function parse<T>(res: Response): Promise<{ ok: boolean; data?: T; error?: string }> {
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `http ${res.status}` };
  return { ok: true, data: json.data };
}

// ─── Manager (authenticated) ─────────────────────────────────────────────────

export async function fetchComplianceOverview(pid: string): Promise<ComplianceOverview | null> {
  const res = await fetchWithAuth(`/api/compliance/overview?pid=${encodeURIComponent(pid)}`);
  const { ok, data } = await parse<ComplianceOverview>(res);
  return ok && data ? data : null;
}

export async function fetchComplianceSummary(pid: string): Promise<ComplianceSummary | null> {
  const res = await fetchWithAuth(`/api/compliance/summary?pid=${encodeURIComponent(pid)}`);
  const { ok, data } = await parse<ComplianceSummary>(res);
  return ok && data ? data : null;
}

export async function fetchComplianceReport(pid: string, from?: string, to?: string): Promise<ComplianceReport | null> {
  const qs = new URLSearchParams({ pid });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const res = await fetchWithAuth(`/api/compliance/report?${qs.toString()}`);
  const { ok, data } = await parse<ComplianceReport>(res);
  return ok && data ? data : null;
}

async function postManager<T>(url: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}

export const saveReadingType = (body: unknown) => postManager(`/api/compliance/reading-type`, body);
export const savePmTask = (body: unknown) => postManager(`/api/compliance/pm-task`, body);
export const logManagerReading = (body: unknown) => postManager<{ readingId: string; outOfRange: boolean; workOrderCreated: boolean }>(`/api/compliance/log-reading`, body);
export const logManagerPmCheck = (body: unknown) => postManager<{ checkId: string; workOrderCreated: boolean }>(`/api/compliance/log-pm-check`, body);
export const runComplianceSetup = (pid: string, text?: string) => postManager<{ detectedBrand: string; readingsCreated: number; pmCreated: number }>(`/api/compliance/setup`, { pid, text });
export const loadComplianceTemplate = (pid: string, templateKey: string) => postManager<{ readingsCreated: number; pmCreated: number }>(`/api/compliance/load-template`, { pid, templateKey });
export const sendEngineerLinks = (pid: string, baseUrl?: string) => postManager<{ sent: number; skipped: number; failed: number; perStaff: Array<{ name: string; status: string; reason?: string }> }>(`/api/send-engineer-links`, { pid, baseUrl });
export const managerVisionReading = (body: unknown) => postManager<{ value: number | null; unit: string | null; confidence: string; note: string | null }>(`/api/compliance/vision-reading`, body);
// v2: dismiss an active leak/spike anomaly alert.
export const acknowledgeAnomaly = (pid: string, alertId: string) => postManager<{ alertId: string }>(`/api/compliance/anomaly-ack`, { pid, alertId });

export async function fetchComplianceTemplates(): Promise<Array<{ key: string; label: string; readingCount: number; pmCount: number }>> {
  const res = await fetchWithAuth(`/api/compliance/load-template`);
  const { ok, data } = await parse<{ templates: Array<{ key: string; label: string; readingCount: number; pmCount: number }> }>(res);
  return ok && data ? data.templates : [];
}

// ─── Engineer mobile (public; pid + staffId capability) ──────────────────────

export interface EngineerBootstrap {
  staff: { id: string; name: string; language: string };
  overview: ComplianceOverview;
}

export async function engineerBootstrap(pid: string, staffId: string): Promise<EngineerBootstrap | null> {
  // Security audit 2026-06-26 #1: forward the per-staff link token (?tok=).
  const res = await fetch(withStaffLinkToken(`/api/engineer/bootstrap?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(staffId)}`));
  const { ok, data } = await parse<EngineerBootstrap>(res);
  return ok && data ? data : null;
}

async function postEngineer<T>(url: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  // Security audit 2026-06-26 #1: fold the per-staff link token into every
  // engineer POST body (this is the single choke point for the mobile POSTs).
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withStaffLinkTokenBody((body ?? {}) as Record<string, unknown>)),
  });
  return parse<T>(res);
}

export const engineerLogReading = (body: unknown) => postEngineer<{ readingId: string; outOfRange: boolean; workOrderCreated: boolean; duplicate: boolean }>(`/api/engineer/log-reading`, body);
export const engineerLogPmCheck = (body: unknown) => postEngineer<{ checkId: string; workOrderCreated: boolean }>(`/api/engineer/log-pm-check`, body);
export const engineerVisionReading = (body: unknown) => postEngineer<{ value: number | null; unit: string | null; confidence: string; note: string | null }>(`/api/engineer/vision-reading`, body);
export const engineerVoiceLog = (body: unknown) => postEngineer<{ logged: Array<{ name: string; value: number; outOfRange: boolean }>; unmatched: string[]; parsedCount: number }>(`/api/engineer/voice-log`, body);
export const engineerSaveLanguage = (pid: string, staffId: string, language: string) => postEngineer<{ id: string; language: string }>(`/api/engineer/save-language`, { pid, staffId, language });
