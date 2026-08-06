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

// ─── Approving what @Staxis proposed ───────────────────────────────────────
//
// The thread assistant proposes; it never writes. A work order or a complaint
// it suggests becomes an approval card, and the card is resolved through the
// ONE approval endpoint the whole app uses — /api/agent/command/resolve-action.
// This is a transport helper for that endpoint, not a second one: it holds no
// decision logic, and every scope, section, role and single-use check lives on
// the server side of this call.
//
// That endpoint answers with an SSE stream (the chat bar renders the model's
// follow-up as it arrives). A thread has nothing to stream into, so this reads
// the stream to the end and hands back the one event a card cares about.

export interface AgentActionOutcome {
  ok: boolean;
  denied: boolean;
  /** What happened, in the reader's language. Empty when the route errored. */
  summary: string;
  error?: string;
}

export async function resolveAgentAction(
  pid: string,
  pendingActionId: string,
  decision: 'approve' | 'deny',
  lang?: string,
): Promise<AgentActionOutcome> {
  try {
    const res = await fetchWithAuth('/api/agent/command/resolve-action', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ pid, pendingActionId, decision }),
      timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
    });
    if (!res.ok || !res.body) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, denied: false, summary: '', error: json.error ?? 'That did not go through.' };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outcome: AgentActionOutcome | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev: { type?: string; ok?: boolean; denied?: boolean; error?: string; resultSummary?: { en: string; es: string } };
        try { ev = JSON.parse(line.slice('data: '.length)); } catch { continue; }
        if (ev.type === 'action_result') {
          outcome = {
            ok: ev.ok === true,
            denied: ev.denied === true,
            summary: (lang === 'es' ? ev.resultSummary?.es : ev.resultSummary?.en) ?? ev.resultSummary?.en ?? '',
            error: ev.error,
          };
        }
        // The model's follow-up text streams after this and is deliberately
        // dropped: the thread already carries Staxis's answer as a message, and
        // a second copy of it inside a card would read as two replies.
      }
    }
    return outcome ?? { ok: false, denied: false, summary: '', error: 'That did not go through.' };
  } catch (e) {
    return { ok: false, denied: false, summary: '', error: e instanceof Error ? e.message : 'network error' };
  }
}
