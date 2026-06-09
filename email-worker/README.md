# Staxis PMS auth-code inbox — Cloudflare Email Worker

Receives the Okta mail for the CUA robot's PMS login and forwards each message to
the Staxis webhook. One Worker serves every hotel via a **catch-all** on the
`getstaxis.com` **apex** — `<propertycode>@getstaxis.com` (Beaumont =
`txa32@getstaxis.com`). The inbox lives on the apex because Choice's Okta user
form rejects subdomained emails (`…@pms.getstaxis.com` → "Enter a valid email").

```
Okta → txa32@getstaxis.com → Cloudflare Email Routing (apex catch-all)
     → THIS Worker (parse + verdict + size-cap)
     → POST {to,from,subject,text,html,messageId,ts,dkim,spf,dmarc,dkimDomain}
       + Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>
     → https://getstaxis.com/api/pms-inbox/inbound
       → pms_inbox_messages  (full email + account-setup links, migration 0275)
       → pms_auth_codes       (6-digit codes for the robot,       migration 0274)
```

The Worker is a **thin courier**. Every security decision (sender allowlist,
DMARC/DKIM enforcement, code extraction, dedup, storage) is made by the webhook,
which re-verifies everything and is the boundary of record. The Worker only:
size-caps, parses the MIME, reads Cloudflare's verified auth verdict, and POSTs.
It forwards **every** message the apex catch-all receives; the webhook is the
sole authority on which recipient maps to a hotel (it silently drops unknown
recipients), so junk to `noreply@`/`support@`/bounces is harmless — and any
sender that isn't DMARC/DKIM-aligned to `okta.com` is rejected before storage.

## Deploy

```bash
cd email-worker
npm install
npx wrangler secret put PMS_INBOX_WEBHOOK_SECRET   # same value as the Vercel env var
npx wrangler deploy
```

Then bind it as the **apex** zone's catch-all destination (Cloudflare dashboard):
**getstaxis.com → Email → Email Routing → Routing rules → Catch-all address →
Send to a Worker → `staxis-pms-inbox`.** This is the only live change to flip the
inbox on — the apex was previously catch-all → "Drop".

### Config

| Var | Where | Purpose |
|---|---|---|
| `WEBHOOK_URL` | `wrangler.toml` `[vars]` | The webhook URL. Prod = `https://getstaxis.com/api/pms-inbox/inbound`. Point at a Vercel **preview** URL during end-to-end testing. |
| `MAX_BYTES` | `wrangler.toml` `[vars]` | Max raw message size to forward. Default 256 KiB (Okta code mails are tiny). |
| `PMS_INBOX_WEBHOOK_SECRET` | `wrangler secret` | Shared Bearer secret. **Must equal** the Vercel `PMS_INBOX_WEBHOOK_SECRET`. Never commit it. |

### DNS — no record changes needed

The apex `getstaxis.com` **already** has Email Routing MX (`route1/2/3.mx.cloudflare.net`)
and the apex SPF — mail to the apex already arrives at Cloudflare; it was just
hitting a "Drop" catch-all. Flipping the catch-all action to this Worker (above)
is the **only** change. **Do NOT edit any DNS record.**

Crucially, the apex MX is independent of the **sending** records, which must stay
intact: `resend._domainkey.getstaxis.com` (Resend DKIM), `send.getstaxis.com` MX
→ `feedback-smtp.us-east-1.amazonses.com` + its SPF. The app sends its login/2FA
mail from `noreply@getstaxis.com` via Resend; receiving (this Worker) does not
touch any of that.

The old `pms.getstaxis.com` subdomain routing is now unused. It's harmless to
leave; remove its MX/TXT/`_dmarc` records later if you want to tidy up.

## Security

- **Sender authenticity** is enforced by the webhook on the forwarded verdict:
  DMARC=pass (or DKIM aligned to the allowlisted sender domain — `okta.com`,
  which publishes DMARC `p=reject`). `choicehotels.com` is deliberately NOT
  allowlisted (it isn't the OTP sender and its DMARC is `p=none`).
- **Verdict trust:** the Worker believes ONLY the `Authentication-Results`
  header whose authserv-id matches `TRUSTED_AUTHSERV_IDS` (Cloudflare). A
  sender can inject a forged AR header, but can't remove Cloudflare's real one,
  so two matches = tampering → the Worker forwards no verdict and the webhook
  fail-closed rejects. It never trusts the first/last raw header.
- **No backscatter:** the Worker never `setReject()`s or bounces these — it acks
  and forwards, so a probing sender learns nothing.
- **Size-capped** and attachments are not forwarded (only subject/text/bounded
  html). The webhook caps body size again and rate-limits per property.
- **Secret** is a Cloudflare secret + a Vercel env var; rotate via the webhook's
  `PMS_INBOX_WEBHOOK_SECRET_NEXT` slot (accepts either during the overlap).

## ⚠️ Empirical-verification step (do this against a real Okta email)

The verdict is parsed from Cloudflare's `Authentication-Results` header. Confirm,
with `npx wrangler tail` while a real Okta code email arrives, that:

1. `dkim` / `dmarc` come through as `pass`, and
2. `dkimDomain` is what Choice's Okta actually signs with (e.g. `okta.com` — or
   a sub-processor domain, in which case add it to the webhook's
   `PMS_INBOX_ALLOWED_SENDER_DOMAINS`).

Until that's confirmed, the webhook will (correctly) reject mail it can't
authenticate. This is the one piece that depends on Okta's real sending setup.
