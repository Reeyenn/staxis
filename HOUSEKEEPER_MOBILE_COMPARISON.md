# Housekeeper Mobile App — Competitive Comparison

**Scope:** What the housekeeper (room attendant) experiences on their phone today across three competitors vs. Staxis as of 2026-05-24.
**Out of scope:** Voice features (separate research), auto-assignment ML, sick-callout flow, cleaning-rules engine, manager web console.
**Branch:** `feature/mobile-housekeeper-research` (research only — no code changes).

---

## 1. Executive summary

The mobile housekeeper experience splits cleanly into two camps. **Optii and Flexkeeping** ship mature native iOS + Android apps with deep mobile features: 20+ languages, auto-translated staff chat, color/symbol UI explicitly designed for non-readers, photo capture on issues, push notifications, SAML SSO, and (in Flexkeeping's case) a dedicated Photo Proof feature for task completion. **Hotel Effectiveness has no housekeeper app at all** — their mobile presence is a manager labor dashboard and a separate employee timeclock; the actual housekeeper-facing product inside the Actabl portfolio is **Alice** (sister product, January 2025 relaunch), which competes on similar ground to Optii/Flexkeeping but with weaker App Store sentiment (2.0★) and known photo-upload bugs. **Staxis today is essentially bare bones** — a publicly-linkable SMS web page with EN/ES translation, single-tap Done, DND toggle, and freeform issue notes. No photo, no push, no offline queue, no native app, no QR scan, no personal stats, no chat. The biggest gaps vs. all three competitors (and Alice): photo capture, exception buttons beyond DND, push notifications, native app delivery, multi-language depth (everyone else supports 20+ languages with auto-translated messages; Staxis ships EN+ES only). Flexkeeping is the strongest single benchmark on mobile UX — its founder Luka Berger explicitly designed the app for multilingual, varying-literacy teams ("if you can use a phone, you can use Flexkeeping") and the philosophy is woven through every screen.

---

## 2. Staxis mobile housekeeper app today

**File reference:** entry page at [src/app/housekeeper/page.tsx](src/app/housekeeper/page.tsx), main page at [src/app/housekeeper/[id]/page.tsx](src/app/housekeeper/[id]/page.tsx) (1404 lines), action API at [src/app/api/housekeeper/room-action/route.ts](src/app/api/housekeeper/room-action/route.ts) (694 lines), translations at [src/lib/translations.ts](src/lib/translations.ts).

### Delivery model
- Public web page only. Each housekeeper opens an SMS-delivered link with `?code=` (current) or `?token=` (legacy). No native iOS or Android app, no Add-to-Home-Screen prompt for this page (the existing PWA manifest points to `/dashboard`, not `/housekeeper`).
- Service worker exists ([public/sw.js](public/sw.js)) but is a kill-switch that unregisters itself and clears legacy push registrations — no offline caching.

### Auth
- SMS magic link only. No SSO, no PIN, no biometric, no email/password. Server exchanges the code via [src/app/api/housekeeper/exchange-code/route.ts](src/app/api/housekeeper/exchange-code/route.ts); if exchange fails, the page still works in service-role API bypass mode.

### Home screen
- Header: "Hello, {firstName}", date, EN/ES toggle, progress bar ("X of Y done · Z DND").
- Single "Shift Start" button (anchors duration; persisted to localStorage).
- Single linear list of rooms sorted by room number ascending. **No tabs, no "My Added Jobs" view, no next-room suggestion banner.**
- "All done" celebration card on completion.

### Job card
Each room is an inline card (no separate detail view):
- Room number (34px monospace), index (1., 2., …), type badge (CHECKOUT / STAYOVER / VACANT).
- Priority badge: VIP (red ★), Early Checkin (orange ⚡), Standard (none).
- In-progress indicator (⟳ + start time) when applicable.
- Issue note rendered below number in red box if present.
- **Missing:** guest name, ETA, nights, checklists, manager reference photos, linked guest preferences, linked prior maintenance, credits/minutes/due-by.

### Actions on job card
- **Done ✓** (large 68px green button, single tap). Records `completed_at` server-side.
- **Undo** (link on done card; no time limit).
- **DND toggle** (icon button, 44×44 min tap target). Toggles Do Not Disturb state.
- **Report Issue** (icon button → opens modal → freeform textarea → submit).
- **Missing:** Start, Pause, Resume, Mark for Inspection, Rush flag, Request Supervisor, Add Photo, Add Note (separate from issue).

### Exception handling
- Only **DND** as a discrete button.
- **Missing:** NSR, DLA, Sleep Out, Guest in Room, Skipped — none exist as buttons.

### Issue reporting
- Freeform textarea only.
- **Missing:** action/item/location pickers, severity selector, photo, video, auto-route to maintenance.

### Multi-language
- EN + ES only. UI fully translated via `useLang()` provider + `src/lib/translations.ts` (1492 lines of strings). Dates formatted locale-aware (esLocale).
- Language seeded from `staff.language` column; toggle saves back via `/api/housekeeper/save-language`.
- **Missing:** auto-detect device language, auto-translated staff messages (no chat exists), any third language.

### Color / symbol UI
- Color coding: navy in-progress, green done, red VIP, orange early checkin, gray standard/DND, white default.
- Emojis used as symbols (🚫 DND, ⭐ senior, ⚡ early, ★ VIP, ⟳ in-progress, ✓ done).
- 44×44 tap targets, `touch-action: manipulation`, `WebkitTapHighlightColor: transparent` for glove-friendly feel.
- **Missing:** dedicated icon library, color-blind mode, custom property color schemes.

### Photo / video capture
- **None.** No `<input type="file">` anywhere in housekeeper code, no Supabase Storage upload, no camera capture.

### Push / browser notifications
- **None.** FCM push was explicitly removed 2026-04-22 ("hostile onboarding step that nobody completed"). Replaced with Twilio SMS for room-assignment alerts.

### Offline mode
- Detection only: persistent orange "You're offline" banner when `navigator.onLine === false`.
- No event queue, no IndexedDB, no replay. Tapping Done while offline shows an error toast; user must retry when online.
- Shift-start timestamp cached in localStorage (the only local-first state).

### QR code scan
- **None.**

### Personal stats
- Header "X of Y done · Z%" is the only stat.
- **Missing:** week hours, average minutes per departure, inspection pass rate, personal best.

### Settings
- Language toggle (only).
- **Missing:** notification prefs, profile edit, help/FAQ, logout (user is unauthenticated on the public link).

### Realtime sync
- Subscribes to `rooms` table via Supabase realtime when authenticated; falls back to polling otherwise.
- Manual refetch on every action; 1500ms dedup window against realtime echoes.

### Known TODOs
- No explicit `TODO/FIXME/XXX` markers in housekeeper files.

---

## 3. Optii — mobile housekeeper app

Optii ships **two parallel mobile experiences**: the legacy "Optii Housekeeping" native app (App Store ID `861717884`, last updated v2.1.55 May 2026) and the next-generation unified "Optii" app (ID `1534330415`) + `optii.app` PWA that bundle Housekeeping, Service, Maintenance, and Chat together. Sources: [legacy App Store](https://apps.apple.com/us/app/optii-housekeeping/id861717884), [new App Store](https://apps.apple.com/us/app/optii/id1534330415), [optii.app](https://optii.app/).

### Delivery
- **Native iOS:** both legacy + new (HIGH).
- **Native Android:** `com.optiisolutions.housekeeping` (legacy) + `com.optii.topcat` (new) (HIGH). HTR reviews note "better Android support" is a recurring ask (MEDIUM).
- **PWA at optii.app:** installable, responsive design, "responsive design optimized for mobile, tablet, and desktop" per the v3.18.0 launch (HIGH). Min iOS 17 / Android 13.
- **Hardware:** Optii recommends rugged devices (IP67, MIL-STD-810H), Wi-Fi 6+ for Rush Room latency (HIGH).

### Auth
- Email/password (HIGH).
- **SAML SSO** since legacy v2.1.45 (Aug 2023), refined v2.1.48; new app has automatic login routing in v3.25.1 (HIGH).
- Device authorization gate beyond credentials (HIGH).
- Quick Access Code login route at `optii.app/login/access` — implies PIN/code login on shared devices (MEDIUM).
- Biometric: **UNKNOWN** (no doc mentions Face ID/fingerprint).

### Home screen tabs
- **My Assigned Jobs** (active jobs from optimizer)
- **My Section / My Sections** (all work in assigned sections)
- **My Added Jobs** (jobs the RA personally created)
- **My Squad Jobs** (multi-assignee jobs, added v3.26.0 April 2026)
- **Status / Job Status page** with location filter
- Credits breakdown by job type visible on home (since v3.22).

### Job card
- Reservation context (arrival/departure icons, yellow in-house, VIP star).
- Color band per cleaning type (HIGH, table below).
- ETA/ETD, Rush flag, DND symbol, Double-lock icon, Extra-job dark circle, Guest-status letter, Custom tags (inline-editable since 3.24.1), Checklist icon (3.22+), Squad icon (3.26+), Pause icon when RA has paused.

### Cleaning-type color palette (HIGH; explicit help-center table)
| Type | Color |
|---|---|
| Departure Clean | Orange |
| Stayover Clean | Green |
| Touch-up Clean | Blue |
| Turndown Clean | Purple |
| Corrections Clean | Red |
| Inspections | Dark Cyan |
| Check Tasks | Dark Crimson |

### Actions
- **Start / End** (real-time PMS sync).
- **Pause / Resume** (supervisor-visible).
- **Add Note** (since v3.18+, dedup fix v2.1.39).
- **Add Photo** (on defects, checklists — see below).
- **Add Job** (was "Report Defect" — renames issue → service ticket).
- **Mark for Inspection** (v3.18+, Skip Inspection added 3.26).
- **Rush Flag** (integrates with Opera "Queue Rooms"; needs Wi-Fi 6 for low-latency push).
- **Request Supervisor:** **UNKNOWN** as explicit button; pause functions as flag-for-help.

### Exception buttons (via "⋯" menu on job card)
| Code | Confirmed? |
|---|---|
| DND | ✓ HIGH |
| NSR | ✓ HIGH |
| DLA (Double Lock Active) | ✓ HIGH |
| Sleep Out / No Show | ✓ HIGH |
| Skipped | ✓ HIGH |
| **Guest in Room** | **UNKNOWN — Optii has no discrete button by this name** |
| OOO/OOS visibility | ✓ HIGH |

### Issue / defect reporting
- Photo attach **optional**, confirmed by v2.1.46 release-note bug fix ("prevent app from closing when adding a defect with an attached photo").
- Mandatory photo proof on completion: **NOT FOUND**. Checklist items can be marked mandatory but no doc enforces a photo-to-complete gate.
- Video: **UNKNOWN** (no source).
- **Job Assist AI** triages text/voice/photo issue intake (HIGH, [4 AI Models blog](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now)).

### Multi-language
- **21 languages on legacy App Store listing** (English, Albanian, Bosnian, Bulgarian, Estonian, French, German, Greek, Haitian, Italian, Japanese, Mongolian, Polish, Portuguese, Punjabi, Romanian, Russian, Simplified Chinese, Spanish, Traditional Chinese, Turkish, Ukrainian) — HIGH.
- New unified app lists "English only" on App Store metadata but platform supports "over 20 languages" — locale strings server-side (MEDIUM).
- **Inline auto-translation in Chat** since July 24, 2024. Operates automatically 1-to-1 and 1-to-many; Spanish housekeeper → English engineer; "save up to an hour per day." Notifications + Service translation "soon to follow." [Press release](https://www.optiisolutions.com/blogs/optii-breaks-barriers-with-inline-translation) (HIGH).
- Video tutorials dubbed in Tagalog, Chinese Simplified, Japanese, Haitian Creole, German, French.

### Color / symbol UI
- "Communicating without speaking" is the explicit positioning (customer quote, HTR).
- Color-coded job-type bands (table above), arrival/departure icons, VIP star, double-lock icon, DND symbol, NSR symbol, DLA symbol, rush icon, pause icon, extra-job circle.

### Photo / video
- Photo capture in Chat (HIGH).
- Photo on defect (optional, HIGH).
- Photo on checklist items (HIGH — v3.22.1 fixed checklist photo upload).
- Photo proof on completion: NOT MANDATORY per any doc found.
- Video: UNKNOWN.
- Annotation / face redaction / compression: UNKNOWN.

### Push / notifications
- iOS native push: ✓ HIGH ("Never miss a job assignment").
- Android native push: ✓ HIGH (dedicated help-center article).
- PWA / browser push: ✓ HIGH (Chrome install path triggers Notifications API permission).
- SMS bumps for managers: MEDIUM.

### Offline mode
- Connectivity-resilient, not full offline queue. v2.1.27 (Nov 2019) "Improved Offline and Online capabilities," v2.1.28 (Jan 2020) "More improvements in detecting Internet issues" — detection patches, not queueing (HIGH).
- System specs page tells properties they need Wi-Fi 6 / LTE because real-time sync is required.

### QR code scan
- **UNKNOWN / not found.** Likely gap.

### Personal stats (RA-facing)
- Credits breakdown by job type on home (since v3.22).
- Manager-facing **Housekeeping Benchmark Report** (v3.25.1, March 2026): average completed credits per RA, correction percentage, average start/end time per RA.

### Settings
- Push notification toggle (per-OS).
- Language preference (implied by 21 locales).
- Most settings live at OS level (iOS Settings → Notifications → Optii) rather than in-app.

### Notable mobile release-note highlights
- **3.26.x (Apr 2026):** Squad jobs (multi-RA), Pass/Fail/N/A checklist scoring, Skip Inspection, non-cleaning credits.
- **3.25.x (Mar 2026):** Component rooms (multi-room suites), Housekeeping Benchmark Report, automatic login routing.
- **3.24.x (Jan–Feb 2026):** Supervisor View, tags on job cards, Optii AI support chat, Pick Up status now optional.
- **3.22 (Nov 2025):** Dedicated HK tab, checklist icon support on mobile, My Jobs credit breakdown.
- **3.18 (Mar 2025):** Next-gen platform early-access launch — modern stack, responsive design, 2-way PMS sync.
- **2.1.45 (Aug 2023, legacy):** SAML SSO added.

---

## 4. Flexkeeping — mobile housekeeper app

Flexkeeping (founded 2013 by ex-housekeeper Luka Berger, acquired by Mews 2025-09-30) is the strongest single benchmark on housekeeper mobile UX. Native iOS app (CREATRIKS d.o.o., bundle ID `id1198674319`) last updated v3.6.5 on 2025-05-08; Android `si.creatriks.facility` v3.9.36 Dec 2025. Sources: [App Store](https://apps.apple.com/us/app/flexkeeping/id1198674319), [housekeeping product page](https://flexkeeping.com/products/housekeeping-software), [Matt Talks EP55 with Luka Berger](https://www.mews.com/en/resources/matt-talks/ep55-walkie-talkies-ai-and-the-remaking-of-housekeeping-with-luka-berger).

### Delivery
- Native iOS (iOS 16+, iPadOS, macOS via Apple Silicon, visionOS) — HIGH.
- Native Android (7.0+) — HIGH.
- Web client at `app.flexkeeping.com` (manager-oriented, fallback for staff) — HIGH.
- PWA: **UNKNOWN**. No manifest-based install path documented.

### Auth
- Email/password, named-user per ToU (no shared accounts) — HIGH.
- SSO via PMS identity (Apaleo OAuth confirmed; SAML for Okta/Azure/Google) — MEDIUM.
- Register code on first launch — MEDIUM.
- PIN-only login: UNKNOWN (ToU prohibits credential sharing; designed for 1-staff-1-login).
- Biometric: UNKNOWN.

### Home screen
- **Workday screen** — per-shift task list (restored standalone v3.5.1 Jul 2025).
- **Assignment grouping by sector** (v3.5.5 Oct 2025) — rooms grouped by floor/sector.
- **FlexChat tab** — full messaging (v3.4.1/3.4.2 Jan 2025, major UI overhaul v3.6.0).
- **Guest module** (v3.6.3 Apr 2025) — DND, eco/no-clean opt-out, stayover/departure context.
- **Notice Board** — broadcast feed since Jan 2022.
- Live room-status counts.

### Job card
- Reservation context (guest type, DND flag, eco/no-clean, stayover/departure).
- Custom color-coded status types per property — HIGH ([FAQ](https://flexkeeping.com/resources/faq)).
- Digital checklists per room type, individually scored (5 points for a perfect bed, 2 for a basic one).
- Cleaning credits / minutes weighted by managers; system flags overworked staff.
- Room reassign action (v3.4.1/3.4.2 Jan 2025).
- Standard PMS status vocabulary preserved (VC/VD/VI/OC/OD/DND/OOS).

### Actions
- Real-time status updates from card (HIGH — Clarion case study).
- Explicit Start/Pause/Resume/Complete buttons: **UNKNOWN as named UI elements**. Minute-per-room tracking implies start/stop timestamps. (LOW confidence on explicit button names.)
- Exception buttons / Rush flag / Request Supervisor: UNKNOWN as named UI. Property can configure custom statuses for these.
- Mark clean → routes to inspection queue (HIGH — Palace Resorts case study).

### Issue reporting
- Pre-defined repair labels (HIGH).
- Photo capture on issues (HIGH — Palace Resorts: "housekeeper takes picture, task sent to maintenance with all needed details").
- **Photo Proof on completion: v3.4.10 (May 20, 2025)** — prompts adding photos when task completed. Configurable, not globally mandatory (HIGH on existence, MEDIUM on mandatory-ness).
- Video capture: LOW (only one third-party source claims it).
- Voice issue reporting via **Flexie AI** (push-to-talk; not always-listening) — HIGH.
- Voice notes structured + translated to maintenance recipient's language — HIGH.

### Multi-language
- **240+ languages** for Flexie AI auto-translation (older copy says 200+) — HIGH ([Flexie AI](https://flexkeeping.com/flexie-ai)).
- Automatic translation of staff communications since **June 2021** — HIGH ([product news](https://flexkeeping.com/product-news/automatic-translations-for-hotel-staff-communication)).
- **Both-languages-visible** — message shown in original + translated side-by-side so staff learn local work terms over time — HIGH.
- App Store lists "English only" for UI shell — translation appears to run over content (messages, tasks, checklists) rather than fully localizing the chrome (MEDIUM).
- Flexie's first 1000 use cases spanned 14 languages (incl. German, Croatian, Afrikaans, Spanish, Samoan) at 20 properties.

### Color / symbol UI
Luka Berger on Matt Talks EP55:
> "There's a certain philosophy of colors and symbols we are using since day one that should explain to everyone, regardless of the language, what needs to be done, what's the priority, what's dynamic, and what has been done already."
> Housekeepers "should know at a glance what needs to be done, what was done."
> Software "should be kind of shadowing you. It should never burden you. It should never stop you in your work process."

- Custom color-coded room status types per property — HIGH.
- Cleaning-type icons (implied by analytics dashboard segmentation).
- Green pin / active-cleaning indicator on manager map.
- Color-coded priority levels on tasks.
- Specific icon library / exact hex codes: UNKNOWN.

### Photo / video / proof
- In-app camera capture, tied to tasks and room cards — HIGH.
- **Photo Proof on completion** — v3.4.10 May 2025 — HIGH.
- File-upload performance under poor connectivity explicitly improved v3.5.2 (Jul 2025) — implies chunked / resumable upload — HIGH.
- Video: LOW (one third-party only).
- Annotation / face redaction / EXIF stripping: UNKNOWN.

### Push / notifications
- Push on iOS + Android — HIGH ("Staff receive push notifications for urgent updates").
- **Live housekeeper location** on manager map; pin turns green when RA actively cleaning a room; toggled via Settings → "Show Housekeepers' Location" (Jun 2024) — HIGH ([product news](https://flexkeeping.com/product-news/housekeepers-location)).
- Browser notifications: UNKNOWN.

### Offline mode
- **Not documented as a marketing claim.** v3.5.2 mentions "file upload performance during poor connectivity" — graceful retry rather than full offline parity. Capterra reviews mention sync issues. Effective gap.

### QR code
- **UNKNOWN.** No release note or marketing page mentions QR.

### Personal stats (RA-facing)
- Analytics dashboard exists — per-person rooms cleaned, working days, expected vs actual time, minutes per room, on-time, re-cleans, inspections, corrections — but **all framed as manager-facing** (HIGH).
- RA-facing "My Stats" view: UNKNOWN.

### Settings
- "Show Housekeepers' Location" toggle — HIGH.
- Language picker: MEDIUM (implied, not documented).
- iPad layout (v3.6.4 Apr 2025) — HIGH.

### Chat / messaging — flagship feature
- **FlexChat module** since Jan 2025, major UI overhaul Dec 2024 — HIGH.
- Auto-translation per message, both languages visible — HIGH.
- GDPR-compliant (positioned as the WhatsApp replacement for hotels) — HIGH.
- Notice Board: broadcast feed with attachments, read receipts, team-targeted — HIGH.
- Voice messages via Flexie AI — HIGH. Akvile Norkute (Villa Copenhagen): *"I don't type maintenance tickets anymore. I only use Flexie."*

### Notable mobile release-note highlights
- **v3.4.10 (May 20, 2025):** Photo Proof.
- **v3.4.1/3.4.2 (Jan 2025):** FlexChat module + room reassign.
- **v3.5.0/3.5.1 (Jul 2025):** Workday performance overhaul.
- **v3.5.2 (Jul 31, 2025):** Upload performance during poor connectivity.
- **v3.5.5 (Oct 7, 2025):** iOS 26 visual fixes + assignment grouping by sector.
- **v3.5.6 (Oct 30, 2025):** Guest check-out in the RA app.
- **v3.6.0 (Dec 2024):** Major FlexChat UI revamp.
- **v3.6.3 (Apr 2025):** Guest module rebuild.
- **v3.6.4 (Apr 2025):** iPad support.

### Customer outcomes (context)
- Palace Resorts: 150 housekeepers per shift coordinated; 1M+ room-service tasks/year automated.
- Clarion The Hub: 464 hours/month saved; "You basically don't need training. If you can use a phone, you can use Flexkeeping."
- 40% productivity gain, 45% drop in guest complaints across customer base (Mews acquisition press).

---

## 5. Hotel Effectiveness (Actabl) — mobile housekeeper app

### Headline finding
**Hotel Effectiveness has NO housekeeper-facing mobile app.** Their two mobile apps are:
- **"Hotel Effectiveness"** (App Store `id1456017147`) — labor-cost dashboard for managers.
- **"MyHotelTeam"** (App Store `id1483596888`) — employee schedule + timeclock.

Neither does room status, cleaning workflow, photo proof, issue reporting, or any housekeeping execution. Hotel Effectiveness owns labor planning, scheduling, time-and-attendance, and MPR analytics — they assume the room-execution layer is handled by the PMS or by their sister product Alice.

### Alice (sister Actabl product) — the real housekeeper mobile in the Actabl portfolio
- **"Alice by Actabl"** (App Store `id6739638710`, Android `com.actabl.alice.android`) — Jan 25 2025 release, latest v1.0.5 Aug 2025.
- Legacy **"ALICE Staff"** (`id971004611`) still listed but appears deprecated; ~2.7★ from 82 reviews, complaints about glitchy photo upload.
- New "Alice by Actabl" rating ~2.0★ on the App Store. Sources cite recurring complaints about photo-upload reliability, app freezing on the Notes screen, and mobile-vs-PC feature parity gaps.

Alice's housekeeper-facing capabilities (compiled from App Store description, Hotel Tech Report, [Sept 2024 Housekeeping Refresh announcement](https://actabl.com/news/actabl-introduces-alice-housekeeping-refresh/)):

| Capability | Status | Confidence |
|---|---|---|
| Native iOS + Android | ✓ | HIGH |
| Languages (UI translation) | UNKNOWN; staff message auto-translation exists | LOW-MEDIUM |
| **Auto-translation of guest messages** | ✓ | HIGH |
| Symbol-heavy UI for non-readers | Designed for multilingual workers (per IxDA design talk) | MEDIUM |
| Color-coded statuses | Implied by status timers + room boards | LOW |
| Photo capture on issues | ✓ — but reviewers complain it's buggy | HIGH |
| Video capture | UNKNOWN | MEDIUM |
| Photo proof on completion | UNKNOWN | UNKNOWN |
| Push notifications | ✓ — deep-link into conversations | HIGH |
| **SAML SSO on mobile** | ✓ — added v1.0.2; same SSO process as web | HIGH |
| PIN-only login | UNKNOWN | UNKNOWN |
| Biometric | UNKNOWN | UNKNOWN |
| **Offline mode** | ✓ — "continue work whenever you lose connection and sync updates once you regain connection" | HIGH |
| QR code (room) | UNKNOWN; QR for **manager password reset** exists | MEDIUM |
| **Personal stats (RA-facing)** | ✓ — "Room Attendant Daily Summary," "My Day progress breakdown with dynamic tracking" | HIGH |
| Job card / room board | ✓ — supervisor view, PMS-synced cleaning status, search | HIGH |
| **Mobile Room Rush flag** | ✓ — explicit feature in 2024 Refresh | HIGH |
| **Do Not Disturb by automation** | ✓ | HIGH |
| Start/Pause/Resume/Complete | Implied via status timers; explicit pause/resume UNKNOWN | MEDIUM |
| Issue reporting (work tickets) | ✓ — with photo, duplicate-detection alerts, dispatch & escalation (Closed Beta) | HIGH |
| Lunch break punch in/out | ✓ — "Punch in/out for lunch breaks right from your mobile device" | HIGH |
| Auto-assign / credit rules | ✓ — Advanced Auto-Assign added Sept 2024 | HIGH |

---

## 6. Side-by-side comparison table

Legend: ✓ = present (HIGH confidence unless noted), ~ = partial, – = absent, ? = UNKNOWN (couldn't verify), `HE→Alice` = Hotel Effectiveness itself has none but Actabl-sister Alice does.

### 6.1 Delivery model

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Native iOS app | ✓ (two: legacy + new) | ✓ | – (HE→Alice ✓) | – | HIGH |
| Native Android app | ✓ (two listings; HTR notes weaker polish) | ✓ | – (HE→Alice ✓) | – | HIGH |
| Web client | ✓ (optii.app PWA) | ✓ (app.flexkeeping.com) | ✓ (manager portal only) | ✓ (sole channel) | HIGH |
| Installable PWA for staff | ✓ optii.app | ? | – | – (manifest exists but targets /dashboard, not /housekeeper) | HIGH |
| iPad / tablet layout | ✓ | ✓ (v3.6.4) | ? | – | HIGH |
| Rugged-device guidance | ✓ (IP67, MIL-STD-810H, Wi-Fi 6+) | ? | ? | – | HIGH |
| Apple Vision / visionOS support | ✓ (new app) | ✓ | ? | – | HIGH |

### 6.2 Auth

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Email/password | ✓ | ✓ | ✓ (manager apps) | – | HIGH |
| SAML SSO | ✓ (since v2.1.45 Aug 2023) | ✓ (Apaleo OAuth confirmed; broader SAML inferred) | ? (HE→Alice ✓ since v1.0.2) | – | HIGH |
| Quick Access Code / PIN login | ~ (optii.app/login/access exists) | ? | ? | – | MEDIUM |
| Biometric (Face ID / fingerprint) | ? | ? | ? (PerfectTime hardware has fingerprint, not the app) | – | UNKNOWN |
| Magic-link / SMS sign-in | ? | ? | ? | ✓ (only auth path) | HIGH |
| Device authorization | ✓ | ? | ? | – | HIGH |
| Remember-me | ✓ (auto-saved password) | ? | ? | – | MEDIUM |

### 6.3 Multi-language

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Number of UI languages | 21 (legacy listing); "20+" (new) | English shell + 240+ language content translation | ? (Spanish MyHotelTeam listing) | 2 (EN + ES) | HIGH |
| Full UI translation (chrome + labels + errors) | ✓ (legacy 21 confirmed) | ~ (App Store lists EN only; content translated, shell appears EN) | ? | ✓ (EN + ES, all strings) | HIGH |
| Auto-detect device language | ? | ? | ? | – | UNKNOWN |
| Per-user language override (persisted) | ✓ | ✓ | ? | ✓ (staff.language) | HIGH |
| Auto-translation of staff messages | ✓ (Inline Translation in Chat, Jul 2024) | ✓ (since Jun 2021; 240+ languages) | ✓ via Alice (guest messages); staff UNKNOWN | – (no chat exists) | HIGH |
| Both-languages-visible side-by-side | ? | ✓ explicit ("original + translated together") | ? | – | HIGH |
| Tutorials dubbed multi-language | ✓ (6 languages) | ? | ? | – | HIGH |

### 6.4 Color / symbol UI

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Color-coded cleaning types | ✓ (explicit 7-color table) | ✓ (custom per property) | ? (HE→Alice ~) | – | HIGH |
| Color-coded room status | ✓ | ✓ | – (HE→Alice ~) | ~ (status only: in-progress blue, done green, DND gray) | HIGH |
| Color-coded urgency (rush) | ✓ (Rush flag) | ✓ (priority colors implied) | – (HE→Alice ✓ Mobile Room Rush) | ~ (VIP red, early orange) | HIGH |
| Symbol/icon library for non-readers | ✓ (rich set: arrival/departure, VIP star, double-lock, DND, NSR, DLA, rush, pause, extra-job, guest-status letter) | ✓ (founder-documented "colors and symbols since day one") | ? (HE→Alice MEDIUM — "designed for multilingual workers") | ~ (emoji-only: 🚫⭐⚡★⟳✓) | HIGH |
| Explicit "designed for non-readers" positioning | ✓ ("communicating without speaking") | ✓ (Berger's stated philosophy) | ? | – (not stated) | HIGH |
| Large tap targets / glove-friendly | ? (rugged-device guidance implies it) | ? | ? | ✓ (44×44 min, touch-action manipulation) | HIGH |
| Custom property color schemes | ? | ✓ (custom status types per property) | ? | – | HIGH |
| Color-blind mode | ? | ? | ? | – | UNKNOWN |

### 6.5 Home screen / navigation

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| "My Jobs" view | ✓ (My Assigned Jobs) | ✓ (Workday) | – (HE→Alice ✓ My Day) | ~ (single linear room list) | HIGH |
| "My Added Jobs" view | ✓ | ? | – (HE→Alice ✓) | – | HIGH |
| Status overview / counts | ✓ | ✓ | – (HE→Alice ✓) | ~ ("X of Y done · Z DND") | HIGH |
| Active timer banner | ✓ (pause icon) | ? | ? | – | MEDIUM |
| Next-room suggestion | ? | ? | – | – | UNKNOWN |
| Notice Board / broadcast feed | ? (Chat exists) | ✓ (Notice Board since Jan 2022) | ? | – | HIGH |
| Squad / multi-RA jobs | ✓ (v3.26.0 Apr 2026) | ? | – | – | HIGH |
| Sector / floor grouping | ✓ (My Section) | ✓ (v3.5.5 Oct 2025) | ? | – (sorted by room number ascending) | HIGH |

### 6.6 Job card

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Large room number display | ✓ | ✓ | – (HE→Alice ✓) | ✓ (34px monospace) | HIGH |
| Cleaning type badge (color) | ✓ | ✓ | – (HE→Alice ~) | ✓ (CHECKOUT/STAYOVER/VACANT, no color band) | HIGH |
| Reservation summary (guest name / ETA / nights / VIP) | ✓ (arrival/departure icons, VIP star, ETA/ETD) | ✓ (guest type, stayover/departure) | – (HE→Alice ✓) | ~ (VIP/Early badges only, no name/ETA) | HIGH |
| Credits / minutes / due-by | ✓ (since v3.22) | ✓ (workload credits) | – (HE→Alice ~) | – | HIGH |
| Manager notes | ✓ | ✓ | – (HE→Alice ✓) | – | HIGH |
| Reservation special-request notes | ✓ | ✓ | – (HE→Alice ✓) | – | HIGH |
| Checklists (per room type) | ✓ (icon support v3.22, Pass/Fail/N/A v3.26) | ✓ (per-item scoring) | – (HE→Alice ?) | – | HIGH |
| Reference photos (manager-uploaded) | ✓ (checklist photos) | ? | ? | – | HIGH |
| Linked guest preferences | ? | ✓ (guest module) | ? | – | MEDIUM |
| Linked prior maintenance | ? | ✓ (issue history) | ? | – | MEDIUM |
| Custom tags on card | ✓ (v3.24.1) | ? | ? | – | HIGH |
| Double-lock icon | ✓ | ✓ | ? | – | HIGH |

### 6.7 Actions on job card

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Start clean | ✓ | ~ (timestamps implied, button name unconfirmed) | – (HE→Alice ~) | – (removed 2026-05-07; server-derives start) | HIGH |
| Pause clean | ✓ | ? | ? | – | HIGH |
| Resume clean | ✓ | ? | ? | – | HIGH |
| Complete clean | ✓ | ✓ | – (HE→Alice ✓) | ✓ (single "Done ✓" tap) | HIGH |
| Mark for inspection | ✓ (Skip Inspection toggle v3.26) | ✓ (auto-routes) | – (HE→Alice ?) | – | HIGH |
| Add note | ✓ | ✓ (FlexChat / notes) | – (HE→Alice ✓ via Notes) | – (only via Issue) | HIGH |
| Add photo | ✓ (defects, checklists) | ✓ | – (HE→Alice ✓ but buggy) | – | HIGH |
| Add issue / job | ✓ ("Add Job") | ✓ | – (HE→Alice ✓ work tickets) | ✓ (freeform note only) | HIGH |
| Rush flag | ✓ (Rush flag → Opera Queue Rooms) | ? (configurable status) | – (HE→Alice ✓ Mobile Room Rush) | – | HIGH |
| Request supervisor | ? (pause acts as flag-for-help) | ? | ? | – | UNKNOWN |
| Undo / reset | ? | ✓ (room reassign) | ? | ✓ (Undo link on done card, no time limit) | HIGH |
| Guest check-out from RA app | ? | ✓ (v3.5.6 Oct 2025) | ? | – | HIGH |

### 6.8 Exception buttons

| Exception | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| DND (Do Not Disturb) | ✓ | ✓ (guest flag) | – (HE→Alice ✓ DND by automation) | ✓ | HIGH |
| NSR (No Service Required) | ✓ | ~ (configurable status) | ? | – | HIGH |
| DLA (Double Lock Active) | ✓ | ✓ (icon) | ? | – | HIGH |
| Sleep Out / No Show | ✓ | ~ (configurable) | ? | – | HIGH |
| Guest in Room | – (not found in Optii) | ? | ? | – | LOW |
| Skipped | ✓ | ? | ? | – | HIGH |
| OOO / OOS visibility | ✓ (Rooms drawer) | ? (PMS codes preserved) | – (HE→Alice ?) | – | HIGH |
| Eco / no-clean (guest opt-out) | ? | ✓ (guest module) | ? | – | HIGH |

### 6.9 Issue reporting

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Photo on issue (optional) | ✓ | ✓ | – (HE→Alice ✓) | – | HIGH |
| Photo on issue (mandatory per category) | ? | ? (configurable) | ? | – | UNKNOWN |
| Video on issue | ? | ~ (one third-party source) | ? | – | LOW |
| Voice issue intake (AI-structured) | ✓ (Job Assist) | ✓ (Flexie AI) | ? | – (out of scope) | HIGH |
| Action / item / location / severity pickers | ✓ (pre-defined labels) | ✓ (pre-defined repair labels) | – (HE→Alice ✓ work tickets) | – (freeform only) | HIGH |
| Auto-route to maintenance | ✓ | ✓ | – (HE→Alice ✓ dispatch & escalation Closed Beta) | – | HIGH |
| Duplicate-issue detection | ? | ? | – (HE→Alice ✓) | – | HIGH |

### 6.10 Photo / video / proof

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Photo capture in app | ✓ (Chat + defects + checklists) | ✓ | – (HE→Alice ✓ but buggy) | – | HIGH |
| **Photo proof on task completion (dedicated feature)** | – (not mandatory) | ✓ (v3.4.10 May 2025; configurable) | ? | – | HIGH |
| Video capture | ? | ~ (one third-party source) | ? | – | LOW |
| Photo annotation (arrows, circles) | ? | ? | ? | – | UNKNOWN |
| Auto-face-redact | ? | ? | ? | – | UNKNOWN |
| Compression / retry on poor signal | ? | ✓ (v3.5.2 Jul 2025 upload performance) | ? | – | HIGH |

### 6.11 Push / notifications

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| iOS native push | ✓ | ✓ | – (HE→Alice ✓) | – (FCM removed 2026-04-22) | HIGH |
| Android native push | ✓ | ✓ | – (HE→Alice ✓) | – | HIGH |
| PWA / browser push | ✓ (optii.app) | ? | ? | – | HIGH |
| SMS notifications to staff | ~ (manager SMS bumps) | ? | ✓ (MyHotelTeam schedule alerts) | ✓ (Twilio; replaced push) | HIGH |
| In-app notification preferences | ~ (OS-level) | ? | ? | – | MEDIUM |
| Deep-link from push to thread | ? | ? | – (HE→Alice ✓ "deep link into conversations") | – | HIGH |

### 6.12 Offline mode

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Offline detection banner | ? | ? | ? | ✓ | HIGH |
| Offline action queue + replay | ~ (v2.1.27/2.1.28 connectivity detection; not full queue) | ~ (upload retry; not full queue) | – (HE→Alice ✓ "continue work whenever you lose connection and sync") | – | HIGH |
| IndexedDB / local-first state | ? | ? | ? (HE→Alice ✓ implied) | ~ (shift-start timestamp only) | HIGH |
| Background sync on reconnect | ? | ~ | ✓ via Alice | – | HIGH |
| Hardware Wi-Fi recommendation | ✓ (Wi-Fi 6+ for Rush) | ? | ? | – | HIGH |

### 6.13 QR code

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| QR scan to open room card | ? | ? | ? | – | UNKNOWN |
| QR for password reset | ? | ? | – (HE→Alice ✓ manager-generates for staff) | – | MEDIUM |
| QR for asset/equipment scan | ? | ? | ? | – | UNKNOWN |

### 6.14 Personal stats (RA-facing)

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Today's progress | ✓ (credits breakdown on home) | ? (manager-only) | – (HE→Alice ✓ My Day progress) | ✓ (X of Y done) | HIGH |
| Week hours / minutes worked | ? | ? | – (HE→Alice ?) | – | UNKNOWN |
| Average minutes per departure | ✓ (Benchmark Report — manager-facing) | ✓ (analytics — manager-facing) | – (HE→Alice ✓ Daily Summary) | – | MEDIUM |
| Inspection pass / correction rate | ✓ (Benchmark Report — manager) | ✓ (manager-facing) | – (HE→Alice ?) | – | MEDIUM |
| Personal-best highlights | ? | ? | – (HE→Alice ?) | – | UNKNOWN |
| Self-serve stats visible to RA on phone | ~ (credits only) | – (stats are manager-framed) | – (HE→Alice ✓ Room Attendant Daily Summary) | ~ (progress bar only) | HIGH |

### 6.15 Settings

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Language toggle in-app | ✓ (implied; 21 locales) | ~ | ? | ✓ (EN/ES top-right button) | HIGH |
| Notification preferences | ~ (OS-level mostly) | ? | ? | – | MEDIUM |
| Profile edit | ? | ? | ? | – | UNKNOWN |
| Help / FAQ in-app | ✓ (Optii AI support chat v3.24) | ? | ? | – | HIGH |
| Logout | ✓ | ✓ | ✓ | – (unauthenticated public link) | HIGH |
| Live-location opt-in toggle | ? | ✓ ("Show Housekeepers' Location") | ? | – | HIGH |

### 6.16 Chat / messaging

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| 1:1 chat between staff | ✓ (Optii Chat) | ✓ (FlexChat) | – (HE→Alice ✓) | – | HIGH |
| Group chat | ✓ | ✓ | – (HE→Alice ✓) | – | HIGH |
| Auto-translated messages | ✓ (Inline Translation Jul 2024) | ✓ (since Jun 2021; both languages visible) | ✓ via Alice for guest comms | – | HIGH |
| Voice messages | ✓ (Job Assist intake) | ✓ (Flexie AI push-to-talk) | ? | – | HIGH |
| Photo / file attachments | ✓ | ✓ (Notice Board, FlexChat implied) | – (HE→Alice ✓) | – | HIGH |
| GDPR-compliant positioning | ? | ✓ (explicit WhatsApp replacement) | ? | – | HIGH |
| Read receipts | ? | ✓ (Notice Board) | ? | – | HIGH |
| Broadcast / notice board | ✓ (Chat 1-to-many) | ✓ (Notice Board) | – (HE→Alice ?) | – | HIGH |

### 6.17 Misc

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Lunch break punch in/out | ? | ? | ✓ (MyHotelTeam schedule + HE→Alice mobile) | – | HIGH |
| Live RA location on manager map | ? | ✓ (green pin when actively cleaning) | ? | – | HIGH |
| Realtime 2-way PMS sync | ✓ (start/end events) | ✓ | – (HE→Alice ✓ PMS sync) | ✓ (Supabase realtime → PMS via scraper / CUA) | HIGH |
| Squad / multi-RA jobs | ✓ (v3.26.0 Apr 2026) | ? | – (HE→Alice ✓ Advanced Auto-Assign) | – | HIGH |
| Component rooms (multi-room suites) | ✓ (v3.25.0 Mar 2026) | ? | ? | – | HIGH |
| AI / automation in mobile flow | ✓ (4 AI models incl. Job Assist) | ✓ (Flexie AI) | ? (HE→Alice ✓ AI work-ticket duplicate detection) | – (out of scope) | HIGH |

---

## 7. Gaps list

### 7.1 Hard gaps (Staxis has nothing; at least one competitor has a real implementation)

1. **Native iOS app** — Optii, Flexkeeping, Alice all ship native. Staxis is web-only.
2. **Native Android app** — same. Staxis is web-only.
3. **Installable PWA for the housekeeper page** — Optii has `optii.app` install path. Staxis manifest targets `/dashboard`, not `/housekeeper`.
4. **SAML SSO** — Optii since Aug 2023; Alice since v1.0.2. Staxis has only SMS magic link.
5. **Photo capture (anywhere)** — all three competitors have it. Staxis has zero photo handling.
6. **Photo proof on task completion (dedicated feature)** — Flexkeeping shipped v3.4.10 May 2025. Staxis: nothing.
7. **iOS native push notifications** — Optii, Flexkeeping, Alice all have it. Staxis explicitly removed FCM in April 2026 ("hostile onboarding step nobody completed") and went SMS-only.
8. **Android native push** — same.
9. **PWA / browser push** — Optii has it on optii.app. Staxis service worker is a kill-switch.
10. **Offline action queue + background sync** — Alice explicitly markets "continue work whenever you lose connection and sync updates once you regain." Staxis only detects offline; doesn't queue actions.
11. **20+ language support** — Optii (21 confirmed), Flexkeeping (English shell + 240+ content), Alice (multiple). Staxis: EN + ES only.
12. **Auto-translation of staff messages** — Optii (Inline Translation Jul 2024), Flexkeeping (since Jun 2021 with both-languages-visible). Staxis: no chat at all.
13. **Both-languages-visible side-by-side translation** — Flexkeeping flagship feature. Staxis: nothing.
14. **In-app chat / messaging** — Optii Chat, Flexkeeping FlexChat, Alice deep-link push. Staxis has zero in-app messaging — manager-to-housekeeper communication is Twilio SMS one-way.
15. **Voice issue intake (AI-structured)** — Optii Job Assist, Flexkeeping Flexie AI. Staxis: out of scope per Reeyen, but a confirmed competitor capability.
16. **Exception buttons beyond DND** — Optii has DND, NSR, DLA, Sleep Out, Skipped (5 of Reeyen's 6). Staxis has only DND.
17. **Cleaning type color coding** — Optii has an explicit 7-color palette; Flexkeeping has per-property custom colors. Staxis cards show CHECKOUT/STAYOVER/VACANT as text badges only.
18. **Reservation context on card (guest name, ETA, nights, special requests)** — all three competitors surface this. Staxis shows only VIP / Early badges.
19. **Checklists per room type** — Optii, Flexkeeping both have per-item checklists. Staxis: none.
20. **Manager notes on card** — Optii, Flexkeeping, Alice all support. Staxis: none.
21. **Reference photos (manager-uploaded)** — Optii supports via checklist photos. Staxis: none.
22. **Rush flag** — Optii, Alice both have explicit Mobile Room Rush. Staxis: none.
23. **Mark for inspection from RA app** — Optii has the toggle. Staxis: none.
24. **Squad / multi-RA jobs** — Optii v3.26.0 (Apr 2026). Staxis: none.
25. **Live location of RA on manager map** — Flexkeeping (green pin when actively cleaning). Staxis: none.
26. **Personal RA Daily Summary (own stats screen)** — Alice has "Room Attendant Daily Summary" and "My Day progress breakdown." Staxis: progress bar only.
27. **Notice Board / broadcast feed** — Flexkeeping since Jan 2022. Staxis: nothing.
28. **iPad / tablet layout** — Flexkeeping v3.6.4. Staxis: works in mobile browser only.
29. **Apple Vision / visionOS** — Optii new app, Flexkeeping both support. Niche but a confirmed bullet on their App Store listings.
30. **Add Note (separate from issue)** — Optii has it. Staxis only lets you write notes via the Report Issue modal.

### 7.2 Partial gaps (Staxis has a weaker version)

1. **UI translation depth** — Staxis has full EN + ES. Optii / Flexkeeping have 20+ language coverage with the same depth. Same feature, narrower scope.
2. **Status overview / counts** — Staxis shows "X of Y done · Z DND" in header. Competitors break it down into multiple tabs with richer counts.
3. **Symbol-heavy UI** — Staxis uses emojis (🚫⭐⚡★⟳✓). Competitors have purpose-designed icon libraries with broader vocabularies (arrival/departure persons, double-lock, NSR, DLA, etc.).
4. **Color coding** — Staxis colors status (in-progress blue, done green, DND gray, VIP red, early orange). Competitors also color cleaning *type* (departure vs stayover vs touch-up vs turndown) and let properties customize.
5. **Today's progress for the RA** — Staxis shows "X of Y done · Z%" only. Alice has dedicated "My Day" breakdown with credits + time.
6. **Issue reporting** — Staxis lets the housekeeper write a freeform note. Competitors offer structured fields (action / item / location / severity), photo attach, and auto-route to maintenance.
7. **Realtime sync** — Staxis subscribes to `rooms` + falls back to polling. Competitors confirm real-time PMS write-back; Staxis already has this via the CUA service so it's close to parity, just framed differently.
8. **Offline detection** — Staxis shows a banner only. Alice queues actions and replays on reconnect.
9. **Auth on shared devices** — Staxis's SMS magic-link works fine for one staffer per phone but doesn't fit a kiosked shared device (no PIN flow). Optii's Quick Access Code route hints at this; Flexkeeping doesn't appear to either.

### 7.3 Wins (Staxis has something competitors don't, or does it differently in a way worth keeping)

1. **SMS magic-link sign-in (zero-friction)** — no competitor documents this. Staxis's housekeeper opens a Twilio SMS and is in. Optii/Flexkeeping/Alice require an app install + login. The cost was push notifications (removed because of low install rates).
2. **Single-tap "Done"** — Staxis collapsed the Start + Done flow into a single tap on 2026-05-07 (server-derives `started_at` from prior cleanings + shift anchor). Optii has explicit Start/Pause/Resume/Complete; Flexkeeping infers it from timestamps. The Staxis pattern is simpler — fewer taps for the housekeeper — but it loses the supervisor-visible "pause" signal Optii uses.
3. **Undo with no time limit** — Staxis lets the RA undo a done room indefinitely via the visible "Undo" link. Optii had a 60-second wall-clock cutoff (Staxis removed theirs on 2026-05-07).
4. **Public link (no install, no app)** — the housekeeper page works in any browser. Competitors all require app install. This is a double-edged sword: zero friction to start, but no push, no app icon, no biometric.
5. **Full UI translation in the two languages we do ship** — Staxis's EN + ES are end-to-end translated (1492 lines of strings including all error messages, date formats, button labels). Flexkeeping's App Store metadata lists only English for the UI shell — they translate content, not the chrome.
6. **Per-page language state** — Staxis isolates the housekeeper's language preference from any admin/manager toggling on the same device (since the page is publicly linked and the language toggle persists to the staff record). Niche but clean.
7. **Idempotency + rate-limit on actions** — Staxis's `/api/housekeeper/room-action` has 90s dedup window + 200/hr rate limit per staff. Defensive against double-taps and accidents. Competitors don't document equivalent safeguards.
8. **Server-derived `started_at`** — Staxis derives clean-start time from shift anchor + prior cleanings rather than asking the RA to remember to tap Start. Removes a tap; the timing data is still complete. No competitor takes this approach.

---

## 8. Sources cited

### Staxis (own code)
- [src/app/housekeeper/page.tsx](src/app/housekeeper/page.tsx) — entry / staff pairing
- [src/app/housekeeper/[id]/page.tsx](src/app/housekeeper/[id]/page.tsx) — main housekeeper page (1404 lines)
- [src/app/api/housekeeper/room-action/route.ts](src/app/api/housekeeper/room-action/route.ts) — mutations (694 lines)
- [src/app/api/housekeeper/me/route.ts](src/app/api/housekeeper/me/route.ts)
- [src/app/api/housekeeper/rooms/route.ts](src/app/api/housekeeper/rooms/route.ts)
- [src/app/api/housekeeper/save-language/route.ts](src/app/api/housekeeper/save-language/route.ts)
- [src/app/api/housekeeper/exchange-code/route.ts](src/app/api/housekeeper/exchange-code/route.ts)
- [src/lib/translations.ts](src/lib/translations.ts) — EN + ES strings (1492 lines)
- [public/manifest.json](public/manifest.json) — PWA manifest (targets /dashboard)
- [public/sw.js](public/sw.js) — service worker (kill-switch)
- [HOUSEKEEPING_FEATURES.md](HOUSEKEEPING_FEATURES.md) — feature checklist (Sections 8 & 13)

### Optii
- [App Store — Optii Housekeeping (legacy, id861717884)](https://apps.apple.com/us/app/optii-housekeeping/id861717884)
- [App Store — Optii (new unified, id1534330415)](https://apps.apple.com/us/app/optii/id1534330415)
- [Google Play — legacy](https://play.google.com/store/apps/details?id=com.optiisolutions.housekeeping)
- [Google Play — new](https://play.google.com/store/apps/details?id=com.optii.topcat)
- [optii.app login](https://optii.app/login/access)
- [Optii.com housekeeping](https://www.optiisolutions.com/housekeeping)
- [Optii Chat product page](https://www.optiisolutions.com/chat)
- [Inline Translation press release (Jul 24, 2024)](https://www.optiisolutions.com/blogs/optii-breaks-barriers-with-inline-translation)
- [4 AI Models blog](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now)
- [Squad system / Pass-Fail / non-cleaning credits blog](https://www.optiisolutions.com/blogs/stronger-teams-smarter-operations)
- [Housekeeping Benchmark Report blog](https://www.optiisolutions.com/blogs/housekeeping-benchmark-report)
- [What's new in Optii](https://www.optiisolutions.com/blogs/whats-new-in-optii)
- [Help — Housekeeping job names, colors, symbols](https://help.optiisolutions.com/housekeeping-job-names-colors-and-symbols)
- [Help — DND / NSR / DLA exception statuses](https://help.optiisolutions.com/dnd-nsr-clean-rooms-and-double-lock-active-in-optii-housekeeping)
- [Help — Push notifications on Android](https://help.optiisolutions.com/how-do-i-turn-push-notifications-on-or-off-on-my-android-smartphone)
- [Help — Add favicon / install PWA](https://help.optiisolutions.com/how-can-i-add-the-optii-favicon-to-my-device-home-screen)
- [Help — Minimum system requirements](https://help.optiisolutions.com/optii-minimum-system-requirments)
- [Help — Tutorials in other languages](https://help.optiisolutions.com/optii-tutorials-in-other-languages)
- [Help — Getting started with Service & Chat](https://help.optiisolutions.com/getting-started-with-optii-service-chat)
- [Hotel Tech Report — Optii Housekeeping](https://hoteltechreport.com/operations/housekeeping-software/optii-housekeeping)

### Flexkeeping
- [App Store — Flexkeeping](https://apps.apple.com/us/app/flexkeeping/id1198674319)
- [Google Play — Flexkeeping](https://play.google.com/store/apps/details?id=si.creatriks.facility)
- [Flexkeeping housekeeping product page](https://flexkeeping.com/products/housekeeping-software)
- [Flexkeeping FAQ](https://flexkeeping.com/resources/faq)
- [Flexie AI product page](https://flexkeeping.com/flexie-ai)
- [Flexie AI launch product news](https://flexkeeping.com/product-news/flexkeeping-assistant)
- [Flexie AI — First 1000 use cases](https://flexkeeping.com/product-news/flexkeeping-ai-assistant-data-findings)
- [Automatic translations for staff comms (Jun 2021)](https://flexkeeping.com/product-news/automatic-translations-for-hotel-staff-communication)
- [Housekeepers' Location feature (Jun 2024)](https://flexkeeping.com/product-news/housekeepers-location)
- [Notice Board (Jan 2022)](https://flexkeeping.com/product-news/notice-board)
- [Analytics dashboard blog](https://flexkeeping.com/blog/9-ways-our-new-dashboard-declutters-housekeeping-data)
- [Digital housekeeping checklist blog](https://flexkeeping.com/blog/housekeeping-checklist)
- [Multicultural teams blog](https://flexkeeping.com/blog/how-ai-automation-can-empower-multicultural-hotel-teams)
- [Collaboration suite](https://flexkeeping.com/products/hotel-collaboration-software)
- [Maintenance suite](https://flexkeeping.com/products/hotel-maintenance-software)
- [Palace Resorts case study](https://flexkeeping.com/case-studies/palace-resorts)
- [Clarion The Hub case study](https://flexkeeping.com/case-studies/clarion-hotel-the-hub)
- [Apaleo Store — Flexkeeping (OAuth scopes)](https://store.apaleo.com/apps/flexkeeping)
- [Terms of Use](https://flexkeeping.com/terms-of-use-for-flexkeeping-software-as-a-service)
- [Mews Matt Talks EP55 — Luka Berger](https://www.mews.com/en/resources/matt-talks/ep55-walkie-talkies-ai-and-the-remaking-of-housekeeping-with-luka-berger)
- [Mews acquires Flexkeeping (Sep 30, 2025)](https://www.mews.com/en/press/mews-acquires-flexkeeping)
- [Mews housekeeping software (post-acquisition)](https://www.mews.com/en/products/housekeeping-software)
- [Mews help — Login to mobile Flexkeeping app](https://help.mews.com/s/article/login-to-the-mobile-app?language=en_US)

### Hotel Effectiveness + Alice (Actabl)
- [App Store — Hotel Effectiveness (manager)](https://apps.apple.com/us/app/hotel-effectiveness/id1456017147)
- [Google Play — Hotel Effectiveness (manager)](https://play.google.com/store/apps/details?id=com.hoteleffectiveness.myhoteleffectiveness)
- [App Store — MyHotelTeam (employee timeclock)](https://apps.apple.com/ca/app/myhotelteam/id1483596888)
- [Google Play — MyHotelTeam](https://play.google.com/store/apps/details?id=com.myhotelteam)
- [PerfectLabor product page](https://actabl.com/labor-management-software/perfectlabor/)
- [PerfectTime product page](https://actabl.com/labor-management-software/perfecttime/)
- [Hotel Tech Report — Hotel Effectiveness](https://hoteltechreport.com/operations/scheduling-labor-management/hotel-effectiveness)
- [App Store — Alice by Actabl (id6739638710)](https://apps.apple.com/us/app/alice-by-actabl/id6739638710)
- [Google Play — Alice by Actabl](https://play.google.com/store/apps/details?id=com.actabl.alice.android)
- [App Store — ALICE Staff (legacy)](https://apps.apple.com/us/app/alice-staff/id971004611)
- [Actabl — Alice product page](https://actabl.com/alice/)
- [Actabl — Housekeeping product page](https://actabl.com/operations-software/housekeeping/)
- [Hotel Tech Report — Alice Housekeeping](https://hoteltechreport.com/operations/housekeeping-software/alice-housekeeping)
- [Hotel Tech Report — ALICE App](https://hoteltechreport.com/operations/collaboration-tools/alice)
- [Actabl Housekeeping Refresh (Sept 2024)](https://actabl.com/news/actabl-introduces-alice-housekeeping-refresh/)
- [IxDA — Innovating Housekeeping with ALICE](https://ixda.org/video/innovating-housekeeping-with-alice/)
- [Alice — Log in with SSO](https://aliceplatform.atlassian.net/wiki/spaces/ALICEKB/pages/1788215313/Log+In+with+Single+Sign-On)
- [ALICE real-time translation press release (2015)](https://www.prnewswire.com/news-releases/alice-launches-first-ever-hospitality-app-with-real-time-translation-between-hotel-guests-and-staff-300097497.html)
