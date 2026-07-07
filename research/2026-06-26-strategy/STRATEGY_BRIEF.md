# Staxis — Strategy & Ideas Brief

> ## ⚠️ Verification update — read this first
> After this brief was written, an 11-agent read-only pass checked its launch-critical claims against your actual code. Most held up. **Three cautions in this brief turned out to be FALSE ALARMS — ignore them:**
> - ✅ **The AI agent does NOT report fake zeros.** It reads live room data correctly (dirty / in-progress / clean / DND / issues / help). You can demo "Ask Staxis" freely — just make sure today's rooms are seeded.
> - ✅ **Letter-prefixed room numbers (e.g. "A12") are NOT silently dropped.** They're accepted, and bad input throws a *visible* error, not a silent drop. Only numeric *ranges* like "101-110" must be numeric — list odd suites individually.
> - ✅ **Owner signup does NOT expire in ~60 min.** Progress is saved server-side and resumable; the login auto-refreshes; the join code is valid 7 days. Onboarding does not have to be one sitting.
>
> **Confirmed real — act on these:**
> - ✅ **Read-only PMS** (no write-back exists). Staff still mark rooms clean *inside Choice Advantage*; Staxis sees it within ~30s. Pitch as the layer on top.
> - ⚠️ **The staffing/headcount feature produces nothing today** — not zeros, but an outright "no prediction": the ML service still reads the old `plan_snapshots` table that the rebuild emptied, and every ML cron is disabled. Needs data re-wiring **and** crons re-enabled. Don't demo it.
> - ✅ **Dashboard money/KPI charts are demo-only for test properties** (gated on `is_test`). Don't present them as the hotel's real data.
> - ✅ **Invite/onboarding email is OFF in prod** — copy/paste the join link yourself.
> - ✅ **The CUA cost cap can fail-open** on a DB error (allows spend). Watch spend during connect.
> - ✅ **Two divergent AI agents exist** (small team-chat vs. the 36-tool main agent), model routing off.
>
> **One correction:** there is **no `/feed` page at all** — the signed-in home is `/dashboard`. "Make /feed real" in the roadmap is *unbuilt scope*, bigger than it looked.
> **Mild good news:** the cohort fields (brand/region/size_tier) that power day-1 predictions are likely **already set** for Comfort Suites (the wizard sets them; a past backfill set this property). Just confirm via `/admin/ml-health`.
>
> Full file:line evidence → [VERIFICATION.md](./VERIFICATION.md).

## 1. TL;DR

- **One thing before anything else:** the Choice Advantage connection is your entire launch. The robot's map for *this exact hotel* has failed and re-failed (burning $20–25 each time). Pre-connect it yourself days ahead, confirm real rooms/arrivals are flowing, and treat "PMS green" as a hard prerequisite for booking the session. If it's red, don't start.
- **Your flagship labor-savings AI is silently broken in the live code.** The "how many housekeepers tomorrow" engine reads a database table that was deleted in your rebuild, and its automatic schedule is turned off. It returns zeros today. Either quietly hide it for go-live or fix it first — do not demo it.
- **The product is far deeper than a solo-built MVP has any right to be** — three real engines (the 24/7 PMS robot, a genuine ML stack, a 36-tool AI agent), but the *write-back* half (Staxis updating the PMS) doesn't exist yet, so pitch read-only.
- **Your moat is real and singular:** you read any PMS with zero integration AND you own the back-of-house floor. No competitor — not Quore, not Canary, not Choice's own CHARLIE — has both. Everything strategic flows from compounding that.
- **The market just confirmed your bet from three sides:** labor is the #1 hotel pain (housekeeping the most unfilled role), every guest-AI tool stops at "creates a ticket" (you can actually fix the room), and consolidation (Mews bought Flexkeeping, Plusgrade bought Oaky) means rivals are *buying* the bundle you already are.
- **Choice is now your frontier-neighbor, not just your customer's brand.** CHARLIE (launched May 7, 2026) coaches staff and touches maintenance/guest comms. Never pitch "Choice gives you nothing" — it's false. Pitch *complementary*: "Choice runs corporate pricing; Staxis runs your floor."
- **Win the first hotel by making it provably stick.** 60–70% of SaaS churn happens in the first 30 days. Your edge is zero-migration onboarding ("watch the robot read your PMS live") — turn your scariest technical step into the wow.

## 2. Where Staxis stands today

Staxis is genuinely impressive: a clean, well-architected platform spanning ~20 product areas with three real engines behind it, strong security discipline, bilingual frontline pages housekeepers can actually use, and honest empty-states. That's the real strength — **breadth + depth + a defensible data-ingestion moat (the CUA) that no competitor has.** The soft spots are equally real and concentrated in exactly the wrong place for launch week: the flagship "decision inbox" home (`/feed`) is sample data, the dashboard's money charts are demo-only, the labor ML is *code-verified broken* (reads a deleted table), the AI agent reports hardcoded zeros for live housekeeping state, you can't write back to the PMS, and the single most fragile thing in the whole system — the from-scratch PMS learn — is the thing that runs during onboarding. The pattern: **the read/ingest, ML architecture, and access-control layers are mature; the "last mile" that the customer actually sees on day one is thin or broken.** None of it is fatal, but it means the gap between your polished demo and a real hotel's empty day-1 account is the single biggest experience risk.

## 3. The 5 biggest opportunities

**1. Make the back-of-house engine your unfair advantage everywhere — "we don't just answer, we finish the work." (Effort: L, builds on: work orders + on-shift roster + SMS pages + CUA, all built)**
This is your one structural moat and it shows up in three of the biggest market gaps at once: guest messaging (everyone files a ticket; you assign the on-shift engineer + track SLA + text the guest back), upsell (everyone sells blind; you only sell the early check-in if a clean room *actually exists*), and brand-QA (everyone flags failures; you turn a failed Choice standard into an assigned, re-inspected, evidence-logged work order). Why it matters: it's the one thing Canary, Oaky, Quore, and CHARLIE *structurally cannot copy* without rebuilding an ops platform. Lead every pitch with it.

**2. Brand-QA closed loop + "QA Evidence Pack." (Effort: L, builds on: existing compliance + inspections + photo engine, currently unlinked from nav)**
A failed Choice QA or missed PIP can *terminate a franchise* — the highest-stakes fear a GM owns, and the #1 reason they keep Quore (the Choice Qualified Vendor). Pre-load Choice's actual standards as a continuous self-audit; on any failure auto-open an assigned task, re-inspect, timestamp, and produce a one-button evidence packet for the annual visit. Nobody closes finding → action → proof. This is your sharpest *displacement* wedge, not just feature parity, and the path to brand-approved-vendor status later.

**3. The agentic, dollar-denominated headcount/OT optimizer. (Effort: L after the ML repoint, builds on: ML optimizer + schedule auto-assign)**
Every labor incumbent (Hotel Effectiveness, UniFocus, Inn-Flow) stops at "forecast + alert"; none drafts the named, overtime-clean crew and defends each shift. Room-attendant OT is up 10.3% YoY because "scheduling standards aren't flexing fast enough with demand" — and your live 30-second PMS occupancy is exactly the fast input they lack. Make it a one-tap card: *"5 housekeepers tomorrow, not 6 = ~$X saved"* and *"this puts Maria into OT Thursday — swap to José, save $58."* **Prerequisite: fix the ML data source (it reads a deleted table).** This lands directly on the #1 verified buyer pain.

**4. Zero-migration onboarding as the GTM headline + the "watch the robot read your PMS" wow. (Effort: M, builds on: CUA + live mapping console already exist)**
The verified #1 cause of hotel AI-project failure is data readiness (Gartner: 60% of under-prepared projects abandoned through 2026); 69% of hoteliers cite legacy integration as the top switching pain. Every competitor runs a multi-week migration. You don't. Turn the scariest onboarding step into the closing argument: the GM watches their *real* data stream in within minutes. Because the Choice recipe is shared per PMS-family, the marginal cost of onboarding hotel #2+ approaches zero — "live in days, no migration" is true *and* a moat.

**5. Two-way conversational SMS through the 36-tool agent. (Effort: M, builds on: agent brain + tools + role-scoping + outbound SMS, only inbound bridge missing)**
Frontline staff (50–75% turnover, multilingual, device-sharing) won't install an app — SMS has a 98% open rate. Today inbound texts only switch language; a housekeeper texting "mark 214 clean" or "I'm sick today" gets a dead-end ack that reads as "the AI is broken." Wiring inbound SMS to the agent meets the real workforce where they live, drives multi-role activation (which cuts churn ~3x), and is a capability no competitor has (SMS + translation + *live ops awareness* + an AI that closes the loop).

## 4. Things you probably don't know

- **An official Choice Advantage data path likely exists** and the strategy nearly missed it. SkyTouch /CONNECT is self-certifying, has no setup fee, and already lists a *live Housekeeping interface category* with four third-party vendors (including Quore). An official feed would be far more reliable than your scraper, which has broken repeatedly on Choice's UI/Okta changes. **Worth investigating in parallel** — ask SkyTouch directly. Keep the CUA as the launch plan (approval may be slow), but this could de-risk the whole platform.
- **There's a live, funded, name-collision competitor: hotelops.ai** — near-identical positioning (housekeeping/maintenance/guest/compliance/multilingual). You need to know it by name before any sales conversation, and lock down the Staxis brand/SEO. _[Verified correction: `hotelops.ai` turned out to be a small Kochi-India housekeeping-checklist app with no disclosed funding — **not** the real threat. The genuine direct competitor is **Lance** (Y Combinator W26, ~$5M seed, 50+ hotels) — same wedge (vision-AI drives a legacy PMS with no API), but aimed at larger branded groups and guest-comms, not the solo economy-franchise owner you serve. Plus the medium-term squeeze: franchisors shipping free owner-facing AI (Choice's CHARLIE, Wyndham's 250 live agents). Full teardown in Appendix F.]_
- **Choice already provides revenue management** — ChoiceMAX (IDeaS-powered), 9 of 10 franchisees opted in, 93% of price recs accepted. **Do not build a room-rate engine for Comfort Suites** — it's effectively brand-provided and a wrong auto-price is instantly visible to corporate. Upsell, by contrast, is *not* brand-mandated — that lane is wide open.
- **Choice Advantage's franchise tier likely never exposes revenue/ADR/RevPAR.** Those data tables are built but will stay empty for this customer. Lead your value story with labor + inventory, never revenue dashboards.
- **Competitor pricing anchors:** Quore ~$135–171/mo per property (unlimited users), the incumbent you'll be compared to — and it's *documented* as glitchy on mobile, weak on reporting, and overwhelming for small hotels. Canary takes **0% of upsell revenue** (consider matching). HelloShift publishes ~$1.25–$5.60/room/month for voice — that's the price wall. Most AI-ops rivals (Optii, Flexkeeping) hide pricing behind NDAs; **publishing yours is itself a wedge.**
- **Consolidation is doing your positioning for you:** Mews bought Flexkeeping (Sept 2025), Plusgrade bought Oaky (Oct 2025), Knowcross→Unifocus, Optii→MCR, Nuvola→Sabre. The pitch writes itself: *"They're acquiring companies to assemble the bundle Staxis already is."*
- **A claim to verify before scoping:** the brief assumes write-back "just needs one recipe authored" and that `/feed` "just needs wiring." The critic could not find `seed-write-recipe.ts` or a `/feed` page in the repo — both may be more build than they look.

## 5. AI-native moonshots

- **The guest-to-floor agent that actually fixes the room.** Guest texts "AC broken in 214" → real work order → auto-assigned to the on-shift engineer → SLA tracked → guest texted "tech on the way, ~20 min" — bridging guest English ↔ housekeeper Haitian Creole inside one thread. The entire crowded guest-AI category stops at ticket-creation. This is category-defining.
- **Voice-to-PMS write-back on a no-API PMS.** A housekeeper says "214 is ready" in their language and the CUA flips it in Choice Advantage where *no API exists*. Every rival integrates via API; Flexie now rides Mews. None can act on Choice Advantage. This turns Staxis from read-only into a true operator and is a structural moat for the exact PMS your customer runs. (Verify the write-recipe scope first.)
- **The proactive loop that closes itself.** Your nudges engine already detects "room 305's AC failed 3× in 60 days" — let it auto-draft the recurring-fault work order *and* attach the warranty-recovery alert ("still covered until [date] — don't pay out of pocket"). Software-only predictive maintenance from work-order history + asset age + occupancy load, zero IoT hardware, for a single limited-service hotel — a thing locked to luxury chains today.
- **The AI go-live playbook where the robot does the setup.** Cloudbeds assigns a human onboarding coach per property — un-scalable for a solo founder. Because your CUA can read the PMS and auto-fill the product, you can make go-live *AI-driven*, not CS-bound. That's how one person onboards 20 hotels.

## 6. Your moat

**What you uniquely have:** floor-level data nobody else can assemble — per-clean, per-housekeeper timing with fatigue/route context; second-by-second room-state history the PMS itself discards; real consumption rates; attendance-vs-callout truth — all originating from mobile taps and the CUA, not a database export. Plus the compounding cross-customer asset: **every PMS family mapped once is reusable for free by every future hotel on that family.**

**The honest caveat:** today the reservoir is empty — `cleaning_events=0`, `model_runs=0`, and even Comfort Suites' cohort keys (brand/region/size) are blank. The moat is 100% latent.

**How to compound it so incumbents can't catch up:**
1. **Fill the reservoir on day one** — set brand/region/size_tier (near-zero effort, switches on cold-start predictions), confirm the CUA is writing room-status, and *physically walk the first crew through tapping Start/Done.* The entire ML value prop is hostage to that one human behavior.
2. **Lead the sales story with the labor-productivity dataset** — it's defensible on a *single* hotel before any network exists.
3. **Make "What Staxis learned about your hotel this week" the signature surface** — agent memory + operational learning that's visibly more useful in month 6 than month 1 = a real switching cost.
4. **Unify your two AI brains and turn on model routing** — you're currently fragmenting your own strongest moat (one cross-department agent) into two divergent ones, and paying Sonnet rates for everything. Consolidating raises team-chat from 3 to 36 tools and cuts agent cost 30–60%.

## 7. Before the first hotel (next few days)

**🔴 BLOCKERS — close all of these or don't start the session:**
- **Pre-connect Choice Advantage yourself, days ahead.** Run the recipe pre-build, confirm on `/admin/property-sessions` that the hotel is "alive" with real rooms/arrivals/departures flowing (not zero) and the map shows "promoted." This prevents the $20+ live-learn hang. *The owner's session must never be the first time the live learn runs.*
- **Have PMS login + MFA ready.** Log in manually first to clear/trust the device; know which phone gets the MFA text; keep the live mapping board open during the session (you have ~10 min to type any code). Confirm the Okta-nag fix is still in the live path.
- **Never build/deploy from this Mac.** The local checkout is 298 commits behind live with files showing as deleted — shipping from it could clobber recent fixes (2FA, sign-in, dashboard honesty). Work only from a fresh checkout off the live code.

**🟠 HIGH — decide/mitigate before go-live:**
- **Pitch read-only.** Staxis can't write back to the PMS yet. Frame it as the operations layer *on top of* the PMS, not a replacement that updates it. Marking a room clean in Staxis won't mark it clean in Choice Advantage.
- **Hide or fix the ML staffing feature** — it returns zeros against the live database (reads a deleted table; crons off). Don't demo it broken.
- **Don't demo `/feed` or the demo-property money charts as if they're the customer's live data** — the gap to their empty account is jarring. Demo what's real day-1: live room status, housekeeper SMS flow, PMS occupancy, inventory.
- **Steer the live "Ask Staxis" demo** away from in-progress/DND/issues/help counts (hardcoded zeros) toward occupancy, room status, inventory, knowledge search.
- **Spot-check room numbers** — anything not 3-4 digits (a letter-prefixed suite) is silently dropped. Probably fine for a Comfort Suites; verify anyway.
- **Confirm crew adoption of Start/Done taps** in person — the whole data flywheel depends on it.

**🟡 MEDIUM/LOW:**
- Invite email is OFF in prod — copy/paste the join link yourself.
- Owner's signup session expires ~60 min — do onboarding in one focused sitting.
- Watch the spend view during connect (cost cap can fail-open on a DB hiccup).
- Consider leaving voice OFF for the first customer (cost + separate trust surface, unproven day-1 value).
- Check `/admin/property-sessions` + doctor twice daily for 48 hours; **write down today's baseline of known doctor reds** so a *new* red stands out.

## 8. How to work better

- **Mechanize the stale-checkout guardrail.** This is your single easiest way to break the live hotel. A pre-deploy check that refuses to build from the Desktop tree and always uses a fresh worktree off origin/main pays for itself the first time.
- **Build the founder-facing one-screen readiness checklist** (code valid? account created? email verified? PMS promoted & live? feeds flowing? staff active?). Turns go-live verification from a multi-page scavenger hunt into a 10-second glance — and scales to hotels #2–#20.
- **Add a golden-snapshot data-quality watchdog with an SMS digest to your phone** — alert only on drift ("room-status feed returned 0 rows 4 polls running" / "only 30% of cleans have Done taps"). Your self-repair only catches *total* zero-row failures; partial/wrong data writes silently.
- **Turn the dead-letter state into an auto-diagnosed alert.** When a hotel's session gives up after 5 failed logins, auto-run the doctor + a login probe and text you the likely cause. Today it stops silently and the GM just sees an empty app.
- **Build a 30/60/90 hotel-health dashboard** (feeds live, staff active, days-since-use, red/yellow/green). For a one-customer-then-scale business, catching a stalling Comfort Suites in week 2 instead of month 3 is existential — this is the CS team you don't have.
- **Add a nightly regression gate** that exercises the agent tools and public pages against a seeded real-data Test Hotel. You can't manually QA 35 tools and 20 sections each release; the RLS silent-empty bug has bitten three times in eight days.
- **Keep using your own build workflow** (plan → self-verify → review) — it's the right instinct. The above just automates the verification so *you* stop being the bottleneck.

## 9. Competitive cheat-sheet

| Competitor | What they do | Segment | What to steal | Where you beat them |
|---|---|---|---|---|
| **Quore** | Ops "control center" (FD/HK/maint), Choice Qualified Vendor | Branded select-service | Brand-standard inspection tooling; per-property unlimited-user pricing | No-integration PMS ingestion (their #1 complaint), simpler mobile, ML labor optimizer, all-in-one bundle |
| **Canary** | Guest messaging + AI Voice + upsell; 9 HotelTechAwards | All segments, incl. Choice | AI Voice for unanswered calls; 0% upsell cut | You own back-of-house — you fix the room, not just file the ticket |
| **Hotel Effectiveness (Actabl)** | Labor BI, minutes-per-room standards | All, portfolio-heavy | MPOR/CPOR fluency; ADP payroll handoff | Agentic scheduling that *drafts* the OT-clean crew; live PMS occupancy |
| **Optii** | AI clean-time prediction + routing | Large/luxury | Predicted clean-time, attendant routing (table stakes) | Limited-service price/scope; full ops bundle, not just HK |
| **Flexkeeping (Mews)** | HK + maint + voice-to-task (Flexie) | Mid→full-service, Mews PMS | Voice-to-task, 240-language translation | Works on Choice Advantage (Mews-only now); no-migration |
| **CHARLIE (Choice)** | Staff coaching AI, surfaces brand standards | Choice franchisees (free/bundled) | Nothing to copy; integrate around it | It *tells* the standard; you make sure it got *done* and prove it |
| **hotelops.ai** | AI HK/maint/guest/compliance (name collision) | Broad | Watch closely | Limited-service focus, CUA zero-integration, bilingual no-login frontline |
| **Inn-Flow** | Accounting + labor + payroll | Select-service (your segment) | CPOR + labor-%-of-rev dashboards | AI that *acts* vs. dashboards; pre-emptive OT prevention |

## 10. Roadmap split

**Quick wins (this week — mostly pre-launch):**
- Pre-connect & promote the Choice Advantage map; confirm real feeds flow.
- Hide or soft-label the broken ML staffing feature; fix the data-source repoint if time allows (it's the highest impact-to-effort change you have).
- Seed brand/region/size_tier on the hotel record (switches on cold-start predictions).
- Founder readiness checklist + baseline-doctor-reds note.
- Stale-checkout build guardrail.
- Warranty-recovery alert (data already captured — near-free "Staxis paid for itself" proof).
- Publish transparent pricing; consider matching Canary's 0% upsell cut.

**Big bets (this quarter):**
- Fix the ML stack (repoint to daily_logs + re-enable schedule) → ship the dollar-denominated headcount/OT card.
- Brand-QA closed loop + QA Evidence Pack (your Quore-displacement wedge).
- Two-way conversational SMS through the agent.
- Guest-message → real-operations loop.
- Build the housekeeper-workflow overlay table (kills the agent's blind zeros).
- Make `/feed` real with 3 live card types (verify the surface exists first).
- Investigate the official SkyTouch /CONNECT path in parallel with the CUA.
- Unify the two AI brains + turn on model routing (margin lever).
- 30/60/90 health dashboard + portfolio pricing tier (the retention/expansion motion).

---

One last framing for the pitch, since it's the throughline of all the market research: **you are the neutral, owner-owned floor brain that the franchisor will never build — because the franchisor's AI optimizes the franchisor's revenue, and the owner's #1 pain is labor cost.** "Choice runs your pricing; Staxis runs your floor — and proves you'll pass QA — for any brand, owned by you." That positioning survives even if Comfort Suites adopts Choice's entire AI suite.
