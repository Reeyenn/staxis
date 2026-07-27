'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The told half's calls to /api/knowledge/*.
//
// This replaces src/lib/comms/client.ts for the panels that moved onto the
// Knows tab. Same four verbs, but on the concourse surface's plumbing:
// fetchWithAuth (token preflight + 401 recovery) and readEnvelope (the one
// place the standard { ok, data, error, code } envelope is unwrapped), so
// these panels fail the same way as everything else on this screen and a
// refusal arrives with its CODE attached — which is what the banner can
// actually translate.
//
// The ROUTES are untouched and stay UI-agnostic. Nothing here knows anything
// about them beyond their URLs.
// ═══════════════════════════════════════════════════════════════════════════

import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';

async function send<T>(url: string, init: RequestInit): Promise<EnvelopeResult<T>> {
  try {
    const res = await fetchWithAuth(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    return await readEnvelope<T>(res);
  } catch (e) {
    // Signed out mid-request: the redirect to /signin is already firing and
    // the caller (useApiResource / the panel) knows to leave state alone.
    if (e instanceof SessionEndedError) throw e;
    return { error: e instanceof Error ? e.message : 'Request failed', code: 'request_failed' };
  }
}

export function toldGet<T>(url: string): Promise<EnvelopeResult<T>> {
  return send<T>(url, { method: 'GET' });
}

export function toldPost<T>(url: string, body: unknown): Promise<EnvelopeResult<T>> {
  return send<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export function toldPatch<T>(url: string, body: unknown): Promise<EnvelopeResult<T>> {
  return send<T>(url, { method: 'PATCH', body: JSON.stringify(body) });
}

export function toldDelete<T>(url: string): Promise<EnvelopeResult<T>> {
  return send<T>(url, { method: 'DELETE' });
}

/**
 * PUT the bytes at a signed storage URL.
 *
 * Deliberately NOT fetchWithAuth: the signed URL carries its own credential
 * and Supabase Storage rejects a request that also carries our bearer token.
 * The content type is the one the presign route resolved — see uploadDocument.
 */
export async function putSigned(signedUrl: string, file: Blob, contentType: string): Promise<boolean> {
  try {
    const res = await fetch(signedUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    return res.ok;
  } catch {
    return false;
  }
}
