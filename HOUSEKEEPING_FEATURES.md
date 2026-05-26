# Housekeeping Product — Complete Feature Specification

Synthesized from deep competitor research on Optii, Flexkeeping, and Hotel Effectiveness (with Alice + Quore + Oracle + Mews + Cloudbeds + Stayntouch as supporting sources). Every feature any of these competitors has is captured here. Plus gaps we should win on.

**Tags:**
- `[O]` = unique to Optii
- `[F]` = unique to Flexkeeping
- `[HE]` = unique to Hotel Effectiveness / broader build guide
- `[gap]` = none of them do this well — opportunity to win
- *No tag* = appears in 2+ competitors (table stakes)

**Already built ✅:**
- 2-way PMS read/write via live CUA (replaces marketplace integrations)
- 15 PMS data tables populated live (`pms_reservations`, `pms_rooms_inventory`, `pms_room_status_log`, `pms_housekeeping_assignments`, `pms_work_orders_v2`, `pms_in_house_snapshot`, plus 9 empty tables for Phase 2)

---

## Table of Contents

1. Master Data & Configuration
2. Cleaning Rules Engine
3. Cleaning Types & Service Catalog
4. Workload Estimation (Credits & Duration)
5. Task Lifecycle, States & Exceptions
6. Assignment, Routing & Reassignment
7. Forecasting (Today, Week, Month)
8. Mobile App — Room Attendant
9. Mobile App — Inspector
10. Mobile/Web App — Manager / Supervisor
11. Inspection, QA & Correction Loop
12. Live Tracking & Communication
13. Voice / Photo / Multi-Language UX
14. Timing Capture & Measurement
15. Manager Web Console
16. Real-Time Events & Notifications
17. Labor Planning & Staffing
18. Schedules, Shifts & Quotas
19. Roles, Permissions & SSO
20. Reporting & Analytics
21. Activity Log & Audit Trail
22. Reports & Exports
23. Auxiliary Workflows (Linen, L&F, Turndown, BOH)
24. Door Lock / Key Management
25. Hardware & Offline Mode
26. Training & Rollout
27. Guest-Facing Housekeeping Touchpoints
28. Front Desk Coordination
29. Maintenance Handoffs
30. Inventory & Supplies
31. Sustainability / ESG
32. Health & Safety
33. Compliance
34. Integrations Beyond PMS
35. AI / ML Features (competitive edge)
36. Multi-Property / Portfolio Features
37. Reporting Beyond Housekeeping

---

## 1. Master Data & Configuration

### Property hierarchy
- Properties (multi-property support, brand affiliation)
- Buildings / towers / wings
- Floors (with elevator banks, stairwells)
- Zones / sections (manager-defined groupings)
- Cart anchors / linen closets (physical staging locations)
- Public areas (lobby, gym, pool, business center, breakfast)
- BOH areas (laundry, kitchen, offices)

### Room master data
- Room number (string, supports alphanumeric)
- Room type (PMS-coded + readable name)
- Bed configuration
- Max occupancy
- View type
- Floor
- Connecting room
- Adjoining room
- Pet-friendly flag
- Smoking allowed flag
- Accessible (ADA) flag
- Is suite
- Square footage
- Last renovated date
- Amenity list (jsonb)

### Room type configuration
- Display name
- PMS code mapping (so a CA "SNQQ" maps to "Standard Non-Smoking Queen Queen")
- Category (standard / premium / suite)
- Default cleaning duration per cleaning type
- Default credit value per cleaning type
- Required checklist template
- Required supplies (linens, amenities)
- Brand standard reference

### Reservations (from PMS)
- All `pms_reservations` fields
- Reservation rooms (handles moves, splits)
- Service preferences per reservation (DND, MUR, turndown, linen policy)
- Special requests
- VIP / group flags

### Cleaning rules (see Section 2 for full detail)

### Notification rules
- Criteria → recipient → channel → delay
- Per-event subscriptions
- Quiet hours per role

---

## 2. Cleaning Rules Engine (the brain)

### Rule structure
- IF [conditions] THEN [cleaning type + priority + due time + assignee filter]
- AND / OR / NOT conditional combinations
- Priority ordering when multiple rules match
- Rule active dates (effective range)
- Rule expiry / sunset
- Time-of-day rules

### Rule input variables (everything available)
- Length of stay (nights)
- Room rate
- Number of guests (adults / children / infants)
- Status (occupied / vacant / arriving / departing / blocked)
- Occupancy % (property-wide)
- Guest preferences (eco-stay, no daily clean, etc.)
- Departure status (in-progress, completed)
- Day of week
- Day of stay (1st night, 3rd night, last night)
- VIP flag
- Group block ID
- Rate code / package name
- Late checkout flag
- Early check-in flag
- Connecting room status
- Adjoining room status
- Previous-day cleaning type
- Inspection result history
- Maintenance hold
- Loyalty tier
- Corporate account
- Channel (OTA vs direct)

### Rule output actions
- Create cleaning task (specific type)
- Skip cleaning (no clean)
- Defer cleaning (move to next day)
- Add inspection requirement
- Trigger amenity setup (welcome gift, baby cot, etc.)
- Override estimated duration
- Set priority
- Set due-by time
- Restrict assignee (specific skill, role)
- Notify role (e.g., manager on VIP)

### Rule preview / simulation
- "If I add this rule, X rooms tomorrow will be affected"
- Show 7-day impact

### Rule templates (out-of-box)
- "Standard franchise hotel" template
- "Boutique" template
- "Long-stay / corporate" template
- "Resort" template
- Custom

### Rule audit
- Who created / modified
- When
- Previous version diff
- Activation history

---

## 3. Cleaning Types & Service Catalog

### Standard cleaning types
- No clean
- Room check (visual, ~5 min)
- Light clean / refresh (~15 min)
- Stayover clean (~18 min standard, ~30 min suite)
- Full clean (~45 min)
- Departure clean (~35 min standard, ~55 min suite)
- Departure deep clean
- Departure full clean
- Deep clean / weekly / monthly
- Touch-up (~10 min)
- Turndown (evening)
- Inspection only (~5 min)
- Correction (post-fail re-clean)
- Check (post-PMS-conflict) `[O]`
- Linen strip (pre-clean decomposition) `[O]`

### Per-cleaning-type configuration
- Display name
- Color code (for UI badges + timeline cards)
- Symbol / icon (for non-readers) `[F]`
- Default duration
- Default credit value
- Required checklist template
- Required supplies
- Inspection required (yes / no / random sample)
- Photo proof required `[F]`
- Voice/video allowed
- Eligible role (RA / inspector / houseman)
- Can be guest-requested

### Custom cleaning types
- Hotel-defined types (e.g., "Pet pre-clean," "ADA setup")
- Color picker for custom badge
- Symbol picker

### Cleaning type → checklist binding
- Checklist templates (versioned)
- Bathroom items
- Bedroom items
- Living area items
- Kitchen / kitchenette items (for extended-stay)
- Welcome / amenity items
- Per-brand-standard variants

---

## 4. Workload Estimation (Credits & Duration)

### Credits vs minutes — both supported
- Credits = abstract workload unit (used for fairness balancing)
- Minutes = concrete time estimate (used for scheduling)
- Hotels can map: 1 credit = 15 min, or use both independently

### 3-layer duration estimator

**Layer 1 — Manual baseline**
- Set per room_type × cleaning_type
- Example seed values:
  - Standard King stayover: 18 min
  - Standard King departure: 35 min
  - Suite stayover: 30 min
  - Suite departure: 55 min
  - Apartment departure: 70 min
  - Deep clean: 90 min
  - Room check: 12 min

**Layer 2 — Rule modifiers**
- +8 min if 3+ guests
- +10 min if pet stay
- +5 min if extra bed / baby cot
- +15 min if long stay departure (>7 nights)
- +20 min if kitchen / kitchenette
- +10 min if late checkout compresses schedule
- -5 min if eco-stay / no linen change
- +X min per special request
- +Y min if F&B / minibar burden detected
- +Z min for travel (floor changes, distance from cart)

**Layer 3 — Data calibration** (after 30–60 days of actuals)
- Median actual time per room_type × cleaning_type
- Excludes outliers:
  - DND events
  - Maintenance hold during clean
  - Trainee cleaning (first 30 days for new RA)
  - Re-clean events
  - Guest interruption events
  - Supply delay events
- Confidence interval per estimate
- Per-housekeeper modifier (slow/fast — used transparently for coaching, NOT punitively)
- Time-of-day modifier (start of shift vs end-of-shift fatigue)

### Inspection time included in estimate
- Separate inspection-minutes line item

### Travel time penalty
- Floor change penalty
- Elevator wait estimate
- Cart anchor distance

### Estimate transparency
- Show breakdown: "35 min base + 8 min (3 guests) + 10 min (pet) = 53 min"
- Build staff trust through explainability

---

## 5. Task Lifecycle, States & Exceptions

### States (full state machine)
- `created` → `assigned` → `started` → `paused` (loop) → `resumed` → `completed` → `inspection_pending` → `inspected_pass` OR `inspected_fail` → `correction_assigned` → `correction_started` → `correction_completed` → `check_pending` → `check_passed`

### Auto-task creation triggers
- PMS check-out event → create departure clean
- PMS check-in event → create arrival prep (if needed)
- Stayover cadence rule fires → create stayover/light/deep
- PMS Vacant Pickup (VP) status → create Check task `[O]`
- Manual Check task → push PMS to VP `[O]`
- Back-to-back same-reservation-ID guest → swap planned departure for stayover `[O]`
- Back-to-back same-name different-reservation-ID → swap (optional, support-enabled) `[O]`
- Early departure detected → cancel stayover, create departure `[O]`
- Room move detected → adjust/cancel tasks for both rooms `[O]`
- OOO/OOS status → exclude room from routing, no clean
- Late checkout → push due-time, possibly create stayover instead

### Exception states (work preserved, deferred — not cancelled)
- DND (Do Not Disturb) — visible, deferred to end of attendant's queue
- NSR (No Service Required) `[O]`
- DLA (Double Lock Active) `[O]`
- Sleep Out `[O]`
- No Show `[O]`
- Guest in room — come back at specific time (e.g., 2pm) `[gap]`
- Maintenance hold
- Lost key / guest can't access
- Disruptive guest (security flag)

### Priority modifiers
- Rush flag (front desk needs 305 now) → push to top of attendant's mobile list
- VIP arrival → boost to higher inspection rigor
- Group arrival → batch by section
- Early ETA → push to front of queue

### Decomposition / specialization
- Job add-ons (towel every 3rd day, linen every 5th day) `[O]`
- Linen strip — pre-clean houseman task `[O]`
- Pair assignments (two RAs for suites)
- Trainee shadow assignments

### State transition rules
- Notification triggers per transition (configurable per role)
- Time limits per state ("if not started within 30 min, alert supervisor")
- Idle detection ("started but no progress for 60 min, check on RA")
- Auto-recovery flows (orphaned tasks reassigned)

---

## 6. Assignment, Routing & Reassignment

### Auto-assign modes
- Faster Turnaround `[O]` (minimize time-to-ready)
- Highest Efficiency `[O]` (minimize travel)
- Equal work distribution (by minutes / credits)
- Zone-based (sections)
- Cart-based (closest cart anchor)
- Checkout batching (all departures first)
- Credit-balanced (no one over quota)
- Priority-queue (urgent rooms first)
- Hybrid weighted scoring

### Optimizer scoring inputs
- Urgency (arrival ETA, rush flag)
- VIP weight
- Floor match (penalize floor change)
- Section match
- Travel cost (cart-to-room)
- Workload imbalance penalty
- Skill match
- Language match (for guest interactions)
- Trainee assignment penalty (don't give VIP to trainee)
- Overtime penalty

### Manual control
- Drag-and-drop rebalance on timeline view
- Reassignment from room detail with workload preview `[F]` — see other RAs' current load before moving
- Bulk reassign
- "Suggested next move" tooltip ("Maria has capacity")
- Manual override audit (who/when/why)

### Real-time rebalance triggers
- Sick callout → re-spread load `[gap]`
- Schedule change mid-day
- Rush room added
- Maintenance block / unblock
- DND lifted / set
- VIP late ETA push

### Routing within an attendant's queue
- Next-best-room recommendation with reason text `[HE]` — "1207 next: same floor, departure with 1pm ETA"
- Floor-aware ordering
- Section-aware ordering
- Priority-aware ordering
- Manual reorder

### Constraints
- Staff skill level
- Training / certification status
- Language match for guest interactions
- Default floor / section assignment
- Shift hours
- Break schedule
- Daily credit quota / minute quota
- Max walking distance per shift (ergonomic)

---

## 7. Forecasting (Today, Week, Month)

### Forecast horizons
- Today (live, recalculating every event)
- Tomorrow
- 7-day projection
- 14-day projection `[F]`
- 30-day projection

### Forecast metrics
- Total credits / minutes needed per day
- Departure count
- Stayover count
- Recurring deep-clean count
- Per-staff assigned minutes
- Ready-room curve by hour
- Arrival readiness board (% rooms released on time)
- Demand vs supply gap

### Forecast accuracy
- Tracks predicted vs actual workload
- Refines model weekly

### Staffing recommendations from forecast
- "Tomorrow needs 4.2 RA-shifts. Schedule 4? 5?"
- Cost trade-off shown ("scheduling 5 vs 4 = +$X labor, -2hr risk of late rooms")
- Multi-day staffing plan

---

## 8. Mobile App — Room Attendant

### Auth
- Login (email/password)
- SSO `[O]`
- PIN-only login for shared devices
- Biometric (Face ID, fingerprint)
- Remember-me

### Home screen
- My Jobs (today's assignments)
- Status overview (assigned / in-progress / completed counts)
- My Added Jobs (issues / maintenance reports I created)
- Active timer banner (if cleaning in progress)
- Next-room suggestion with reason

### Job card details
- Room number (huge font)
- Floor / section
- Cleaning type (color-coded badge)
- Reservation summary (guest name, ETA, nights, VIP flag)
- Credits / minutes / due-by time
- Notes (manager-entered + reservation special requests)
- Checklist
- Photos (manager-uploaded reference photos)
- Linked guest preferences
- Linked prior maintenance issues for this room

### Actions on job card
- Start cleaning (records started_at)
- Pause / resume (records pause events)
- Complete cleaning (records completed_at)
- Mark for inspection
- Add note
- Add photo
- Add issue (maintenance, lost item, supplies)
- Trigger exception (DND, NSR, DLA, Sleep Out, Guest in Room, Skipped)
- Rush flag (request priority bump)
- Request supervisor

### Issue reporting
- Action (replace / repair / clean / report)
- Item (lightbulb, sink, mirror, etc.)
- Location detail (near hand basin)
- Note (free text)
- Photo (required for some categories)
- Video `[F]`
- AI voice assistant input `[F]`
- Severity (minor / major / urgent)
- Assigns automatically to maintenance or houseman

### Room search
- Search by number
- Search by floor
- Filter by status

### Personal stats
- Today's progress (X of Y completed)
- This week's hours / minutes worked
- Average minutes per departure
- Inspection pass rate
- "Personal best" highlights

### Settings
- Language selection
- Notification preferences
- Profile (name, photo)
- Help / FAQ
- Logout

### UX principles
- Color-coded everything `[F]`
- Symbol-heavy UI (universal icons) `[F]`
- Multilingual / auto-translation `[F]`
- Large tap targets (works with gloves)
- Offline mode (queue actions, sync when online)
- QR code scan to open room card `[gap]`

---

## 9. Mobile App — Inspector

### Inspection queue
- All rooms ready for inspection
- Filter by floor / section / RA
- Sort by completion time / priority

### Inspection screen
- Room context (number, type, RA, completed time)
- Checklist (by area: bathroom, bedroom, living, kitchen)
- Item severity selector (pass / minor / major / fail)
- Photo / video proof per item `[F]`
- Voice note per item `[F]`
- Overall score (auto-calculated)
- Pass / Fail decision
- Re-clean assignment (which RA, optional)
- Note to RA
- Notes to manager

### After completion
- If pass → mark inspected, push to PMS
- If fail → auto-create Correction job, assign back to RA `[O]`
- Correction complete → auto-create Check task `[O]`

### Inspector tools
- Calibration mode (compare inspector consistency)
- Inspection sampling rules (random N%, all VIPs, all post-maintenance)
- Inspector training mode
- Inspector dashboard (my inspections today, fail rate, common issues found)
- Fast inspect mode (GM as inspector, optimized for speed) `[gap]`

### Timestamps
- Every checklist edit logged (who/when) `[F]`

---

## 10. Mobile/Web App — Manager / Supervisor

### Floor view
- Live room status board
- Who's cleaning what (with photo)
- Ahead/behind schedule per attendant
- Drag rooms between RAs

### Room actions
- Reassign room
- Reorder attendant's queue
- Mark room as rush
- Add note
- View full room history (cleaning log, maintenance, guests)
- Override status
- Mark OOO/OOS

### Reassignment with workload preview `[F]`
- Shows each RA's current load (minutes / credits)
- Shows projected new load if you move room X to RA Y
- Highlights overload risk

### Live location view `[F]`
- Pin per room when RA enters
- Green dot when actively cleaning
- Heatmap of staff activity

### Phone-friendly manager view `[gap]`
- Single-screen mobile dashboard
- One-tap reassign / rush
- Optimized for GMs walking the floor

### Communication
- Message individual staff
- Group broadcast
- Front desk → housekeeping ping ("need 305 in 30 min")

---

## 11. Inspection, QA & Correction Loop

### Inspection cadence (configurable)
- Every room
- Every Nth room (sampling)
- Every VIP arrival
- Every post-maintenance room
- Every new-RA's room (training)
- Random sampling

### Checklist construction
- Master checklist library
- Per-brand-standard variants
- Per-room-type variants
- Item categories (bathroom, bedroom, living, kitchen, welcome)
- Item severity rules (minor / major / critical)
- Custom items per property

### Scoring
- Pass / fail per item
- Weighted scoring (critical items count more)
- Overall percentage
- Auto-fail thresholds (any critical item fails the room)

### Pass flow
- Mark room inspected
- Push status to PMS (inspected / ready)
- Notify front desk

### Fail flow
- Auto-create Correction task `[O]`
- Assign to original RA (configurable: same RA, different RA, or houseman)
- After correction → auto-create Check task `[O]`
- Track fail reason categories

### Inspection metrics
- Pass rate per RA
- Pass rate per cleaning type
- Most common failure items (training opportunities)
- Re-clean rate
- Inspector consistency (calibration)

### Photo proof requirement `[F]`
- Per-item or overall
- Can require for specific cleaning types only

---

## 12. Live Tracking & Communication

### Room status board (real-time)
- All rooms on one screen
- Color-coded by status
- Filter by floor, section, type, RA
- Click for detail

### Live staff location `[F]`
- Pin on map of property
- Green dot when actively cleaning
- Last-seen timestamp
- Privacy controls (opt-in / opt-out, off-shift hidden)

### Messaging
- 1:1 manager ↔ attendant
- Group chats (per section, per shift)
- Broadcast (all on shift now)
- Auto-translate (Spanish ↔ English)
- Voice messages
- Photo / video attachments
- Read receipts
- Notification preferences

### Cross-department
- Front desk ↔ housekeeping ("305 ready?")
- Maintenance ↔ housekeeping (issue handoff)
- F&B ↔ housekeeping (in-room dining cleanup)

---

## 13. Voice / Photo / Multi-Language UX

### Voice
- AI voice assistant for issue reporting `[F]`
- Voice commands: "Start clean," "Complete clean," "Request supplies," "Report issue"
- Voice notes attached to rooms
- Languages: EN, ES (minimum); also FR, ZH, TL, HT for common housekeeper languages
- Voice-to-text for messaging

### Photo / video
- Photo capture on issues (mandatory or optional per category)
- Video capture for complex issues `[F]`
- Photo annotation (draw arrows, circles)
- Auto-redact faces (privacy)
- Compression / upload retry on poor signal

### Multi-language UI
- Full UI translation (not just labels — also error messages, notifications)
- Auto-detect device language
- Per-user language override
- Per-message auto-translation (Spanish manager messages → English RA reads in English)

### Color / symbol UI
- Color-coded room status (universal across web + mobile)
- Color-coded cleaning types
- Color-coded urgency (red = rush)
- Symbol library for room states / actions
- Designed for varying literacy levels `[F]`

---

## 14. Timing Capture & Measurement

### Event timestamps
- Task created
- Task assigned
- Task started (started_at)
- Each pause (paused_at)
- Each resume (resumed_at)
- Task completed (completed_at)
- Inspection started
- Inspection completed
- Correction started
- Correction completed
- Check started
- Check completed
- Status synced to PMS

### Derived metrics
- Raw elapsed time (start → complete)
- Active cleaning time (minus pauses)
- Pause duration total
- Pause count
- Travel time per job (gap between completion of N and start of N+1) `[O]`
- Variance vs scheduled
- Cost per job (labor rate × active time) `[O]`

### Integration with payroll
- Clock-in / clock-out via app
- Lunch break tracking
- Active vs idle distinction
- Daily hours summary for RA (personal view)
- Pay period summary
- Overtime alerts

---

## 15. Manager Web Console

### Views
- Housekeeping List (bulk control surface)
- Timeline View (visual time-based, job cards = duration) `[O]`
- Workday view (single-day focused)
- Work Schedule view (7–14 day forward) `[F]`
- Supervisor view (inspections + credits)
- Calendar view (week / month)
- Floor map view (visual)

### Home dashboard widgets
- Rushed rooms count
- Unassigned jobs count
- Due-outs count
- Arrivals count
- Total rooms to complete
- Active room attendants count
- Active supervisors count
- Room-status counts (clean / dirty / inspected / OOO)
- Inspection pass/fail rate (today)
- Today's labor cost (live)
- Forecast vs actual variance

### Customizable layout
- Drag/drop widgets
- Saved views per user
- Per-role default layouts

### Drill-downs
- Click rushed rooms → list with rush reasons
- Click unassigned → assign flow
- Click attendant → their queue + stats
- Click room → full history

### Real-time updates
- WebSocket-driven (no refresh)
- Animated state transitions (room goes green when inspected)

### Filters & search
- By floor, section, status, attendant, type
- Free-text search
- Saved filters

### Actions on rooms
- Reassign
- Rush
- Mark OOO
- Add note
- View history
- Push to PMS (force sync)

---

## 16. Real-Time Events & Notifications

### Event types (full list)
- `reservation.created`, `reservation.updated`, `reservation.cancelled`
- `room.checked_in`, `room.checked_out`, `room.assigned`, `room.moved`
- `room.status.changed` (all status transitions)
- `task.created`, `task.assigned`, `task.started`, `task.paused`, `task.resumed`, `task.completed`
- `inspection.started`, `inspection.passed`, `inspection.failed`
- `correction.created`, `correction.completed`
- `check.created`, `check.completed`
- `task.reopened`, `task.reassigned`
- `maintenance.blocked`, `maintenance.unblocked`
- `dnd.reported`, `dnd.cleared`
- `nsr.reported`, `dla.reported`, `sleep_out.reported`
- `rush.flagged`
- `staff.clocked_in`, `staff.clocked_out`
- `staff.break_started`, `staff.break_ended`
- `issue.created`, `issue.resolved`
- `lost_found.created`, `lost_found.claimed`
- `status.synced_to_pms`

### Delivery channels
- In-app push notification
- Browser push notification
- SMS (Twilio)
- Email
- Voice call (escalations)
- Slack / Teams webhook
- Custom webhook

### Notification rules
- Criteria (event + filter)
- Recipient (role / individual)
- Channel
- Delay (e.g., "if not acknowledged in 5 min, escalate")
- Quiet hours
- Frequency limits (don't spam)

### Subscription management
- Per-user preferences
- Per-role defaults
- Mute / unmute by room or RA

---

## 17. Labor Planning & Staffing `[HE strongest]`

### Forecasting
- Tomorrow's optimal headcount based on occupancy
- Hourly staffing recommendations (peaks at 10am-2pm)
- Multi-day labor plan
- Seasonal adjustment

### Cost tracking
- Cost-per-labor-hour per role
- Total labor cost today (live)
- Budget vs actual labor cost
- Daily / weekly / monthly variance
- Cost per occupied room
- Cost per cleaned room

### Productivity
- Productivity score per employee (cleans/hour vs benchmark)
- Trend over time (improving / declining)
- Peer comparison (anonymized)
- Training opportunity flagging

### Multi-property labor planning
- Cross-property workload visibility
- Shared float pool
- Centralized scheduling

### Overtime
- Live OT tracking per employee
- OT alerts (approaching threshold)
- OT budget per week
- OT-free reassignment suggestions

### Coverage flows
- Sick-callout recovery (re-spread load) `[gap]`
- No-show alerts
- Shift swap requests
- Call-in volunteers ("we need 1 more, who's available?")

### Cross-training
- Skill matrix per employee
- Training certifications
- Career progression (RA → Inspector → Supervisor → Manager)

---

## 18. Schedules, Shifts & Quotas

### Schedule construction
- Weekly schedule per property
- Per-day shifts (start / end times)
- Multiple shifts per day (AM, PM, turndown, overnight)
- Section assignments per shift
- Breaks (lunch, short breaks)
- Days off
- Vacation / PTO

### Schedule templates
- Recurring weekly patterns
- Holiday adjustments
- Seasonal variants

### Schedule changes
- Auto-adjust for PMS occupancy changes `[F]`
- Manager-initiated changes
- Employee-requested swaps (with manager approval)
- Vacation request flow

### Quotas
- Daily credit quota per RA
- Daily minute quota per RA
- Weekly hour cap (OT prevention)
- Quota fairness reports

### Publishing
- Draft → Published
- Notification to staff on publish
- Lock period (no changes within X days of shift)

---

## 19. Roles, Permissions & SSO

### Role types
- Room Attendant
- Houseman / Public Area Attendant
- Inspector
- Supervisor
- Housekeeping Manager
- General Manager
- Front Desk (read-only on HK status)
- Maintenance (sees only their work orders)
- Owner / Multi-property admin
- Float / support
- Trainee (limited permissions)

### Permission matrix
- View own tasks
- View all tasks
- Assign tasks
- Reassign tasks
- Mark inspected
- Override room status
- Manage staff
- View labor costs
- Configure rules
- Configure pricing / wages
- Multi-property access

### Custom roles
- Property-level role creation
- Inherit-from-base + override

### Authentication
- Email / password
- SSO (SAML) `[O]`
- SSO (Google / Microsoft OIDC)
- Magic link
- PIN-only for shared devices
- 2FA / MFA optional

### User lifecycle
- Activate / deactivate
- Reactivate
- Reset password
- Audit trail

### Scope
- Property-level
- Section / floor-level
- Department-level

---

## 20. Reporting & Analytics

### Operational KPIs
- Today's room readiness
- Rooms by status
- Arrival rooms not inspected
- Avg cleaning time by room type
- Avg cleaning time by cleaning type
- Expected vs actual variance
- Housekeeper workload distribution
- Rooms cleaned per person
- Inspection failure reasons
- Inspection fail rate
- Re-clean rate
- DND / skipped room count
- Maintenance issues found during cleaning
- Clean-to-inspected lag time
- Ready-room curve by hour
- % early-arrival rooms released on time
- Overtime minutes
- Unassigned-room backlog
- OOO/OOS aging
- Travel time heatmap by floor/section `[O]`
- Cost per job `[O]`
- Cost per occupied room
- Labor cost as % of revenue

### Trend & comparison
- Period-over-period (week / month / year)
- Forecast vs actual
- Benchmark vs industry average
- Multi-property comparison

### Insights (AI-generated) `[gap]`
- "Inspection failures jumped 12% this week — top reason: bathroom mirror polish"
- "Maria's avg minutes-per-departure dropped 8% — improvement"
- "Friday afternoons consistently understaffed by ~2 hours"
- Anomaly detection

### Custom reports
- Drag-and-drop report builder
- Saved reports
- Scheduled email delivery
- Public link sharing (read-only)

---

## 21. Activity Log & Audit Trail `[O strongest]`

### Logged actions
- Date, time, location
- Job source (manual / automated / PMS)
- Event type
- Event description
- Username of actor
- Device / IP (optional)
- Related entities (room, reservation, task)

### Use cases
- Dispute resolution ("what happened with room 305 yesterday?")
- Incident investigation
- Accountability / coaching
- Compliance audits
- Insurance claims

### Exports
- CSV
- Excel
- PDF
- Direct query (for legal / compliance)

### Retention
- 7 years (or per regulatory requirement)
- Cold storage after 1 year

---

## 22. Reports & Exports

### Standard reports
- **Daily Hotel Report** (auto-sent to GM at EOD) `[F]`
  - Staffing / productivity
  - Rooms per housekeeper
  - Cleaning times
  - Departure / general vs stayover / daily cleans
  - Current-day forecast
  - Tomorrow's outlook
- **Weekly Report**
- **Monthly Report**
- **History / Cleaning Report** (full job log)
- **Activity Log Report**
- **Labor Cost Report**
- **Inventory / Supply Report**
- **Inspection Quality Report**
- **Lost & Found Report**
- **Maintenance Issues Report**

### Delivery
- Scheduled email
- SMS link
- In-app
- Slack / Teams
- Stored in repository (downloadable)

### Formats
- CSV
- Excel
- PDF
- JSON (for integrations)

---

## 23. Auxiliary Workflows

### Linen Management
- Par levels per room type
- Linen strip pre-clean task `[O]`
- Towel / sheet inventory
- RFID tracking (optional) `[HE]`
- Wash cycle tracking
- Loss tracking (linen disappears)
- Auto-reorder triggers
- Vendor ordering integration

### Lost & Found
- Item description
- Location found (room, public area)
- Found by (staff member)
- Found at (timestamp)
- Photo
- Storage location (locker, bag, vault)
- Claimed by guest (with verification)
- Claimed at
- Shipping info (carrier, tracking, paid by)
- Status: open / claimed / disposed / shipped / expired
- Chain of custody log
- Auto-dispose / shipping after N days

### Turndown Service
- Triggered by reservation type / VIP / package
- Evening shift assignment
- Separate checklist
- Amenity placement (chocolates, robe, slippers)
- Per-room preferences

### Public Area Cleaning
- Lobby, gym, pool, business center, breakfast area
- Schedule-based (hourly lobby check, etc.)
- Per-area checklists
- Tied to event schedule (post-event extra cleaning)

### BOH (Back-of-House)
- Laundry room
- Kitchen
- Offices
- Storage areas

### Deep Clean Recurring
- Weekly / monthly / quarterly schedules
- Per-room rotation
- Assigned to specialized team
- Photo proof required `[F]`

### Job Add-ons `[O]`
- Towel every 3rd day
- Linen every 5th day
- Welcome gift on Day 1 of long stay
- Cadence based on check-in date

### Minibar Postings
- Charge tracking
- Restock alerts
- Per-room consumption history

### Welcome / Amenity Setup
- Welcome gift placement
- Branded welcome cards
- VIP-specific amenities (champagne, fruit basket)
- Baby cot / extra bed setup

---

## 24. Door Lock / Key Management `[HE]`

### Lock systems supported
- ASSA ABLOY (VingCard)
- dormakaba (Saflok)
- SALTO
- ASSA ABLOY Mobile
- Apple Wallet / Google Wallet keys

### Key lifecycle
- Issue keycard at check-in
- Mobile key activation
- Access code generation (suite codes)
- Maintenance master keys (audited)
- Key invalidation on room reassignment
- Key invalidation on check-out
- Key request webhook (from PMS or housekeeping)

### Audit
- Every issue / invalidate / use logged
- Per-room key history
- Compliance reporting

### Housekeeping-specific
- RA master keys (per-shift)
- Public area access
- BOH access
- After-hours access controls

---

## 25. Hardware & Offline Mode

### Hardware recommendations
- **Low end**: shared smartphone + charger + label printer
- **Mid range**: tablet on cart + Bluetooth printer + rugged case
- **High end**: persistent tablet per RA + RFID scanner + headset for voice
- Keycard encoders (for L&F shipping labels)
- RFID readers (linen tracking, optional)
- Room occupancy sensors (optional, advisory)

### Network
- Wi-Fi coverage required throughout property
- Cellular fallback (especially for guest-area access)
- VPN for sensitive operations

### Offline mode
- Local-first task event capture
- Idempotent replay when online
- Conflict resolution by event ordering
- Supervisor sees "offline" indicators per RA
- Cached job cards work offline
- Photo / video uploads queued

### Device management
- MDM (mobile device management)
- Remote wipe on loss
- Auto-update enforcement
- Kiosk mode option (locked to app)

---

## 26. Training & Rollout

### Onboarding
- New RA in-app tutorial
- Video library (per language)
- Interactive walkthroughs
- Certification quiz
- Shadow mode (first 30 days, recommendations only)

### Rollout phases
- Phase 1: Shadow mode (system recommends, manager decides)
- Phase 2: Supervisor-assisted (system assigns, supervisor reviews)
- Phase 3: Partial auto-assign (low-stakes rooms automated)
- Phase 4: Full automation with manager override

### Explainability
- "Why this room next" reasoning shown
- "Why this assignment" reasoning shown
- "Why this estimate" breakdown
- Trust-building through transparency

### Manager training (separate)
- System administration
- Rule configuration
- Reporting deep-dive
- Coaching with system data

---

## 27. Guest-Facing Housekeeping Touchpoints

### Guest requests
- "Make my room" via in-room QR / SMS / chat
- "Skip my room today" (eco opt-in)
- "Bring extra towels" / "Bring shampoo"
- "Late checkout request"
- "Early check-in request"

### Status communication
- "Your room will be ready by 2pm" (push from system to guest)
- "Welcome — your room is ready" notification
- "Cleaning in progress — service complete soon"

### Eco-stay program
- Opt-in for no daily clean
- Credit / perk display ($X credit, eco badge)
- Tracks rooms saved per stay
- Sustainability dashboard

### Feedback
- Post-stay cleanliness rating (1–5)
- Comment box
- Auto-flag low scores for manager review
- Tied to specific RA (for coaching, not punishment)

---

## 28. Front Desk Coordination

### Ready-room requests
- FD pings HK "we need 305 in 30 min"
- HK acknowledges + commits ETA
- Live ETA updates back to FD

### Check-in flow
- FD sees real-time ready-room count
- Predicted ready-room curve by hour
- Suggested room assignment to FD (matches preferences)

### Check-out flow
- FD marks departure → triggers departure clean
- Late checkout coordination (push due-time)
- Express checkout handling

### Room moves
- Triggered from FD
- Both rooms' tasks adjust automatically
- Lock keys re-issued
- Linen counts updated

### VIP coordination
- VIP arrival board
- Pre-stocked amenities checklist
- Supervisor inspection required
- FD notified when ready

---

## 29. Maintenance Handoffs

### Issue → work order workflow
- RA reports issue during clean
- Categorized (plumbing, electrical, HVAC, cosmetic, safety, appliance)
- Severity (minor / major / urgent / safety)
- Photo evidence required
- Auto-assigned to maintenance team
- Created in `pms_work_orders_v2`

### Maintenance status visibility
- HK sees work order status (open / in-progress / closed)
- Maintenance comments back to HK
- Photo of fix attached

### OOO release back to HK
- Maintenance marks complete
- HK gets notified room ready for re-inspection
- Re-clean task auto-created if needed

### Preventive maintenance
- Scheduled (per room, quarterly etc.)
- Triggered by recurring patterns ("this room had 3 plumbing calls this month")

---

## 30. Inventory & Supplies

### Supply catalog
- Toilet paper, tissues
- Shampoo, conditioner, body wash, soap
- Towels (bath, hand, face, pool)
- Sheets, pillowcases, duvet covers
- Pillows, blankets
- Coffee, tea, water
- Welcome cards, pens, notepads
- Cleaning chemicals
- Trash bags
- Light bulbs (per room)
- Batteries (remotes, smoke detectors)

### Par levels
- Per supply, per property
- Per room type (suite needs more)
- Auto-reorder triggers (when below par)

### Receiving
- Vendor PO tracking
- Receiving log (what came in, when)
- Quality check
- Stock by location (main storage, floor closets)

### Cart loadout
- Pre-shift cart stocking checklist
- Cart inventory tracking
- Missing supply alerts mid-shift

### Vendor ordering
- Integrations: Walmart, Costco Business, hotel supply distributors
- Auto-PO generation
- Approval workflows

### Chemical safety
- SDS sheets per chemical
- Dilution charts
- Training certifications

---

## 31. Sustainability / ESG

### Eco-stay tracking
- Rooms skipped per month
- Water saved (gallons)
- Energy saved (kWh)
- Linen washes saved
- Chemical usage reduced

### Carbon footprint
- Per cleaning type estimate
- Per property monthly
- Year-over-year reduction

### Sustainability reports
- ESG metrics for owner / brand
- Public-facing sustainability page data
- Certification support (LEED, Green Key)

### Chemical reduction
- Non-toxic alternative tracking
- Refillable container programs
- Bulk vs single-use comparisons

---

## 32. Health & Safety

### Incident reporting
- Slip / fall
- Chemical exposure
- Needlestick
- Assault / harassment
- Property damage
- Photo + report

### Hazard tracking
- Sharps disposal
- Hazardous material handling
- Biohazard cleanup protocols

### PPE tracking
- Gloves, masks, eye protection
- Issued per RA
- Disposal logs

### Pandemic mode (toggleable)
- Enhanced cleaning checklists
- PPE requirements
- Guest-facing protocols
- Exposure contact tracing

### OSHA / regulatory
- Training records
- Incident logs (OSHA 300)
- Audit support

---

## 33. Compliance

### Brand standards
- Choice Hotels standards
- Marriott standards
- Hilton standards
- IHG / Hyatt / Wyndham standards
- Inspection checklists tied to brand requirements
- Brand audit support (mock inspections)

### ADA / accessibility
- Accessible room tracking
- Accessibility-specific cleaning checklists
- Maintenance prioritization for accessibility issues

### Labor law
- FLSA compliance (OT calculation)
- Break enforcement (per state)
- Minimum wage compliance
- Tip credit handling (where applicable)

### Union rules
- Per-CBA configuration
- Seniority-based scheduling
- Bid systems
- Grievance tracking

### Data privacy
- GDPR (for international guests)
- CCPA (California guests)
- Guest data retention rules
- Employee data handling

---

## 34. Integrations Beyond PMS

### Payroll
- ADP
- Gusto
- Paychex
- Custom export

### HR
- BambooHR
- Workday
- Rippling

### Communication
- Slack
- Microsoft Teams
- WhatsApp Business (for staff)
- SMS via Twilio

### Voice / AI
- ElevenLabs (TTS)
- OpenAI / Anthropic (LLMs)
- Picovoice (wake word)
- Google Translate (translation)

### Maintenance systems
- Quore
- Hotelkit (operations)
- ServiceChannel

### F&B / minibar
- Squirrel
- Aloha
- Toast

### Tip processing
- Stripe Connect
- Square

### Background checks
- Checkr
- Sterling

---

## 35. AI / ML Features (the competitive edge)

### Predictive cleaning time
- Per-individual-room (not just type)
- Learns from history (Room 305 always takes 5 min longer due to layout)
- Anomaly detection ("this clean took 2x normal — something's wrong")

### Smart routing
- Reroute mid-day on conditions (rush rooms, sick callouts)
- "Next-best-room" with reason text `[HE]`

### Quality prediction
- "RA Maria has 92% inspection pass rate" → less inspection needed
- "RA Carlos struggling with bathrooms" → targeted coaching

### Demand forecasting
- Tomorrow's labor needs from occupancy + reservation context
- Multi-day rolling forecast

### Voice assistant for training
- "Hey Staxis, how do I clean a suite?" → walkthrough
- Voice-controlled job navigation

### Sentiment analysis
- Auto-flag negative review patterns
- Tied to specific RAs (for coaching)

### Image AI
- Photo quality scoring (is the room actually clean?)
- Anomaly detection in inspection photos
- Auto-categorize maintenance issues from photos

### Predictive maintenance
- "Room 207 will need PM in 2 weeks based on usage"
- Trigger preventive work orders

### Personalization
- Per-RA UI adaptation (slower / faster pacing)
- Per-guest preferences memory

---

## 36. Multi-Property / Portfolio Features

### Cross-property dashboard
- All properties on one screen
- Comparative metrics
- Drill-down per property

### Best-practice sharing
- "Property A has 95% pass rate — here's what they do differently"
- Template export / import

### Centralized procurement
- Multi-property supply ordering
- Volume discounts
- Centralized warehouse

### Multi-property labor planning `[HE]`
- Float pool across properties
- Cross-training tracking
- Centralized scheduling

### Brand rollout
- Push brand standards to all properties
- Compliance reporting per property
- Mock audits

### Owner / corporate reporting
- Portfolio P&L
- KPI scorecards per property
- Variance alerts

---

## 37. Reporting Beyond Housekeeping

### Revenue management input
- Room ready by X time → impacts ADR strategy
- Inventory turnover signals

### F&B coordination
- VIP arrivals → F&B notified
- In-room dining → cleanup task

### Owner reports
- Profitability per property
- Labor as % of revenue
- Cleaning quality scores

### Corporate KPIs
- Brand audit results
- Customer satisfaction
- ESG scorecards

### Insurance / risk
- Incident frequency
- Slip-and-fall hotspots
- Claim support docs

---

## Appendix A — Source Coverage

| Category | Optii | Flexkeeping | HE / Build Guide |
|---|---|---|---|
| 1. Master Data | ✓ | ✓ | ✓✓ |
| 2. Rules Engine | ✓ | ✓✓ | ✓ |
| 3. Cleaning Types | ✓✓ | ✓✓ | ✓ |
| 4. Workload Estimation | ✓ | ✓✓ | ✓ |
| 5. Task Lifecycle | ✓✓ | ✓ | ✓ |
| 6. Assignment & Routing | ✓✓ | ✓ | ✓✓ |
| 7. Forecasting | ✓ | ✓✓ | ✓ |
| 8-10. Mobile | ✓ | ✓✓ | ✓ |
| 11. Inspection | ✓✓ | ✓✓ | ✓ |
| 12. Live Tracking | — | ✓✓ | — |
| 13. Voice / Multilang | — | ✓✓ | — |
| 14. Timing | ✓✓ | ✓ | ✓ |
| 15. Manager Console | ✓✓ | ✓ | ✓ |
| 16. Real-Time | ✓ | ✓✓ | ✓ |
| 17. Labor Planning | — | — | ✓✓ |
| 18. Schedules | ✓ | ✓ | ✓ |
| 19. Roles | ✓✓ | ✓ | ✓ |
| 20. Reporting | ✓✓ | ✓ | ✓ |
| 21. Activity Log | ✓✓ | — | — |
| 22. Reports | ✓✓ | ✓✓ | ✓ |
| 23. Auxiliary | ✓ | ✓ | ✓✓ |
| 24. Door Lock | — | — | ✓✓ |
| 25. Hardware / Offline | ✓ | — | ✓ |
| 26. Training | — | — | ✓ |
| 27-37. Expansions (gaps) | — | — | — |

`✓✓` = strong coverage; `✓` = covered; `—` = not covered

---

## Appendix B — Notes on Sources

- **Optii**: full deep research dated May 2026. Focus on Optii.com, YC materials, App Store / Play Store version histories, HotelTechReport reviews, OHIP docs.
- **Flexkeeping**: full deep research dated May 2026. Sources: flexkeeping.com, Mews.com (post-Sept 2025 acquisition), Cloudbeds marketplace docs, founder podcast.
- **Hotel Effectiveness**: full deep research dated May 2026, but expanded to cover the broader housekeeping software landscape (Alice, Quore, Oracle OPERA, Mews, Cloudbeds, Stayntouch).

---

*Last updated: 2026-05-24. Maintained as the master housekeeping product feature reference.*
