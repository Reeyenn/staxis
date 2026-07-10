# Staxis Housekeeping Features — Gap Analysis vs Discovery Findings
**Audit Date:** April 4, 2026
**Scope:** Phase 1 MVP features from Comfort Suites customer discovery (April 2026)

---

## EXECUTIVE SUMMARY

Staxis has built a **strong foundation** for the Phase 1 MVP housekeeping scheduler. The core scaffolding for scheduling, notifications, room status tracking, and dashboarding is in place. However, **critical gaps remain** in areas that directly impact daily operations: mobile app completeness, real-time notifications, maintenance routing, and language support depth.

**Overall Build Status:** ~55–65% complete for Phase 1 MVP features. Foundation is solid; execution is incomplete.

---

## SECTION 1: HOUSEKEEPING SCHEDULING & STAFFING
**Discovery Priority:** CRITICAL

### 1.1 Night-Before Calculation (Staffing Prediction)
**Status:** BUILT ✓

**What Works:**
- Automated staffing calculator exists in `/housekeeping/page.tsx` (lines 363–392)
- Uses 4-bucket model: room minutes + public area minutes + prep minutes + fixed laundry
- Configurable defaults: 30 min checkout (validated), 20 min stayover (validated), 5 min transitions (validated)
- Real-time calculation tied to PMS room data for selected shift date
- Formula accounts for variable shift lengths (default 480 min = 8 hrs)
- Displays **recommended staff count** prominently in blue gradient card

**Partial/Incomplete:**
- Public areas included in calculation but not validated against Maria's exact task inventory
- No deep clean scheduler yet (Maria mentioned 2–4 rooms per week on Mondays, takes ~1.5 hrs with 2–3 people) — not surfaced in recommendation UI
- Laundry staffing: hardcoded as 1 fixed person, not configurable by property or day
- No override for "this room is always difficult" — Maria tracks known problem rooms (room 42 leak "many years")
- Prediction is shown but no confirmation flow for whether user wants to proceed with recommendation

**Missing Entirely:**
- Historical prediction from past weeks (buildable via DailyLog — not yet wired)
- Day-of-week variance (some days are always harder; no trend detection)
- Integration with staff availability from staffing calendar (exists separately in Settings, not wired into prediction)

**Critical Gap:** Calculation is sound but **not tied to staff availability**. System recommends 5 people but doesn't auto-check if 5 people are available/eligible. Operator must manually cross-reference.

---

### 1.2 One-Tap Housekeeper Notification & Scheduling
**Status:** PARTIALLY BUILT (~40%)

**What Works:**
- Staff member list with eligibility filtering (lines 69–79): checks active status, vacation dates, weekly hour limits, days per week
- "Auto Select Crew" button (lines 715–726) — filters eligible staff based on hours/availability
- Manual selection UI: grid of toggleable staff cards (lines 737–787)
- Send notifications button (line 790): triggers `/api/send-shift-confirmations`
- SMS text integration confirmed (Twilio backend wired; code references SMS sending in discovery doc)
- Supports both English and Spanish notifications

**Partial/Incomplete:**
- UI shows confirmations **after** sending, but no confirmation timeout/reminder system
- No "auto-replace if no response" logic visible in housekeeping.page.tsx
- Notifications panel exists (lines 454–506) but shows manager notifications (declines, replacements) — doesn't show housekeeper responses in real-time on this tab

**Missing Entirely:**
- **1-hour auto-escalation rule:** Maria gets alert if housekeeper doesn't respond within 1 hour (not implemented)
- Backup housekeeper auto-dispatch if person declines (exists as logic in ManagerNotification type but not surfaced in UI)
- View of "who replied when" with response times
- Ability to resend to specific non-responders
- SMS delivery status (sent vs. failed) not displayed in UI

**Critical Gap:** Notification flow exists but is **one-way and incomplete**. No visibility into response status, no auto-escalation, no backup selection workflow.

---

### 1.3 Morning Room Assignment Interface
**Status:** PARTIALLY BUILT (~50%)

**What Works:**
- Rooms loaded from PMS per selected date (line 303–307)
- Rooms grouped by floor (lines 846–927)
- Room status tiles show type (checkout 🚪 / stayover 🔒 / vacant 💎) and cleaning state
- Can tap to toggle room status manually (dirty → in_progress → clean → inspected)

**Partial/Incomplete:**
- **No explicit assignment UI on manager side.** Rooms exist but no drag/drop or form-based assignment
- Housekeeper view auto-loads "assigned rooms" from Firebase (housekeeper/[id]/page.tsx) but assignment happens offline or via a missing admin interface
- No visual "suggested assignments by floor" for morning briefing

**Missing Entirely:**
- **Manager-side room assignment interface** — no way for Maria to reassign rooms in the morning or adjust based on "this housekeeper is slow today"
- Deep clean scheduler/flag — no visual indicator of rooms due for deep clean
- "Reassign on the fly" if a room takes longer than expected
- One-click "distribute 16 rooms across 4 housekeepers" auto-balancer

**Critical Gap:** Rooms exist in system but **assignment is invisible to manager**. Maria must manage this outside the app (still texting/verbal).

---

## SECTION 2: HOUSEKEEPER MOBILE APP & ROOM STATUS UPDATES
**Discovery Priority:** CRITICAL

### 2.1 Individual Housekeeper View (My Assigned Rooms)
**Status:** BUILT ✓

**What Works:**
- Dedicated housekeeper view at `/housekeeper/[id]/page.tsx`
- Shows only **assigned rooms** for that housekeeper (lines 83–98)
- Rooms sorted by priority (checkout first, then stayover; VIP → early → standard within each)
- Language preference auto-loads from `staffPrefs` collection (lines 61–72)
- Spanish-language interface available (translations wired throughout)
- Individual room cards with status badges

**Partial/Incomplete:**
- Room type labels exist (checkout/stayover) but icons and visual hierarchy could be clearer for fast scanning
- No "time spent so far" indicator on each room
- No "estimated done time" per room based on predicted cleaning time

**Missing Entirely:**
- No performance metrics on personal view (Maria wants to know "am I on pace?")
- No live comparisons to other housekeepers' progress (competitive visibility)

---

### 2.2 Tap-to-Start / Tap-to-Clean Workflow
**Status:** BUILT ✓

**What Works:**
- "Start" button (handleStartRoom, lines 120–127): marks room in_progress, records startedAt timestamp
- "Done" button (handleFinishRoom, lines 130–159+): marks room clean, records completedAt timestamp
- Timestamps captured as Firestore Timestamp.now() — enables real performance tracking
- UI shows room in dirty state initially, then in_progress (amber), then clean (green)

**Partial/Incomplete:**
- Finish button has "hold-to-confirm" safety (mentioned in code) but implementation not visible in preview
- No visual feedback for "hold duration" — housekeeper doesn't know how long to hold

**Missing Entirely:**
- **Photo capability** — Maria mentioned housekeepers should flag issues with photos (not built)
- No timer/stopwatch to track room cleaning time in real-time
- No "request help" button (mentioned in discovery: housekeeper taps when room is taking too long)

**Critical Gap:** Basic workflow exists but **no help-request mechanism** or **photo attachment**. Housekeepers are blind if a room is unexpectedly difficult.

---

### 2.3 Do Not Disturb (DND) Button
**Status:** PARTIALLY BUILT (~40%)

**What Works:**
- DND flag exists in Room type (isDnd: boolean, line 93 in types)
- Visual indicator on dashboard (DND rooms show 🚫 emoji, line 969)
- Room status reflects DND in assignment view

**Partial/Incomplete:**
- No explicit "DND button" on housekeeper view visible in code
- Maria's reactions when seeing DND described in discovery ("count how many DNDs to reallocate time to deep clean") — no auto-adjustment logic

**Missing Entirely:**
- **Housekeeper-facing DND detection:** discovery doc says housekeepers "discover DND by walking corridor" and should be able to tap button to report it, triggering Maria notification
- No "tap to report DND" action on room in housekeeper view
- No instant notification to Maria: "DND detected on room 217"
- No auto-time-adjustment: "One housekeeper now has X fewer rooms to do"
- No summary for Maria: "Total DNDs today: 3, affecting 45 min of cleaning"

**Critical Gap:** DND data structure exists but **no workflow for housekeeper to report it** or **for system to re-optimize workload when DND is discovered**.

---

### 2.4 Stayover vs. Checkout Labels
**Status:** BUILT ✓

**What Works:**
- Room.type property distinguishes checkout / stayover / vacant (line 75)
- Housekeeper view sorts by type (checkout first)
- Icons displayed on room cards (🚪 checkout, 🔒 stayover, 💎 vacant)

**Partial/Incomplete:**
- Could be more visually distinct (current icons are emoji, hard to scan at a glance)
- No time-estimate label per room type ("checkout ~30 min, stayover ~20 min")

---

### 2.5 Front Desk Real-Time View
**Status:** BUILT ✓

**What Works:**
- Dashboard shows live room status grid by floor (lines 21–88)
- Color-coded: green (clean) / amber (in progress) / red (dirty)
- Shows updated room state in real-time via Firestore subscription
- Accessible from any device (responsive design)

**Partial/Incomplete:**
- Dashboard is read-only for front desk (good for visibility, but discovery mentions front desk should trigger room swaps)
- No "front desk override" capability (e.g., guest complains, room needs to go out of order)

---

## SECTION 3: REAL-TIME NOTIFICATIONS & ROOM CHANGE ALERTS
**Discovery Priority:** HIGH

### 3.1 Auto-Notification on Room Status Changes
**Status:** PARTIALLY BUILT (~30%)

**What Works:**
- ManagerNotification type exists with message, type (decline/no_response/all_confirmed/replacement_found), staffName, shiftDate
- Notification panel in housekeeping view (lines 454–506) shows manager notifications

**Partial/Incomplete:**
- Notifications are one-directional: **only about shift confirmations/staff changes**, not room status changes
- No webhook/trigger for "room status changed" → notify Maria

**Missing Entirely:**
- **Room change listeners:** front desk changes room status, Maria should get instant alert
- **Occupancy threshold approval:** discovery says "when occupancy > 90%, room swaps need Maria approval" — not implemented
- **Stayover extensions:** front desk inputs extension, auto-updates cleaning schedule (not wired)
- **Early checkouts:** front desk inputs early checkout, removes room from today's workload (not wired)

**Critical Gap:** Notification infrastructure exists for **shift scheduling only**. No real-time alerts for **operational changes** (room swaps, checkouts, extensions, maintenance issues).

---

### 3.2 Overnight Notes Replacement (Physical Book → App)
**Status:** NOT BUILT (0%)

**Current State:**
- Overnight staff writes in physical book
- Maria reads book in morning
- If rushed, she forgets (discovery quote: "sometimes it starts already and I forgot if there was any maintenance")
- People text her photos of pages when she's off-site

**Missing Entirely:**
- No digital notes input for overnight staff
- No shift handoff notes data structure
- No notification to Maria: "3 notes waiting from night shift"

**Critical Gap:** The most manual, fragile part of daily communication. High priority for reducing errors.

---

### 3.3 Front Desk Extension/Early Checkout Input
**Status:** NOT BUILT (0%)

**Current State:**
- Front desk texts Maria for stayover extensions and early checkouts
- If text is missed/delayed, room assignments are wrong
- Manual, failure-prone

**Missing Entirely:**
- No "stayover extension" button in front desk interface
- No "early checkout" button in front desk interface
- No automatic room-assignment recalculation when these occur

**Critical Gap:** Large operational impact. Causes wasted labor (unnecessary room cleans) or missed cleans.

---

## SECTION 4: MAINTENANCE TASK ROUTING & LOGGING
**Discovery Priority:** HIGH (HIGH for Phase 1 inclusion despite Phase 2 label)

**Key Finding from Discovery:** Maria does ALL maintenance herself. No dedicated maintenance person. This is a **staffing bottleneck**, not a department issue.

### 4.1 Current Implementation
**Status:** NOT BUILT (0%)

**What Exists in Data Model:**
- WorkOrder type (lines 235–251 in types.ts): submitted, assigned, in_progress, resolved states
- PreventiveTask type (lines 255–264): recurrence tracking

**What's Missing:**
- No UI for maintenance submission (front desk can't submit via app)
- No morning briefing view (Maria can't see pending maintenance alongside room assignments)
- No assignment interface (can't reassign to another staff member)
- No recurring pattern detection (Maria mentioned room 42 leak "for many, many years" — no way to flag recurring issues)

**Critical Gap:** Maria still uses physical book. No digital workflow exists.

---

## SECTION 12: OPERATOR DASHBOARD & VISIBILITY
**Discovery Priority:** CRITICAL

### 12.1 Phase 1 MVP Dashboard
**Status:** PARTIALLY BUILT (~60%)

**What Works:**
- Dashboard page exists (`/dashboard/page.tsx`)
- Shows today's room status:
  - Total rooms, occupied, clean, dirty, in progress (lines 130–136)
  - Clean rooms highlighted with % complete progress bar
  - Room grid by floor with real-time color coding
- Tomorrow's crew confirmations:
  - Shows confirmed, pending, declined, no_response statuses
  - Quick ratio view: "3/5 confirmed"
- 4 stat cards: staff tomorrow, est labor cost, dirty rooms, available rooms (lines 177–207)

**Partial/Incomplete:**
- Staff count card shows "confirmed" for tomorrow but doesn't show if **enough** staff (what if only 2/5 confirmed but need 4?)
- No open maintenance count (mentioned in discovery: "Open maintenance requests count and status")
- No "expected checkouts and arrivals" (discovery: "Today's expected checkouts and arrivals")
- Room grid is read-only (can't tap to reassign from dashboard)

**Missing Entirely:**
- **Mobile-first version:** Discovery emphasizes Maria manages from phone/iPad. Dashboard is desktop-optimized.
- **DND count:** "Total DNDs today: X"
- **Housekeeper pace indicators:** "3 ahead, 1 behind, 2 on pace" per discovery "Housekeeping progress: X of Y rooms completed, by housekeeper"
- **Arrival/departure times:** No calendar integration

**Critical Gap:** Dashboard exists but **not optimized for mobile use or real-time operational decisions**. Missing key metrics Maria needs to manage exceptions.

---

### 12.2 Phase 2–3 ROI Dashboard
**Status:** NOT BUILT (0%)

**Missing:**
- Labor cost per occupied room (before vs. after)
- Weekly/monthly labor savings (dollar amount)
- Room turn time trends
- Retention mechanism: "you saved $23K this year"

---

## SECTION 14: SPANISH-LANGUAGE SUPPORT
**Discovery Priority:** HIGH (Competitive differentiator)

### 14.1 Current Implementation
**Status:** PARTIALLY BUILT (~70%)

**What Works:**
- Full translation system via `/lib/translations.ts` (referenced throughout)
- Manager/front desk interfaces have language toggle (English by default, Spanish available)
- Housekeeper view auto-loads language preference from `staffPrefs` collection (lines 61–72)
- Notifications sent in staff member's preferred language (discovery: "bilingual notifications")
- Key terms translated: habitaciones, horario, rendimiento, salida, continuación, etc.

**Partial/Incomplete:**
- Translation strings exist but need audit for completeness
- Housekeeper interface has language toggle button (lines 116–131) but auto-detection from staffPrefs works
- No Spanish SMS templates documented

**Missing Entirely:**
- No **Spanish-first** onboarding (everything defaults to English, then housekeeper must toggle)
- No Spanish documentation/help for housekeepers (only UI translations)

---

## SECTION 5: PUBLIC AREA TASK MANAGEMENT
**Discovery Priority:** MEDIUM-HIGH

**Status:** PARTIALLY BUILT (~50%)

### 5.1 What Exists
**What Works:**
- PublicArea data type (lines 48–58 in types.ts): name, floor, locations, frequencyDays, minutesPerClean, startDate
- Calculation: `getPublicAreasDueToday()` and `calcPublicAreaMinutes()` (lines 13–30 in calculations.ts)
- Public areas modal referenced in settings (line 649: `<PublicAreasModal/>`)
- Included in staffing prediction (line 379–381): areas due today factored into total workload

### 5.2 What's Missing
- **Public areas interface UI:** Modal referenced but not implemented in provided files
- **Laundry person assignment:** No way to assign public area tasks to specific staff member
- **Completion tracking:** No "laundry person taps Done" workflow
- **Frequency flexibility:** Data model supports variable frequency but no UI for "edit times per day of week" (pool cleanup heavier on Mondays)
- **Task inventory validation:** Discovery lists 17 specific tasks with exact times; no way to verify they're all configured

**Critical Gap:** Public areas are calculated but **not operationally wired**. Laundry person has no assigned task list.

---

## SECTION 6: STAFF COMMUNICATION PLATFORM (Bonus)
**Discovery Priority:** HIGH (Manager's #1 magic wand request)

**Status:** NOT BUILT (0%)

**Current State:**
- Fragmented: physical book + Connecteam (scheduling) + text messages
- Discovery: Manager wants one platform for all housekeeping communication

**What's Built:**
- ManagerNotification infrastructure (shift confirmations, declines, replacements)
- Housekeeper view has language support

**What's Missing:**
- **Unified messaging/notes:** No chat or comment system
- **Overnight shift handoff notes:** No digital replacement for physical book
- **Broadcast messages:** Maria can't send group message to all housekeepers
- **Acknowledgment tracking:** No way to confirm "housekeepers read this"

---

## SUMMARY TABLE: BUILD STATUS BY FEATURE

| **Feature** | **Status** | **% Complete** | **Impact** |
|---|---|---|---|
| **1.1 Staffing Calculator** | Built | 80% | Strong foundation; missing deep clean & historical variance |
| **1.2 Notification & Scheduling** | Partial | 40% | SMS sent, but no escalation or response tracking |
| **1.3 Morning Assignments** | Partial | 50% | Rooms exist but no manager assignment UI |
| **2.1 Housekeeper Mobile View** | Built | 90% | Solid; missing help button & timers |
| **2.2 Tap-to-Start/Clean** | Built | 95% | Works; needs UX refinement for confirmation |
| **2.3 DND Detection** | Partial | 20% | Data exists; no housekeeper reporting workflow |
| **2.4 Stayover/Checkout Labels** | Built | 85% | Works; visual clarity could improve |
| **2.5 Front Desk Real-Time View** | Built | 85% | Read-only; no override capability |
| **3.1 Room Change Alerts** | Partial | 30% | Only for staff scheduling, not operations |
| **3.2 Overnight Notes (Digital)** | Missing | 0% | Critical gap; still paper-based |
| **3.3 Extension/Early Checkout Input** | Missing | 0% | Still manual texts; major labor impact |
| **4.1 Maintenance Routing** | Missing | 5% | Data model exists; no UI or workflow |
| **12.1 Phase 1 Dashboard** | Partial | 60% | Good overview; missing mobile optimization & key metrics |
| **12.2 ROI Dashboard** | Missing | 0% | Retention risk |
| **14.1 Spanish Support** | Partial | 70% | UI translated; not Spanish-first for housekeepers |
| **5.1 Public Areas** | Partial | 50% | Calculation works; no task assignment or tracking |
| **6.1 Communications Platform** | Missing | 0% | Manager's top request; fragmented today |

---

## CRITICAL BLOCKERS FOR PRODUCTION LAUNCH

### Tier 1: Deal-Breaker (Must Fix Before Piloting)
1. **Morning Room Assignments** — Maria has no way to assign or reassign rooms. System still requires manual verbal/text communication.
2. **Help Request Button** — Housekeeper can't flag difficult room. Maria blind to problems.
3. **Overnight Notes** — No digital handoff. Still using physical book; defeats purpose of app.
4. **Maintenance Input** — Front desk can't submit digitally. Maria still uses physical book.

### Tier 2: High Priority (Fix Before First Customer)
1. **Shift Confirmation Escalation** — No 1-hour rule or auto-replacement workflow.
2. **Real-Time Room Change Alerts** — Front desk changes don't notify Maria automatically.
3. **Extension/Early Checkout Input** — Still texting; no auto-recalculation.
4. **DND Reporting Workflow** — Housekeeper can't report DND; Maria can't optimize workload.
5. **Mobile Dashboard Optimization** — Maria manages from phone; dashboard is desktop-first.

### Tier 3: Phase 1 Polish (Nice-to-Have)
1. ROI dashboard (retention tool)
2. Historical staffing prediction (forecasting)
3. Public area task assignment UI
4. Photo attachments for issue reporting
5. Performance timers/pace indicators

---

## RECOMMENDATIONS FOR NEXT SPRINT

**Immediate (Week 1):**
- [ ] Build room assignment UI on manager housekeeping view (drag/drop or form-based)
- [ ] Add "help request" button to housekeeper room view
- [ ] Implement overnight shift notes input form in housekeeping/schedule tab

**Short-term (Week 2):**
- [ ] Wire real-time room change notifications (occupancy, extensions, early checkouts)
- [ ] Add 1-hour escalation timer for shift confirmations
- [ ] Build maintenance submission form (accessible to front desk)

**Medium-term (Week 3–4):**
- [ ] Mobile-optimize dashboard (optimized for 375px viewport, accessible from phone)
- [ ] Implement DND reporting workflow
- [ ] Add public area task assignment interface

**Polish (Week 5+):**
- [ ] Photo uploads for maintenance and room issues
- [ ] Historical trend analysis for staffing prediction
- [ ] ROI calculator and retention dashboard

---

## FILES REFERENCED IN AUDIT

**Key Application Files:**
- `/src/app/housekeeping/page.tsx` — Manager scheduling, staffing calc, room management (1973 lines)
- `/src/app/housekeeper/page.tsx` — Housekeeper setup/onboarding (280 lines)
- `/src/app/housekeeper/[id]/page.tsx` — Housekeeper room view & workflow (~280 lines)
- `/src/app/dashboard/page.tsx` — Operator dashboard (325 lines)
- `/src/types/index.ts` — Data model (includes Room, WorkOrder, ShiftConfirmation, etc.)
- `/src/lib/calculations.ts` — Staffing & public area calculations

**Discovery Source:**
- `[C] Customer Discovery Findings — Comfort Suites (April 2026).md` (43KB, comprehensive field notes)

---

# SECURITY AUDIT — 2026-06-26 (pre-onboarding)

Multi-agent security audit of the whole codebase (web `src/`, CUA worker
`cua-service/`, ML service `ml-service/`, migrations) run before onboarding
real hotels. 55 agents across access-control/IDOR, multi-tenancy, secrets,
injection/SSRF, session/2FA, rate-limit/cost-abuse, PII, CUA, ML, and
dependencies; every finding adversarially re-verified against the real code.
**59 confirmed findings: 4 high, 9 medium, 46 low.**

All fixes landed on branch `fix/security-hardening` (5 commits, off live
`origin/main` @ b442e60). Verification per commit: `tsc --noEmit`, `eslint`
(+ the repo's own tenant-scope / RLS-coverage / MFA-gate audit scripts),
2388 web tests, 1059 cua-service tests, and a full production build — all green.

## Fixed & shipped (branch `fix/security-hardening`)

HIGH
- **Cron/admin auth fail-open on Vercel preview** (`api-auth.ts requireCronSecret`).
  Preview deploys carry the prod service-role key and are publicly reachable;
  unsigned requests passed through, exposing destructive cron endpoints. Now
  fails closed on preview (mirrors `requireHeartbeatSecret`). Commit 0f48559.
- **Rate-limit key spoofable via leftmost `X-Forwarded-For`** on auth/onboarding/
  housekeeper endpoints — defeated join-code/invite brute-force + cost caps. New
  `trustedClientIp()`/`clientIpRateLimitKey()` use the platform-trusted source;
  all 7 call sites routed through it. Commit 0f48559.
- **AI agent ignored per-hotel Access-tab capability restrictions** — a manager an
  admin had switched OFF for financials could still ask the copilot for
  revenue/budgets/wages. Added `requiresCapability` to the tool registry +
  `canForProperty` gate in `executeTool`; tagged finance/reports/payments/
  compliance tools. Commit 0f48559.
- (#1 root cause — public staff-page `staffId` enumeration via `/api/staff-list` —
  see "Remaining" below; the structural fix is a documented follow-up.)

MEDIUM
- **sms/callout webhook fail-open** when `TWILIO_AUTH_TOKEN` unset/blank — now
  fails closed + rejects unsigned JSON (mirrors `sms-reply`). Commit 0f48559.
- **inventory/accounting-summary** leaked spend/budget to any same-tenant role —
  now routes through `requireFinanceAccess`. Commit 0f48559.
- **inventory/ai-mode** writable by any property-scoped role — now via
  `requireOrderingAccess` (manage_inventory_orders). Commit dac9e53.
- **CUA `extractFetchApi` SSRF** — the one credentialed (`credentials:'include'`)
  egress that bypassed `safeGoto`; now refuses private/loopback/link-local hosts
  + optional DNS-rebinding preflight. Commit 3625185.
- **CapEx attachment**: projectId validated as UUID (kills path traversal into the
  storage key) + magic-byte / `%PDF-` validation. Commit dac9e53.
- **axios/form-data/qs/ws** advisories patched (`npm audit fix`, non-breaking) in
  root + cua-service; cua-service → 0 vulns. Commit 3b670d4.

LOW (selected)
- complaints/draft 403-vs-404 cross-tenant existence oracle → single 404. dac9e53.
- onboarding_state PATCH: reject unknown keys + length-cap strings (bounds jsonb). dac9e53.
- Sentry `includeLocalVariables:false` (don't serialize secrets in stack locals). dac9e53.
- Stripe portal `return_url` from canonical `NEXT_PUBLIC_APP_URL`, not Origin header. dac9e53.
- UUID validation on agent conversations/nudges id params (500→400). dac9e53.
- Stop echoing raw Postgres `error.message` to clients (agent convo, staff-schedule
  ×3, feedback). dac9e53 + eab45e3.
- **CI gate**: new `.github/workflows/dependency-audit.yml` fails build on HIGH/
  CRITICAL prod advisories (npm root+cua, pip-audit ml), per-PR + weekly. 3b670d4.

## Remaining — recommended follow-ups (not yet fixed)

1. **HIGH — public staff-page `staffId` enumeration.** `GET /api/staff-list?pid=`
   returns live `staffId`s with no auth; the whole housekeeper/laundry/engineer
   public surface trusts the `(pid, staffId)` tuple as its only credential, and
   `pid` leaks via SMS links. Fix: stop emitting `staff.id` from any
   unauthenticated endpoint AND bind those public routes to a per-staff token
   minted at SMS-send time (a `staff_magic_codes`-style bearer) verified
   server-side, instead of a raw `staffId`. Multi-route change + migration; needs
   its own focused build + signed-in QA.
2. **MEDIUM — staff phone readable by any same-tenant user via the anon client**
   (`STAFF_COLS` in `src/lib/db/staff.ts`). Insider-only (requires a valid hotel
   account). Fix mirrors the shipped `hourly_wage` pattern: strip `phone` from the
   anon read projection (and anon write helpers), add a manager-gated
   `GET/PUT /api/staff/contact` (verifyTeamManager + `manage_team`), and rewire
   `ManagerDirectory.tsx` to a `phones` map with the same `wageTouched`-style
   race-guard so a save can't clear a phone before the async map loads. Deferred
   because it touches the live staff-management write path and needs signed-in
   browser QA — a rushed version risks clearing staff phone numbers on save.
3. **MEDIUM — pms-feeds money tools still allow `front_desk`** for guest-balance/
   future-booking aggregates. `get_payments_summary` is now gated; decide per-tool
   whether front desk needs the others operationally before tightening.
4. **MEDIUM — CUA recipe signing ships in `warn` mode** (read/login path). Ops:
   `fly secrets set RECIPE_SIGNING_KEY=<32+ bytes> RECIPE_SIGNING_ENFORCE=enforce -a staxis-cua`,
   then run the resign-knowledge-files backfill, so the read path fails closed like
   the write path already does.
5. **LOW (hardening, ~30 items)** — full list in the audit run output. Highlights:
   CSP uses `unsafe-inline` (no nonce) and `img-src https:` wildcard; CSRF relies on
   SameSite=Lax only; remaining admin routes echo `error.message`; `validateNumber`
   accepts hex/exponential; `validateString` permits control chars into SMS; pms-inbox
   trusts caller-supplied DKIM/DMARC verdicts; sentry-webhook has no replay window.
   None are unauthenticated data-exfil; schedule alongside normal work.

## Ops actions required (config — cannot be done in code)

- **Set `CRON_SECRET` on ALL Vercel environments (Production AND Preview).** With
  the fail-closed fix an unset secret on preview now returns 500 (safe) instead of
  exposing endpoints — but preview cron/admin smoke tests need the secret set.
  Strongly consider a SEPARATE Supabase project (or disabled preview deploys) so
  preview never carries the production service-role key.
- **Redeploy the Fly CUA worker** (`flyctl deploy staxis-cua`) to ship the patched
  `ws`, the `extractFetchApi` SSRF guard, and (with #4 above) recipe-signing enforce.
- **Rotate any secret** that may have been exposed via a publicly-reachable preview
  deploy during the pass-through window (precautionary).



---

## Appendix: Staff-pages overhaul bug ledger (2026-07-11)

Pre-existing bugs found during the refactor/staff-pages-overhaul branch bug hunt. Each was adversarially verified by an independent agent. NONE are fixed on that branch (fixing changes visible behavior; needs sign-off). communications was hunted but its verification pass was cut short by a usage limit — its raw findings live in the session journal only.

### settings (14)

- **src/app/settings/shifts/page.tsx** — A failed presets load is silently swallowed (`.then(r => r.ok ? r.json() : null)` maps any non-OK response to an empty list), rendering the 'No shifts configured yet' empty state with no error; saving from that state permanently deletes all real presets because the PUT is bulk-replace.
  - Impact: If the server hiccups (500/403) when a manager opens Settings > Shifts, the page claims they have no shifts and offers 'Load defaults'. If they click it and Save, every shift template they actually had is deleted from the hotel — the schedule grid loses all its one-click picks.
- **src/app/settings/clean-times/page.tsx** — A failed clean-times load (non-OK response) is silently converted to null and every field is filled with the industry defaults with no error banner; pressing Save then overwrites the hotel's customized times with the defaults.
  - Impact: A manager who opens Clean Times during a server error sees the stock numbers (e.g. 30 min checkout) instead of their tuned values, with no warning. If they tweak one field and Save, all their other customized times get reset to the defaults — silently corrupting the workload balancing on the Auto-Assign Board.
- **src/app/settings/pms/use-pms-onboard-job.ts** — The Stop button in the stalled-sync banner doesn't actually stop polling: `setUserStopped(false)` inside the effect that is keyed on `userStopped` immediately resets the flag, re-runs the effect, and restarts the 3-second poll loop.
  - Impact: During a stuck PMS onboarding, clicking 'Stop' makes the 'We stopped polling…' message flash and vanish, the stalled warning resets, and the app quietly keeps hammering the server every 3 seconds anyway. The user believes they stopped it; nothing changed.
- **src/app/settings/checklists/page.tsx** — Switching cleaning types has no fetch cancellation: two rapid clicks leave both loads in flight, and if the older response resolves last, type A's checklist items render under the type-B selector — saving then bulk-writes A's items over B's checklist.
  - Impact: A manager who clicks quickly between Departure and Stayover can end up editing the Departure list while 'Stayover' is highlighted; hitting Save replaces the Stayover checklist with Departure's items. Housekeepers then see the wrong checklist in rooms.
- **src/app/settings/wages/page.tsx** — Both the load and save paths have no exception handling: a network failure during load leaves the page stuck on 'LOADING…' forever, and a network failure during save leaves the button stuck on 'Saving…' forever (setSaving(false) is skipped).
  - Impact: On flaky hotel wifi, the Wages page either never finishes loading or the Save button freezes in 'Saving…' with no error and no way to retry except a full page refresh. The manager can't tell whether wages were saved.
- **src/app/settings/activity-log/page.tsx** — The custom date range's 'to' bound is midnight at the START of the chosen end date while the server query is end-exclusive (occurred_at < to), so the entire selected end day is excluded; picking the same day for from and to always returns zero events.
  - Impact: A manager using Custom dates to review 'July 8 to July 10' never sees July 10's events, and 'July 8 to July 8' always shows 'No events' even when that day was busy — making the log look like data is missing.
- **src/app/settings/users/page.tsx** — load() and performAction() use try/finally with no catch: a network failure loading users shows a silently empty list with no error, and a failed role-change/deactivate/reactivate/transfer silently does nothing (unhandled promise rejection).
  - Impact: On a connection blip, Users & Roles renders as if the hotel has no users, or a manager picks a new role from the dropdown and nothing happens — no error, no spinner, no retry hint. They may believe a deactivation succeeded when it didn't.
- **src/app/settings/notifications/page.tsx** — load() and save() use try/finally with no catch, so any network failure is an unhandled rejection with zero user feedback: the page renders blank (prefs null, no error) or a toggle/pause click silently does nothing; additionally a failed add-CC discards the typed email because the input is cleared before the save resolves.
  - Impact: Offline or on a flaky connection, tapping the Email/SMS toggles, pause buttons, or delivery-time pills does nothing at all — no error, no saved toast — and the manager can't tell their report settings weren't changed. Adding a CC email that fails to save also erases what they typed.
- **src/app/settings/voice/page.tsx** — Two failure gaps on the wake-word toggle: (a) a network exception during save keeps the optimistic flip — the toggle shows the new state even though it never persisted; (b) a non-OK preference load is silently ignored, leaving the toggle permanently disabled with no error message.
  - Impact: A user toggles 'Hey Staxis' on with bad wifi, sees it turn green, and walks away believing it's enabled — after a refresh it's off again. And if the preferences call errors, the toggle is just grayed out forever with no explanation.
- **src/app/settings/reports/page.tsx** — Deleting a report schedule silently ignores failures (non-OK response does nothing, exceptions are swallowed with an empty catch), so the trash button can appear completely dead; report runs also have no cancellation, so overlapping runs can display a stale range's data under the newly selected range.
  - Impact: A manager deletes a scheduled auto-email, sees the row stay in the list with no error, and the report keeps emailing every week. Separately, quickly changing date ranges can show numbers from the previous range labeled as the current one.
- **src/app/settings/shifts/page.tsx** — The post-save reload doesn't check the response: if the refetch after a successful save returns an error body, drafts are reset to [] and the editor collapses to the 'No shifts configured yet' empty state; if it throws, an error banner is shown even though the save succeeded.
  - Impact: Right after pressing Save (which worked), the manager can see all their shift rows vanish and the page invite them to 'Load defaults' — or see 'Save failed'-style red text for a save that actually went through.
- **src/app/settings/accounts/_components/JoinCodes.tsx** — Revoking a join code (and an email invite in Invites.tsx) never checks the DELETE response — on failure the list just reloads unchanged with no error; the load functions likewise silently ignore non-OK responses so the sections quietly disappear.
  - Impact: An owner revokes a signup code that leaked, gets no error, and the code stays in the list — and stays usable by anyone who has it. Same for revoking email invites. If the lists fail to load, pending invites/codes are simply invisible with no hint anything went wrong.
- **src/app/settings/pms/page.tsx** — The PMS form fields are seeded from activeProperty only in the initial useState and never re-synced, so on a hard page load (contexts still resolving at first mount) the PMS System dropdown and Login URL render blank even when a PMS is connected.
  - Impact: A manager who opens Settings > PMS Connection directly (refresh/bookmark) sees an empty '- Select your PMS -' dropdown and empty URL despite the green 'Connected' banner above — inviting them to re-enter or mismatch the connection details.
- **src/app/settings/shifts/page.tsx** — Several user-facing strings on Spanish UI are English-only: the access gate 'Manager access only.', the 'SAVED ·' stamp, the '{n} presets' counter, and department section labels (Housekeeping/Front desk/Maintenance) shown untranslated inside Spanish sentences; also the shared CopyButton feedback ('Copied!' / 'Copied to clipboard') and the 'Sign in to continue.' gates on checklists/activity-log/reports are English-only.
  - Impact: Spanish-speaking staff see mixed-language screens: a Spanish page with 'Manager access only.', 'SAVED · 3:41 PM', '4 presets', 'Agregar turno a Housekeeping', and green 'Copied!' toasts in English after copying a join code.

### financials (16)

- **src/app/financials/_components/CapexRequestModal.tsx** — Submitting a new CapEx request never checks the result: on any failure the modal closes and the whole request (plus scanned line items) is silently lost.
  - Impact: A manager types up a capital request (or scans a contractor quote), hits Submit, the dialog closes like it worked — but nothing was saved and everything they typed is gone with no message.
- **src/app/financials/_components/BudgetTab.tsx** — "Save budgets" swallows every failure: each department upsert result is ignored and the modal always closes as saved.
  - Impact: A GM sets monthly budgets, clicks Save, modal closes — if the network or server failed (or a value was rejected), some or all budgets silently didn't save and the grid quietly shows the old numbers.
- **src/app/financials/_components/BudgetTab.tsx** — A typo in a budget field is coerced to $0, silently wiping that department's existing budget.
  - Impact: Typing "1,50o" or any invalid amount into a budget line and saving deletes that department's budget (sets it to no budget) with no warning — the budget meter and overspend alerts for that department disappear.
- **src/app/financials/_components/CapexDetailModal.tsx** — Approve / Reject / Request-changes never checks the decision result — a failed decision closes the modal as if it were recorded.
  - Impact: An owner approves a capital request, the dialog closes — if the call failed (offline, or another manager already decided it and the server refuses with 'not found'), the approval was never recorded and no one is told. The project silently stays pending or keeps the other person's decision.
- **src/app/financials/_components/CapexDetailModal.tsx** — Every binder action fails silently: Start work / Mark complete / % slider, add & delete line items, and attachment upload never surface errors; add-line even clears the inputs on failure.
  - Impact: Inside a project's binder, marking work complete, moving the % slider, adding a receipt line, deleting one, or attaching a photo can all fail (network drop, session expiry) with zero feedback — the numbers just don't change and typed line-item text is erased. The % slider also never saves when adjusted with the keyboard (only mouse-up/touch-end trigger a save).
- **src/app/financials/_components/CapexTab.tsx** — Opening a project binder when the detail fetch fails leaves the modal stuck on "Loading…" forever with no error or retry.
  - Impact: Click a project card while the connection is flaky and the binder shows an endless "Loading…" spinner — the only escape is closing the modal; nothing says it failed or offers a retry.
- **src/app/financials/_components/CheckbookTab.tsx** — Deleting an expense does nothing visible when the request fails — the card just stays after the user confirmed the delete.
  - Impact: A manager confirms "Delete this expense?", nothing happens, no error — the expense is still there and they don't know whether to click again or if the books are wrong.
- **src/app/financials/page.tsx** — When the summary fetch errors, the header confidently shows Expenses $0.00 plus the "Revenue auto-flows from the PMS…" cold-start note instead of an error, with no retry.
  - Impact: On a transient network/server error the owner sees $0 expenses and 'no PMS revenue yet' for the month — wrong numbers presented as truth. Only a full page reload or switching months recovers.
- **src/app/financials/_components/CheckbookTab.tsx** — New-expense date defaults to the UTC calendar day, so evening entries are dated tomorrow — and on the last day of the month they land in next month's books.
  - Impact: A Texas manager logging an expense after ~6-7pm gets tomorrow's date pre-filled; on July 31 evening the expense is dated Aug 1, so it vanishes from July's checkbook, month total, and budget actuals unless they notice and fix the date. The month header has the same flaw: monthKey() is UTC, so late on the month's last day the page opens showing next (empty) month as 'current'.
- **src/app/financials/_components/CapexDetailModal.tsx** — "View attachment" opens the file via window.open after an await, which Safari's popup blocker kills — and a failed fetch does nothing at all.
  - Impact: On an iPhone/iPad (or Safari on Mac), tapping "View attachment" frequently does nothing — the signed link is fetched but the popup is blocked because it isn't opened in the direct tap gesture. Any fetch error is also a silent no-op.
- **src/app/financials/_components/ScanButton.tsx** — Every scan failure — including rate limiting, the daily AI budget cap, and the vision service being down — shows "Could not read that image. Try a clearer photo."
  - Impact: When the hotel hits the hourly scan limit or the daily AI budget cap, the manager is told their photo was blurry and keeps retaking photos pointlessly; nothing tells them to wait or that the service is unavailable.
- **src/app/financials/_components/CapexProjection.tsx** — The Forecast and All-properties views render a load failure as empty data ("No upcoming capital spend scheduled." / all-zero totals) with no error or retry.
  - Impact: If the forecast or rollup request fails, the owner is told there's no upcoming capital spend — or sees $0 across all properties — instead of being told the load failed. They may make decisions off phantom-empty data.
- **src/app/financials/_components/BudgetTab.tsx** — Spend alerts and forecast messages are server-generated English-only strings, shown untranslated to Spanish users.
  - Impact: A Spanish-language GM sees alerts like "Housekeeping is trending 23% over budget (projected $4,100.00 vs $3,200.00)" and "Utilities spend is 40% over last month" in English inside an otherwise fully Spanish page. The invoice-scan outlier warning has the same problem.
- **src/app/financials/_components/fin-board.tsx** — Budget cards hardcode the English words "spent" and "of" in the spent-of-budget footer.
  - Impact: On the Spanish UI the budget cards read "$1,200 spent / of $2,000" — two English words in every card on the Budget tab.
- **src/app/financials/_components/CapexTab.tsx** — The "$X committed" toolbar figure (and the Estimated/Spent strip) sums ALL projects, including rejected and cancelled requests.
  - Impact: Reject a $50,000 roof quote and the CapEx toolbar still says $50,000 committed — the committed/estimated totals overstate real obligations by every rejected or cancelled request that was ever submitted.
- **src/app/financials/page.tsx** — The next-month stepper is only disabled via pointerEvents/opacity, so keyboard users can step into future months.
  - Impact: Tabbing to the "›" button and pressing Enter advances the page into future months (empty books) even though the button looks disabled — mildly confusing, and there's no cap on how far forward you can go.

### dashboard (7)

- **src/app/dashboard/page.tsx** — One failed 30s counts poll makes the live dashboard flap to the zero/neutral state: fetchTodayPropertyCounts returns all-zeros on RPC error instead of holding last-good, and the page overwrites good state with those zeros.
  - Impact: On a hotel with a live PMS, a single transient database/network hiccup makes the wall-TV dashboard flip from '82% occupancy' to a blank '—  learning from your PMS' ring, and the Departures tile drops to 0, for up to 30 seconds — then flips back. Managers see the numbers randomly blink out during any brief connectivity blip.
- **src/app/dashboard/page.tsx** — A failed compliance poll blanks the compliance/anomaly lines out of 'Needs attention' (the card can flip to green 'All clear') for up to 60s; a network-level failure is also an unhandled promise rejection.
  - Impact: A manager glancing at the dashboard during a transient API failure sees 'All clear — nothing needs you right now' in green even though compliance checks are overdue or anomalies are flagged. The truth reappears on the next 60-second poll.
- **src/app/dashboard/_components/MemoryRecapCard.tsx** — The 'Remove' button on 'What Staxis learned/noticed' fails silently: any non-ok response leaves the fact on screen with zero feedback, and a network error or non-JSON response throws an unhandled promise rejection.
  - Impact: An owner taps Remove on a wrong learned fact, the button flashes '…' and then the fact just stays there with no error message. If they're offline or the server errors, nothing tells them the removal didn't happen — they assume Staxis 'unlearned' it when it didn't.
- **src/app/dashboard/page.tsx** — 'Needs attention' strings have singular/plural and EN/ES parity defects: English shows '3 anomaly flagged'; Spanish shows '1 quejas atrasadas', '1 revisiones de cumplimiento vencidas', '1 llamadas de seguimiento hoy', '1 habitaciones por limpiar', 'ordenes' missing its accent (órdenes), and the '· Maintenance' hint exists only in English.
  - Impact: Spanish-speaking managers read grammatically wrong alerts whenever a count is exactly 1 (e.g. '1 quejas atrasadas'), English users read '3 anomaly flagged' when there are several anomalies, and Spanish users never get the 'Maintenance' pointer that English users get on the anomaly line.
- **src/app/dashboard/_components/WorklistCard.tsx** — Spanish overdue counter on the Open-items card is always plural: one overdue item renders '1 vencidas'.
  - Impact: A Spanish-speaking manager with exactly one overdue item sees the grammatically wrong '1 vencidas' (should be '1 vencida'); English handles the same case correctly ('1 overdue').
- **src/app/dashboard/_components/WorklistCard.tsx** — All five glass cards (Open items, Log book, Upcoming events, What Staxis learned, What Staxis knows) fetch exactly once per mount — no polling, no realtime — so their contents go permanently stale on a long-lived dashboard.
  - Impact: On the wall-TV / always-open dashboard usage the codebase explicitly designs for (see use-today-str.ts's midnight-rollover rationale), the 'Open items' count keeps showing work that was completed hours ago, new shift-log recaps and calendar events never appear, and an event that ended days ago stays listed as 'upcoming' — until someone reloads the page. The hero (ring/tiles/attention) all poll or subscribe; these cards don't.
- **src/lib/knowledge/core.ts** — listEvents returns the 500 OLDEST calendar events (ascending order + limit 500, no date filter), so once a hotel accumulates >500 events the dashboard's Upcoming-events card filters them all out and shows nothing, even when future events exist.
  - Impact: A long-running hotel that logs more than 500 calendar entries over the years silently loses the Upcoming-events card on the dashboard (and any other consumer that filters client-side): the API keeps serving the oldest 500 historical events, all of which fail the 'not finished yet' filter. Low likelihood near-term, but it's a fail-silent cliff with no error anywhere.

### inventory (6)

- **src/app/inventory/_components/overlays/AddItemSheet.tsx** — Saving ANY edit to an item (vendor, lead days, notes, name) silently rewrites current_stock from the form snapshot and stamps last_counted_at = now, faking a physical count and resetting the consumption-estimate window.
  - Impact: A manager fixing a typo on an item counted 10 days ago wipes out the occupancy-based drain estimate: estimated stock snaps back up to the stale stored value, 'last counted' shows just now, and a critical item can flip to Good without anyone counting. It also overwrites a concurrent count saved by a housekeeper while the edit sheet was open.
- **src/app/inventory/_components/overlays/ReorderPanel.tsx** — Race condition: the reorder cart (checked lines, edited quantities, success banner) resets to defaults whenever any realtime inventory change lands while the panel is open.
  - Impact: While a GM is ticking items and adjusting quantities, a housekeeper saving a count (or anyone editing an item) on another device triggers the inventory subscription refetch; the GM's checkboxes silently revert to the auto-pre-check set, their typed quantities reset to suggestions, and any 'orders placed' confirmation banner disappears mid-read.
- **src/app/inventory/_components/overlays/CountSheet.tsx** — One stray click outside the modal (or ESC) instantly discards an in-progress inventory count with no confirmation — all typed entries are lost.
  - Impact: A housekeeper 40 items into a walk-and-tally who taps the dimmed background or presses ESC loses every number typed; the sheet also clears entries on reopen (scope reset), so there is no recovery. On a shared phone mid-walk this is a full re-count.
- **src/app/inventory/_components/overlays/ReportsPanel.tsx** — Three footer controls in the Reports panel are dead: the month picker ('July ▾'), 'Compare ▾' and 'Export ↓' buttons have no onClick and do nothing when clicked.
  - Impact: A GM clicks Export to pull the spend report (or tries to switch month / compare) and nothing happens — no feedback, no download, no error. Looks broken and silently eats the action.
- **src/app/inventory/_components/overlays/CountSheet.tsx** — A partially-failed count save has no resume bookkeeping: retrying after the alert re-inserts the already-saved count rows and duplicates the auto 'stock-up' orders.
  - Impact: If the count batch (step 1) or stock-up orders (step 2) succeed but a later step fails (flaky connection on a phone), the user sees 'Saving the count failed. Please try again.' and retries — producing duplicate Physical-count events in History and duplicate stock-up order rows that inflate month spend and feed phantom consumption into the AI's learning windows.
- **src/app/inventory/_components/InventoryShell.tsx** — Timezone drift on the month boundary: 'this month' spend and budget caps are computed on the UTC month, so on the evening of the last day of a month (US timezones) the sidebar spend resets to $0 and the caps flip to next month hours early.
  - Impact: On July 31 at 7:30pm Central, the sidebar 'This month' strip and budget totals already show August ($0 spent), hiding the month's real spend during end-of-month review; a purchase received that evening is booked to August's MTD.

### maintenance (10)

- **src/app/maintenance/_components/_mt-snow.tsx** — Modal closes on any scrim click (including the browser-synthesized click when a drag starts inside the card and ends on the scrim), and SubmitModal/NewTaskModal wire onClose to a reset() — so a text-selection drag out of the description textarea, or one Escape press, instantly wipes the whole half-typed form.
  - Impact: A front-desk clerk typing up a work order who drag-selects text in the "What's wrong?" box and releases the mouse past the modal edge loses location, description, priority, photo and cost with no confirmation — the classic eaten-form bug.
- **src/app/maintenance/_components/WorkOrdersTab.tsx** — Board writes are fire-and-forget with zero user feedback on failure: re-prioritizing a work order (void updateWorkOrder), stepping storeroom stock (void updateInventoryItem), and the preventive card's "Done today" (void handleCompleteToday) all swallow rejections — the error goes to console/Sentry only.
  - Impact: On a flaky hotel-lobby connection a maintenance tech taps "Urgent", the modal closes, the card never moves, and nothing tells them why; a housekeeper steps a filter count down 3 and the modal proudly shows the new number (local draft state) even though the DB write failed, so the count is silently wrong after they close it.
- **src/app/maintenance/_components/WorkOrdersTab.tsx** — When the initial data fetch fails, every maintenance board renders its happy empty state instead of an error: "All caught up. Nothing open. Nice work." for work orders, "Storeroom is empty." for parts, "No preventive tasks yet." for PM — and the equipment registry shows "No equipment yet" on API errors or hangs on "Loading…" forever if the fetch throws.
  - Impact: A manager opening Maintenance during a network blip is told everything is done/empty — open urgent work orders are invisible and there is no retry or error indication. This is the same silent-empty-state class that bit the public pages, here for signed-in users.
- **src/app/maintenance/_components/WorkOrdersTab.tsx** — Photo upload failures are silently discarded: on submit the work order is created without the photo and no one is told; attaching a photo from the detail modal just no-ops back to the empty dropzone.
  - Impact: A housekeeper snaps a photo of the leak, submits, and the order arrives photoless with no warning — the fixer walks in blind. In the detail modal the "Uploading…" label disappears and the photo simply never appears, with no error.
- **src/app/maintenance/_components/WorkOrdersTab.tsx** — Moving a work order out of the Professional lane (one tap on a priority chip in the detail modal) permanently erases the contractor's trade, company, phone and called-at with no confirmation and no undo.
  - Impact: A GM who recorded "Acme Plumbing (409) 555-0142" and later fat-fingers the "Normal" chip in the detail modal loses the contractor's phone number instantly; tapping back to Professional does not restore it.
- **src/app/maintenance/_components/_mt-snow.tsx** — All date/time strings on the maintenance boards are hardcoded English (en-US months, "today", "ago", AM/PM), so the Spanish UI shows mixed-language lines; separately, the submitter's role is persisted pre-translated at submit time, so it displays in the submitter's language rather than the viewer's.
  - Impact: A Spanish-speaking housekeeper sees "Abierta · enviada May 11 · 1d ago" in the detail modal and English month names on every preventive card and history row; an English-speaking GM sees "Personal"/"Gerente general" as the submitter role if the submitter had the app in Spanish.
- **src/app/maintenance/_components/_mt-snow.tsx** — fmtSubmittedAt renders "0d ago" for anything submitted the previous calendar day but less than 24h ago (e.g. last night viewed this morning).
  - Impact: The night auditor's 11pm work order shows "May 11 · 0d ago" on the morning shift's board — nonsense wording where "yesterday"/"1d ago" is expected.
- **src/app/maintenance/_components/PreventiveTab.tsx** — Preventive next-due dates are computed by raw millisecond addition (lastCompletedAt + frequencyDays × 86400000), so backfilled last-done dates (stored at local midnight) that cross the November DST fall-back land at 23:00 the previous day — the due date displays and bands one day early; the same formula also makes cadence labels lie (a 45-day cadence card reads "every 2 mo", 84 days reads "every 3 mo").
  - Impact: A quarterly inspection backfilled to a summer date shows due (and turns "Overdue" red) one day before it actually is once the schedule spans the fall time change; cadence text on cards misstates the real interval, e.g. a 12-week task labeled "every 3 mo".
- **src/app/maintenance/_components/PreventiveTab.tsx** — Editing a preventive task whose lastCompletedAt is null (legacy/externally-created rows) and pressing "Save changes" silently stamps last-completed = today, because the empty date field defaults to new Date() — an overdue task quietly becomes freshly completed.
  - Impact: A manager who only wanted to fix the frequency of a never-completed fire-extinguisher check accidentally marks it as done today; it jumps out of Overdue and the real inspection gets skipped.
- **src/app/maintenance/_components/EquipmentTab.tsx** — The stock stepper fires one absolute-value UPDATE per tap with no serialization: rapid −/− /− taps issue parallel requests whose out-of-order completion can leave a stale intermediate count in the DB, and the once-seeded local draft clobbers any concurrent count change made on another device.
  - Impact: Two staff adjusting the same filter stock, or one person tapping fast on hotel Wi-Fi, can end with the storeroom count off by a few units without anyone noticing — the modal shows the tapped value while the DB kept an earlier one.

### front-desk (12)

- **src/app/api/front-desk/rush/route.ts** — Rush shows a success toast even when the rush was never saved. When the room has no housekeeping assignment row for today, the UPDATE-only write matches 0 rows — the route just logs a warning (lines 161-169) and still returns ok() (line 265), so the clerk sees 'Send rush' / 'Housekeeper notified' while nothing was persisted and no SMS went out.
  - Impact: A front-desk clerk rushes a room for an early-arriving guest, sees success, and walks away. The housekeeper never sees the rush and never gets the SMS. The clean is late and nobody knows the request was dropped.
- **src/lib/db/packages.ts** — A transient server error (HTTP 500 from the packages or lost-and-found list route) silently wipes the register to an empty list instead of keeping the last good data. fetchPackages returns `data ?? EMPTY` on any non-ok envelope (line 83), and the 30s poll pushes that EMPTY payload over the real list; the try/catch 'keep last good' guard only covers thrown network errors, not HTTP error responses.
  - Impact: During a brief database blip, the Packages tab flips to 'No packages held' (and Lost & Found to 'Nothing here yet') on a desk terminal. A clerk can conclude a parcel was already handed off or an item was never logged — the classic silent-empty-state failure the codebase explicitly guards against elsewhere.
- **src/app/front-desk/_components/LostFoundTab.tsx** — A matched guest lost report gets permanently stuck in the 'Active' view with no way to close it. Action buttons on a lost report only render while status === 'open' (line 337); matching flips both sides to 'matched', and when the desk later marks the FOUND item returned/shipped/disposed, nothing updates the lost report — it stays 'matched' forever, which the 'unresolved' filter (line 133) counts as active.
  - Impact: Every completed match leaves a zombie 'Matched' lost-report card in the Active list forever. Over months the register fills with unresolvable entries; the desk can't clear them (no buttons render) and the Active view stops being a useful worklist.
- **src/app/api/front-desk/rush/route.ts** — The rush endpoint's rate limit is a permanent no-op: it passes hashToRateLimitKey(`pid:userId`) — a pseudo-UUID — as the property_id, which violates the api_limits.property_id FK to properties(id). The RPC errors on every call and 'front-desk-rush' is not in BILLING_IMPACTING_ENDPOINTS, so it fails open every time (plus logs a Sentry-visible ratelimit error per rush).
  - Impact: No visible change for users, but the SMS-spend guard the limit exists for never engages — a mash-tapping clerk (or scripted client) can enqueue unlimited rush SMS jobs — and every legitimate rush press emits a '[ratelimit] rpc failed' error to logs/Sentry, creating alert noise.
- **src/app/api/front-desk/rush/route.ts** — Timezone drift in the cleaning_tasks mirror: the rush write targets business_date computed as UTC (`new Date().toISOString().slice(0,10)`, lines 174 and 193), but cleaning_tasks.business_date is written property-local by the rules engine (propertyLocalDate). From ~6-7 PM Central until midnight the two dates differ, so the priority='urgent' (and clear→'normal') mirror silently matches zero rows.
  - Impact: Evening rushes — a common case for late arrivals — never mark the housekeeper's cleaning task urgent in any cleaning_tasks-driven UI, and clearing an evening rush leaves a task stuck at 'urgent'. Daytime rushes work, so the bug looks intermittent and unreproducible.
- **src/app/front-desk/page.tsx** — The 'Clean' filter pill count doesn't match what clicking it shows: the count includes inspected rooms (stats.clean = status 'clean' OR 'inspected', line 208) but the filter matches r.status === 'clean' strictly (line 228), so inspected rooms are counted in the pill yet excluded from the grid.
  - Impact: Front desk clicks 'Clean (12)' and sees, say, 8 room cards — inspected rooms vanish. Looks like rooms are missing from the board; at a hotel where inspection is routine the discrepancy is constant.
- **src/app/front-desk/_components/RushButton.tsx** — Rush failure toasts are hardcoded English — "Couldn't set rush" (lines 61, 64) and "Couldn't clear rush" (lines 88, 91) bypass the translations layer entirely, while every success string on the same component goes through t().
  - Impact: A Spanish-language front-desk clerk who hits a rush failure (rate limit, room not found, network) gets an untranslated English error, violating the repo's bilingual-UI rule on an error path where clarity matters most.
- **src/app/front-desk/_components/LostFoundTab.tsx** — AI match-confidence labels are untranslated in Spanish: line 379 renders `tr(lang, m.aiConfidence + ' confidence', m.aiConfidence)` — the Spanish branch is just the raw English word ('high'/'medium'/'low') with no translation, and the English branch produces lowercase 'high confidence'.
  - Impact: Spanish-language staff running '✨ Buscar coincidencias' see bare English words 'high' / 'medium' / 'low' next to each suggested match — the one signal that tells them how much to trust the AI suggestion is unreadable.
- **src/app/front-desk/page.tsx** — The room-detail bottom sheet renders from a stale snapshot: selectedRoom is captured once on tap (line 552) and never reconciled with the 6s rooms poll, so status, type, DND, and the RushButton's isAlreadyRush prop (line 846) reflect the state at open time, not current state.
  - Impact: A clerk sets a rush from the sheet — the button keeps saying 'Rush' instead of 'Clear rush' (the clear option never appears until they close and reopen), and a room that a housekeeper just finished still shows 'Dirty' in the open sheet. Encourages double actions and mistrust of the board.
- **src/app/front-desk/_components/ComplaintsTab.tsx** — "Today's callbacks" and overdue badges only recompute when complaint data changes: callbacksDue/counts are useMemo'd on [complaints] (lines 101-106, 130-137) and `now` is a render-time clock (line 100), with no timer or visibility tick. On an idle desk terminal a callback whose time arrives (or a complaint crossing its overdue SLA) won't surface until some unrelated data change or tab switch triggers a rerender.
  - Impact: The satisfaction-callback reminder — the whole point of scheduling — can appear hours late on the always-open front-desk screen if no other complaint activity happens, so promised guest callbacks get missed.
- **src/app/front-desk/_components/LostFoundTab.tsx** — In the log modal, a photo picked while on 'Found item' silently survives switching to 'Guest lost report': the photo picker UI disappears (only rendered when type==='found', line 506) but photo.prepared.current persists and is uploaded and attached to the lost report on save (lines 460-462), along with any AI-generated description.
  - Impact: A clerk who starts logging a found item, then flips the toggle to log a guest's lost report instead, unknowingly attaches the unrelated found-item photo to the guest's report — wrong evidence on the record with no visual indication it's there.
- **src/app/front-desk/_components/ComplaintsTab.tsx** — Spanish error toast for 'callback done' drops the error entirely: line 282 shows `Error: ${r.error}` in English but the Spanish branch is just the bare word 'Error' with no detail, inconsistent with every other error path in the file which shows the reason in both languages.
  - Impact: A Spanish-speaking clerk whose 'Hecho' (callback done) tap fails gets an unexplained 'Error' with no hint whether to retry, versus English users who see the reason.

Total: 65 verified bugs.
