/**
 * Staxis PMS auth-code inbox — Cloudflare Email Worker.
 *
 * Bound as the CATCH-ALL destination for Email Routing on pms.getstaxis.com.
 * For each inbound message it: size-caps, parses the MIME (postal-mime),
 * extracts Cloudflare's verified DKIM/SPF/DMARC verdict, and POSTs the
 * relevant fields to the Next.js webhook with a shared Bearer secret.
 *
 * This Worker is intentionally THIN — a courier. All security decisions
 * (sender allowlist, DMARC enforcement, code extraction, dedup, storage) live
 * in the tested webhook (/api/pms-inbox/inbound), which re-verifies everything
 * and is the boundary of record. The Worker never decides what to store.
 *
 * Trust note: the verdict is read from the FIRST Authentication-Results header
 * (the one our receiver — Cloudflare — prepends), not a sender-supplied one,
 * and the webhook independently requires DMARC/DKIM aligned to an allowlisted
 * domain. See README.md for the empirical-verification step.
 */

import PostalMime from 'postal-mime';

export interface Env {
  /** Full URL of the Next.js webhook, e.g. https://getstaxis.com/api/pms-inbox/inbound */
  WEBHOOK_URL: string;
  /** Shared secret (wrangler secret put PMS_INBOX_WEBHOOK_SECRET). */
  PMS_INBOX_WEBHOOK_SECRET: string;
  /** Max raw message size to forward (bytes). Default 256 KiB. */
  MAX_BYTES?: string;
}

interface Verdict {
  dkim: string | null;
  spf: string | null;
  dmarc: string | null;
  dkimDomain: string | null;
}

function firstHeaderValue(
  headers: Array<{ key: string; value: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lname = name.toLowerCase();
  for (const h of headers) {
    if ((h.key ?? '').toLowerCase() === lname) return h.value ?? null;
  }
  return null;
}

/** Parse an Authentication-Results header into discrete verdicts. */
function parseAuthResults(header: string | null): Verdict {
  const lower = (header ?? '').toLowerCase();
  const get = (re: RegExp): string | null => re.exec(lower)?.[1] ?? null;
  const dkim = get(/\bdkim=(\w+)/);
  const spf = get(/\bspf=(\w+)/);
  const dmarc = get(/\bdmarc=(\w+)/);
  // Prefer the header.d from the dkim=pass segment; fall back to any header.d.
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
  return { dkim, spf, dmarc, dkimDomain };
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

    // First Authentication-Results = the one our receiver (Cloudflare) added.
    const authResults =
      firstHeaderValue(parsed.headers, 'authentication-results') ??
      message.headers.get('authentication-results');
    const verdict = parseAuthResults(authResults);

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
          dkim: verdict.dkim,
          dmarc: verdict.dmarc,
          dkimDomain: verdict.dkimDomain,
        }),
      );
    } catch (e) {
      // Returning without throwing acks the message (no SMTP bounce/backscatter).
      // A genuine outage is visible in `wrangler tail`; the webhook's own retry
      // posture is moot here because Okta will re-send a fresh code on next login.
      console.log(JSON.stringify({ msg: 'forward_failed', to: message.to, err: String(e) }));
    }
  },
};
