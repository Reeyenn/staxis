# Staxis PMS auth-code inbox — Cloudflare Email Worker

Receives the Okta 2FA emails for the CUA robot's PMS login and forwards them to
the Staxis webhook. One Worker serves every hotel via a **catch-all** on the
`pms.getstaxis.com` subdomain — `<propertycode>@pms.getstaxis.com` (Beaumont =
`txa32@pms.getstaxis.com`).

```
Okta → txa32@pms.getstaxis.com → Cloudflare Email Routing (catch-all)
     → THIS Worker (parse + verdict + size-cap)
     → POST {to,from,subject,text,html,messageId,ts,dkim,spf,dmarc,dkimDomain}
       + Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>
     → https://getstaxis.com/api/pms-inbox/inbound → pms_auth_codes (migration 0274)
```

The Worker is a **thin courier**. Every security decision (sender allowlist,
DMARC/DKIM enforcement, code extraction, dedup, storage) is made by the webhook,
which re-verifies everything and is the boundary of record. The Worker only:
size-caps, parses the MIME, reads Cloudflare's verified auth verdict, and POSTs.

## Deploy

```bash
cd email-worker
npm install
npx wrangler secret put PMS_INBOX_WEBHOOK_SECRET   # same value as the Vercel env var
npx wrangler deploy
```

Then bind it as the catch-all destination (Cloudflare dashboard or API):
**Email → Email Routing → Routing rules → Catch-all address → Send to a Worker →
`staxis-pms-inbox`.**

### Config

| Var | Where | Purpose |
|---|---|---|
| `WEBHOOK_URL` | `wrangler.toml` `[vars]` | The webhook URL. Prod = `https://getstaxis.com/api/pms-inbox/inbound`. Point at a Vercel **preview** URL during end-to-end testing. |
| `MAX_BYTES` | `wrangler.toml` `[vars]` | Max raw message size to forward. Default 256 KiB (Okta code mails are tiny). |
| `PMS_INBOX_WEBHOOK_SECRET` | `wrangler secret` | Shared Bearer secret. **Must equal** the Vercel `PMS_INBOX_WEBHOOK_SECRET`. Never commit it. |

DNS for the subdomain (created by Email Routing's "Add subdomain" flow — apex
`getstaxis.com` MX is **never** touched):

```
pms.getstaxis.com   MX   route1.mx.cloudflare.net
pms.getstaxis.com   MX   route2.mx.cloudflare.net
pms.getstaxis.com   MX   route3.mx.cloudflare.net
pms.getstaxis.com   TXT  "v=spf1 include:_spf.mx.cloudflare.net ~all"
_dmarc.pms.getstaxis.com  TXT  "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;"
```

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
