'use client';

// Browser-side API client for the Communications tab. Attaches the Supabase
// access token (+ same-origin cookies for 2FA) to every call. All reads/writes
// go through /api/comms/* (server, supabaseAdmin) — never the browser DB client.

import { supabase } from '@/lib/supabase';

async function authHeaders(): Promise<Record<string, string>> {
  let token: string | undefined;
  try { token = (await supabase.auth.getSession()).data.session?.access_token; } catch { /* */ }
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export interface ApiResult<T> { ok: boolean; status: number; data?: T; error?: string }

export async function apiGet<T>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { headers: await authHeaders() });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiPost<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiPatch<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method: 'PATCH', headers: await authHeaders(), body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiDelete<T>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method: 'DELETE', headers: await authHeaders() });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

/** Upload a file to a signed-upload URL from presignAttachment. */
export async function uploadToSignedUrl(signedUrl: string, file: Blob): Promise<boolean> {
  try {
    const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    return res.ok;
  } catch {
    return false;
  }
}
