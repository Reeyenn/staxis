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

