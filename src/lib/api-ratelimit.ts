/**
 * Per-property hourly rate limit for SMS-firing endpoints.
 *
 * Storage: a single Postgres table `api_limits` keyed by
 * (property_id, endpoint, hour_bucket). On each call we INCREMENT and
 * compare against a per-endpoint cap. Hits are atomic (a single SQL
 * upsert) so two concurrent requests can't both squeak under the limit.
 *
 * Why Postgres and not Redis: we already have a single Postgres
 * dependency, and the SMS-fire rate is at most ~1 RPS per property at
 * peak. The cost of one extra round-trip per SMS is acceptable. If we
 * ever need higher throughput, swap the body of `checkAndIncrement`
 * with an Upstash Redis call without touching call sites.
 *
 * Migration `0008_api_limits.sql` creates the table.
 */

import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/** Endpoint identifier — keep these short and stable. */
export type RateLimitEndpoint =
  // ── Reports (self-serve report hub) ──────────────────────────────────────
  // reports-run can call Claude for the AI summary (billing-impacting); keyed
  // on the RAW property id, never a hashed composite (api_limits FK trap).
  | 'reports-run'
  | 'reports-export'
  | 'populate-rooms-from-plan'
  // Phase 3 — each manager room-status change, when write-back is enabled,
  // enqueues a robot job that MUTATES the real PMS. Cap per property so a
  // compromised account or a runaway UI loop can't fire thousands of PMS
  // writes. Billing-impacting (fails CLOSED below).
  | 'pms-writeback-enqueue'
  // AI Control Center validation runs a real synthetic provider probe before
  // a model can be activated. Admin-only, but still billable and therefore
  // bounded/fail-closed against a compromised session or retry loop.
  | 'admin-ai-config-validate'
  // AI Control Center provider catalog refresh: outbound model-list calls to
  // Anthropic/OpenAI + bulk catalog upserts. Not token-billable, so fail-open,
  // but bounded against a scripted retry loop rewriting the fleet catalog.
  | 'admin-ai-models-refresh'
  // Invoice OCR — Claude Vision call per image ($0.003-0.01/scan).
  // Maria might scan 5-10 invoices a week in normal use; 50/hr per
  // property is generous headroom. A compromised session or buggy
  // retry loop hits the cap fast. May 2026 audit pass-5.
  | 'scan-invoice'
  // Shelf photo counting — same Claude Vision pricing as scan-invoice.
  // Originally shipped without a cap; Codex audit (pass-6) flagged it
  // as the largest unbounded-spend exposure in the inventory surface.
  | 'photo-count'
  // Reading a whole inventory or occupancy sheet. One call per file, and a
  // file is bigger than an invoice, so each read costs more than a scan does.
  // Setting a hotel up is a handful of files in an afternoon; 30/hr covers
  // that with room to re-try a mis-read one, and stops a scripted loop from
  // re-reading the same workbook forever. Billing-impacting, so it fails
  // closed.
  | 'inventory-import'
  // Public signup — keyed on a per-IP UUID (sha256(ip) → UUID shape).
  // No auth gate, creates auth.users + properties + Stripe customer +
  // bcrypt CPU work, so trivially abusable without a rate cap. (Pass-3
  // fix — H6.)
  // Public join-code signup and invite acceptance — IP-keyed. Both
  // create auth.users without any prior auth gate and do bcrypt CPU
  // work; codes/tokens are low-entropy enough that brute-force or
  // token-spray attacks matter. (Codex audit 2026-05-12.)
  | 'auth-use-join-code'
  | 'auth-accept-invite'
  | 'invite-preview'
  // Desktop-to-phone QR handoff. Create is keyed per account; the public
  // claim/resend/verify surfaces are keyed per trusted source IP; complete is
  // checked against both IP and account scopes. Claim/resend send Resend email
  // and therefore fail closed below.
  | 'auth-phone-pairing-create'
  | 'auth-phone-pairing-claim'
  | 'auth-phone-pairing-resend'
  | 'auth-phone-pairing-verify'
  | 'auth-phone-pairing-complete'
  // Onboard wizard PATCH + GET — IP-keyed. Pre-account paths (steps 1-2)
  // are gated only by a hotel-join-code, which is brute-forceable at
  // ~50 bits without a rate limit. Without this cap, an attacker could
  // enumerate codes by hammering /api/onboard/wizard. Same 10/hr bucket
  // shape as auth-use-join-code. (Security review 2026-05-16, Pattern G.)
  | 'onboard-wizard'
  // Phase M1.5 (2026-05-14) — transactional email send via Resend.
  // Keyed on the recipient (normalized email, plus-addressing collapsed)
  // so an admin can't accidentally spam alice@hotel.com by re-clicking
  // "send invite". 5/hour matches our most conservative outbound caps.
  | 'email-transactional'
  // 2026-05-20 security audit M3 — public SMS-linked routes. Capability
  // tokens (pid + staffId) gate access, but the URLs are replayable
  // indefinitely if a SMS forward leaks the link. Rate limits are
  // defense-in-depth so a stolen link can't be hammered.
  //
  | 'housekeeper-rooms'
  | 'housekeeper-room-action'
  | 'housekeeper-save-language'
  // Housekeeper mobile rebuild piece A (2026-05-24) — explicit
  // Start → Pause → Resume → Done workflow + 5 exception types +
  // per-cleaning-type checklists + lunch breaks. Each route gets its
  // own bucket so a runaway in one (e.g., checklist toggle on a fast
  // tapper) doesn't lock out Start/Done on the same shift. All keyed on
  // `${pid}:${staffId}` via hashToRateLimitKey.
  | 'housekeeper-start-clean'
  | 'housekeeper-pause-clean'
  | 'housekeeper-resume-clean'
  | 'housekeeper-complete-clean'
  | 'housekeeper-exception'
  | 'housekeeper-checklist-toggle'
  | 'housekeeper-checklist-read'
  | 'housekeeper-lunch-break'
  | 'housekeeper-daily-summary'
  | 'laundry-bootstrap'
  | 'laundry-complete'
  // F-NEW-02 / Batch D — public POST that swaps the SMS-link CODE for the
  // hashed_token used to verifyOtp. Code is ~40 bits; the rate limit caps
  // brute-force enumeration further. IP-keyed. 30/hr lets a real
  // housekeeper retry a few times if the first tap fails over flaky
  // cellular without ever bumping the cap.
  | 'housekeeper-exchange-code'
  // Codex follow-up to Batch D — fire-and-forget telemetry endpoint that
  // counts legacy ?token= URL redemptions on the housekeeper page so we
  // can verify in-flight pre-Batch-D SMSes have drained before deleting
  // the page's legacy branch. IP-keyed; 30/hr is generous because real
  // legitimate redemptions are bounded by SMS volume.
  | 'housekeeper-log-legacy-token'
  // Sick-callout coverage flow (feature #6, 2026-05-24). Each entry point
  // gets its own bucket so a runaway in one channel doesn't lock the
  // others. Caps tuned to "this is a person tapping a button" — anything
  // above the cap is bot/script abuse and should 429.
  // Housekeeper mobile rebuild B/C (2026-05-25). Each endpoint gets its
  // own bucket so a runaway in one flow can't lock out the others. Caps
  // tuned for "person tapping a button" — generous enough that real use
  // never hits them, tight enough to stop a stolen SMS-link replay.
  | 'housekeeping-notices-post'      // manager posts to the notice board
  | 'housekeeping-notices-read'      // housekeeper page polls notices
  | 'housekeeping-notice-dismiss'    // per-user dismissal
  // First-time Housekeeping setup — the optional "photograph your paper board"
  // screen. Uploads an image AND runs one Claude Vision read of it, so it costs
  // real money. Keyed on the RAW property id (api_limits.property_id FKs
  // properties(id), so a hashed composite would FK-violate → the RPC errors →
  // this billing endpoint would fail closed for the wrong reason). The cap is
  // deliberately tiny: this fires once per hotel, ever.
  | 'housekeeping-setup-board-photo'
  | 'housekeeper-structured-issue'   // structured issue → work order
  | 'housekeeper-photo-presign'      // request signed-upload URL
  | 'housekeeper-add-note'           // quick note from housekeeper page
  | 'housekeeper-mark-inspection'    // tap to flag ready for inspection
  // Cross-department activity log export (feature #18, 2026-05-25).
  | 'settings-activity-log-export'
  // Post-merge sweep (Plan v4 cutover) — today's room list, read-only.
  // The dashboard polls it every 6s when foregrounded.
  | 'housekeeping-rooms'
  // Schedule Forecast view — manager pulls multi-day demand/supply
  // predictions across today / 7-day / 14-day ranges. Each call fans
  // out to pms_reservations + demand_predictions + optimizer_results +
  // scheduled_shifts + staff reads. Keyed on (userId, propertyId).
  // 60/hr is "open the tab, switch ranges, leave it polling" headroom
  // — a runaway tab or stale-link replay caps fast.
  | 'housekeeping-forecast'
  // Complaints / service recovery (2026-05-30). log = create a complaint
  // (manager UI or agent/voice); update = assign / status / resolve /
  // callback; draft = Claude service-recovery text (billing); sms = assignee
  // notify + satisfaction-callback nudges (billing).
  | 'complaints-log'
  | 'complaints-update'
  | 'complaints-draft'
  // Financials — GM/owner finance suite (2026-05-31). ALL keyed on the RAW
  // property id (api_limits.property_id has an FK to properties(id), so a hashed
  // pid:user pseudo-UUID FK-violates → the RPC errors → billing endpoints fail
  // CLOSED). scan-invoice / scan-quote run Claude Vision; sms = overspend /
  // anomaly alert fan-out. All three are billing-impacting → fail closed.
  | 'financials-scan-invoice'
  | 'financials-scan-quote'
  // Security audit 2026-06-26 #1 — per-staff link-token verification FAILURES
  // on the public mobile surface (housekeeper/laundry/engineer/save-fcm-token).
  // Only failed verifications increment (a legitimate token holder never trips
  // it), so this bounds token-spray / pid+staffId enumeration retry loops.
  // Keyed on the trusted source IP via clientIpRateLimitKey (a hashed-UUID key,
  // safe as api_limits.property_id — NOT a raw pid). 60/hr is generous for a
  // real phone occasionally opening a stale/expired link while still choking a
  // scripted enumeration storm. See src/lib/staff-link-auth.ts.
  | 'staff-link-verify-fail'
  // Equipment (asset) registry (0249). Manager create/edit/delete of assets,
  // keyed on the RAW property UUID (no SMS / Claude — not billing-impacting).
  | 'equipment-config'
  // Lost & Found (feature, 2026-05-30) — housekeeper "Found an item" reporting.
  // The front-desk register surface was retired in the 2026-07 purge.
  | 'housekeeper-report-found-item'
  | 'housekeeper-found-item-photo-presign'
  // ── Communications (built-in staff messaging) ────────────────────────
  // AI endpoints key on the RAW property UUID (a real properties.id) — NOT a
  // hashToRateLimitKey pseudo-UUID. api_limits.property_id has an FK to
  // properties(id) (migration 0142), so a pseudo-UUID FK-violates → the RPC
  // errors → billing endpoints fail CLOSED. RAW pid avoids that. Cached.
  | 'comms-assistant'        // @Staxis in-chat assistant
  | 'comms-detect-action'    // message → work-order/complaint detection
  | 'comms-polish'           // AI-polished announcements
  | 'comms-transcribe'       // voice message → text (Whisper)
  // Non-AI comms endpoints — keyed per-user ((pid,userId)/(pid,staffId)
  // composite via hashToRateLimitKey; fail-open like the other public
  // composite-key endpoints), so one person's polling can't 429 the property.
  | 'comms-send'
  | 'comms-read'
  | 'comms-task'
  // Shift Log Book — recap/reply POST (WRITES only). Non-AI, per-user
  // ((pid,userId) composite via hashToRateLimitKey, fail-open). The Log book
  // panel polls its GETs every ~8s (list + replies + the dashboard card), so the
  // READS go through the shared 'comms-read' bucket (3600/hr) like every other
  // polled comms read (see tasks/route.ts) — NOT this one. Keeping reads off this
  // bucket is what lets the write cap stay tight: 400/hr is "a person posting
  // recaps + replies" with wide headroom, and bounds a runaway/stolen session.
  | 'comms-logbook'
  | 'comms-action'
  | 'comms-react'             // ✓ acknowledgement reaction toggle (Slack-redesign)
  | 'comms-pin'              // pin / unpin a message (Slack-redesign)
  | 'comms-photo-presign'
  | 'comms-save-language'
  // Announcement acknowledgement (migration 0248). Tapping "I read & understand"
  // is a deliberate, idempotent action (unique(message_id,staff_id)); keyed per
  // (pid, staffId) composite via hashToRateLimitKey, fail-open like the other
  // non-AI comms write endpoints.
  | 'comms-acknowledge'
  // ── Unified Worklist (2026-06-14) — the Communications To-do view's auto-
  // gathered cross-module worklist. read = the aggregated GET; assign/complete
  // are the dispatch writes. ALL keyed on the RAW property id (a real
  // properties.id) — api_limits.property_id FKs properties(id), so a
  // hashToRateLimitKey composite would FK-violate. Per-property caps; not
  // billing-impacting, so they fail OPEN on an RPC blip.
  | 'worklist-read'
  | 'worklist-assign'
  | 'worklist-complete'
  // One person's Staxis-list preference write ("Include log book in Staxis").
  // Keyed on the HASHED (property, user) composite, not the raw pid: this is a
  // per-person switch, and a shared per-property bucket would let one impatient
  // manager 429 their colleagues out of their own settings. Costs nothing and
  // is not billing-impacting, so it fails OPEN.
  | 'feed-prefs-write'
  // The optional second reading of a to-do sentence, when the plain code path
  // found no person, day or repeat in it. One short model call, so it IS
  // billing-impacting and fails CLOSED — and failing closed costs nothing a
  // person would notice: the composer already behaves correctly without it.
  // Keyed on the HASHED (property, user) composite, because the debounce that
  // bounds it is per-typist and one person on a long sentence must not be able
  // to exhaust the hotel's whole budget.
  | 'feed-interpret-todo'
  // ── Inventory vendors (2026-05-31) — keyed on the RAW property id (a real
  // properties.id) — api_limits.property_id has an FK to properties(id)
  // (migration 0142), so a hashToRateLimitKey pseudo-UUID would FK-violate.
  // (The order-create/send/receive + catalog + spend-rollup keys were removed
  // with the ordering flow, 2026-07-18.)
  | 'inventory-vendors'
  // ── Ordering Manager (2026-07-28) ───────────────────────────────────────
  // `inventory-ordering` covers the screen's reads and its cheap writes
  // (confirm a suggested vendor, map a category, mark ordered). Keyed on the
  // RAW property id like inventory-vendors above, for the same FK reason.
  | 'inventory-ordering'
  // `inventory-po-send` is the purchase-order email to a VENDOR — the only
  // path here that leaves the building. It gets its own bucket rather than
  // reusing 'email-transactional' (5/hr, keyed on the recipient) because that
  // cap is per-address: a hotel legitimately sending Sysco a second order
  // after a delivery correction would be blocked by a limit meant to stop
  // invite spam. Keyed on the PROPERTY, so one hotel's ordering day cannot
  // exhaust another's. Billing-impacting → fails CLOSED: if we cannot prove
  // the hotel is under its cap, we do not mail a third party on their behalf.
  | 'inventory-po-send'
  // ── Knowledge hub (0252) — manager-gated. knowledge-presign mints a signed
  // upload URL; knowledge-write covers the document register (synchronous
  // storage download + text extraction). Both keyed on the (pid,userId)
  // composite via hashToRateLimitKey and fail OPEN (not billing-impacting — no
  // Claude/SMS), exactly like comms-photo-presign. Cheap article/contact/event
  // CRUD is intentionally left un-limited: this list scopes to billing / SMS /
  // public / heavy-IO endpoints, not generic authenticated manager CRUD.
  | 'knowledge-presign'
  | 'knowledge-write'
  // ── Knows screen intake (0358) ────────────────────────────────────────────
  // The open box on /feed → Knows: a manager types a note or drops in a file,
  // and one Claude call turns it into proposed facts. Billing-impacting (real
  // token spend, and an uploaded PDF can be 4 MB of text), so it fails CLOSED
  // below. Keyed on the RAW property id — api_limits.property_id FKs
  // properties(id), so a hashToRateLimitKey composite would FK-violate → the
  // RPC errors → the endpoint would fail closed for the wrong reason.
  | 'knows-intake'
  // Confirm / Edit / Remove on the same screen. No model, no email — a person
  // tapping buttons. Per-property, fails OPEN.
  | 'knows-write'
  // ── Company rulebook (0365) ───────────────────────────────────────────────
  // The same two shapes one level up. Keyed on the RAW property id of the hotel
  // the person was standing in — api_limits.property_id FKs properties(id), and
  // an organization id would FK-violate. That means a company with twenty
  // hotels gets twenty buckets, which is deliberately generous: the cap exists
  // to bound a runaway tab or a stolen session, and the person pasting the
  // group SOP is doing it from one hotel's screen.
  | 'company-rulebook-intake'
  // Confirm / Edit / Remove / setup choices. A person tapping buttons.
  | 'company-rulebook-write'
  // ── PMS auth-code inbox (Okta 2FA email reader; migration 0274) ────────────
  // Cloudflare Email Worker → /api/pms-inbox/inbound. Keyed on the RESOLVED RAW
  // property id (api_limits.property_id has an FK to properties(id), so a hashed
  // pseudo-UUID would FK-violate → fail closed). Real Okta sends are a handful a
  // day; 60/hr/property bounds a forged flood to a known inbox. NOT billing-
  // impacting (a DB-write webhook) → fail OPEN so a Supabase blip never drops a
  // real login code.
  | 'pms-inbox-inbound'
  // ── PMS report intake (migrations 0340-0342) ──────────────────────────────
  // Scheduled report mail → /api/pms-inbox/inbound (kind='report') and the
  // follow-up /api/pms-inbox/attachment-commit. Keyed on the RESOLVED RAW
  // property id, same FK reason as pms-inbox-inbound. A hotel scheduling every
  // 30 min tops out at 48 deliveries/day; 20/hr/property leaves room for a
  // burst of catch-up sends while bounding a flood at a known-good address.
  // NOT billing-impacting (a DB write + a signed-URL mint) → fails OPEN, so a
  // Supabase blip never silently drops a real report.
  | 'pms-report-inbound'
  // ── Drip questions (migration 0359) ───────────────────────────────────────
  // The manager's one tap on the Staxis screen's question card. A "yes" writes
  // a human-authored agent_memory fact, so this is a real knowledge-mutating
  // surface even though it is one button. By design a manager answers at most
  // ONE per session, so any volume above a handful an hour is a replay loop or
  // a stolen session rewriting the hotel's memory. NOT billing-impacting (no
  // model call anywhere in the path) → fails OPEN, so a Supabase blip never
  // eats a legitimate answer.
  | 'knowledge-question-answer'
  // ── Findings queue verdicts (migration 0360) ──────────────────────────────
  // "Known problem" / "Mute" / "Fixed" on a findings card. Each one changes
  // what Staxis will and will not tell this hotel from now on — muting is
  // permanent — so a stolen session or a runaway loop must not be able to
  // silence a whole ledger in one pass. Keyed on the RAW property id
  // (api_limits.property_id FKs properties(id), so a hashToRateLimitKey
  // composite would FK-violate → the RPC errors → this would fail for the
  // wrong reason). NOT billing-impacting (no model call, no message send) →
  // fails OPEN, so a Supabase blip never swallows a real decision.
  | 'findings-verdict'
  // ── The hands: executing / undoing a fix Staxis offered ───────────────────
  // Each tap can create a real work order or change a real reorder point. Not
  // billing-impacting (no model call at execution — the plan was frozen the
  // night before), so it fails OPEN: the database already guarantees a double
  // tap is one action (finding_actions_idempotency_uq + the FOR UPDATE state
  // guard in 0363), so a Supabase blip on the limiter cannot produce duplicate
  // work, and swallowing a manager's approval would be the worse failure.
  // Keyed on the RAW property id (api_limits.property_id FKs properties(id)).
  | 'findings-action'
  // ── Morning brief (Staxis tab, pinned card) ───────────────────────────────
  // A GET, and on the FIRST load of a hotel's local day it can make one cheap
  // model call to smooth the wording. Every load after that is served from the
  // day's cached copy, so the realistic ceiling is one call per hotel per day —
  // but the cache is what makes that true, and a cap must not depend on another
  // mechanism working. Keyed on the RAW property id (api_limits.property_id
  // FKs properties(id)). Billing-impacting → fails CLOSED: a Supabase blip
  // costs a manager the summary, which is a paragraph above cards that are
  // still all there, and that is a far better trade than uncapped spend.
  | 'findings-brief'
  // ── The portfolio queue (a company-scope person's whole screen) ───────────
  // One GET that reads every hotel in the company, and on the first load of the
  // company's day also runs the portfolio checks. Not billing-impacting (no
  // model call anywhere in it) → fails OPEN: losing a portfolio screen to a
  // limiter blip would be the worse failure. Keyed on a REAL property id — one
  // of the company's own hotels, because api_limits.property_id FKs
  // properties(id) — with the ORGANIZATION folded into the sub-key, so two
  // companies can never share a bucket.
  | 'companion-read'
  | 'companion-write'
  | 'companion-trace'
  | 'companion-trace-act'
  | 'company-queue'
  // The hotel picker / command centre bootstrap. Read-only and model-free, but
  // for a company-scope caller it reads one findings ledger per covered hotel,
  // and can mint receipts/settings for up to 50 companies, so a scripted loop
  // is a real load. Keyed on one opaque account-derived UUID before catalog
  // construction; company/property selection cannot rotate the bucket and
  // platform admins are covered too. Fails OPEN: nothing here is billable, and
  // locking somebody out of the screen that lists their hotels would be the
  // worse failure.
  | 'property-selector';

/** Per-endpoint hourly caps. Tuned to "real-world ops use" headroom. */
const HOURLY_CAPS: Record<RateLimitEndpoint, number> = {
  'reports-run':                 120,
  'reports-export':              120,
  'admin-ai-config-validate':   30,
  // Catalog refreshes hit two provider list APIs; a human clicks this a few
  // times a day at most.
  'admin-ai-models-refresh':    30,
  // Invoice scans cost $0.003-0.01 each; 50/hr per property absorbs
  // legitimate use (Maria scanning a stack of weekly invoices) but
  // caps runaway loops fast.
  'scan-invoice':               50,
  // Shelf photo counting — same per-call cost as scan-invoice; same cap.
  // A staff member doing inventory rounds might fire 20-30 photos in a
  // session; 50/hr per property covers that with headroom.
  'photo-count':                50,
  // A whole sheet per call, so each one costs several invoice scans. A hotel
  // being set up imports a handful of files; nobody legitimately imports 30
  // workbooks in an hour.
  'inventory-import':           30,
  // Maria might re-send shift confirmations 2-3 times if she tweaks the
  // schedule. 10/hour gives plenty of room without unlimited resend abuse.
  // ENGLISH/ESPAÑOL replies look like loops if abused.
  // Schedule autosave is debounced client-side but a runaway tab could
  // hammer this. 200/hr is "click 3x per minute for an hour" headroom.
  'populate-rooms-from-plan':  20,
  // PMS write-back enqueue — one per manager status change when enabled. A
  // busy 74-room checkout morning is ~100-150 changes/hr; 300/hr/property
  // gives headroom while bounding abuse.
  'pms-writeback-enqueue':    300,
  // Public signup — 5/hour per source IP. Real signups are rare; a
  // legitimate person filling out the form 5 times in an hour is
  // already a customer-support situation, not a happy path. Anything
  // higher is bot/abuse and should 429.
  // Public join-code signup — 10/hour per source IP. Same logic as
  // 'signup-ip' (real signups are rare, anything higher is abuse).
  'auth-use-join-code':         10,
  'onboard-wizard':             10,
  // Invite acceptance — 10/hour per source IP. One-shot per token in
  // normal use; the cap exists to bound token-spray brute force.
  'auth-accept-invite':         10,
  // Invitation preview — 60/hour per source IP. Guessing a 192-bit token is
  // infeasible, so this is not the primary defense; it bounds the DB work a
  // scanner can force from one address, which is exactly what an unauthenticated
  // token-shaped lookup should be capped at.
  'invite-preview':             60,
  // QR phone handoff. Database state adds the stronger per-pair limits:
  // three sends (10-second cooldown) and five verification attempts.
  'auth-phone-pairing-create':   10,
  'auth-phone-pairing-claim':    30,
  'auth-phone-pairing-resend':   10,
  'auth-phone-pairing-verify':   30,
  'auth-phone-pairing-complete': 10,
  // Phase M1.5 transactional email — keyed on recipient. 5/hour stops
  // an admin click-spamming "send invite" from blasting one inbox; a
  // legitimate admin re-sending after a typo has 4 retries before they
  // need to wait. Per-recipient (not per-property) so different hotels'
  // invites don't compete with each other.
  'email-transactional':         5,
  // 2026-05-20 audit M3 — public SMS-linked surface. Caps tuned to
  // generous real-world ops use.
  'housekeeper-rooms':         3600,
  // housekeeper-room-action is the write path (mark clean / dirty / etc.).
  // One action every ~18s sustained = 200/hr, well above realistic use.
  'housekeeper-room-action':    200,
  // Language toggle — a settings change. Set once, occasionally re-toggled.
  // 10/hr is plenty.
  'housekeeper-save-language':   10,
  // Housekeeper workflow rebuild (piece A). Caps tuned for "this is a
  // person tapping a button" — a real housekeeper cleans maybe 14 rooms
  // a shift = 14 Starts and 14 Dones. 200/hr per write endpoint absorbs
  // accidental double-taps without ever inconveniencing real use, and
  // bounds a stolen-link replay loop to ≤200 phantom rooms an hour.
  'housekeeper-start-clean':     200,
  'housekeeper-pause-clean':     200,
  'housekeeper-resume-clean':    200,
  'housekeeper-complete-clean':  200,
  'housekeeper-exception':       100,
  // Checklist toggle: fast tappers can fire one item per second through
  // a long checklist. 600/hr covers 10 items × 60 rooms with headroom.
  'housekeeper-checklist-toggle': 600,
  // Checklist template read is cached on the client per cleaning type;
  // 60/hr is "open every room's checklist once". Bumped if needed.
  'housekeeper-checklist-read':   60,
  // Lunch break: at most 4 transitions per shift (start lunch, end
  // lunch, maybe a short break). 30/hr is "tap a few times by mistake"
  // headroom.
  'housekeeper-lunch-break':      30,
  // Daily summary is a read at end of shift. 30/hr stops a tab that
  // accidentally polls.
  'housekeeper-daily-summary':    30,
  // Front-desk rush button: each rush is a deliberate decision. 60/hr
  // per (pid, staffId) is generous for a busy front desk.
  // laundry-bootstrap is a read-only page bootstrap. Polled less often
  // than housekeeper. 600/hr per property covers heavy use.
  'laundry-bootstrap':          600,
  // laundry-complete: one write per checklist toggle (debounced client-side).
  // A full shift is a few dozen toggles; 240/hr per property is generous.
  'laundry-complete':           240,
  // housekeeper-exchange-code: one-shot per SMS-link tap, IP-keyed.
  // Real housekeepers tap once; the cap exists to bound brute-force
  // enumeration of the ~40-bit code space. 30/hr leaves room for a few
  // retries on flaky cellular without ever inconveniencing a real tap.
  'housekeeper-exchange-code':   30,
  // housekeeper-log-legacy-token: fire-and-forget telemetry; the legacy
  // ?token= URL path on the housekeeper page hits this so we can count
  // redemptions and decide when the in-flight SMS drain is complete.
  // 30/hr per IP — well above any single phone's realistic re-tap rate.
  'housekeeper-log-legacy-token': 30,
  // Sick-callout buckets — see RateLimitEndpoint union comment for rationale.
  // Piece B/C caps. Manager posts to the notice board are deliberate
  // actions — 60/hr is "manager spamming the notice board" headroom.
  'housekeeping-notices-post':     60,
  'housekeeping-notices-read':    600,
  'housekeeping-notice-dismiss':  100,
  // First-time setup board photo — one Claude Vision read per upload. A hotel
  // does this ONCE; 5/hr per property leaves room for a couple of retries on a
  // blurry first shot and nothing more.
  'housekeeping-setup-board-photo':  5,
  'housekeeper-structured-issue': 200,
  'housekeeper-photo-presign':    200,
  'housekeeper-add-note':         200,
  'housekeeper-mark-inspection':  200,
  // Cross-department activity log export.
  'settings-activity-log-export':  30,
  // Plan v4 today's-rooms read — 6s dashboard polling + visibility refetches.
  'housekeeping-rooms':         2400,
  // Schedule Forecast view — 60/hr per (user, property) covers a manager
  // opening the tab and switching ranges all day, with headroom for
  // realtime refetches and visibility-change refresh. Anything above
  // this cap is a runaway useEffect or stale-link replay.
  'housekeeping-forecast':        60,
  // Complaints. log: a busy front desk might file several at check-out rush;
  // 100/hr per (pid,user) is generous. update: assign/resolve/callback taps,
  // 300/hr. draft: Claude call, 30/hr. sms: assignee notify + callback nudges
  // (billing), 60/hr per property.
  'complaints-log':              100,
  'complaints-update':           300,
  'complaints-draft':             30,
  // Financials — GM/owner finance suite. Per-property (raw pid). scan-* are
  // Claude-Vision-cost-bounded (a manager scanning a stack of invoices).
  'financials-scan-invoice':      50,
  'financials-scan-quote':        50,
  // Security audit 2026-06-26 #1 — link-token verification failures per IP.
  // Only failures increment; a real holder never hits it. 60/hr chokes a
  // scripted enumeration/token-spray loop while tolerating a few stale-link
  // taps over flaky cellular.
  'staff-link-verify-fail':       60,
  // Equipment registry writes — manager-only create/edit/delete; generous.
  'equipment-config':            100,
  // Lost & Found (2026-05-30). Register read is polled (~30s/tab) + the
  // dashboard tile polls counts — 3600/hr per property absorbs several
  // terminals. Writes are deliberate desk actions. AI + SMS endpoints cost
  // money so they're tighter (and fail-closed below).
  'housekeeper-report-found-item': 200,
  'housekeeper-found-item-photo-presign': 200,
  // ── Communications ───────────────────────────────────────────────────
  'comms-assistant':             80,
  'comms-detect-action':        400,
  'comms-polish':                80,
  'comms-transcribe':           150,
  // Non-AI, per-user composite key (fail-open). comms-read is polled
  // (~3s open chat / ~8s list); 3600/hr = 1/sec/user gives wide headroom.
  'comms-send':                 400,
  'comms-read':                3600,
  'comms-task':                 400,
  'comms-logbook':              400,
  'comms-action':               200,
  'comms-react':               1200,
  'comms-pin':                  300,
  'comms-photo-presign':        300,
  'comms-save-language':         20,
  // Acknowledge: a person taps "I read & understand" once per required
  // announcement. 200/hr per (pid,staffId) absorbs catching up on a backlog of
  // mandatory reads + accidental double-taps, well above realistic use.
  'comms-acknowledge':          200,
  // Unified Worklist — read is the aggregated GET (the To-do view polls it ~every
  // 15s while open). 3600/hr per property = ~15 simultaneously-open terminals
  // before a 429, matching the housekeeper-rooms / lost-found-read poll
  // precedent (a single open tab is ~240/hr). Writes (assign/complete) are
  // deliberate taps; 300/hr per property is far above real completion volume.
  'worklist-read':             3600,
  'worklist-assign':            300,
  'worklist-complete':          300,
  // A human flipping one switch. 120/hr per person is two per minute for an
  // hour, which is well past deliberate and well short of a runaway tab.
  'feed-prefs-write':           120,
  // One reading per sentence somebody pauses on, per person. A manager adding
  // twenty to-dos in an hour trips it at most twenty times; 60 leaves room for
  // a person who writes slowly in bursts and still bounds a runaway tab.
  'feed-interpret-todo':         60,
  // Inventory Ordering — per-property (raw pid). order-create/approve/receive
  // are deliberate manager actions; order-send fires email (billing); reads are
  // panel polls. Tuned to "a manager working through orders" with headroom.
  'inventory-vendors':          200,
  // Ordering Manager — per-property (raw pid). The screen's reads plus its
  // cheap writes; a manager working a full reorder round trips this a few
  // dozen times, so 300 is generous headroom on an ordinary morning.
  'inventory-ordering':         300,
  // Purchase-order sends. 20/hour is well above a real ordering round (a
  // hotel has 3-6 vendors) and low enough that a loop cannot mail a vendor
  // hundreds of times before anyone notices.
  'inventory-po-send':           20,
  // Packages — per-property (raw pid). read = the polled list; write covers
  // create / pickup / delete; scan-label is Claude Vision; presign mints a
  // signed upload URL. Tuned to "a busy front desk".
  // Knowledge hub uploads (0252). A manager bulk-adding files won't hit these;
  // a runaway/stolen session caps fast.
  'knowledge-presign':          120,
  'knowledge-write':            120,
  // Knows intake — one Claude call per submission. A manager describing their
  // hotel does this a handful of times ever, then occasionally after that; 20/hr
  // per property leaves room for a document-by-document session while capping a
  // runaway tab or a stolen session at ~20 model calls an hour.
  'knows-intake':                20,
  // Confirm / Edit / Remove taps. A first pass through a freshly-extracted
  // vendor list is realistically 30-40 taps; 400/hr is far above that.
  'knows-write':                400,
  // Company rulebook intake — one Sonnet call per submission. A VP writes the
  // group's book once and then edits it occasionally; 20/hr matches the hotel
  // equivalent and still leaves room for a document-by-document session.
  'company-rulebook-intake':     20,
  // Confirm / Edit / Remove / setup taps on the rulebook screen.
  'company-rulebook-write':     400,
  // PMS auth-code inbox — per-property (raw pid). Real Okta sends are a few a
  // day; 60/hr bounds a forged flood to a known inbox without ever dropping a
  // legitimate burst of re-login codes.
  'pms-inbox-inbound':           60,
  // Report deliveries — see the union comment above. 48/day expected.
  'pms-report-inbound':          20,
  // One question per manager per session; 30/hr/property is generous even for a
  // hotel with several managers all answering at once.
  'knowledge-question-answer':   30,
  // Findings verdicts. The nightly runner is capped at a handful of new cards
  // a night, so a manager clearing a backlog is realistically tens of taps;
  // 200/hr per property is far above that and still bounds a scripted sweep
  // that tries to mute everything.
  'findings-verdict':           200,
  // Approving or undoing a fix. The runner offers a handful of these a night at
  // most, so a manager working through everything Staxis found is tens of taps;
  // 60/hr per property is well clear of that and still bounds a scripted sweep.
  'findings-action':             60,
  // Morning brief. Sized for the CACHE READS, not for the model call: the
  // atomic daily claim already makes at most one of these a generation, so 120
  // requests buys a manager (and their colleagues) all the tab-switching they
  // like without ever buying a second model call. A scripted loop still hits
  // the wall in under a minute.
  'findings-brief':             120,
  // The portfolio queue. Sized like the brief's cache reads: a VP flicking
  // between tabs all morning never comes close, and the daily claim already
  // makes the expensive half (the portfolio checks) happen once. A scripted
  // loop, which would be reading a dozen hotels' ledgers per request, hits the
  // wall in about a minute.
  // The bubble bootstraps once per page mount, so a manager clicking through
  // the app all morning is the normal case rather than abuse. The write bucket
  // is small: it moves only when the companion actually speaks or is answered.
  'companion-read':             1200,
  'companion-write':            300,
  // One read per screen somebody lands on, so it tracks navigation rather than
  // time. A manager working a full shift moves between six screens all morning.
  'companion-trace':            1200,
  // A trace only ever offers to put one job on the board, and a person only
  // ever taps that a handful of times a day.
  'companion-trace-act':        60,
  'company-queue':              120,
  // The picker is hit on sign-in, on every "switch hotel", and on a tab
  // refocus. A person doing that all morning never approaches 240; a loop
  // reading a dozen ledgers per request hits the wall inside a minute.
  'property-selector':          240,
};

/**
 * Hash any string into a deterministic UUID-shaped key suitable as the
 * `pid` argument to checkAndIncrementRateLimit. The api_limits table's
 * `property_id` column is just an opaque UUID slot — so this same
 * function works for IPs, phone numbers, emails, or composite keys
 * like `${pid}:${staffId}`. Same input → same key (stable across
 * processes and regions). Empty input falls back to
 * NO_PROPERTY_RATE_LIMIT_KEY so unknown callers share one bucket
 * (a defense against header-spoofing attacks).
 */
export function hashToRateLimitKey(s: string | null | undefined): string {
  const trimmed = (s ?? '').trim().toLowerCase();
  if (!trimmed) return NO_PROPERTY_RATE_LIMIT_KEY;
  const h = createHash('sha256').update(trimmed).digest();
  // Format the first 16 bytes as a UUID (8-4-4-4-12 hex). Not a real
  // RFC4122 UUID — we don't set the version/variant bits — but it
  // satisfies the api_limits.property_id UUID column shape.
  return [
    h.slice(0, 4).toString('hex'),
    h.slice(4, 6).toString('hex'),
    h.slice(6, 8).toString('hex'),
    h.slice(8, 10).toString('hex'),
    h.slice(10, 16).toString('hex'),
  ].join('-');
}

/**
 * Backwards-compatible alias — early callers used this name when the
 * function only handled IPs. Now just a thin wrapper over
 * hashToRateLimitKey. New code should prefer the generic name.
 */
export const ipToRateLimitKey = hashToRateLimitKey;

/**
 * Derive a NON-SPOOFABLE client IP for rate-limit keying.
 *
 * Security audit 2026-06-26: callers were reading
 * `x-forwarded-for`.split(',')[0] — the LEFTMOST token. On Vercel the
 * client cannot overwrite the platform-trusted IP, but Vercel APPENDS it
 * to the RIGHT of whatever `X-Forwarded-For` the client sent, so the
 * leftmost value is fully attacker-controlled. Rotating it gave a fresh
 * rate-limit bucket per request and defeated every per-IP cap (join-code
 * brute force, account-creation/cost abuse, etc.).
 *
 * Trust order:
 *   1. `x-vercel-forwarded-for` — set by the Vercel proxy, NOT forwardable
 *      by the client. This is the real client IP on Vercel.
 *   2. `x-real-ip` — also set by the Vercel edge (and most reverse proxies).
 *   3. `x-forwarded-for` RIGHTMOST entry — the hop our trusted proxy
 *      appended, never the leftmost client-supplied one.
 *
 * Returns '' when no header is present (local dev): hashToRateLimitKey
 * then collapses to a single shared bucket, which is the safe default.
 */
export function trustedClientIp(req: { headers: { get(name: string): string | null } }): string {
  const vercel = req.headers.get('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0]?.trim() ?? '';
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return '';
}

/** Convenience: trusted client IP already hashed into a rate-limit key. */
export function clientIpRateLimitKey(req: { headers: { get(name: string): string | null } }): string {
  return hashToRateLimitKey(trustedClientIp(req));
}

/**
 * Sentinel UUID used as the property_id when an SMS-fan-out endpoint accepts
 * a payload without a `pid` (legacy callers). The zero-UUID is reserved for
 * "no specific property" and will rate-limit such calls in a single global
 * bucket — defense in depth against a runaway legacy caller hammering the
 * route. Real properties never use this UUID.
 */
export const NO_PROPERTY_RATE_LIMIT_KEY = '00000000-0000-0000-0000-000000000000';

/**
 * Endpoints that directly cost money on every call (Twilio SMS, Claude API,
 * Resend email). When the rate-limit RPC errors, these endpoints fail
 * CLOSED — refuse the request — instead of falling open. Rationale: a
 * Postgres hiccup during peak-traffic hour would otherwise leave billing
 * uncapped fleet-wide (the cap exists precisely to bound spend during
 * abuse / runaway-script scenarios; without it, the spend exposure is
 * unbounded).
 *
 * Non-billing endpoints (read-path rate limits, schedule autosave, etc.)
 * still fail OPEN because blocking them on a transient DB error would
 * inconvenience legitimate users without limiting any real downside.
 *
 * Doctor's `api_limits_writable` check probes the same RPC every 60s, so
 * a sustained failure of THIS path lights up the doctor BEFORE any real
 * caller hits the fail-closed branch.
 */
const BILLING_IMPACTING_ENDPOINTS: ReadonlySet<RateLimitEndpoint> = new Set<RateLimitEndpoint>([
  'reports-run',
  // PMS write-back enqueue mutates the hotel's real PMS — fail CLOSED so a
  // Supabase blip can't let a runaway uncap real-PMS writes (Codex P1-7).
  'pms-writeback-enqueue',
  'admin-ai-config-validate',
  // Claude Vision calls.
  'scan-invoice',
  'photo-count',
  // Reading a whole inventory or occupancy sheet. Same Claude spend shape as
  // the scanners and a bigger payload per call, so a limiter outage declines
  // rather than letting a retry loop read the same workbook all afternoon.
  'inventory-import',
  // The morning brief's wording pass — one Haiku call on the first load of a
  // hotel's local day. Cheap, but uncapped-cheap is still uncapped.
  'findings-brief',
  // The optional second reading of a to-do sentence. One Haiku call per
  // sentence somebody pauses on, fired from a keystroke handler, so a runaway
  // tab is the exact shape of abuse this guards. Failing closed costs the
  // person nothing: the composer's behaviour without a reading IS the design.
  'feed-interpret-todo',
  // First-time Housekeeping setup board photo — Claude Vision. Fail CLOSED so a
  // Supabase blip can't uncap Anthropic spend. The route treats a denied read as
  // "we couldn't read the photo", which is already a supported outcome there.
  'housekeeping-setup-board-photo',
  // Twilio SMS fan-out (per-recipient charge).
  // Resend transactional email (per-recipient charge).
  'email-transactional',
  // Purchase-order email to a vendor. Fails CLOSED: this is the one path that
  // sends mail to a third party in the hotel's name, so if the limiter itself
  // is unavailable we decline rather than risk mailing a supplier in a loop.
  'inventory-po-send',
  // Claim/resend each attempt a transactional OTP email. The inner Resend
  // wrapper also enforces its recipient cap; these outer guards keep an
  // api-limit outage from reaching link generation/email at all.
  'auth-phone-pairing-claim',
  'auth-phone-pairing-resend',
  // Complaints — Claude service-recovery draft (token cost). Fail CLOSED so a
  // Supabase blip can't uncap spend. complaints-log is here too: it runs a
  // Claude classify on every call (Codex review #6).
  'complaints-log',
  'complaints-draft',
  // Lost & Found — vision (describe) + Claude (auto-match). Each call costs
  // money, so fail CLOSED if the rate-limit RPC errors.
  // Communications AI endpoints — each call costs Claude/OpenAI credit.
  // Keyed on the RAW property UUID (real properties.id), so failing closed
  // is never triggered by an FK violation. Clients degrade gracefully on 429
  // (assistant → "try again").
  'comms-assistant',
  'comms-detect-action',
  'comms-polish',
  'comms-transcribe',
  // Financials — Claude Vision (scan invoice / contractor quote) + Twilio
  // overspend/anomaly alert fan-out. Fail CLOSED so a DB blip can't uncap
  // Anthropic / Twilio spend.
  'financials-scan-invoice',
  'financials-scan-quote',
  // Knows-screen intake — one Sonnet call over up to 24K characters of pasted
  // text or extracted PDF. Fail CLOSED so a Supabase blip can't uncap spend;
  // the UI degrades to "couldn't read that just now, try again".
  'knows-intake',
  // Company rulebook intake — the same Sonnet call over the same amount of
  // pasted text, one level up. Same reasoning, same fail-closed posture.
  'company-rulebook-intake',
  // Packages — scan-label (Claude Vision). Fail CLOSED so a DB blip can't
  // uncap Anthropic spend.
]);

/**
 * Check the rate limit for (property_id, endpoint) and increment the hour
 * counter atomically. Returns:
 *   { allowed: true }  → call may proceed
 *   { allowed: false, retryAfterSec, current, cap }  → caller should 429
 *
 * If the rate-limit table doesn't exist yet (e.g. running before the
 * migration is applied), we fail-open with a console warning rather than
 * blocking all SMS sends. Production should always have the migration
 * applied; this guard avoids a deploy-order footgun.
 */
export async function checkAndIncrementRateLimit(
  endpoint: RateLimitEndpoint,
  pid: string,
  opts?: { subKey?: string },
): Promise<
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; current: number; cap: number }
> {
  // The cap and the billing-fail-closed decision ALWAYS key on the BASE
  // endpoint (the typed union value) — never the composite below.
  const cap = HOURLY_CAPS[endpoint];
  // Per-staff (or other sub-identity) bucketing WITHOUT breaking the
  // api_limits.property_id FK to properties(id): `pid` stays a REAL property id
  // (FK-valid), and the sub-key is folded into the endpoint TEXT column (no FK)
  // instead. This lets a public SMS-link route limit per (pid, staffId) so one
  // staffer or a replayed link can't exhaust the whole property's bucket, while
  // keeping real enforcement (raw pid never FK-violates) and the fail-CLOSED
  // guarantee for billing endpoints. When no subKey is passed the DB endpoint
  // is the base string verbatim (backward-compatible).
  const dbEndpoint = opts?.subKey ? `${endpoint}:${opts.subKey}` : endpoint;
  const hourBucket = new Date().toISOString().slice(0, 13);  // "2026-04-27T17"
  try {
    // Atomic upsert: increment count, return new value.
    const { data, error } = await supabaseAdmin.rpc('staxis_api_limit_hit', {
      p_property_id: pid,
      p_endpoint: dbEndpoint,
      p_hour_bucket: hourBucket,
    });
    if (error) {
      // ── Billing endpoints fail CLOSED, others fail OPEN ────────────
      // The original blanket fail-open was correct for "don't break the
      // app on a DB hiccup", but for billing-impacting endpoints (Twilio
      // SMS, Claude tokens, Resend email) failing open removes the only
      // guardrail against fleet-wide spend abuse during a DB outage.
      // Pair: the api_limits_writable doctor check polls the same RPC,
      // so a sustained failure lights up monitoring before this branch
      // ever rejects a real user request.
      const billing = BILLING_IMPACTING_ENDPOINTS.has(endpoint);
      log.error(
        billing
          ? '[ratelimit] rpc failed on billing endpoint — FAILING CLOSED'
          : '[ratelimit] rpc failed — FAILING OPEN',
        {
          endpoint, pid, rpcError: error.message,
          // Tag for Sentry dashboards (see src/lib/sentry.ts tag-lift).
          route: `ratelimit:${endpoint}`,
        },
      );
      if (billing) {
        // Give the caller a retry-after hint. 60s matches the cache TTL
        // the doctor uses for its probe — by then ops should know.
        return { allowed: false, retryAfterSec: 60, current: 0, cap };
      }
      return { allowed: true };
    }
    const current = Number(data) || 0;
    if (current > cap) {
      // Compute seconds until the next hour bucket.
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setUTCMinutes(0, 0, 0);
      nextHour.setUTCHours(now.getUTCHours() + 1);
      const retryAfterSec = Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 1000));
      return { allowed: false, retryAfterSec, current, cap };
    }
    return { allowed: true };
  } catch (e) {
    const billing = BILLING_IMPACTING_ENDPOINTS.has(endpoint);
    log.error(
      billing
        ? '[ratelimit] threw on billing endpoint — FAILING CLOSED'
        : '[ratelimit] threw — FAILING OPEN',
      {
        endpoint, pid,
        err: e instanceof Error ? e : new Error(String(e)),
        route: `ratelimit:${endpoint}`,
      },
    );
    if (billing) {
      return { allowed: false, retryAfterSec: 60, current: 0, cap };
    }
    return { allowed: true };
  }
}

/** Convenience: return a NextResponse for a denied limit.
 *
 * Returns NextResponse (not raw Response) so route handlers with an
 * explicit `Promise<NextResponse>` return-type signature can use it
 * without a type error — caught the hard way by the 2026-05-20
 * Vercel deploy failing TypeScript on /api/housekeeper/room-action.
 */
export function rateLimitedResponse(
  current: number,
  cap: number,
  retryAfterSec: number,
): NextResponse {
  return NextResponse.json(
    {
      error: 'rate_limited',
      detail: `${current}/${cap} for this property in the past hour. Try again in ${retryAfterSec}s.`,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
    },
  );
}
