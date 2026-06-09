/**
 * Staxis PMS auth-code inbox — Cloudflare Email Worker.
 *
 * Bound as the CATCH-ALL destination for Email Routing on the getstaxis.com apex.
 * For each inbound message it: size-caps, parses the MIME (postal-mime),
 * extracts the TRUSTED DKIM/SPF/DMARC verdict, and POSTs the relevant fields
 * to the Next.js webhook with a shared Bearer secret.
 *
 * This Worker is intentionally THIN — a courier. All policy (sender allowlist,
 * DMARC enforcement, code extraction, dedup, storage) lives in the tested
 * webhook (/api/pms-inbox/inbound).
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
  /** Shared secret (wrangler secret put PMS_INBOX_WEBHOOK_SECRET). */
  PMS_INBOX_WEBHOOK_SECRET: string;
  /** Max raw message size to forward (bytes). Default 256 KiB. */
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

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const maxBytes = Number(env.MAX_BYTES ?? '262144') || 262144;
    if (message.rawSize > maxBytes) {
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
    };

    try {
      const res = await fetch(env.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.PMS_INBOX_WEBHOOK_SECRET}`,
        },
        body: JSON.stringify(payload),
      });
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
        }),
      );
    } catch (e) {
      // Returning without throwing acks the message (no SMTP bounce/backscatter).
      // Okta re-sends a fresh code on next login, so a transient forward failure
      // is self-healing; it's visible in `wrangler tail`.
      console.log(JSON.stringify({ msg: 'forward_failed', to: message.to, err: String(e) }));
    }
  },
};
