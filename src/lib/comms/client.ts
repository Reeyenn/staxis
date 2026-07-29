'use client';

// Browser-side API client for the Communications tab. Attaches the Supabase
// access token (+ same-origin cookies for 2FA) to every call. All reads/writes
// go through /api/comms/* (server, supabaseAdmin) — never the browser DB client.

import { fetchWithAuth, INTERACTIVE_ACTION_TIMEOUT_MS } from '@/lib/api-fetch';
import { fetchWithDeadline } from '@/lib/fetch-deadline';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface ApiResult<T> { ok: boolean; status: number; data?: T; error?: string }

export async function apiGet<T>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url, { headers: JSON_HEADERS });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiPost<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiPatch<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

export async function apiDelete<T>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
    return { ok: !!json.ok, status: res.status, data: json.data, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
}

/** Upload a file to a signed-upload URL from presignAttachment. */
export async function uploadToSignedUrl(
  signedUrl: string,
  file: Blob,
  contentType = file.type || 'application/octet-stream',
): Promise<boolean> {
  try {
    const res = await fetchWithDeadline(
      signedUrl,
      { method: 'PUT', body: file, headers: { 'Content-Type': contentType } },
      { timeoutMs: 60_000, label: 'Attachment upload' },
    );
    return res.ok;
  } catch {
    return false;
  }
}
