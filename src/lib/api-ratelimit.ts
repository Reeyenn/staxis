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
  | 'send-shift-confirmations'
  | 'morning-resend'
  | 'sms-reply-resend'
  | 'test-sms-flow'
  | 'sync-room-assignments'
  | 'populate-rooms-from-plan'
  | 'notify-housekeepers-sms'
  // PMS onboarding endpoints — tight caps because each onboarding
  // job spawns a Fly worker that potentially burns Claude tokens.
  // A malicious authenticated user shouldn't be able to queue 1000
  // jobs and exhaust the daily budget.
  | 'pms-save-credentials'
  | 'pms-onboard'
  // Admin actions that incur Claude API cost. Even though only admins
  // hit them, a compromised admin account or scripted retry storm
  // could rack up real spend. Cap at 10/hr per property.
  | 'admin-regenerate-recipe'
  // Invoice OCR — Claude Vision call per image ($0.003-0.01/scan).
  // Maria might scan 5-10 invoices a week in normal use; 50/hr per
  // property is generous headroom. A compromised session or buggy
  // retry loop hits the cap fast. May 2026 audit pass-5.
  | 'scan-invoice'
  // Shelf photo counting — same Claude Vision pricing as scan-invoice.
  // Originally shipped without a cap; Codex audit (pass-6) flagged it
  // as the largest unbounded-spend exposure in the inventory surface.
  | 'photo-count'
  // Public signup — keyed on a per-IP UUID (sha256(ip) → UUID shape).
  // No auth gate, creates auth.users + properties + Stripe customer +
  // bcrypt CPU work, so trivially abusable without a rate cap. (Pass-3
  // fix — H6.)
  | 'signup-ip'
  // Public join-code signup and invite acceptance — IP-keyed. Both
  // create auth.users without any prior auth gate and do bcrypt CPU
  // work; codes/tokens are low-entropy enough that brute-force or
  // token-spray attacks matter. (Codex audit 2026-05-12.)
  | 'auth-use-join-code'
  | 'auth-accept-invite'
  // Onboard wizard PATCH + GET — IP-keyed. Pre-account paths (steps 1-3)
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
  // sms-reply is keyed on the From phone (housekeeper's E.164 hashed
  // via ipToRateLimitKey). The other three are keyed on `${pid}:${staffId}`
  // hashed the same way (laundry-bootstrap is keyed on pid directly
  // since the page has no per-staff identity).
  | 'sms-reply'
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
  // Front-desk "rush" button (display side ships in piece A so the
  // housekeeper banner works; the posting side comes in piece B).
  | 'front-desk-rush'
  | 'laundry-bootstrap'
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
  // Comms-voice audit P4 (2026-05-22) — /api/agent/speak walkthrough
  // narration. ElevenLabs Turbo v2.5 costs ~$0.10/1k chars; a runaway
  // client or compromised session can burn the $5 daily budget cap in
  // ~50 calls of 1k chars each, but a request-count cap kicks in long
  // before that. Keyed on accountId (one bucket per user across
  // properties). MUST also be added to BILLING_IMPACTING_ENDPOINTS below
  // so an RPC failure fails closed.
  | 'agent-tts-speak'
  // Scraper hardening v2 (F6) — read-only freshness probe powering the
  // <StaleDataBanner /> on /dashboard and /staff. Polled every 60s
  // from each open tab. Keyed on (userId, propertyId).
  | 'scraper-status'
  // Sick-callout coverage flow (feature #6, 2026-05-24). Each entry point
  // gets its own bucket so a runaway in one channel doesn't lock the
  // others. Caps tuned to "this is a person tapping a button" — anything
  // above the cap is bot/script abuse and should 429.
  //
  // callout-housekeeper: HK taps "I can't work today" on their mobile.
  //   Keyed on (pid, staffId). 10/hr — one real callout per day, the
  //   rest is room for accidental re-taps and undo-then-redo flows.
  // callout-manager: manager presses "Mark sick" on the dashboard.
  //   Keyed on (pid, userId). Manager might mark several HKs sick in a
  //   bad-flu morning, so 30/hr.
  // callout-sms: inbound Twilio webhook firing the SICK keyword.
  //   Keyed on the sender phone hash. 20/hr stops a Twilio replay or a
  //   phone in someone's pocket dialing the route.
  // callout-revert: same cap shape as the report path it mirrors.
  // callout-status: read endpoint feeding the CalloutBanner. Polled on
  //   the manager page; 600/hr per property is plenty.
  | 'callout-housekeeper'
  | 'callout-manager'
  | 'callout-sms'
  | 'callout-revert'
  | 'callout-status'
  // Housekeeper mobile rebuild B/C (2026-05-25). Each endpoint gets its
  // own bucket so a runaway in one flow can't lock out the others. Caps
  // tuned for "person tapping a button" — generous enough that real use
  // never hits them, tight enough to stop a stolen SMS-link replay.
  | 'housekeeping-notices-post'      // manager posts to the notice board
  | 'housekeeping-notices-read'      // housekeeper page polls notices
  | 'housekeeping-notice-dismiss'    // per-user dismissal
  | 'housekeeping-room-notes-post'   // manager adds a note from RoomsTab
  | 'housekeeping-room-notes-read'   // housekeeper page reads manager notes
  // 'front-desk-rush' was already added in piece A — re-using that bucket.
  | 'housekeeper-structured-issue'   // structured issue → work order
  | 'housekeeper-photo-presign'      // request signed-upload URL
  | 'housekeeper-add-note'           // quick note from housekeeper page
  | 'housekeeper-mark-inspection'    // tap to flag ready for inspection
  | 'housekeeper-save-language-loc'  // language-switcher save (locale-wide)
  | 'housekeeper-offline-replay'     // service worker replay-batch handler
  // Cross-department activity log export (feature #18, 2026-05-25).
  | 'settings-activity-log-export'
  // Post-merge sweep (Plan v4 cutover) — manager-facing Rooms board read
  // endpoint. RoomsTab polls every 6s when foregrounded.
  | 'housekeeping-rooms'
  // Plan v4 manager Rooms-tab writes (tile-cycling, add/delete). The
  // browser DB layer (src/lib/db/rooms.ts) calls /api/housekeeping/
  // room-action; keyed on (userId, propertyId). 600/hr is ~10 taps/min
  // sustained — well above realistic manual tile cycling.
  | 'housekeeping-room-action'
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
  | 'complaints-sms'
  // Financials — GM/owner finance suite (2026-05-31). ALL keyed on the RAW
  // property id (api_limits.property_id has an FK to properties(id), so a hashed
  // pid:user pseudo-UUID FK-violates → the RPC errors → billing endpoints fail
  // CLOSED). scan-invoice / scan-quote run Claude Vision; sms = overspend /
  // anomaly alert fan-out. All three are billing-impacting → fail closed.
  | 'financials-scan-invoice'
  | 'financials-scan-quote'
  | 'financials-sms'
  // Engineering Compliance (feature #19, 2026-05-30). ALL keyed on the RAW
  // property id (a real properties.id) — api_limits.property_id has an FK to
  // properties(id) (migration 0142), so a hashToRateLimitKey pseudo-UUID
  // FK-violates → the RPC errors → billing endpoints fail CLOSED (429 on every
  // call). So these are per-property caps, like laundry-bootstrap / send-shift-
  // confirmations. Vision + voice + setup + link-send are billing-impacting
  // (Claude / Twilio) and fail closed.
  | 'engineer-bootstrap'      // polled read of due readings + PM checks
  | 'engineer-log'            // tap-to-log a reading or PM check
  | 'engineer-vision'         // snap-to-log: Claude Vision reads a gauge/strip
  | 'engineer-voice'          // voice/typed natural-language reading log (Claude)
  | 'engineer-save-language'  // language switcher
  | 'compliance-read'         // manager overview / summary / report reads
  | 'compliance-config'       // manager create/edit reading types + PM tasks + templates
  | 'compliance-log'          // manager logs a reading / PM check from desktop
  | 'compliance-setup'        // one-line AI setup (Claude)
  | 'compliance-vision'       // manager snap-to-log (Claude Vision)
  | 'send-engineer-links'     // SMS the compliance magic-link to maintenance staff
  | 'compliance-anomaly-phrase' // v2: AI-sharpen anomaly alert wording (sweep cron; Claude; raw pid)
  // Lost & Found (feature, 2026-05-30). Front-desk register + AI features +
  // housekeeper "Found an item". Reads keyed on pid; writes/AI/SMS too.
  | 'lost-found-read'
  | 'lost-found-write'
  | 'lost-found-describe-photo'
  | 'lost-found-auto-match'
  | 'lost-found-notify-guest'
  | 'lost-found-photo-presign'
  | 'housekeeper-report-found-item'
  | 'housekeeper-found-item-photo-presign'
  // ── Communications (built-in staff messaging) ────────────────────────
  // AI endpoints key on the RAW property UUID (a real properties.id) — NOT a
  // hashToRateLimitKey pseudo-UUID. api_limits.property_id has an FK to
  // properties(id) (migration 0142), so a pseudo-UUID FK-violates → the RPC
  // errors → billing endpoints fail CLOSED. RAW pid avoids that. Cached.
  | 'comms-translate'        // per-message + UI-string auto-translate (cache-miss only)
  | 'comms-assistant'        // @Staxis in-chat assistant
  | 'comms-detect-action'    // message → work-order/complaint detection
  | 'comms-summary'          // "what did I miss" unread summary
  | 'comms-polish'           // AI-polished announcements
  | 'comms-transcribe'       // voice message → text (Whisper)
  // Non-AI comms endpoints — keyed per-user ((pid,userId)/(pid,staffId)
  // composite via hashToRateLimitKey; fail-open like the other public
  // composite-key endpoints), so one person's polling can't 429 the property.
  | 'comms-send'
  | 'comms-read'
  | 'comms-task'
  | 'comms-action'
  | 'comms-photo-presign'
  | 'comms-save-language';

/** Per-endpoint hourly caps. Tuned to "real-world ops use" headroom. */
const HOURLY_CAPS: Record<RateLimitEndpoint, number> = {
  // PMS onboarding — testing creds is cheap so 30/hr handles a GM
  // typo-fixing iteratively. Onboard kicks off a real CUA mapping
  // run that costs $1-3, so 5/hr is plenty (one onboarding usually
  // succeeds the first time; this leaves room for a few retries).
  'pms-save-credentials':       30,
  'pms-onboard':                 5,
  // Admin recipe regeneration costs $1-3 each. 10/hour/property is
  // generous for legitimate ops use; tight enough to stop a runaway.
  'admin-regenerate-recipe':    10,
  // Invoice scans cost $0.003-0.01 each; 50/hr per property absorbs
  // legitimate use (Maria scanning a stack of weekly invoices) but
  // caps runaway loops fast.
  'scan-invoice':               50,
  // Shelf photo counting — same per-call cost as scan-invoice; same cap.
  // A staff member doing inventory rounds might fire 20-30 photos in a
  // session; 50/hr per property covers that with headroom.
  'photo-count':                50,
  // Maria might re-send shift confirmations 2-3 times if she tweaks the
  // schedule. 10/hour gives plenty of room without unlimited resend abuse.
  'send-shift-confirmations': 10,
  // Cron route — one or two real calls per day max.
  'morning-resend':             5,
  // ENGLISH/ESPAÑOL replies look like loops if abused.
  'sms-reply-resend':          30,
  'test-sms-flow':             50,
  // Schedule autosave is debounced client-side but a runaway tab could
  // hammer this. 200/hr is "click 3x per minute for an hour" headroom.
  'sync-room-assignments':    200,
  'populate-rooms-from-plan':  20,
  // SMS fan-out to housekeepers — Maria might re-broadcast after schedule
  // tweaks. 30/hr covers normal use and stops a runaway loop dead.
  'notify-housekeepers-sms':   30,
  // Public signup — 5/hour per source IP. Real signups are rare; a
  // legitimate person filling out the form 5 times in an hour is
  // already a customer-support situation, not a happy path. Anything
  // higher is bot/abuse and should 429.
  'signup-ip':                  5,
  // Public join-code signup — 10/hour per source IP. Same logic as
  // 'signup-ip' (real signups are rare, anything higher is abuse).
  'auth-use-join-code':         10,
  'onboard-wizard':             10,
  // Invite acceptance — 10/hour per source IP. One-shot per token in
  // normal use; the cap exists to bound token-spray brute force.
  'auth-accept-invite':         10,
  // Phase M1.5 transactional email — keyed on recipient. 5/hour stops
  // an admin click-spamming "send invite" from blasting one inbox; a
  // legitimate admin re-sending after a typo has 4 retries before they
  // need to wait. Per-recipient (not per-property) so different hotels'
  // invites don't compete with each other.
  'email-transactional':         5,
  // 2026-05-20 audit M3 — public SMS-linked surface. Caps tuned to
  // generous real-world ops use.
  // sms-reply: a chatty housekeeper might fire 50+ ENGLISH/ESPAÑOL toggles
  // and short replies per shift; 120/hr per phone leaves headroom.
  'sms-reply':                  120,
  // housekeeper-rooms is the polled-read endpoint for the housekeeper
  // page. The page polls every 4 seconds (see subscribeToRoomsForStaff
  // in src/lib/db/housekeeper-helpers.ts) so legitimate worst-case is
  // 900/hr from polling alone, plus realtime-triggered refetches plus
  // action-driven refetches after every Done/Reset tap. 3600/hr = 1/sec
  // gives ~4x headroom over worst legitimate use while still bounding
  // a stolen-link replay loop within an hour.
  //
  // DO NOT tighten below ~2400 without first reducing the page's poll
  // interval — the original 600 cap (2026-05-20) shipped broken: real
  // housekeepers got 429'd after ~40 minutes of normal foreground use
  // (Codex post-shipment review, 2026-05-21, finding A2).
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
  'front-desk-rush':              60,
  // laundry-bootstrap is a read-only page bootstrap. Polled less often
  // than housekeeper. 600/hr per property covers heavy use.
  'laundry-bootstrap':          600,
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
  // Comms-voice audit P4 (2026-05-22) — TTS narration cap per user/hour.
  // Real walkthroughs play 5–15 narrations; 30/hr is "do the full
  // walkthrough twice with retries" headroom. Catches runaway clients
  // long before the $5 daily budget cap trips. Easy to bump if a real
  // user hits it.
  'agent-tts-speak':             30,
  // scraper-status — banner polls every 60s = 60/hr per tab. Cap at
  // 240/hr per (user, property) to absorb 4 open tabs without 429,
  // while still stopping a runaway useEffect or stale-link DDoS.
  'scraper-status':              240,
  // Sick-callout buckets — see RateLimitEndpoint union comment for rationale.
  'callout-housekeeper':          10,
  'callout-manager':              30,
  'callout-sms':                  20,
  'callout-revert':               30,
  'callout-status':              600,
  // Piece B/C caps. Manager posts (notices, room notes) are deliberate
  // actions — 60/hr is "manager spamming the notice board" headroom.
  'housekeeping-notices-post':     60,
  'housekeeping-notices-read':    600,
  'housekeeping-notice-dismiss':  100,
  'housekeeping-room-notes-post':  60,
  'housekeeping-room-notes-read': 600,
  'housekeeper-structured-issue': 200,
  'housekeeper-photo-presign':    200,
  'housekeeper-add-note':         200,
  'housekeeper-mark-inspection':  200,
  'housekeeper-save-language-loc': 10,
  'housekeeper-offline-replay':   300,
  // Cross-department activity log export.
  'settings-activity-log-export':  30,
  // Plan v4 manager Rooms board — 6s polling + visibility refetches.
  'housekeeping-rooms':         2400,
  // Plan v4 manager Rooms-tab writes (tile cycling). 600/hr per
  // (user, property) — 10 taps/min sustained, well above real-world use.
  'housekeeping-room-action':    600,
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
  'complaints-sms':               60,
  // Financials — GM/owner finance suite. Per-property (raw pid). scan-* are
  // Claude-Vision-cost-bounded (a manager scanning a stack of invoices); sms is
  // the overspend/anomaly alert fan-out, same shape as complaints-sms.
  'financials-scan-invoice':      50,
  'financials-scan-quote':        50,
  'financials-sms':               60,
  // Engineering Compliance (feature #19). All PER-PROPERTY (keyed on raw pid).
  // Read/log caps sized for several engineers polling one property at once
  // (bootstrap polls ~80/hr each). Vision/voice/setup are Claude-cost bounded;
  // send-engineer-links matches the SMS-fan-out cap shape.
  'engineer-bootstrap':         1200,
  'engineer-log':                600,
  'engineer-vision':              50,
  'engineer-voice':               60,
  'engineer-save-language':       30,
  'compliance-read':            1800,
  'compliance-config':           100,
  'compliance-log':              200,
  'compliance-setup':             20,
  'compliance-vision':            50,
  'send-engineer-links':          10,
  // v2 anomaly AI phrasing — at most one Claude batch per property per sweep.
  'compliance-anomaly-phrase':    20,
  // Lost & Found (2026-05-30). Register read is polled (~30s/tab) + the
  // dashboard tile polls counts — 3600/hr per property absorbs several
  // terminals. Writes are deliberate desk actions. AI + SMS endpoints cost
  // money so they're tighter (and fail-closed below).
  'lost-found-read':            3600,
  'lost-found-write':            300,
  'lost-found-describe-photo':    50,
  'lost-found-auto-match':        60,
  'lost-found-notify-guest':      30,
  'lost-found-photo-presign':    200,
  'housekeeper-report-found-item': 200,
  'housekeeper-found-item-photo-presign': 200,
  // ── Communications ───────────────────────────────────────────────────
  // Translation is cache-first: only cache MISSES hit the model + counter.
  'comms-translate':           1500,
  'comms-assistant':             80,
  'comms-detect-action':        400,
  'comms-summary':               80,
  'comms-polish':                80,
  'comms-transcribe':           150,
  // Non-AI, per-user composite key (fail-open). comms-read is polled
  // (~3s open chat / ~8s list); 3600/hr = 1/sec/user gives wide headroom.
  'comms-send':                 400,
  'comms-read':                3600,
  'comms-task':                 400,
  'comms-action':               200,
  'comms-photo-presign':        300,
  'comms-save-language':         20,
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
  // Each pms-onboard burns $1-3 of Anthropic credit on the Fly worker.
  'pms-onboard',
  // Recipe regeneration is the same shape as pms-onboard.
  'admin-regenerate-recipe',
  // Claude Vision calls.
  'scan-invoice',
  'photo-count',
  // Twilio SMS fan-out (per-recipient charge).
  'send-shift-confirmations',
  'notify-housekeepers-sms',
  'morning-resend',
  'sms-reply-resend',
  'test-sms-flow',
  // Resend transactional email (per-recipient charge).
  'email-transactional',
  // Comms-voice audit P4 (2026-05-22) — ElevenLabs TTS billed per char.
  // MUST be in this set so an RPC failure fails CLOSED (denies the call).
  // Without this, a Supabase blip would let a runaway client bypass the
  // cap until the daily budget tripped.
  'agent-tts-speak',
  // Codex review 2026-05-24 (Probe 10) — sick-callout report endpoints
  // fan out Twilio SMS to every affected housekeeper plus the manager
  // via sendCalloutNotifications. A rate-limit RPC failure would let a
  // valid (pid, staffId) link spam those messages until the daily
  // Twilio cap hit. callout-status is read-only and stays fail-open.
  'callout-housekeeper',
  'callout-manager',
  'callout-sms',
  'callout-revert',
  // Complaints — Claude service-recovery draft (token cost) + Twilio
  // assignee-notify / satisfaction-callback nudges (per-message charge).
  // Fail CLOSED so a Supabase blip can't uncap spend. complaints-log is here
  // too: it runs a Claude classify on every call (Codex review #6).
  'complaints-log',
  'complaints-draft',
  'complaints-sms',
  // Engineering Compliance (feature #19) — Claude Vision, Claude text parse,
  // and Twilio SMS fan-out. Fail closed so a DB blip can't uncap spend.
  'engineer-vision',
  'engineer-voice',
  'compliance-setup',
  'compliance-vision',
  'send-engineer-links',
  'compliance-anomaly-phrase',
  // Lost & Found — vision (describe), Claude (auto-match), Twilio (notify).
  // Each call costs money, so fail CLOSED if the rate-limit RPC errors.
  'lost-found-describe-photo',
  'lost-found-auto-match',
  'lost-found-notify-guest',
  // Communications AI endpoints — each call costs Claude/OpenAI credit.
  // Keyed on the RAW property UUID (real properties.id), so failing closed
  // is never triggered by an FK violation. Clients degrade gracefully on 429
  // (translate → original text; assistant → "try again").
  'comms-translate',
  'comms-assistant',
  'comms-detect-action',
  'comms-summary',
  'comms-polish',
  'comms-transcribe',
  // Financials — Claude Vision (scan invoice / contractor quote) + Twilio
  // overspend/anomaly alert fan-out. Fail CLOSED so a DB blip can't uncap
  // Anthropic / Twilio spend.
  'financials-scan-invoice',
  'financials-scan-quote',
  'financials-sms',
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
): Promise<
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; current: number; cap: number }
> {
  const cap = HOURLY_CAPS[endpoint];
  const hourBucket = new Date().toISOString().slice(0, 13);  // "2026-04-27T17"
  try {
    // Atomic upsert: increment count, return new value.
    const { data, error } = await supabaseAdmin.rpc('staxis_api_limit_hit', {
      p_property_id: pid,
      p_endpoint: endpoint,
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
