/**
 * Shared Sentry PII scrubber. Used as `beforeSend` for both the client
 * and server SDK configs.
 *
 * 2026-05-12 (Codex audit): Sentry's sendDefaultPii=false sanitises the
 * SDK's automatic capture (IPs, cookies, request headers) but does NOT
 * touch custom message text, exception values, tags, contexts, or
 * breadcrumb data. Hotel-ops errors routinely include staff phone
 * numbers, names, PMS payload fragments, and auth tokens. This scrubber
 * runs over the whole event before ingestion and replaces those.
 *
 * Conservative posture: redact whenever a value MIGHT be PII rather
 * than only when we're sure. False positives are noise; false negatives
 * are compliance issues.
 */

import type { Event, EventHint } from '@sentry/types';

const PHONE_RX = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_RX = /(Authorization:\s*Bearer\s+)\S+/gi;
const COOKIE_RX = /(Cookie:\s*)[^\n]+/gi;
const JWT_RX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SUPABASE_KEY_RX = /sb-[a-z0-9-]+-auth-token/gi;
const TWILIO_SID_RX = /\b(AC|SM|MM)[a-f0-9]{32}\b/gi;

// Keys we should scrub in tags / contexts / extras even if their VALUE
// doesn't match a regex (e.g. raw staff name as the value of "staffName").
const PII_KEYS = new Set([
  'phone', 'phone_number', 'phoneNumber', 'phone164',
  'email', 'from', 'fromnumber', 'fromheader', 'to', 'toPhone',
  'username', 'password', 'access_token', 'accessToken',
  'authorization', 'cookie',
  'staffname', 'staff_name', 'guestname', 'guest_name',
]);

export function scrubString(s: string): string {
  let out = s;
  out = out.replace(PHONE_RX, '<phone>');
  out = out.replace(EMAIL_RX, '<email>');
  out = out.replace(BEARER_RX, '$1<redacted>');
  out = out.replace(COOKIE_RX, '$1<redacted>');
  out = out.replace(JWT_RX, '<jwt>');
  out = out.replace(SUPABASE_KEY_RX, '<supabase-key>');
  out = out.replace(TWILIO_SID_RX, '<twilio-sid>');
  return out;
}

function scrubValue(key: string, v: unknown): unknown {
  if (PII_KEYS.has(key.toLowerCase())) return '<redacted>';
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((x, i) => scrubValue(`${key}[${i}]`, x));
  if (v && typeof v === 'object') return scrubRecord(v as Record<string, unknown>);
  return v;
}

function scrubRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = scrubValue(k, v);
  }
  return out;
}

export function scrubSentryEvent(event: Event, _hint?: EventHint): Event | null {
  // Top-level message
  if (event.message) event.message = scrubString(event.message);

  // Exception values
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubString(ex.value);
    }
  }

  // Request body / query / headers
  if (event.request) {
    if (event.request.data && typeof event.request.data === 'string') {
      event.request.data = scrubString(event.request.data);
    } else if (event.request.data && typeof event.request.data === 'object') {
      event.request.data = scrubRecord(event.request.data as Record<string, unknown>);
    }
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      event.request.query_string = scrubString(event.request.query_string);
    }
    if (event.request.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        headers[k] = typeof v === 'string' ? scrubString(v) : (v as string);
      }
      event.request.headers = headers;
    }
  }

  // Tags / extras / contexts
  if (event.tags) {
    const tags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.tags)) tags[k] = scrubValue(k, v);
    event.tags = tags as typeof event.tags;
  }
  if (event.extra) event.extra = scrubRecord(event.extra as Record<string, unknown>);
  if (event.contexts) {
    const contexts: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.contexts)) {
      contexts[k] = v && typeof v === 'object' ? scrubRecord(v as Record<string, unknown>) : v;
    }
    event.contexts = contexts as typeof event.contexts;
  }

  // Breadcrumbs
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubString(b.message);
      if (b.data) b.data = scrubRecord(b.data as Record<string, unknown>);
    }
  }

  return event;
}
