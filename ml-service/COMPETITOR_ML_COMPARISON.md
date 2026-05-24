# Staxis ML vs. Optii / Flexkeeping / Hotel Effectiveness — Competitor Comparison

*Research-only document. Last updated: 2026-05-24. Branch: `feature/ml-parity-research`.*

---

## Executive summary

The headline finding is simpler than expected: **none of the three competitors has a deeper or more rigorous core ML stack than Staxis already has today.** Staxis's Bayesian demand model with cohort priors, per-(room × housekeeper) supply model, Monte Carlo headcount optimizer, statistical auto-rollback (Wilcoxon + BH-FDR fleet-wide), shadow-mode promotion soak, walk-forward backtest, and cold-start honesty labels are all uncommon in this market — they don't exist in any of the three competitors. **Optii** has one genuinely strong ML feature (continuously-retrained per-job cleaning-time prediction that drives a deterministic route engine) and a multimodal LLM-likely Job Assist for issue reporting; everything else marketed as "AI" is rules-based. **Flexkeeping** has exactly one real ML feature (Flexie AI voice assistant with auto-translation) and rules-based everything else; the future story is Mews's roadmap "agentic AI" but the operations agent is unshipped. **Hotel Effectiveness** has effectively zero learned ML in the housekeeping/labor product itself — its strength is statistical peer benchmarks over ~5,000 properties' payroll data; the only real ML in the Actabl family lives in sister products (ProfitAbility revenue-anomaly detection, AI Asset Setup CV in Transcendent, and a data-normalization patent with an ML mapping component).

Where the competitors are ahead is in **breadth of product surfaces, not depth of ML rigor**: voice-to-task in the housekeeper's native language (Optii + Flexkeeping), live auto-translation across staff languages (Optii + Flexkeeping), photo-to-task multimodal extraction (Optii), in-app LLM helper (Optii), predictive maintenance ETA (Optii), wage benchmarking from peer data (Hotel Effectiveness), and route mapping per attendant (Optii). The gaps list at section 6 enumerates these one by one — none of them require Staxis to throw out the existing stack; they're additive product surfaces, mostly LLM-shaped, that the three competitors have shipped over the last 18 months.

---

## 1. Staxis ML — what we have today (audit)

Read directly from `ml-service/` on `feature/ml-parity-research` (2026-05-24). Production status, model class, and known issues are all sourced from the README + the code, not memory.

### Architecture overview

Three-layer hierarchical model + a parallel inventory layer. All models are per-property; no cross-hotel inference (cross-hotel data is only used to build cold-start priors).

| Layer | What it predicts | Model class | Inputs | Output | Status |
|---|---|---|---|---|---|
| L1 Demand | Total cleaning minutes for tomorrow | Bayesian conjugate Gaussian-Inverse-Gamma (cold-start) → XGBoost-quantile (after 500 events) | total_checkouts, stayover_day_1_count, stayover_day_2plus_count, vacant_dirty_count, occupancy_pct, day_of_week | Quantile band: p10, p25, p50, p75, p90, p95 minutes | **Live** (Bayesian path). XGBoost training works; XGBoost inference flag `XGBOOST_INFERENCE_READY=False` fleet-wide. |
| L2 Supply | Per-(room × housekeeper) cleaning time | Same as L1 (Bayesian → XGBoost-quantile) | day_of_week, occupancy_at_start, is_checkout, stayover_day_2, room_floor, one-hot room_number, one-hot staff_id | Quantile band per row: p25, p50, p75, p90 | **Live**. Feature set v2 — learns "room 305 takes +5 min" and "Cindy is faster than Astri." |
| L3 Optimizer | Recommended headcount for tomorrow | Monte Carlo (10K draws) over L1+L2 quantiles, LPT bin-packing across H workers | L1+L2 predictions, per-property `shift_minutes`, target_completion_prob (default 0.95) | recommended_headcount, achieved_completion_probability, full curve, sensitivity (one HK sick, +5 checkouts) | **Live** but optimizer cron paused as of 2026-05-13 (per code comment); recommendations served on-demand via Schedule tab. |
| Inventory rate | Daily usage rate per (property × item) | Bayesian conjugate (cold-start cohort prior → fitted) → XGBoost-quantile (gated) | item history (count events), industry-benchmark seed, cohort prior | predicted daily rate + predicted_current_stock for Count Mode auto-fill | **Live**. Drives "days until out" badges + reorder list. Shipped 2026-05-22 honesty pass. |

### Key engineering invariants (all 4 layers)

- **Cold-start honesty contract** — every prediction tagged `is_cold_start: true|false`. UI labels cold-start rows as "Industry estimate · learning," fitted rows as "AI recommendation." `optimizer_results.inputs_snapshot` carries `l1_is_cold_start`, `l2_any_cold_start`, `used_l2_supply`. When both backing layers are cold-start, the completion-probability curve is OMITTED (set to `[]`) so the UI can't misread bin-packing variance as a confidence band.
- **Activation gates** — a model only goes live when (1) training_row_count ≥ 500, (2) validation_mae < 5, (3) beats_baseline_pct ≥ 20% over static rules, AND (4) two consecutive runs pass all of the above. Single lucky run can't flip activation.
- **Promotion safety gate (Phase 4a)** — if an active fitted model already exists and a new fit would normally activate, the new fit ships as `is_shadow=true` for a 7-day soak. The cross-layer `ml-shadow-evaluate` cron promotes only if `shadow.validation_mae <= active.validation_mae × 1.05`.
- **Statistical auto-rollback (Phase 7 v2)** — daily cron runs paired Wilcoxon signed-rank test of active model errors vs same-DOW naive baseline, with 14-day cooldown and Benjamini-Hochberg fleet-wide FDR correction at α=0.05. Currently in dry-run mode (`AUTO_ROLLBACK_DRY_RUN=true` default); logs "would-have-fired" events for review.
- **Walk-forward backtest** — `scripts/backtest_housekeeping.py` replays 8 weeks of real `cleaning_events` weekly, reporting honest out-of-sample MAE separately for fitted days vs cold-start days. Read-only by construction (ReadOnlySupabaseClient proxy). Refuses to report a headline number if `days_fitted < 14`.
- **Per-property advisory locks** — concurrent training on the same property serializes via `pg_try_advisory_lock(hashtext(property_id || ':' || layer))`. Different properties train in parallel.
- **Feature snapshots** — every prediction writes its full feature vector to `demand_predictions.features_snapshot` (jsonb) for post-hoc debugging and drift audits.
- **Deterministic Monte Carlo** — seeded per `(property_id, prediction_date)` with full 128-bit SHA digest so the same input always gives the same output (auditable). Common random numbers across H values means adjacent headcount values can't flip purely from MC noise.

### Cross-hotel cohort priors

Aggregator endpoints `/train/inventory-priors`, `/train/demand-priors`, `/train/supply-priors` recompute cohort prior tables from network data (last 90 days). Cohort key is `<brand-region-size_tier>`. New hotels get warm-started from `cohort-aggregate` priors (≥5 hotels) or fall back to `industry-benchmark` seeds. This is the only place cross-hotel data flows.

### Where ML surfaces in the product

- **Schedule tab** (`src/app/housekeeping/_components/ScheduleTab.tsx`) — shows recommended headcount with the "AI recommendation" / "Industry estimate · learning" / "Industry estimate · learning (capacity unavailable)" labels depending on backing-layer status.
- **Inventory page** — "days until out" badges on each item (`SimpleSheet`, `Sidebar`, `ReorderPanel`). Suffix `ai` (fitted) or `rule` (cold-start). Em-dash for items with no history.
- **Admin ML page** (`/admin/ml`) — system health, overrides, timeline of training runs, backtest tile, auto-rollback fire log.

### Cron jobs

- `ml-train-demand` — weekly per-property
- `ml-train-supply` — weekly per-property
- `ml-train-inventory` — weekly per-property
- `ml-aggregate-priors` — weekly fleet-wide
- `ml-run-inference` — daily per-property (writes tomorrow's predictions)
- `ml-predict-inventory` — daily per-property
- `ml-shadow-evaluate` — daily (promotes/rejects shadow models)
- `ml-auto-rollback` — daily 06:45 CDT (dry-run by default)
- `ml-retention-purge` — periodic cleanup

### Known issues / open follow-ups

- **XGBoost inference flag is FALSE fleet-wide** — `XGBOOST_INFERENCE_READY=False` in `ml-service/src/layers/xgboost_quantile.py`. Training side handles graduation; inference side at `ml-service/src/inference/inventory_rate.py:261-265` returns `predicted: False` for XGBoost runs. To turn it on: wire deserialization from Supabase Storage, then flip the flag. DO NOT flip without the deserialization.
- **Optimizer cron paused** since 2026-05-13 per code comment. Recommendations still served on-demand to Schedule tab.
- **L1 demand model uses only 6 features.** Doesn't yet know about VIPs, group blocks, packages, late-checkout flag, weather, local events. All of those exist in the rules-engine inputs spec (HOUSEKEEPING_FEATURES.md §2) but are not fed into the ML model today.
- **No anomaly detection on individual clean times.** A clean that takes 2× normal isn't flagged ("something's wrong with this room or this RA").
- **No quality prediction per housekeeper.** Inspection pass rate is tracked descriptively but not predictively (no "Maria has 92% pass rate, less inspection rigor warranted").
- **No photo AI.** Inspection photos aren't scored, maintenance issues aren't auto-categorized from photos.
- **No voice assistant.** Not even speech-to-text on issue reporting.
- **No mid-day rerouting.** Schedule is set at start of day; sick-callout recovery is manual.
- **No demand signal beyond occupancy.** No weather, no local-event calendar, no holiday-adjacent surge prediction (beyond fixed US federal + Texas school holidays hardcoded in `features/calendar.py`).

---

## 2. Optii ML features

**Company snapshot.** Founded 2006, Sydney → Austin TX. CEO Katherine Grass (ex-Amadeus Ventures). Acquired Dec 2021 by hotel owner-operator MCR, operates as arms-length subsidiary. Claims 1,000+ hotels, 10M+ rooms, 27,000+ users. Jan 2023: publicly announced a Data Analytics team to "double down on advanced predictive technology." The Mar 2025 blog post *AI in Hotel Operations: 4 Models Working Inside Optii Right Now* is the primary technical source; they explicitly name only four production ML/AI capabilities.

### 2.1 Housekeeping Predictive Duration ("Predictive Clean Time")
- **What it is.** Per-job predicted cleaning duration that drives room sequencing, route generation, and credit allocation.
- **How it works.** Supervised learning, retrained continuously against actuals at each property ("the longer it runs at your property the more accurate it gets"). Model class not disclosed.
- **Inputs / outputs.** Inputs: job type, room type, time of day, reservation context, property-specific patterns, inspection data, guest profiles. Output: per-job minutes that feed the route optimizer. Credits themselves are still manually configured per property — no auto-tuning loop.
- **Confidence.** HIGH on existence + continuous-retraining loop. MEDIUM on inputs. LOW on model class.
- **Sources.** [optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now), [optiisolutions.com/housekeeping](https://www.optiisolutions.com/housekeeping), [help.optiisolutions.com/housekeeping-operations-understanding-credits-faqs](https://help.optiisolutions.com/housekeeping-operations-understanding-credits-faqs).

### 2.2 Predictive Due Time (maintenance/service ETA)
- **What it is.** Forecasts when a maintenance/service ticket will actually be done — predicted wait time + predicted job duration.
- **How it works.** Property-specific supervised model, continuously refined from completion records.
- **Inputs / outputs.** Inputs: job type, priority, assigned staff, facility-specific historical performance. Output: completion ETA.
- **Confidence.** HIGH it exists and is property-trained. LOW on model class.
- **Sources.** [4-models blog post](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now), [optiisolutions.com/service](https://www.optiisolutions.com/service).

### 2.3 Job Assist (multimodal unstructured → structured work order)
- **What it is.** Staff type, speak in their native language, OR photograph the issue; AI extracts location, issue type, urgency into a clean ticket.
- **How it works.** Multimodal LLM-likely (text + speech + vision). Provider/model not disclosed. No continuous-learning claim.
- **Confidence.** HIGH that the feature exists with all three input modes. MEDIUM that extraction is LLM-based vs rules.
- **Sources.** [4-models blog post](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now), [help.optiisolutions.com/getting-started-with-optii-service-chat](https://help.optiisolutions.com/getting-started-with-optii-service-chat).

### 2.4 Chat Assist (conversation → job converter + translation)
- **What it is.** Reads staff chat in real time, auto-creates jobs when a conversation signals real work, bridges languages between sender and receiver.
- **How it works.** Intent classification + translation. Per Optii's own write-up, "appears rule-based rather than continuously learning." Translation engine undisclosed.
- **Confidence.** HIGH feature exists. MEDIUM on rules-vs-LLM split.
- **Sources.** [4-models blog post](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now).

### 2.5 Inline Translation in Chat (standalone launch, July 2024)
- **What it is.** Sender writes in their language, recipient reads in theirs; works in 1:1 and group chats.
- **How it works.** Real-time machine translation. Provider not disclosed (could be Google, Azure, or proprietary LLM). Optii claims "save up to an hour per day" vs manual translation.
- **Confidence.** HIGH it exists. LOW on which engine.
- **Sources.** [optiisolutions.com/blogs/optii-breaks-barriers-with-inline-translation](https://www.optiisolutions.com/blogs/optii-breaks-barriers-with-inline-translation).

### 2.6 Predictive Route Mapping (per-attendant route generation)
- **What it is.** Most-marketed Optii AI feature — "the only solution on the market to deploy predictive technology that maps daily room attendant routes based on guest profiles and hotel needs." Generates each attendant's ordered job list, claimed to adjust "guest-by-guest, room-by-room and minute-by-minute."
- **How it works.** Best inference: an optimization layer fed by ML predictions (clean times) + reservation/guest signals + credit quotas + working hours + preferred locations. Whether the optimizer itself is learned or deterministic OR-search informed by ML predictions is not disclosed — the latter is far more likely.
- **Confidence.** HIGH feature exists and is dynamic. MEDIUM on "real-time re-routing" (marketing claim, no user-visible toggle found). LOW on whether the routing layer itself is ML.
- **Sources.** [optiisolutions.com/housekeeping](https://www.optiisolutions.com/housekeeping), [help.optiisolutions.com/migration/optii-housekeeping-general-introduction](https://help.optiisolutions.com/migration/optii-housekeeping-general-introduction).

### 2.7 Optii AI Support (in-platform support agent)
- **What it is.** In-app chat agent + contextual tooltips that guide users.
- **How it works.** LLM-powered support wrapper (no architecture published).
- **Confidence.** MEDIUM (only surfaced in iOS release notes for v3.24.0 Jan 2026 and v3.25.0 Mar 2026; no dedicated marketing page).
- **Sources.** [apps.apple.com Optii v3.24/3.25 release notes](https://apps.apple.com/us/app/optii/id1534330415).

### 2.8 AI Smart Concierge (guest-request automation via InnSpire / Medallia)
- **What it is.** Inbound guest requests from InnSpire or Medallia Concierge are auto-routed into Optii jobs assigned to the right staff.
- **How it works.** Combination of Job Assist / Chat Assist extraction + Optii's rule-based assignment. Notably, the Medallia press release deliberately drops the AI framing — pure workflow automation language ("eliminating friction").
- **Confidence.** MEDIUM that it's genuinely AI vs partner-message rules-routing.
- **Sources.** [hospitalitynet.org/news/4122059.html](https://www.hospitalitynet.org/news/4122059.html), [hotel-online.com/news/innspire-integration-with-optii-leverages-ai…](https://www.hotel-online.com/news/innspire-integration-with-optii-leverages-ai-to-optimize-hotel-operational-efficiency-guest-service-and-satisfaction), [optiisolutions.com/press-release/optii-and-medallia-concierge](https://www.optiisolutions.com/press-release/optii-and-medallia-concierge).

### 2.9 Multi-language app (static localization, NOT translation AI)
- **What it is.** Optii Housekeeping mobile app in English + 21 other languages (Albanian, Bosnian, Bulgarian, Estonian, French, German, Greek, Haitian, Italian, Japanese, Mongolian, Polish, Portuguese, Punjabi, Romanian, Russian, Simplified Chinese, Spanish, Traditional Chinese, Turkish, Ukrainian).
- **Confidence.** HIGH. Pure static localization.
- **Sources.** [businesswire 2022-08-03](https://www.businesswire.com/news/home/20220803005345/en/Optii-Solutions-Adds-Multiple-New-Languages-to-Its-Platform).

### Sold as "AI/predictive" but actually rules-based (confirmed)
- **Back-to-Back reservation auto-handling** — same-guest + same-room + back-to-back date pattern detected from PMS, swap Departure for Stayover, preserve attendant. Pure rules. [Source](https://help.optiisolutions.com/whats-a-back-to-back-reservation-and-how-it-works-in-optii).
- **Job Add-Ons (towel every 3rd day, etc.)** — cadence anchored to check-in date, deterministic. Optii's own doc: "no machine learning is mentioned." [Source](https://help.optiisolutions.com/housekeeping-automation-faqs-jobs-add-on).
- **VIP/special-code stayover cadences + turndown automation** — rules engine on PMS codes (v3.22.0, v3.23.0).
- **Squad System** (group assignment with auto credit-split, v3.26.0) — rules + arithmetic.
- **Smart Prioritization** — sort by priority field + recency. Rules.
- **Housekeeping Benchmark Report** — descriptive analytics (30-day trends, slowest/fastest comparisons), no anomaly model. Author titled "Senior Data Analyst," not data scientist.

### What Optii does NOT have (confirmed gaps in Optii)
| Feature | Verdict |
|---|---|
| Faster Turnaround / Highest Efficiency optimizer modes | UNKNOWN — no documented named modes anywhere. "Faster turnaround" is benefit phrasing only. |
| Predicted guest arrival ETA | NO — ETA/ETD pulled directly from PMS, not predicted. Predictive Due Time predicts maintenance ETA only. |
| Photo AI / cleanliness verification / damage detection on inspection photos | NO — photos captured but no CV scoring. |
| Anomaly detection on clean times or staff behavior | NO — only variance reporting + slowest/fastest comparisons. |
| Quality prediction per housekeeper | NO — pass rate tracked descriptively, no learned per-individual score. |
| True predictive maintenance (sensor/condition-based) | NO — asset tracking is usage- and repair-frequency-based, not PdM. |
| Persistent voice assistant (wake-word) | NO — voice is only an input modality inside Job Assist. |
| Workforce demand forecasting / headcount planning / labor optimization | NO — Optii allocates fixed shift hours against predicted clean times. No demand forecast, no headcount recommendation. |
| Auto-tuning of room-type credits from actuals | NO — credits are manually configured; predicted clean times feed routing but don't retune credits. |
| Cross-property federated learning | NO — Predictive Duration trains on each property's own data only. |
| General-purpose LLM chatbot for managers ("show me today's late departures") | NO. |

### Optii sources cited (deduplicated)
- [optiisolutions.com](https://www.optiisolutions.com/) (housekeeping, service, maintenance, about, team)
- [4-models blog post](https://www.optiisolutions.com/blogs/ai-in-hotel-operations-4-models-working-inside-optii-right-now)
- [What's New blog (v3.22-v3.26)](https://www.optiisolutions.com/blogs/whats-new-in-optii)
- [Inline translation launch](https://www.optiisolutions.com/blogs/optii-breaks-barriers-with-inline-translation)
- [Housekeeping Benchmark Report blog](https://www.optiisolutions.com/blogs/housekeeping-benchmark-report)
- [Squad System blog](https://www.optiisolutions.com/blogs/stronger-teams-smarter-operations)
- [Help center: housekeeping intro, credits FAQ, B2B, stayover, add-ons FAQ, ETA/ETD PMS integrations, Service+Chat getting started](https://help.optiisolutions.com/)
- [Apple App Store — Optii Housekeeping](https://apps.apple.com/us/app/optii-housekeeping/id861717884) + [Optii (Service)](https://apps.apple.com/us/app/optii/id1534330415)
- [Google Play — Optii Housekeeping](https://play.google.com/store/apps/details?id=com.optiisolutions.housekeeping&hl=en_CA) + [Optii (topcat)](https://play.google.com/store/apps/details?id=com.optii.topcat)
- [Hotel Tech Report — Optii listings](https://hoteltechreport.com/operations/housekeeping-software/optii-housekeeping) (note: HTTP 403 to WebFetch — sampled via search snippets only)
- [BusinessWire — Data Analytics team launch (Jan 2023)](https://www.businesswire.com/news/home/20230118005196/en/Optii-Solutions-Launches-Data-Analytics-Team-to-Double-Down-on-Advanced-Predictive-Technology)
- [BusinessWire — multi-language launch (Aug 2022)](https://www.businesswire.com/news/home/20220803005345/en/Optii-Solutions-Adds-Multiple-New-Languages-to-Its-Platform)
- [BusinessWire — Oracle OHIP connectivity](https://www.businesswire.com/news/home/20220928005280/en/Optii-Announces-Connectivity-to-Oracle-Hospitality-Integration-Platform)
- [Hospitality Net — InnSpire + Optii AI Smart Concierge](https://www.hospitalitynet.org/news/4122059.html)
- [Hotel Online — InnSpire integration coverage](https://www.hotel-online.com/news/innspire-integration-with-optii-leverages-ai-to-optimize-hotel-operational-efficiency-guest-service-and-satisfaction)
- [Optii press — Medallia Concierge integration](https://www.optiisolutions.com/press-release/optii-and-medallia-concierge)
- [Lodging Magazine — InnSpire/Optii partnership](https://lodgingmagazine.com/innspire-and-optii-solutions-form-strategic-partnership/)
- [Crunchbase — Optii Solutions](https://www.crunchbase.com/organization/optii-solution) + [Soenke Weiss founder profile](https://www.crunchbase.com/person/soenke-weiss)
- [PhocusWire — MCR acquires Optii](https://www.phocuswire.com/mcr-acquires-housekeeping-management-platform-optii)
- [Optii press — MCR acquisition](https://www.optiisolutions.com/press-release/mcr-acquires-cloud-based-hotel-management-platform-optii)

**Research caveats.** (1) `hoteltechreport.com` returned HTTP 403 — claims sampled via search snippets only. (2) `patents.google.com` doesn't render via WebFetch; one weak secondary mention claims founder Soenke Weiss "holds a patent related to productivity management in housekeeping" but the document could not be located — treat as unverified.

---

## 3. Flexkeeping ML features

**Company snapshot.** Slovenian, founded 2012 by Luka Berger. ~1,000 hotels in 80+ countries. Bootstrapped (~$620K-$799K total funding). **Acquired by Mews on September 30, 2025** as Mews's 13th acquisition. Mews then acquired DataChat (Oct 2025, generative AI analytics) and raised a **$300M Series D in Jan 2026 at $2.5B valuation** explicitly to build "agentic AI." Flexkeeping is now Mews's housekeeping product, slotted as one of three "agent domains" (revenue / operations / guest) in Mews's published vision. As of May 2026 the operations-agent for housekeeping is roadmap, NOT shipped.

**Bottom line up front.** Flexkeeping's ONLY genuine ML feature today is the Flexie voice assistant (LLM-powered speech-to-task). Everything else marketed as "AI," "smart," or "intelligent" is rule-based with manager-set parameters. "Expected vs actual" times use manager-set expectations, not learned ones. The "green dot" is app task-state, not GPS/beacon/ML. No predictive features, no photo AI, no learned time estimation, no inspection-failure classifier.

### 3.1 Flexie AI voice assistant ("Flexkeeping Assistant")
- **What it is.** Voice-input task creator. Staff speak in their native language; assistant transcribes, understands intent, structures a task (title, description, priority, assigned dept/person, schedule date), translates, creates + routes. Launched July 11, 2024. App version: "FlexAssistant" in iOS v3.4.3+, macOS crash fix in v3.6.5.
- **How it works.** Speech-to-text + LLM intent extraction + machine translation. **Model, vendor, and STT engine are all undisclosed** — Flexkeeping never names a partner (no Anthropic / OpenAI / Google / Azure attribution in any primary material). LLM is the only plausible architecture for the described behavior.
- **Inputs / outputs.** Input: voice utterance in one of 44 understood input languages. Output: structured task object translated to display in 200+ languages (Flexkeeping marketing) / 240 languages (Flexkeeping FAQ + Mews product page — consistent with Google Cloud Translation language count, but unconfirmed).
- **Confidence.** HIGH on existence + scope. MEDIUM-LOW on exact model class. HIGH on the 44-input / 240-display language split (corroborated across multiple sources).
- **Sources.** [flexkeeping.com/product-news/flexkeeping-assistant](https://flexkeeping.com/product-news/flexkeeping-assistant), [flexkeeping.com/product-news/flexie-ai](https://flexkeeping.com/product-news/flexie-ai), [hoteltechreport.com/news/flexkeeping-launches-first-ever-ai-voice-assistant-for-multilingual-hotel-teams](https://hoteltechreport.com/news/flexkeeping-launches-first-ever-ai-voice-assistant-for-multilingual-hotel-teams), [hospitalitynet.org/news/4122871.html](https://www.hospitalitynet.org/news/4122871.html), [mews.com housekeeping product page](https://www.mews.com/en/products/housekeeping-software).

### 3.2 Voice-to-task for maintenance
- **What it is.** Same Flexie pipeline surfaced on the Maintenance Suite — staff report repairs by voice with pre-defined labels and auto-translation.
- **How it works.** Same as Flexie AI. **No photo/video AI on the issue.** Photo Proof attaches photos for accountability only — no vision model interprets them.
- **Confidence.** HIGH on scope. HIGH that no CV runs on Photo Proof.
- **Sources.** [flexkeeping.com/products/hotel-maintenance-software](https://flexkeeping.com/products/hotel-maintenance-software), [flexkeeping.com/resources/faq](https://flexkeeping.com/resources/faq).

### 3.3 Auto-translation across tasks/chat (200-240 languages)
- **What it is.** Real-time translation of tasks, messages, chat into the recipient's preferred display language.
- **How it works.** Machine translation engine undisclosed. Onboarding/support is English, Spanish, German, Croatian, Slovenian, Serbian, Portuguese only. The 240-language figure is consistent with Google Cloud Translation's list (unconfirmed).
- **Confidence.** HIGH it exists. LOW on engine.
- **Sources.** [flexkeeping.com/resources/faq](https://flexkeeping.com/resources/faq), [flexkeeping.com/product-news/flexie-ai](https://flexkeeping.com/product-news/flexie-ai).

### 3.4 Automated Cleanings (marketed as "smart," explicitly rule-based)
- **What it is.** Auto-generates per-room cleaning schedule daily from PMS + manager-configured if/then rules.
- **How it works.** **No learning.** Rules the manager configures: length of stay, room rate, guest count, status (stayover/departure/arrival/empty), cleanliness status, staff availability, weekend availability, booking source (Airbnb/Booking.com/direct), VIP flag. Example rules: "Light clean every 2 days for stays <14 nights," "Full clean every 7 days for 14+ nights," "Deep clean Saturdays only," "Skip weekend service — shift Fri/Mon."
- **Inputs / outputs.** PMS data + rule set + manager-set "cleaning credits" (minutes per room-type × room-status) → daily plan.
- **Confidence.** HIGH this is rule-based, not ML. Flexkeeping itself markets it as "customizable if/then rules" and manager-set "cleaning credits."
- **Sources.** [flexkeeping.com/product-news/automated-cleanings](https://flexkeeping.com/product-news/automated-cleanings), [hoteltechreport.com/news/flexkeeping-automated-cleanings](https://hoteltechreport.com/news/flexkeeping-automated-cleanings).

### 3.5 "Smart" auto-assignment of housekeepers to rooms — credit-balancing heuristic
- **What it is.** One-click allocation of the day's rooms to available housekeepers.
- **How it works.** Distributes manager-set "cleaning credits" across housekeepers to ensure equal distribution. Considers availability and (per FAQ) experience. **No scoring function, no weights, no learned model** — it's a balancing heuristic over manager-supplied minute estimates. Managers can override.
- **Confidence.** HIGH this is a rule-based balancer, not ML.
- **Sources.** [flexkeeping.com/product-news/schedule-in-advance](https://flexkeeping.com/product-news/schedule-in-advance), [flexkeeping.com/resources/faq](https://flexkeeping.com/resources/faq).

### 3.6 Workload preview on reassign — arithmetic display, not forecast
- **What it is.** Manager sees credits per housekeeper, flagged when someone is overworked.
- **How it works.** Simple summation against a configured cap. Arithmetic, no ML forecasting.
- **Confidence.** HIGH this is a sum.
- **Sources.** [flexkeeping.com/product-news/automated-cleanings](https://flexkeeping.com/product-news/automated-cleanings).

### 3.7 Schedule-in-advance (multi-week scheduling) — rule-based forward projection
- **What it is.** Generate schedules "weeks in advance." Manager makes small corrections against PMS sync.
- **How it works.** Same Automated Cleanings rule engine applied forward over PMS pipeline. Mechanical: forecasted reservations × manager-set per-room-type minutes ÷ available staff. **No ML demand modeling.**
- **Important.** The "14-day projection" claim in the original task brief has **NO corroboration** in any Flexkeeping primary source. Marketing only says "weeks in advance" — no specific horizon documented.
- **Confidence.** HIGH this is mechanical.
- **Sources.** [flexkeeping.com/product-news/schedule-in-advance](https://flexkeeping.com/product-news/schedule-in-advance).

### 3.8 Auto-adjust on PMS occupancy changes — event-driven rule recomputation
- **What it is.** PMS reservation changes (cancellation, length-of-stay change, room move, VIP added) auto-update Flexkeeping's plan.
- **How it works.** Real-time PMS webhook re-runs Automated Cleanings rules. PMS partners: Mews, Cloudbeds, Apaleo, Oracle OPERA, RMS Cloud, Shiji, Protel, SIHOT, Hirum, Nebook.
- **Confidence.** HIGH this is rule-driven recomputation.

### 3.9 Live location / "green dot" — app task-state, not GPS, not ML
- **What it is.** Pin per housekeeper on property map; green dot when "actively cleaning."
- **How it works.** Official wording: "when a housekeeper enters a room, Flexkeeping will automatically mark their location with a pin." **Flexkeeping does NOT disclose the detection mechanism.** No evidence of GPS, BLE beacons, or NFC in primary sources (one third-party search reply asserted "GPS-based" — uncorroborated, likely AI hallucination). Best inference: the "enter room" event is the housekeeper's own app action (open room / start cleaning); green dot is tied to in-progress task state machine. Timer/state-based, not ML.
- **Confidence.** MEDIUM-HIGH that this is app-event/state-based. LOW on whether positional signal is also involved — Flexkeeping is deliberately vague.
- **Sources.** [flexkeeping.com/product-news/housekeepers-location](https://flexkeeping.com/product-news/housekeepers-location).

### 3.10 Analytics dashboard — descriptive, NOT predictive
- **What it is.** Performance dashboard (major redesign 2026, Mews-era).
- **How it works.** Tracks every event individually with guest-context awareness (DND, eco/no-clean). Reports cleanings and inspections separately, multi-property compare, Excel export.
- **Metrics surfaced (verbatim from sources):** average rooms cleaned per person, total working days, average cleaning time, **"expected vs actual cleaning time"** (where "expected" = manager-set credits, NOT ML prediction — variance is descriptive), **re-cleans**, **on-time readiness**, minutes per room, housekeepers per day.
- **Confidence.** HIGH this is descriptive. Flexkeeping's CPO explicitly frames predictive features as future: the new dashboard creates "a scalable analytics foundation that will support new dashboards, smarter benchmarks, and more advanced operational insights" (i.e., not yet present). **No inspection-failure-reason classifier exists.**
- **Sources.** [flexkeeping.com/blog/flexkeeping-launches-new-analytics-dashboard-for-housekeeping-performance](https://flexkeeping.com/blog/flexkeeping-launches-new-analytics-dashboard-for-housekeeping-performance), [mews.com housekeeping product page](https://www.mews.com/en/products/housekeeping-software).

### 3.11 Workflow Builder (no-code automation, 2026, GM-tier) — rule-based
- **What it is.** Visual builder for custom trigger→action automations. Mews-era launch.
- **How it works.** Triggers (services added, length of stay, rate code, booking source, VIP, late checkout) → action (e.g., place VIP welcome package pre-arrival). Pure event-condition-action, no ML.
- **Sources.** [flexkeeping.com/blog/flexkeeping-unveils-workflow-builder](https://flexkeeping.com/blog/flexkeeping-unveils-workflow-builder-the-no-code-automation-creator-for-hotel-operations).

### 3.12 MARA Solutions integration — third-party AI, not Flexkeeping
- **What it is.** Inbound integration: MARA's AI classifies guest reviews/surveys by topic/room → auto-creates Flexkeeping tickets.
- **How it works.** MARA runs the NLP. Flexkeeping is the receiver — does NOT do classification itself.
- **Confidence.** HIGH that the ML work is on MARA's side.
- **Sources.** [flexkeeping.com/blog/flexkeeping-and-mara-solutions-integration](https://flexkeeping.com/blog/flexkeeping-and-mara-solutions-integration-turns-guest-feedback-into-real-time-tasks).

### Post-Mews-acquisition AI (Mews stack, not Flexkeeping native — relevant for forward parity)
- **Mews AI Smart Tips** — LLM-generated per-guest summary in reservation calendar; 5M+ weekly views. Will likely consume Flexkeeping housekeeping notes post-integration. ([Source](https://www.mews.com/en/press/mews-ai-powered-smart-tips))
- **Mews AI rooming lists** — Agentic AI in beta at ITB Berlin 2026; ingests spreadsheets for groups/events, links to reservations, validates. Built on DataChat semantic layer. ([Source](https://www.mews.com/en/press/mews-raises-the-bar-at-itb-berlin))
- **Atomize (RMS, Mews-owned)** — Generative-AI pricing "Autopilot." 70% of users on Autopilot. Not housekeeping but is the most mature ML product in the Mews family. ([Source](https://atomize.com/blog/mews-accelerates-ai-powered-revenue-growth-with-atomize-integration/))
- **DataChat (acquired Oct 2025)** — NL interface over hotel data; "automatically generating insights, workflows and predictive models." Provides semantic layer for agentic AI. ([Source](https://www.mews.com/en/press/mews-acquires-datachat))
- **Mews "Agentic AI for Hotels" vision** — three agent categories (revenue / operations / guest). Operations agents will manage "staffing needs, housekeeping schedules, maintenance coordination." **Nothing shipped for housekeeping yet** as of May 2026. ([Source](https://www.mews.com/en/press/agentic-ai-mews-report))

### What Flexkeeping does NOT have (confirmed gaps)
| Feature | Verdict |
|---|---|
| 3-layer estimation model (manual baseline → rule modifier → data calibration) | UNKNOWN/ABSENT — no mention in any primary source. Time estimation is single-layer: manager-set "cleaning credits." No documented loop that adjusts credits from observed actuals. |
| 14-day workload projection (as a specific horizon) | UNKNOWN — only "weeks in advance" found. |
| Smart-assignment scoring function with weights | ABSENT — credit-balancing heuristic only. |
| Data-calibrated minutes-per-room (ML learning actual time) | ABSENT — analytics surfaces variance for HUMAN review, no auto-update. |
| Photo AI on issue reports / cleaning verification | ABSENT. Photo Proof = accountability only. |
| Video AI | ABSENT. |
| Predictive maintenance | ABSENT in primary sources. One third-party article generically claimed ML for predictive maintenance — uncorroborated. |
| Demand prediction inside Flexkeeping | ABSENT — demand consumed from PMS. Mews's Atomize handles demand on the RMS side. |
| Inspection-failure-reason classifier | ABSENT — failure reasons are human-tagged. |
| Patents on housekeeping algorithms | NONE FOUND. |
| Picovoice/wake-word style always-on voice | ABSENT. |

### Flexkeeping sources cited (deduplicated)
- [flexkeeping.com](https://flexkeeping.com/) (housekeeping, task management, maintenance, automation, analytics, front-desk products)
- [Flexie AI launch + product page](https://flexkeeping.com/flexie-ai) + [Flexkeeping Assistant news](https://flexkeeping.com/product-news/flexkeeping-assistant)
- [Automated Cleanings product news](https://flexkeeping.com/product-news/automated-cleanings) + [capability page](https://flexkeeping.com/capabilities/automated-cleanings)
- [Schedule in advance](https://flexkeeping.com/product-news/schedule-in-advance)
- [Housekeepers location / green dot](https://flexkeeping.com/product-news/housekeepers-location)
- [Workflow Builder launch blog](https://flexkeeping.com/blog/flexkeeping-unveils-workflow-builder-the-no-code-automation-creator-for-hotel-operations)
- [Analytics dashboard launch](https://flexkeeping.com/blog/flexkeeping-launches-new-analytics-dashboard-for-housekeeping-performance) + [9 ways the new dashboard declutters housekeeping data](https://flexkeeping.com/blog/9-ways-our-new-dashboard-declutters-housekeeping-data)
- [Flexkeeping FAQ](https://flexkeeping.com/resources/faq)
- [Flexkeeping API docs](https://api-docs-ana.flexkeeping.com/)
- [Integrations: Mews, Cloudbeds, Apaleo](https://flexkeeping.com/integrations)
- [Mews acquires Flexkeeping press](https://www.mews.com/en/press/mews-acquires-flexkeeping) + [Flexkeeping side blog](https://flexkeeping.com/blog/flexkeeping-and-mews-are-joining-forces)
- [Mews acquires DataChat](https://www.mews.com/en/press/mews-acquires-datachat) + [PR Newswire](https://www.prnewswire.com/news-releases/mews-accelerates-the-dawn-of-agentic-hospitality-with-acquisition-of-datachat-a-leading-generative-ai-analytics-platform-302596126.html)
- [Mews acquires Atomize](https://www.mews.com/en/press/mews-acquires-atomize) + [Atomize integration blog](https://atomize.com/blog/mews-accelerates-ai-powered-revenue-growth-with-atomize-integration/)
- [Mews AI Smart Tips press](https://www.mews.com/en/press/mews-ai-powered-smart-tips) + [Silicon Canals tool of the week](https://siliconcanals.com/ai-tool-of-the-week-mews-ai-smart-tips/)
- [Mews agentic AI report](https://www.mews.com/en/press/agentic-ai-mews-report) + [research page](https://www.mews.com/en/resources/research/agentic-ai-hotels)
- [Mews $300M Series D — Skift](https://skift.com/2026/01/22/mews-raises-300-million-series-d-2-5-billion-valuation/) + [Hotel Technology News](https://hoteltechnologynews.com/2026/01/mews-secures-300-million-to-accelerate-agentic-ai-for-autonomous-hotel-management/)
- [Mews AI rooming lists at ITB Berlin 2026](https://www.mews.com/en/press/mews-raises-the-bar-at-itb-berlin)
- [Hotel Tech Report — Flexie AI voice assistant launch](https://hoteltechreport.com/news/flexkeeping-launches-first-ever-ai-voice-assistant-for-multilingual-hotel-teams)
- [Hotel Tech Report — Mews+Flexkeeping coverage](https://hoteltechreport.com/news/mews-flexkeeping) + [Flexkeeping by Mews 2026 capabilities](https://hoteltechreport.com/news/flexkeeping-by-mews-set-to-launch-advanced-capabilities-in-2026)
- [Hospitality Net — Flexie AI launch](https://www.hospitalitynet.org/news/4122871.html)
- [HFTP — Flexie AI launch](https://www.hftp.org/news/4122871/flexkeeping-launches-first-ever-ai-voice-assistant-for-multilingual-hotel-teams)
- [Phocuswire — Mews acquires Flexkeeping](https://www.phocuswire.com/mews-acquires-flexkeeping) + [Mews/DataChat coverage](https://www.phocuswire.com/mews-datachat-agentic-ai-hospitality)
- [Skift — Mews/Flexkeeping acquisition](https://skift.com/2025/09/30/mews-flexkeeping-acquisition-housekeeping-ai/)
- [Flexkeeping App Store](https://apps.apple.com/us/app/flexkeeping/id1198674319) + [Google Play](https://play.google.com/store/apps/details?id=si.creatriks.facility)
- [Apaleo store listing](https://store.apaleo.com/apps/flexkeeping) + [Cloudbeds integration](https://www.cloudbeds.com/integrations/flexkeeping/)
- [MARA Solutions integration](https://flexkeeping.com/blog/flexkeeping-and-mara-solutions-integration-turns-guest-feedback-into-real-time-tasks) + [MARA on HTR](https://hoteltechreport.com/marketing/reputation-management/mara-ai-review-assistant)
- [Luka Berger LinkedIn](https://si.linkedin.com/in/lukaberger) + [ZAKA VC exit announcement](https://zaka.vc/zaka-vc-backed-flexkeeping-acquired-by-mews/)

---

## 4. Hotel Effectiveness ML features

**Company snapshot.** Founded 2007 by Mike Martin and Taylor Beauchamp in Alpharetta, GA. Built the "hotel-specific labor management" category around primitives: labor standards (e.g. minutes-per-occupied-room / MPR), occupancy-aligned schedules, per-property staffing rules. Flagship: PerfectLabor. Add-ons: PerfectWage, PerfectTime, PerfectEngage, CoverageFinder, Housekeeping Optimizer (2024). Data feeds from ~5,000-6,000 US properties, 20,000+ managers. **Acquired by Alpine SG / Alpine Investors in May 2022**, fourth acquisition after ProfitSword (BI), Alice (operations), Transcendent (asset mgmt). Combined entity launched as **Actabl** on June 28, 2022 at HITEC. Now positioned as a four-product platform covering ~14,000 hotels and 400+ integrations.

**Bottom line up front.** Hotel Effectiveness has less ML than the marketing implies. PerfectLabor itself is a rules-and-standards engine with no learned model class disclosed anywhere. The 2024 Housekeeping Optimizer is a deterministic supply/demand simulation marketed as "predictive analytics." Real ML at Actabl lives in *sister products* — ProfitAbility (anomaly detection, 2020), AI Asset Setup in Transcendent (CV/OCR for equipment photos, April 2026), and the data-normalization patent (April 2026) with an ML mapping component. Per Actabl's own roadmap page, **Hotel Effectiveness AI capabilities are "in development"** — not yet shipped. The competitive moat is the dataset breadth (5K-6K properties feeding peer benchmarks), not learned models.

### 4.1 PerfectLabor (core scheduling/planning engine)
- **What it is.** Converts per-property labor standards + occupancy forecasts into per-department per-shift staffing plans and schedule templates.
- **How it works.** Marketing says "advanced algorithms and staffing rules developed for each property." In practice: rules-and-standards engine. Hoteliers define standards (front desk = X positions at occupancy Y, housekeeping = MPR target Z), system multiplies forecasted demand drivers (rooms sold, cleans, covers) by standards, emits recommended headcount per shift. **No learned model documented anywhere** (no regression / tree / NN class mentioned in any public material).
- **Inputs / outputs.** Inputs: occupancy/rooms forecast, per-department labor standards, position rules, wage data, compliance constraints. Outputs: scheduling templates, "smart schedules," variance dashboards.
- **Confidence.** LOW that it's ML. HIGH that it's rules-and-standards-based with no learned model.
- **Sources.** [actabl.com/labor-management-software/perfectlabor](https://actabl.com/labor-management-software/perfectlabor/), [Hotel Effectiveness on HTR](https://hoteltechreport.com/operations/scheduling-labor-management/hotel-effectiveness).

### 4.2 Room Cleans Forecasting (statistical aggregation, not ML)
- **What it is.** Forecasts mix of room cleans (stayover/checkout/clean type) so housekeeping schedulers can right-size attendant count per day.
- **How it works.** Per 2024 release notes: "utilizes data from the past eight weeks and year-over-year history." That's a rolling-window + YoY blend — moving-average / seasonal-naive aggregation. **No model class named.**
- **Inputs / outputs.** Inputs: historical clean counts/mix from past 8 weeks + same period prior year + current occupancy forecast. Outputs: per-day forecasted clean count + mix.
- **Confidence.** MEDIUM that mechanism is statistical aggregation (no ML class disclosed). HIGH on the 8-week + YoY inputs.
- **Sources.** [Hotel Effectiveness unveils new labor trends 2024](https://actabl.com/news/hotel-effectiveness-by-actabl-unveils-new-labor-trends/).

### 4.3 Housekeeping Optimizer — Inventory Horizon (2024)
- **What it is.** Multi-day early-warning forecast flagging days at risk of running out of clean rooms due to short staffing. "Outlines the number of Room Attendants required per shift well in advance — even more than a week out."
- **How it works.** Combines occupancy forecasts, employee schedules, labor plans, clean types, per-associate MPR variance, attendance rates. Actabl markets this as "predictive analytics" but the Director-of-Product interview frames the prior state as managers "doing so much of this in their heads." Mechanic: simulate required-clean-hours vs scheduled-clean-hours per day, surface the gap. The experts-weigh-in post explicitly contains **no mention** of recommendation engines or ML models — only "data aggregation, automation, and real-time visibility."
- **Confidence.** LOW that it's ML. MEDIUM-HIGH that it's a deterministic supply/demand simulation marketed as "predictive analytics."
- **Sources.** [Actabl launches Housekeeping Optimizer](https://actabl.com/news/actabl-launches-hotel-effectiveness-housekeeping-optimizer/), [How we built it (Taylor Jones)](https://actabl.com/blog/how-we-built-the-housekeeping-optimizer/), [experts weigh in](https://actabl.com/blog/housekeeping-optimizer-the-experts-weign-in/).

### 4.4 Housekeeping Optimizer — Board Builder (rule-based)
- **What it is.** Automated daily housekeeping board generator — assigns rooms to scheduled attendants based on schedule + labor plan + hotel preferences.
- **How it works.** Aggregates schedules + labor plan + per-property preferences, prioritizes rooms by status (checkout/stayover/rush), flags when staffing may be insufficient for arrivals. **No public description of an assignment-optimization algorithm** (ILP, bipartite matching, etc.). Most likely heuristic round-robin with priority sort.
- **Confidence.** LOW it's ML. HIGH it's deterministic workflow automation.

### 4.5 Housekeeping Optimizer — Realtime Rooms (pure UI, not ML)
- **What it is.** Live in-progress room status board; allows reordering based on arrival times.
- **How it works.** PMS room status + RA mobile app updates. No ML.
- **Confidence.** HIGH this is not ML — it's a live-data UI.

### 4.6 PerfectWage (wage benchmarking + retention risk)
- **What it is.** Wage benchmarking across ~100 markets at position level. Includes a "retention action plan" — flags employees at elevated risk of leaving, recommends actions.
- **How it works.** Wage side: peer-data lookup against the 5K-6K property payroll feed. No predictive modeling described for wages. Retention side: described as "automatically tracks risks and delivers a retention action plan," but **no model class, no features used, no risk-score methodology disclosed.** Almost certainly rules-based on observable signals (wage gap to peer average, tenure, no-show rate) rather than a learned classifier.
- **Confidence.** HIGH that wage benchmarking = aggregation only. LOW-to-UNKNOWN whether retention risk is ML or threshold rules.
- **Sources.** [PerfectWage product page](https://actabl.com/labor-management-software/perfectwage/), [Hotel Management.net coverage](https://www.hotelmanagement.net/tech/hotel-effectiveness-launches-wage-benchmarking-tool).

### 4.7 CoverageFinder + ShiftSwap (rules-based filtering)
- **What it is.** Cross-property open-shift filler. ShiftSwap (May 2023) lets employees trade shifts.
- **How it works.** Press release: system "programmed to understand scheduling, wage data and overall strategy." Rule-based filtering: same position + availability + no OT trigger + wage feasibility. No algorithmic matching / optimization described.
- **Confidence.** HIGH it's rules-based filtering.
- **Sources.** [CoverageFinder page](https://actabl.com/labor-management-software/coverage-finder/), [ShiftSwap launch](https://actabl.com/news/hotel-effectiveness-by-actabl-launches-shiftswap-to-streamline-employee-schedule-management/).

### 4.8 PerfectTime — "unusual punches" alerting (threshold rules)
- **What it is.** Time-clock product, real-time alerts for missed shifts, "riding the clock," potential OT.
- **How it works.** Marketing: "automatic alerts of unusual punches." Mechanism consistent with threshold rules (planned shift vs actual punch delta, scheduled vs actual hours, OT triggers). **No outlier-detection model documented.**
- **Confidence.** MEDIUM-HIGH it's rules-based. LOW that it's ML anomaly detection.

### 4.9 Productivity benchmarking / Hotel Labor Cost Index (statistical aggregation)
- **What it is.** Industry-wide labor benchmarks (wages, productivity, MPR, CPOR by brand and segment) derived from live data of Actabl/Hotel Effectiveness customers. Published periodically (e.g. quarterly via HotelData.com). Used inside PerfectLabor for peer comparison.
- **How it works.** Aggregation/percentile statistics across the customer base. Not ML.
- **Confidence.** HIGH this is statistical aggregation.
- **Sources.** [HotelData.com Q3 2025 report](https://hoteldata.com/reports/q3-2025-labor-costs-report/), [HotelTechReport coverage](https://hoteltechreport.com/news/hotel-labor-cost-index-and-housekeeping-report).

### 4.10 PerfectEngage HR/IT chatbot (unverified)
- **What it is.** Single secondary source claims "Chatbots can automate, facilitate, and respond to common HR or IT requests." The actual PerfectEngage product page makes **no mention** of LLMs, chatbots, or generative AI.
- **Confidence.** LOW. Possibly not a real shipped feature.

### 4.11 Actabl data normalization patent (April 2026) — ML mapping
- **What it is.** US patent issued April 14, 2026 covering Actabl's real-time normalization of raw enterprise hotel data (PMS, POS, accounting, labor, OTA — 400+ integrations) into a unified taxonomy.
- **How it works.** "Reads the natural language inside that data, identifies what each field means, and maps it to a consistent, standardized taxonomy." Patent specifically covers "a machine learning component trained on Actabl's proprietary hospitality data mapping history" that will surface mapping recommendations "as it is brought fully online." Model class not disclosed publicly.
- **Confidence.** HIGH that ML exists. MEDIUM that it's only partially live. UNKNOWN on architecture.
- **Sources.** [PRNewswire patent announcement](https://www.prnewswire.com/news-releases/actabl-earns-us-patent-for-hotel-data-normalization-as-ai-raises-the-stakes-on-data-reliability-302770422.html), [HospitalityNet coverage](https://www.hospitalitynet.org/news/4132376/actabl-earns-us-patent-for-hotel-data-normalization-as-ai-raises-the-stakes-on-data-reliability).

### 4.12 ProfitAbility (sister product, Feb 2020) — time-series anomaly detection
- **What it is.** ProfitSword's "AI-powered" data viz platform; autonomously identifies and reports anomalies in hotel performance data (reservations, sales). Predates Actabl.
- **How it works.** Self-described as "machine learning that learns from data patterns." Time-series anomaly detection. No specific model class disclosed (could be z-score / Holt-Winters residuals / Isolation Forest).
- **Confidence.** HIGH ML is claimed. LOW on what model class.
- **Note.** Lives in ProfitSword, not Hotel Effectiveness, but operates on the same Actabl data substrate.
- **Sources.** [ProfitSword unveils ProfitAbility](https://actabl.com/news/profitsword-unveils-profitability-with-machine-learning/), [HospitalityNet launch](https://www.hospitalitynet.org/news/4097040.html).

### 4.13 AI Asset Setup (Transcendent sister product, April 2026) — CV/OCR
- **What it is.** Engineering teams snap photos of equipment; system auto-extracts equipment type and serial numbers, structures the asset record. Reduces onboarding from 30 days to under a week.
- **How it works.** Photo input → structured asset record. Press releases don't name the technique; mechanically this is CV/OCR + LLM-style field extraction.
- **Confidence.** HIGH that CV+ML is involved. LOW on specific stack.
- **Note.** Lives in Transcendent, not Hotel Effectiveness. **First live "Actabl AI" capability** — proves the parent's direction.
- **Sources.** [Hospitality Net launch](https://www.hospitalitynet.org/news/4131775/actabl-launches-ai-asset-setup-to-eliminate-manual-data-entry-for-hotel-maintenance-and-capital-planning), [HotelTechnologyNews coverage](https://hoteltechnologynews.com/2026/04/actabl-launches-ai-asset-setup-to-automate-hotel-asset-data-collection-and-improve-maintenance-planning/).

### 4.14 "Actabl AI" roadmap framing
- **What it is.** Actabl's umbrella AI strategy page. Status per [actabl.com/hotel-ai](https://actabl.com/hotel-ai/): **Transcendent's AI Asset Setup is live**; **Hotel Effectiveness, ProfitSword, and Alice AI capabilities are "in development."**
- **So:** As of mid-2026, Hotel Effectiveness has no publicly shipped "Actabl AI"-branded feature — only the legacy rules engines + the 2024 Housekeeping Optimizer.

### What Hotel Effectiveness does NOT have (confirmed gaps)
| Feature | Verdict |
|---|---|
| "AutoSchedule" SKU | NOT A PRODUCT. PerfectLabor's "smart scheduling templates" is closest analog. |
| "LaborWatch" | NOT A PRODUCT BY THAT NAME. Closest: PerfectTime variance alerts. |
| "GuestCounter" | NOT A HE PRODUCT — sensor-based people-counting (V-Count, Traf-Sys) is unrelated. |
| "Express" SKU | NOT FOUND. May be a confusion with another vendor. |
| LLM features in Hotel Effectiveness itself | NONE publicly deployed. PerfectEngage chatbot is single-source and unverified. |
| Federated / fleet-wide labor model | UNKNOWN — PerfectLabor is per-property; benchmarks aggregate but no learned cross-property model. |
| Specific model class (NN / XGBoost / ARIMA / regression) | NONE PUBLICLY DISCLOSED anywhere — job posts, press, patent, product docs. |
| Quantified savings claims tied to ML | 5-15% labor savings are tied to the product overall (scheduling discipline, OT control), NOT specifically to an ML feature. The 7.4% housekeeping case study is a process change (split-MPR), not ML. |
| Engineering data-science roles | NO public ML engineer / data scientist roles found under Hotel Effectiveness or Actabl with stack disclosure. |

### Hotel Effectiveness sources cited (deduplicated)
- [actabl.com](https://actabl.com/) (PerfectLabor, PerfectWage, PerfectEngage, CoverageFinder, Hotel Effectiveness, ProfitSword, BI, Operations, Housekeeping, Hotel AI roadmap)
- [Actabl launches Housekeeping Optimizer](https://actabl.com/news/actabl-launches-hotel-effectiveness-housekeeping-optimizer/) + [Taylor Jones build blog](https://actabl.com/blog/how-we-built-the-housekeeping-optimizer/) + [experts weigh in](https://actabl.com/blog/housekeeping-optimizer-the-experts-weign-in/)
- [Hotel Effectiveness 2024 labor trends](https://actabl.com/news/hotel-effectiveness-by-actabl-unveils-new-labor-trends/)
- [ShiftSwap launch (Actabl)](https://actabl.com/news/hotel-effectiveness-by-actabl-launches-shiftswap-to-streamline-employee-schedule-management/) + [HotelBusiness coverage](https://hotelbusiness.com/hotel-effectiveness-by-actabl-launches-shiftswap/)
- [ProfitSword unveils ProfitAbility](https://actabl.com/news/profitsword-unveils-profitability-with-machine-learning/) + [HospitalityNet](https://www.hospitalitynet.org/news/4097040.html) + [HotelTechnologyNews](https://hoteltechnologynews.com/2020/02/profitsword-unveils-profitability-to-empower-hoteliers-with-next-generation-business-intelligence-capabilities/)
- [PerfectWage launch (HotelManagement.net)](https://www.hotelmanagement.net/tech/hotel-effectiveness-launches-wage-benchmarking-tool) + [Hospitality Upgrade](https://www.hospitalityupgrade.com/_news/NewsArticles/Hotel-Effectiveness-Launches-PerfectWage.asp/)
- [Dear Edie blog series (PerfectLabor scheduler internals)](https://www.hoteleffectiveness.com/blog/dear-edie-why-is-it-necessary-for-me-to-schedule-in-perfectlabor-when-i-know-how-many-associates-are-needed-to-cover-shifts-scheduler-pains)
- [PerfectTime](https://www.hoteleffectiveness.com/perfecttime) + [Housekeeping case study (PDF)](https://info.hoteleffectiveness.com/hubfs/Housekeeping_Case_Study-6.pdf)
- [HotelData.com Q3 2025](https://hoteldata.com/reports/q3-2025-labor-costs-report/) + [Q4 2025](https://hoteldata.com/reports/q4-2025-labor-costs-report/)
- [HotelTechReport Hotel Effectiveness listing](https://hoteltechreport.com/operations/scheduling-labor-management/hotel-effectiveness) + [PerfectEngage listing](https://hoteltechreport.com/hr-staffing/employee-engagement-software/perfectengage-hotel-effectiveness) + [Labor Cost Index news](https://hoteltechreport.com/news/hotel-labor-cost-index-and-housekeeping-report)
- [Data normalization patent — PRNewswire](https://www.prnewswire.com/news-releases/actabl-earns-us-patent-for-hotel-data-normalization-as-ai-raises-the-stakes-on-data-reliability-302770422.html) + [HotelTechnologyNews](https://hoteltechnologynews.com/2026/05/actabl-secures-patent-for-hotel-data-normalization-technology-powering-reliable-ai-driven-analytics/) + [HospitalityNet](https://www.hospitalitynet.org/news/4132376/actabl-earns-us-patent-for-hotel-data-normalization-as-ai-raises-the-stakes-on-data-reliability) + [Hotel Management.net](https://www.hotelmanagement.net/tech/actabl-receives-us-patent-hotel-data-normalization-technology)
- [AI Asset Setup launch — HospitalityNet](https://www.hospitalitynet.org/news/4131775/actabl-launches-ai-asset-setup-to-eliminate-manual-data-entry-for-hotel-maintenance-and-capital-planning) + [HotelTechnologyNews](https://hoteltechnologynews.com/2026/04/actabl-launches-ai-asset-setup-to-automate-hotel-asset-data-collection-and-improve-maintenance-planning/) + [Lodging Magazine](https://lodgingmagazine.com/actabl-announces-launch-of-ai-asset-setup/)
- [Alpine SG — Actabl launch + HE acquisition](https://www.alpinesg.com/blog/actabl-launch-and-hotel-effectiveness-acquisition)
- [Crunchbase — Hotel Effectiveness](https://www.crunchbase.com/organization/hotel-effectiveness-solutions)
- [App stores: Hotel Effectiveness iOS](https://apps.apple.com/us/app/hotel-effectiveness/id1456017147) + [MyHotelTeam iOS](https://apps.apple.com/us/app/myhotelteam/id1483596888) + [Hotel Effectiveness Android](https://play.google.com/store/apps/details?id=com.hoteleffectiveness.myhoteleffectiveness&hl=en_US)
- [Hapi + Actabl Future of Hotel Data Survey](https://www.hospitalitynet.org/news/4132400/hapi-and-actabl-launch-the-future-of-hotel-data-survey-to-benchmark-industry-readiness-for-ai-real-time-insights-and-smarter-operations)
- [ProfitSword ↔ Hotel Effectiveness budget integration](https://www.hospitalitynet.org/news/4131575/actabl-launches-integration-connecting-profitsword-budgets-with-hotel-effectiveness-to-streamline-hotel-portfolio-labor-planning)

---

## 5. Side-by-side comparison

Legend:
- **✓** = shipped and matches description
- **✓ (partial)** = shipped but materially narrower than full description
- **rules** = exists in product but is rules/heuristics, not learned ML
- **✗** = not in product
- **roadmap** = announced/in-development, not shipped as of May 2026
- **UNKNOWN** = couldn't verify after deep search

Confidence applies to whether the feature exists at all in that vendor at the described level.

### A. Demand & headcount forecasting

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Per-day housekeeping cleans demand forecast | ✗ | rules (PMS pass-through) | ✓ Room Cleans Forecast (8-week + YoY blend, statistical) | ✓ Bayesian L1 → XGBoost-quantile (gated) | HIGH |
| Multi-day staffing forecast (1+ week out) | ✗ | rules (Schedule-in-advance, mechanical) | ✓ Inventory Horizon (deterministic simulation, marketed as "predictive analytics") | ✓ L1 + L2 + optimizer on any date | HIGH |
| Headcount recommendation with completion probability | ✗ | ✗ | ✗ (recommends count via standards, no probability) | ✓ Monte Carlo over quantiles, default p95 target | HIGH |
| Probabilistic quantile bands (p10..p95) on predictions | ✗ | ✗ | ✗ | ✓ explicit quantile predictions both layers | HIGH |
| Sensitivity scenarios (one HK sick, +5 checkouts) | ✗ | ✗ | rules (manager can rerun) | ✓ surfaced on every optimizer result | HIGH |
| Per-property shift cap honored in optimizer | ✗ | rules | rules (per-property standards) | ✓ reads `properties.shift_minutes` | HIGH |

### B. Cleaning-time learning

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Per-room-type duration prediction | ✓ (room type is an input) | rules (manager-set credits per room type × status) | rules (MPR standards) | ✓ via L2 features | HIGH |
| Per-individual-room learning ("305 always takes +5 min") | ✓ (continuously retrained on property data) | ✗ | ✗ | ✓ one-hot room_number coefficient | HIGH on Optii + Staxis |
| Per-housekeeper learning ("Cindy faster than Astri") | ✓ (Optii's claim) | ✗ | rules (per-associate MPR variance tracked) | ✓ one-hot staff_id coefficient | HIGH on Staxis; MEDIUM on Optii (not explicitly disclosed) |
| Auto-tuning of room-type credits from actuals | ✗ (Optii FAQ: credits manually configured) | ✗ (cleaning credits manually configured) | ✗ (MPR standards manually configured) | ✓ effectively — L2 model learns directly, bypasses credits | HIGH |
| Anomaly detection on individual clean times | ✗ | ✗ | ✗ (PerfectTime is threshold rules; ProfitAbility anomaly is on revenue not housekeeping) | ✗ | HIGH |
| Variance / expected-vs-actual reporting | ✓ Housekeeping Benchmark Report | ✓ analytics dashboard (variance vs manager-set expected) | ✓ PerfectLabor variance dashboards | ✓ shadow MAE + backtest report | HIGH |

### C. Routing & assignment

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Auto-assignment of housekeepers to rooms | ✓ (rules-fed-by-ML — predicted clean times into route engine) | rules (credit-balancing heuristic) | rules (Board Builder, round-robin + priority) | ✗ (rule engine not built yet) | HIGH |
| Predictive route mapping per attendant | ✓ marketed as "the only solution" — routing layer itself likely deterministic | ✗ | rules | ✗ | HIGH on Optii's existence; LOW on whether routing is ML |
| Mid-day rerouting on disruption | ✓ (marketing claims "minute-by-minute" adjustment) | ✗ | ✗ (Realtime Rooms is reorder UI, no auto-recompute) | ✗ | LOW on Optii actual behavior |
| Workload preview / balance on reassign | ✓ | ✓ (arithmetic sum) | ✓ | ✗ | HIGH |
| Sick-callout / no-show auto-rebalance | UNKNOWN | rules (manager re-runs) | rules (CoverageFinder for cross-property fill) | ✗ | MEDIUM |

### D. Multimodal input (LLM-likely)

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Voice-to-task (speech in native language → structured ticket) | ✓ Job Assist | ✓ Flexie AI / FlexAssistant (44 input languages) | ✗ | ✗ | HIGH |
| Photo-to-task (snap photo of issue → structured ticket) | ✓ Job Assist | ✗ (Photo Proof = accountability only) | ✗ (in HE itself; Transcendent sister has AI Asset Setup for equipment onboarding) | ✗ | HIGH |
| Chat-intent classifier (conversation → auto-create job) | ✓ Chat Assist | ✗ | ✗ | ✗ | HIGH |
| In-app LLM support agent / contextual helper | ✓ Optii AI Support (v3.24+ / v3.25+) | ✗ | rules (PerfectEngage chatbot is unverified single-source) | ✗ | MEDIUM on Optii (release notes only) |
| General-purpose ops chatbot for managers ("show late departures") | ✗ | ✗ | ✗ | ✗ | HIGH |

### E. Translation & language

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Live auto-translation between staff languages in chat/tasks | ✓ Inline Translation (engine undisclosed) | ✓ 200-240 display languages (engine undisclosed) | ✗ | ✗ | HIGH |
| Static UI localization | ✓ EN + 21 languages | ✓ multiple | ✗ (English-only) | ✓ (partial — EN + ES) | HIGH |

### F. Quality & inspection

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Photo AI on cleanliness verification (does the room look clean?) | ✗ (photos captured but no CV scoring) | ✗ (Photo Proof = accountability only) | ✗ | ✗ | HIGH |
| Inspection-failure-reason classifier | ✗ | ✗ (human-tagged) | ✗ | ✗ | HIGH |
| Per-housekeeper quality / pass-rate prediction | ✗ (only descriptive 30-day trends, slowest/fastest) | ✗ | rules (PerfectWage retention risk — likely rules) | ✗ | HIGH on absence |
| Anomaly detection on staff behavior | ✗ | ✗ | rules (PerfectTime threshold alerts on "unusual punches") | ✗ | HIGH |

### G. Maintenance

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Predictive ETA on maintenance tickets | ✓ Predictive Due Time (supervised per-property) | ✗ | ✗ | ✗ | HIGH |
| Auto-categorize maintenance issue from photo | ✓ (partial — via Job Assist multimodal extraction) | ✗ | ✓ in Transcendent sister product only (AI Asset Setup, for equipment onboarding NOT issues) | ✗ | HIGH on Optii partial |
| True predictive maintenance (sensor / condition-based) | ✗ (usage- and repair-frequency only) | ✗ | ✗ | ✗ | HIGH |

### H. Inventory

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Days-until-out forecast per item | ✗ | ✗ | ✗ | ✓ per-(property × item) Bayesian rate prediction | HIGH |
| Reorder recommendation | ✗ | ✗ | ✗ | ✓ Reorder list driven by inventory rate model | HIGH |
| Cross-hotel item benchmarks (cohort priors) | ✗ | ✗ | ✗ | ✓ cohort-aggregate + industry-benchmark seeds | HIGH |

### I. Labor / wage

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Wage benchmark from peer data | ✗ | ✗ | ✓ PerfectWage (5K-6K property feed, ~100 markets) | ✗ | HIGH |
| Retention risk score | ✗ | ✗ | ✓ PerfectWage retention action plan (likely rules, no methodology disclosed) | ✗ | LOW on it being ML |
| Productivity benchmarking (peer percentile rankings) | rules (within-property only) | ✗ | ✓ Hotel Labor Cost Index (peer percentiles across 5K hotels) | ✗ | HIGH |

### J. Reviews / sentiment

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Sentiment classification on guest reviews | partial via AI Smart Concierge / Medallia partner | partial via MARA Solutions third-party | ✗ | ✗ | HIGH |
| Auto-create ops tickets from negative reviews | partial via partners | ✓ via MARA integration | ✗ | ✗ | HIGH |

### K. Production-ML engineering (the "is this safe to ship" surface)

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Cohort priors / cross-hotel cold-start warm-up | ✗ (per-property only) | ✗ | partial (peer benchmarks aggregate, no learned model) | ✓ cohort-aggregate priors (demand/supply/inventory) | HIGH |
| Cold-start honesty labels in UI ("AI" vs "Industry estimate · learning") | ✗ | ✗ | ✗ | ✓ explicit "AI recommendation" / "Industry estimate · learning" / "Industry estimate · learning (capacity unavailable)" | HIGH |
| Statistical activation gates (size + MAE + baseline + streak) | ✗ (continuous retrain, no documented gates) | ✗ | ✗ | ✓ 5-gate, requires 2 consecutive passing runs | HIGH |
| Shadow-mode promotion soak | ✗ | ✗ | ✗ | ✓ 7-day soak, shadow.mae ≤ active.mae × 1.05 | HIGH |
| Statistical auto-rollback / drift detection | ✗ | ✗ | ✗ | ✓ Wilcoxon vs same-DOW naive + BH-FDR fleet-wide, dry-run default | HIGH |
| Walk-forward backtest with refusal contract | ✗ | ✗ | ✗ | ✓ 8-week replay, read-only proxy, refuses headline if days_fitted<14 | HIGH |
| Per-property advisory lock (no concurrent train corruption) | UNKNOWN | UNKNOWN | UNKNOWN | ✓ pg_try_advisory_lock per (property, layer) | HIGH on Staxis |
| Deterministic Monte Carlo seed (reproducible recommendations) | n/a | n/a | n/a | ✓ 128-bit seed from (property, date) | HIGH |
| Feature snapshot per prediction (jsonb) for post-hoc audit | ✗ | ✗ | ✗ | ✓ `demand_predictions.features_snapshot` | HIGH |

### L. Platform-level AI (sister products / parent company moves)

| Feature | Optii | Flexkeeping | Hotel Effectiveness | Staxis today | Confidence |
|---|---|---|---|---|---|
| Cross-system data-mapping ML (PMS field normalization) | ✗ | ✗ | ✓ Actabl patent April 2026 (ML mapping, partially live) | ✗ (per-PMS recipes, no ML) | HIGH |
| Generative-AI guest summaries in PMS | ✗ | roadmap (Mews Smart Tips will likely consume Flexkeeping notes) | ✗ | ✗ | HIGH on Mews Smart Tips existence |
| Agentic AI ops agent (future) | ✗ | roadmap (Mews "operations agent" announced, not shipped) | roadmap ("Actabl AI for HE in development") | ✗ | HIGH on roadmap framing |
| Generative-AI pricing autopilot | ✗ | ✓ via parent (Mews-owned Atomize, 70% on Autopilot) | ✗ | ✗ | HIGH |
| Generative-AI analytics over hotel data | ✗ | ✓ via parent (Mews-acquired DataChat Oct 2025) | ✗ | ✗ | HIGH |

---

## 6. Gaps list

Pure list of where Staxis stands vs the 3 competitors, organized by hard gaps / partial gaps / wins. Each entry is **what** + **who has it** — no plan, no spec, no "what to build first."

### 6.1 Hard gaps (one or more competitors have it, Staxis has nothing)

- **Voice-to-task in housekeeper's native language.** Optii (Job Assist) + Flexkeeping (Flexie AI, 44 input languages → 240 display). Staxis has none.
- **Photo-to-task / multimodal issue reporting.** Optii (Job Assist accepts text/voice/photo). Staxis: photo capture exists in housekeeper flow but no AI extraction.
- **Live auto-translation across staff languages in chat/tasks.** Optii Inline Translation. Flexkeeping 200-240 display languages. Staxis: nothing (translations.ts is static EN/ES, not live).
- **Chat-intent classifier → auto-create job.** Optii Chat Assist. Staxis: messages stay messages.
- **Predictive ETA on maintenance tickets.** Optii Predictive Due Time. Staxis: nothing.
- **Predictive route mapping per attendant.** Optii's headline AI claim. Staxis: nothing.
- **In-app LLM support agent (contextual tooltips, "how do I…?").** Optii AI Support (in v3.24+/v3.25+). Staxis: nothing.
- **Sentiment classification → auto-ops-ticket from negative reviews.** Flexkeeping (via MARA partner) + Optii (via Medallia partner). Staxis: no review ingest at all.
- **Wage benchmarking from peer data.** Hotel Effectiveness PerfectWage (5K-6K property feed). Staxis: nothing.
- **Industry productivity benchmark (peer percentiles).** Hotel Effectiveness Hotel Labor Cost Index. Staxis: nothing.
- **Retention-risk score per employee.** Hotel Effectiveness (likely rules, but the feature exists). Staxis: nothing.
- **ML field-mapping across PMS systems.** Actabl patent (partially live). Staxis: per-PMS recipes hand-built.
- **Generative-AI pricing autopilot.** Mews-owned Atomize. Staxis: out-of-scope (no RMS).
- **Generative-AI analytics ("ask the hotel a question").** Mews via DataChat acquisition. Staxis: nothing.

### 6.2 Partial gaps (Staxis has a weaker version)

- **Static UI localization.** Optii has 21+1 languages. Flexkeeping has many (count not stated). Staxis: EN/ES only.
- **Auto-categorize maintenance issue from photo.** Optii has it partially via Job Assist (LLM-likely vision extraction). Hotel Effectiveness has CV in Transcendent for equipment onboarding (not maintenance issues). Staxis: nothing.
- **Variance / expected-vs-actual reporting.** All three competitors have descriptive variance dashboards. Staxis has shadow-MAE + backtest report, but it's developer-facing on the admin ML page, not operator-facing on a housekeeping dashboard.
- **Auto-assignment of housekeepers.** All three have some form of auto-assign (rules or rules-fed-by-ML). Staxis: nothing — rules engine not built yet.

### 6.3 Wins (Staxis has things none of the 3 competitors have)

- **Per-(room × housekeeper) supply prediction with quantile bands.** Optii predicts per-job duration but doesn't publicly expose quantile bands. Staxis returns p25/p50/p75/p90 per row.
- **Bayesian cold-start that works at N=0.** Cohort-aggregate priors + closed-form Gaussian-IG posterior. Competitors either require data accumulation or fall back to manager-set defaults (no graceful uncertainty).
- **Cold-start honesty labels in product UI.** Staxis explicitly labels predictions as "AI recommendation" vs "Industry estimate · learning" vs "capacity unavailable." No competitor does this — they either pretend cold-start is AI or hide it from the user.
- **Monte Carlo headcount optimizer with completion-probability curve.** Recommends headcount where P(complete within shift) ≥ 95%. Hotel Effectiveness recommends headcount via standards but no probability. Optii doesn't forecast headcount at all. Flexkeeping doesn't forecast headcount at all.
- **Sensitivity scenarios on every optimizer result.** "one HK sick" and "+5 checkouts" shown automatically. No competitor surfaces this.
- **Statistical activation gates (5-gate + 2-run streak).** Model can't go live without passing data-size + MAE + beats-baseline + 2 consecutive runs. No competitor documents anything similar.
- **Shadow-mode promotion soak (7 days, MAE ≤ active × 1.05).** A bad retrain can't silently degrade an active model. No competitor documents this.
- **Statistical auto-rollback (Wilcoxon + BH-FDR fleet-wide).** Daily check that the active model isn't worse than a same-DOW naive baseline; FDR correction at α=0.05 means at fleet scale we don't fire spurious rollbacks. No competitor documents drift detection of any kind.
- **Walk-forward backtest with read-only proxy + refusal contract.** Honestly reports out-of-sample MAE, refuses to report headline if `days_fitted<14`. Competitors only show descriptive variance.
- **Inventory days-until-out forecast.** Per-(property × item) Bayesian rate prediction → reorder recommendation. **None of the 3 competitors do inventory forecasting at all** — they're all housekeeping/labor first.
- **Feature snapshot persisted with every prediction (jsonb).** Enables post-hoc audit and re-training with exact historical context. No competitor documents this.
- **Deterministic Monte Carlo (128-bit seed from property+date).** Same input → same output, auditable. No competitor documents this.
- **Cohort priors with explicit `cohort-aggregate` vs `industry-benchmark` source tracking.** Lets us upgrade cold-start quality as the network grows, without polluting industry seeds.

---

## 7. Sources cited

All URLs are deduplicated across the three competitor sections. See sections 2 (Optii), 3 (Flexkeeping), and 4 (Hotel Effectiveness) for source lists organized per competitor.

**Research caveats applicable to all three:**
- `hoteltechreport.com` returned HTTP 403 to WebFetch — claims sampled via search snippets only.
- `patents.google.com` does not render via WebFetch; patent claims rely on press-release summaries.
- App Store / Play Store release notes give partial version histories; full granular changelogs were not retrievable.
- Specific LLM / STT / MT vendors are NEVER disclosed by Optii or Flexkeeping. All "LLM-likely" inferences are architectural, not attributed.
- Mews "agentic AI" operations agent for housekeeping is roadmap, not shipped as of May 2026.
- Hotel Effectiveness AI capabilities are "in development" per Actabl's own AI strategy page — no shipped AI-branded feature inside Hotel Effectiveness itself.


---

## 6. Gaps list

[PENDING — built after comparison table]

---

## 7. Sources cited

[PENDING]
