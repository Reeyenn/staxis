# Staxis PMS report inbox — Cloudflare Email Worker

> The browser robot's Okta auth-code path is retired. The Worker remains a
> thin courier because it also carries scheduled PMS reports; authenticated
> auth-code recipients are accepted and dropped by the webhook without a
> database write while `PMS_ROBOT_ENABLED` is false.

Receives PMS inbox mail and forwards each message to the Staxis webhook. One
Worker serves every hotel via a **catch-all** on the
`getstaxis.com` **apex** — `<propertycode>@getstaxis.com` (Beaumont =
`txa32@getstaxis.com`). The inbox lives on the apex because Choice's Okta user
form rejects subdomained emails (`…@pms.getstaxis.com` → "Enter a valid email").

```
Okta → txa32@getstaxis.com → Cloudflare Email Routing (apex catch-all)
     → THIS Worker (parse + verdict + size-cap)
     → POST {to,from,subject,text,html,messageId,ts,dkim,spf,dmarc,dkimDomain}
       + Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>
     → https://getstaxis.com/api/pms-inbox/inbound
       → report recipient: report ledger + attachment upload handshake
       → old auth recipient: accepted and dropped while the robot is retired
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
| `COMMIT_URL` | `wrangler.toml` `[vars]` | Phase two of the attachment handshake. Defaults to `WEBHOOK_URL` with `/inbound` → `/attachment-commit`. |
| `MAX_BYTES` | `wrangler.toml` `[vars]` | Max raw message size to forward. **25 MiB** (was 256 KiB) — report emails carry CSV/PDF/XLSX attachments. Must stay ≤ the `pms-raw` bucket's `file_size_limit` (migration 0340). |
| `PMS_INBOX_WEBHOOK_SECRET` | `wrangler secret` | Shared Bearer secret. **Must equal** the Vercel `PMS_INBOX_WEBHOOK_SECRET`. Never commit it. |

## Report emails (migrations 0340–0342)

The same Worker now also carries **scheduled PMS report emails**, the new data
intake path. Which class a message is depends ONLY on the recipient address, and
the **webhook** decides — the Worker never classifies anything.

```
PMS report scheduler → <unguessable-token>@in.getstaxis.com  (or r-<token>@getstaxis.com)
     → Cloudflare Email Routing → THIS Worker
     → POST {…, attachments:[{filename,mimeType,size,sha256}]}   ← METADATA ONLY (~2 KB)
     → webhook replies per attachment: 'skip' | 'upload' + signed Storage URL
     → Worker PUTs raw bytes straight to Supabase Storage (never through Vercel)
     → POST /api/pms-inbox/attachment-commit {messageId, sha256[]}
```

Attachment bytes never enter a Vercel function's memory or request log, a
duplicate file transfers **zero** bytes, and an interrupted upload leaves a
visible `pending_upload` ledger row that the daily purge cron sweeps to `failed`
after an hour.

### ⚠️ Human deploy steps (nobody else can do these)

1. `cd email-worker && npm install && npx wrangler deploy` — ships the
   attachment handshake and the 25 MiB limit.
2. Decide the report address shape in the Cloudflare dashboard:
   - **Preferred:** Email Routing on `in.getstaxis.com` (MX for the subdomain +
     a catch-all → this Worker). If the zone/plan doesn't allow a subdomain,
   - **Fallback:** keep the apex catch-all and set the Vercel env var
     `PMS_REPORT_INBOX_DOMAIN=getstaxis.com`. Report mail is then addressed
     `r-<token>@getstaxis.com` and stays disjoint from the 2FA inbox by prefix.
   No DB constraint hard-codes either shape, so this decision can be made after
   the migrations are applied.
3. Set each hotel's report address via the `staxis_set_report_inbox` RPC (only
   the sha256 and a vault-encrypted copy are stored — never the plaintext).

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
- **Size-capped.** Attachment BYTES are still never forwarded through the
  webhook — only `{filename, mimeType, size, sha256}`. The webhook caps body
  size again and rate-limits per property.
- **Report-address secrecy:** the per-hotel report address is an unguessable
  capability token. Only its sha256 reaches the database lookup, and the
  webhook never writes the token into `pms_inbox_messages.email_to`.
- **Secret** is a Cloudflare secret + a Vercel env var; rotate via the webhook's
  `PMS_INBOX_WEBHOOK_SECRET_NEXT` slot (accepts either during the overlap).

## Historical robot-auth verification (retained, inactive)

The verdict is parsed from Cloudflare's `Authentication-Results` header. Confirm,
with `npx wrangler tail` while a real Okta code email arrives, that:

1. `dkim` / `dmarc` come through as `pass`, and
2. `dkimDomain` is what Choice's Okta actually signs with (e.g. `okta.com` — or
   a sub-processor domain, in which case add it to the webhook's
   `PMS_INBOX_ALLOWED_SENDER_DOMAINS`).

Until that's confirmed, the webhook will (correctly) reject mail it can't
authenticate. This is the one piece that depends on Okta's real sending setup.
