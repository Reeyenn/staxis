/**
 * Staxis PMS inbox — Cloudflare Email Worker.
 *
 * Bound as the CATCH-ALL destination for Email Routing on the getstaxis.com
 * apex (and, if the zone supports it, on the report subdomain too). For each
 * inbound message it: size-caps, parses the MIME (postal-mime), extracts the
 * TRUSTED DKIM/SPF/DMARC verdict, and POSTs the relevant fields to the Next.js
 * webhook with a shared Bearer secret.
 *
 * This Worker is intentionally THIN — a courier. All policy (which class of
 * message this is, sender allowlist, DMARC enforcement, code extraction,
 * dedup, storage, retention) lives in the tested webhook
 * (/api/pms-inbox/inbound).
 *
 * ── ATTACHMENTS: HASH-FIRST HANDSHAKE ──────────────────────────────────────
 * Scheduled PMS report emails carry the actual data as attachments, and those
 * can be megabytes. They are NEVER sent through the webhook body:
 *
 *   1. The Worker hashes each attachment (sha256) and forwards METADATA ONLY
 *      — {filename, mimeType, size, sha256}. The webhook request stays ~2 KB
 *      no matter how big the files are.
 *   2. The webhook answers per attachment: 'skip' (we already hold these exact
 *      bytes for this hotel — zero bytes transferred) or 'upload' with a
 *      short-lived Supabase signed upload URL.
 *   3. The Worker PUTs the raw bytes straight to Storage. They never enter a
 *      Vercel function's memory or request log.
 *   4. The Worker calls /api/pms-inbox/attachment-commit with the hashes it
 *      uploaded, which is what flips each ledger row from pending to stored.
 *
 * Why not base64-in-the-webhook: Vercel serverless request bodies cap around
 * 4.5 MB and base64 inflates 33%, giving an effective ~3.3 MB ceiling. A
 * night-audit PDF pack blows through that, and the failure is a 413 the hotel
 * never sees.
 *
 * ── VERDICT TRUST (security-critical) ──────────────────────────────────────
 * An inbound message can carry sender-FORGED `Authentication-Results` headers.
 * We believe ONLY the header added by our trusted receiver (Cloudflare),
 * identified by its authserv-id (TRUSTED_AUTHSERV_IDS, default cloudflare.net).
 * An attacker can inject a header spoofing that authserv-id but cannot remove
 * Cloudflare's real one, so if MORE THAN ONE header matches the trusted
 * authserv-id we treat it as tampering and forward NO verdict (the webhook then
 * fail-closed rejects). We never read the verdict from the first/last parsed
 * header, and never from message.headers.get() (which joins duplicates).
 *
 * The selection + parsing logic below mirrors src/lib/pms-inbox/parse.ts
 * (selectTrustedAuthResults / parseAuthResults), which is unit-tested in CI.
 * Keep them in sync.
 */

import PostalMime from 'postal-mime';

export interface Env {
  /** Full URL of the Next.js webhook, e.g. https://getstaxis.com/api/pms-inbox/inbound */
  WEBHOOK_URL: string;
  /**
   * Full URL of the attachment-commit endpoint. Optional — defaults to
   * WEBHOOK_URL with the trailing `/inbound` swapped for `/attachment-commit`.
   */
  COMMIT_URL?: string;
  /** Shared secret (wrangler secret put PMS_INBOX_WEBHOOK_SECRET). */
  PMS_INBOX_WEBHOOK_SECRET: string;
  /** Max raw message size to forward (bytes). Default 25 MiB. */
  MAX_BYTES?: string;
  /** CSV of trusted receiver authserv-ids. Default cloudflare.net. */
  TRUSTED_AUTHSERV_IDS?: string;
}

interface Verdict {
  dkim: string | null;
  spf: string | null;
  dmarc: string | null;
  dkimDomain: string | null;
}

const EMPTY_VERDICT: Verdict = { dkim: null, spf: null, dmarc: null, dkimDomain: null };

/** authserv-id = the token before the first ';' in an Authentication-Results value. */
function authservIdOf(headerValue: string): string {
  return (headerValue.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Return the single Authentication-Results value whose authserv-id belongs to a
 * trusted receiver, or null if zero or MORE THAN ONE match (the latter = an
 * injected look-alike → refuse to trust).
 */
function selectTrustedAuthResults(headerValues: string[], trustedIds: string[]): string | null {
  const trusted = trustedIds.map((s) => s.toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
  const matches = headerValues.filter((v) => {
    const id = authservIdOf(v);
    return trusted.some((t) => id === t || id.endsWith('.' + t));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Parse one Authentication-Results value into discrete verdicts. */
function parseAuthResults(headerValue: string | null): Verdict {
  if (!headerValue) return EMPTY_VERDICT;
  const lower = headerValue.toLowerCase();
  const get = (re: RegExp): string | null => re.exec(lower)?.[1] ?? null;
  let dkimDomain: string | null = null;
  for (const seg of lower.split(';')) {
    if (seg.includes('dkim=pass')) {
      const m = /header\.d=([a-z0-9.\-]+)/.exec(seg);
      if (m) {
        dkimDomain = m[1];
        break;
      }
    }
  }
  if (!dkimDomain) dkimDomain = get(/header\.d=([a-z0-9.\-]+)/);
  return {
    dkim: get(/\bdkim=(\w+)/),
    spf: get(/\bspf=(\w+)/),
    dmarc: get(/\bdmarc=(\w+)/),
    dkimDomain,
  };
}

const MAX_HTML = 20_000;
/** 25 MiB — Cloudflare Email Routing's own ceiling; mirrors the pms-raw bucket. */
const DEFAULT_MAX_BYTES = 26_214_400;
/** Refuse a pathological multi-attachment message. Mirrors the webhook. */
const MAX_ATTACHMENTS = 10;

/** Lowercase hex sha256 of the exact bytes. Same address the webhook records. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function commitUrlFor(env: Env): string {
  if (env.COMMIT_URL) return env.COMMIT_URL;
  return env.WEBHOOK_URL.replace(/\/inbound\/?$/, '/attachment-commit');
}

interface PreparedAttachment {
  filename: string | null;
  mimeType: string;
  size: number;
  sha256: string;
  bytes: ArrayBuffer;
}

interface AttachmentDecision {
  sha256?: unknown;
  action?: unknown;
  uploadUrl?: unknown;
}

/** postal-mime hands back ArrayBuffer for binary parts and string for text ones. */
function toArrayBuffer(content: unknown): ArrayBuffer | null {
  if (content instanceof ArrayBuffer) return content;
  if (typeof content === 'string') {
    const encoded = new TextEncoder().encode(content);
    // Copy into a standalone ArrayBuffer so the byteOffset is always 0.
    return encoded.slice().buffer as ArrayBuffer;
  }
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer as ArrayBuffer;
  }
  return null;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const maxBytes = Number(env.MAX_BYTES ?? String(DEFAULT_MAX_BYTES)) || DEFAULT_MAX_BYTES;
    if (message.rawSize > maxBytes) {
      // Cloudflare also rejects over-limit mail at the edge before we ever run,
      // so this is a belt-and-braces log, not the primary detector.
      console.log(JSON.stringify({ msg: 'drop_oversized', to: message.to, rawSize: message.rawSize }));
      return;
    }

    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (e) {
      console.log(JSON.stringify({ msg: 'parse_failed', to: message.to, err: String(e) }));
      return;
    }

    // Trusted verdict ONLY — see the VERDICT TRUST block above.
    const trustedIds = (env.TRUSTED_AUTHSERV_IDS ?? 'cloudflare.net')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const arValues = (parsed.headers ?? [])
      .filter((h) => (h.key ?? '').toLowerCase() === 'authentication-results')
      .map((h) => h.value ?? '');
    const trustedAR = selectTrustedAuthResults(arValues, trustedIds);
    const verdict = parseAuthResults(trustedAR);

    const headerFrom = parsed.from?.address
      ? parsed.from.name
        ? `${parsed.from.name} <${parsed.from.address}>`
        : parsed.from.address
      : message.from;

    const html = typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_HTML) : '';

    // ── Hash every attachment; forward metadata only ────────────────────────
    const prepared: PreparedAttachment[] = [];
    for (const att of (parsed.attachments ?? []).slice(0, MAX_ATTACHMENTS)) {
      const bytes = toArrayBuffer((att as { content?: unknown }).content);
      if (!bytes || bytes.byteLength === 0) continue;
      try {
        prepared.push({
          filename: att.filename ?? null,
          mimeType: att.mimeType ?? 'application/octet-stream',
          size: bytes.byteLength,
          sha256: await sha256Hex(bytes),
          bytes,
        });
      } catch (e) {
        console.log(JSON.stringify({ msg: 'attachment_hash_failed', to: message.to, err: String(e) }));
      }
    }

    const payload = {
      to: message.to, // envelope recipient Cloudflare matched
      from: headerFrom, // header From (what DMARC aligns to)
      subject: parsed.subject ?? message.headers.get('subject') ?? '',
      text: parsed.text ?? '',
      html,
      messageId: parsed.messageId ?? message.headers.get('message-id') ?? null,
      ts: Date.now(),
      dkim: verdict.dkim,
      spf: verdict.spf,
      dmarc: verdict.dmarc,
      dkimDomain: verdict.dkimDomain,
      attachments: prepared.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        sha256: a.sha256,
      })),
    };

    let decisions: AttachmentDecision[] = [];
    try {
      const res = await fetch(env.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.PMS_INBOX_WEBHOOK_SECRET}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        try {
          const json = (await res.json()) as { data?: { attachments?: AttachmentDecision[] } };
          decisions = json?.data?.attachments ?? [];
        } catch {
          decisions = [];
        }
      }
      console.log(
        JSON.stringify({
          msg: 'forwarded',
          to: message.to,
          status: res.status,
          arCount: arValues.length,
          trusted: trustedAR != null,
          dkim: verdict.dkim,
          dmarc: verdict.dmarc,
          dkimDomain: verdict.dkimDomain,
          attachments: prepared.length,
          uploads: decisions.filter((d) => d.action === 'upload').length,
        }),
      );
    } catch (e) {
      // Returning without throwing acks the message (no SMTP bounce/backscatter).
      // Okta re-sends a fresh code on next login and a report scheduler resends
      // on its next tick, so a transient forward failure is self-healing; it's
      // visible in `wrangler tail`.
      console.log(JSON.stringify({ msg: 'forward_failed', to: message.to, err: String(e) }));
      return;
    }

    // ── PUT the bytes the webhook asked for, then commit ────────────────────
    const bySha = new Map(prepared.map((a) => [a.sha256, a]));
    const uploaded: string[] = [];
    for (const d of decisions) {
      if (d.action !== 'upload' || typeof d.sha256 !== 'string' || typeof d.uploadUrl !== 'string') continue;
      const att = bySha.get(d.sha256);
      if (!att) continue;
      try {
        const put = await fetch(d.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': att.mimeType },
          body: att.bytes,
        });
        if (put.ok) {
          uploaded.push(att.sha256);
        } else {
          console.log(JSON.stringify({ msg: 'upload_failed', to: message.to, status: put.status }));
        }
      } catch (e) {
        console.log(JSON.stringify({ msg: 'upload_threw', to: message.to, err: String(e) }));
      }
    }

    if (uploaded.length === 0) return;

    try {
      const res = await fetch(commitUrlFor(env), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.PMS_INBOX_WEBHOOK_SECRET}`,
        },
        body: JSON.stringify({ messageId: payload.messageId, sha256: uploaded }),
      });
      console.log(JSON.stringify({ msg: 'committed', to: message.to, status: res.status, count: uploaded.length }));
    } catch (e) {
      // The bytes are safe in Storage; the ledger row stays 'pending_upload'
      // and the hourly sweep makes the gap visible rather than silent.
      console.log(JSON.stringify({ msg: 'commit_failed', to: message.to, err: String(e) }));
    }
  },
};
