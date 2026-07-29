# Portfolio Intelligence architecture

- Status: implemented behind the existing management-company chatbot
- Last reviewed: 2026-07-28
- Contracts: `portfolio-scope.v1`, `portfolio-query-plan.v1`, `portfolio-evidence.v1`, `portfolio-synthesis.v2`, `portfolio-finding.v1`

## Product boundary

Portfolio Intelligence is an orchestration and evidence layer, not a second chatbot or a second hotel data platform. The existing chat surface selects one of two server paths:

- hotel mode uses the existing property-scoped tools;
- management-company mode resolves a fresh company scope, plans a bounded portfolio query, invokes normalized property adapters, and asks the configured model only to synthesize the resulting evidence.

The model does not receive a raw portfolio export and does not decide authorization, hotel identity, metric definitions, comparisons, denominators, inclusion, or totals. It cannot call mutation tools in portfolio mode.

The `/company` surface remains **My Hotel** with exactly four tabs:

| Tab | Responsibility |
| --- | --- |
| Overview | Summarize company → portfolio/region → hotel structure and surface access/topology problems. |
| Hotels | Manage same-company portfolio/region assignments. In the same tab, a freshly verified platform admin can preview, confirm, and audit hotel acquisition/linking, relationship type changes, deactivation, or transfer. |
| People | Invitations, memberships, lifecycle state, and the selected-hotel roster. |
| Access | Each person's role and whole-company, portfolio/region, or selected-hotel scope; revocation is immediate and audited. |

No fifth company tab or parallel customer access console is introduced. The existing Admin-view switch changes the perspective of these four tabs. The global Admin navigation entry is a separate platform-administration route and is visible only after a fresh server verification of `accounts.role = 'admin'` on an active account. A self-only Realtime authorization-version notification triggers a new no-store server verdict on initial subscription, reconnect, and role/scope change; the notification itself contains no role, organization, capability, or hotel data. Page layouts and APIs still authorize independently.

The People lifecycle is authoritative rather than a UI-only roster. An invitation carries one exact organization, portfolio/region, or hotel scope and a server-validated access profile. The public preview reveals only its human-readable terms; acceptance rechecks the verified email, current inviter authority, active organization/topology, expiry, and single-use claim before atomically consuming the invitation and creating its normalized membership/grant. New-account registration starts with the least-privileged legacy account (`staff`, no hotel IDs) and compensates a definitively failed identity setup. Cancellation and membership suspend/resume/remove use caller-specific server verdicts, require a reason, update authorization state immediately, and emit an audit event. The browser-projected `canCancel`, `canSuspend`, `canResume`, and `canRemove` flags are presentation hints only; each transaction reauthorizes.

## System review and chosen architecture

### Identity, hierarchy, and access

The existing hierarchy is account → organization membership → organization access grant → portfolio tree and/or hotel, intersected with the organization's current primary owner/operator hotel relationships. Portfolios can represent regions, divisions, or other nested management groupings. A hotel can be operated only through a current governing relationship for authorization purposes.

The former system had multiple partially overlapping authorities: `accounts.property_access`, membership hats, access grants, property relationships, and several route-specific role checks. This allowed a legacy hotel ID to survive a hat revocation or hotel transfer; region grants did not reliably bridge to hotel tools; finance could be denied intended read access; some capability gates ignored hats; and some readers truncated at 30 hotels.

Migration 0376 introduces one per-account authority state:

- `legacy` and `shadow` read the legacy array only;
- `normalized` reads normalized entitlements plus explicit, expiring migration bridge rows only;
- no runtime path unions legacy and normalized authority.

Normalized reach is the intersection of current account/membership/grant state and current governing topology. Company hats, recursive portfolio/region grants, and explicit property grants expand into exact hotel entitlements. Revocation, hotel reassignment, grant change, membership change, or account-role/state change increments authorization state and organization access epochs. Receipts issued under an old epoch fail revalidation.

`resolveAuthorizationScope` is the authoritative request-time resolver for company AI and management surfaces. It accepts only:

- all authorized hotels;
- one authorized portfolio/region, including cycle-safe descendants;
- an explicit non-empty set of authorized hotel IDs.

The selector is all-or-nothing. Unknown or unauthorized IDs, ambiguous organizations, empty scopes, stale receipts, or store failures fail closed. The full authorized universe and selected set are sorted, hashed, persisted, and returned without the old 30-hotel truncation. A supported interactive query may contain at most 250 hotels; a larger exact scope is refused explicitly, never silently sliced. A named single-hotel drill-down in a larger authorized universe remains bounded and supported.

A single-property GM may use hotel mode for their own hotel. A property-only role does not acquire portfolio reach and cannot enumerate, aggregate, infer, or direct-ID query a sister hotel. Finance and other read-oriented company roles can receive normalized portfolio read reach without inheriting write capabilities.

`resolveManagementCompanyScopeUncached` is the feature-independent server facade shared with read-only company surfaces and queue consumers. It resolves one explicit organization to an exact all-authorized receipt without consulting the `cross_hotel_ai_chat` setting, fails closed on ambiguous or foreign organizations, and returns the exact property IDs plus receipt-derived company role, grant descriptors (`company`, `region`, `portfolio`, or `selected_hotels`), presentation capability hints, an org-wide queue-availability verdict, and an exact per-hotel standing. Receipt provenance is strictly parsed before any of these values can be derived. Queue availability requires broad company/organization provenance to cover every hotel in the exact receipt; a mixed broad+narrow grant cannot launder opaque company findings.

The per-hotel standing deliberately separates `seesFinancials`, `hotelMutationAllowed`, `operationalRole`, and `portfolioIntelligenceRead`. A bare company owner, VP, or finance hat remains read-only inside an individual hotel. It is never translated to general manager and cannot enter private local Communications, create a staff identity, or mutate hotel records without an explicit property-level operational entitlement. A company finance hat may use server-authorized read-only hotel Financials drill-down, while payroll/wage and mutation tools remain unavailable. Cards and client state consume these standings only as presentation input; each route/tool and every database commit rechecks current authority independently.

For `/feed`, this Access candidate owns the authorization contract, not downstream mutation mounting. `queueAvailable` is the fresh organization-wide read verdict: every hotel in the exact receipt must be covered by company/organization provenance, so a region, portfolio, selected-hotel, or mixed broad+narrow grant cannot expose opaque company cards. Any hotel-level write reached from `/feed` must ignore that read verdict and freshly resolve the targeted hotel's `AuthoritativePropertyStanding`, require `hotelMutationAllowed`, and recheck the relevant section/capability at the write boundary. The Finding Patterns semantic integration owns mounting and testing any `/feed` mutation path; the current Access candidate must not claim that downstream route as mounted.

Hotel-chat tools use an old-and-current intersection at every execution boundary. The immutable catalog actually shown to the model is the maximum authority for that turn, and a hallucinated, aliased, replayed, or newly granted tool outside that catalog is refused. Mutation, section, and capability tools also require explicit route-captured proofs; omitted proofs fail closed. Immediately before each handler, the server reloads the active account and exact hotel standing, then performs uncached section and capability reads. Revocation, reassignment, role loss, capability removal, section disablement, or any resolver/configuration outage therefore stops the next tool before it reads or writes. A mid-turn grant never expands an already-issued catalog.

Recursive portfolio/region access expands through active descendants with a cycle-safe database query. Structure preview/commit and delegation require the actor's own managerial entitlement over every affected hotel; a narrow manager grant cannot be combined with an unrelated viewer grant to manufacture write reach. A selected-hotels deep link treats its descriptor ID as opaque: the server freshly resolves the explicit organization, requires one current matching descriptor, and mints a new exact-subset receipt from the current hotel IDs. URL-carried IDs never become authority.

### Conversation scope

Migration 0377 gives portfolio conversations a first-class kind, organization ID, authorization hash, and receipt identity. Migration 0397 makes a completed portfolio turn one atomic database commit: the exact immutable model-request artifact and query receipt must already agree with the normalized question and deterministic rendered answer; PostgreSQL then reasserts current account/company scope and inserts the user message, assistant message, and immutable turn link together. The same insert trigger validates the two roles, conversation IDs, text bounds, and exact replay bytes, then updates a service-inaccessible per-conversation turn/byte ledger. Conversation creation and continuation prep write no message. A provider failure, withheld answer, invalid receipt, question/answer mismatch, revocation, or retry before commit therefore leaves no dangling user text in future model context or browser history. Retries of the exact committed receipt/text are idempotent.

Ordinary property history routes cannot list, read, or continue portfolio conversations. Dedicated portfolio list/detail routes require an explicit company, an active account, and a freshly resolved exact authorization hash both before reading and immediately before browser egress. Model replay includes only message pairs joined through immutable turn commits whose question/answer hashes and receipt/evidence scope all match. It reads an indexed newest-24 candidate set, then applies a 65,536-byte UTF-8 replay budget before aggregation and restores the included suffix chronologically. The budget includes a conservative 128-byte provider-envelope allowance per complete turn. Durable writes cap a user message at 4,000 characters/16,000 UTF-8 bytes and the deterministic assistant answer at 49,000 bytes, so the newest valid committed turn always fits. Exact currently retained included/omitted turn and byte counts come from the atomic ledger, avoiding an all-history text scan; receipt retention decrements that ledger in the same transaction. TypeScript checks the closed metadata, pair shape, role order, per-message limits, and recomputed included bytes again before provider egress. Browser metadata omits these internal counters along with authorization hashes, receipt IDs, raw hotel IDs, raw evidence, and the relational anchor hotel. Each restored answer carries a sanitized disclosure of company, selected grain, authorized/selected/reported counts, hotel names, and omissions.

The selector/scope hash may change across turns—company → region → hotel → company—but the organization and selector-independent authorization hash may not. Each turn and each history load resolve authorization again. Switching company, mode, or property clears the client conversation immediately, aborts in-flight work, masks buffered output, and starts a new context. A stale or reused conversation receives a refusal rather than being repaired or moved to another company.

The legacy physical conversation archive deletes live rows. That would destroy portfolio turn links and null immutable artifact/receipt conversation bindings. Migration 0399 therefore rejects archive and restore for portfolio conversations before any write, while preserving property-chat archive behavior. Receipt-provenance-preserving portfolio archival is intentionally deferred; silently restoring an unreceipted transcript is not allowed.

### Planning and hotel identity

The deterministic planner maps a bounded question to a typed query plan. It recognizes all authorized hotels, a named portfolio/region, an explicit hotel subset, or one hotel. A name is matched only against the freshly authorized catalog. If two authorized hotels share the name, the planner requires a city, region, property code, or short-ID qualifier; otherwise it asks for disambiguation. An unknown or unauthorized name never falls back to all hotels.

Examples supported in the same conversation:

- “How many rooms are booked today across all my hotels, and which hotels are above or below normal?”
- “How many rooms are booked today at Comfort Suites?”
- “What is happening at Hotel X today?”
- “Now show the Midwest region.”
- “Back to all my hotels.”

For every tool execution, the route creates a selector-specific receipt from the same resolver and reasserts it before and after the database work. It rechecks again after optional knowledge, immediately before the provider, after synthesis, before persistence, and after both the awaited cost reconciliation and distributed query-lease release. No await remains between the final check and response construction. This intentionally buffers the bounded synthesis response so a revocation during generation, final accounting, or lease release cannot leak the completed answer.

### Canonical metrics and property adapters

Metric semantics live in a closed registry. Each definition includes its version, numerator, denominator, unit, normalized unit, aggregation rule, source grain, hotel-local window, freshness threshold, currency policy, and missing-data policy. Aggregation uses raw totals plus a valid normalized comparison; averages are not averaged across hotels when a weighted denominator is required.

Implemented metrics:

| Metric | Canonical meaning | Comparison behavior |
| --- | --- | --- |
| `rooms_booked_otb` | `pms_booking_pace.rooms_otb` for each hotel's current business/stay date from the newest successful/promoted ingest receipt. It is not live occupancy or final sold rooms. | Same-weekday, lead-zero median and median absolute deviation over 12 weeks, with at least 6 comparable points. No peer fallback. |
| `housekeeping_rooms_cleaned` | Recorded or approved cleaning events in the hotel-local business window. | Raw count. |
| `housekeeping_active_minutes` | Active minutes for those same events. | Weighted minutes per cleaned room; missing denominator excludes normalization. |
| `work_orders_open` | Current unresolved first-party Staxis work orders. | Raw count. |

`live_in_house_rooms` and `final_rooms_sold` have versioned definitions, but the portfolio adapter deliberately abstains until a source with the required live/sealed semantics is available. It never substitutes OTB rooms. Money aggregation likewise requires ISO currency and an explicit versioned FX policy; no current portfolio money metric crosses currencies.

The portfolio layer delegates to existing normalized hotel/PMS tables and receipt lineage. It does not copy or reinterpret each hotel's adapter. A missing measure, invalid timezone, missing denominator, stale source, failed ingest, or timeout becomes an explicit exclusion with a reason. For example, a 20-hotel query can say “17 of 20 hotels reported; 3 omitted” and identify each omission; it cannot estimate the other three.

Every hotel fact carries its business date, timezone, metric and comparison versions, numerator/denominator, quality, freshness, source table/record, ingest run, source business-as-of date, source observation time, capture time, parser, and parser version. Both observation and ingest capture must be current, so a newly ingested old backfill cannot appear fresh. Evidence distinguishes observed facts, deterministic aggregates/comparisons, accepted pattern findings, and unverified hypotheses.

### Snapshots and reproducibility

Migration 0378 stores short-lived, immutable **property-grain** booked-room metric snapshots. It intentionally stores no company aggregate and no organization ID. Every request freshly resolves the authorized hotels, loads eligible property facts, and aggregates only that exact selection. This prevents a cached company result from surviving a hotel transfer. Operational housekeeping/work-order metrics still use bounded direct property reads; they are not falsely described as materialized.

Snapshot keys include property, metric/comparison versions, business date, source identity, ingest receipt, source business-as-of/observation/capture time, and parser version. Expiration is bounded by both the five-minute acceleration TTL and the six-hour OTB freshness window. A baseline-enriched snapshot can satisfy a later factual drill-down, but a no-comparison snapshot cannot satisfy an “above normal” query. Source reads remain authoritative and are used on a miss or cache rollout failure.

Each answer candidate produces an immutable query receipt containing exact authorized and selected hotel IDs, authorization/scope hashes, question and answer hashes, the exact composed prompt hash/version when a model is used, actual model ID/tier (including fallback), plan/evidence/metric/source versions, source timestamps, knowledge fact IDs/revisions, the Finding Patterns contract/run status, status, and duration. Raw question, prompt, knowledge content, and answer text are not duplicated in that compact receipt. A separate service-only immutable 0397 artifact retains the exact provider request attempts, applied parameters, raw model candidate, validated presentation plan, and deterministic rendered answer for incident reproduction. Deterministic knowledge answers instead use the service-only 0403 artifact, which preserves the exact verified overlay, selection, source revisions, and rendered answer without inventing a provider attempt. Both artifact kinds share the same minimum 90-day retention boundary and are XOR-bound to the compact receipt. Browser roles cannot read any of these stores. A completed receipt becomes conversation history only after the receipt-bound atomic turn commit and the final authorization check.

Migration 0403 preserves rolling provenance instead of rewriting history. Every pre-0403 query receipt is labeled `finding_binding_status = 'legacy_unbound'` without changing its `finding_versions` bytes and may retain the prior 262,144-byte ceiling; new receipts default to `validated`, must carry the closed signed projection receipt, and are capped at 65,536 bytes. `legacy_unbound` is migration-only and cannot be inserted by a new writer. Existing pre-0403 model artifacts keep null finding/scope additions; every new model or deterministic-knowledge artifact must bind the real signed finding receipt to the exact account, organization, authorization receipt/hash, scope hash, and authorized/selected hotel sets. DB-first compatibility may derive only the two new scope arrays from the live receipt and may copy only an already signed, scope-validated `not_mounted` receipt from the model artifact into an old writer's query receipt. Missing provenance is never synthesized, repaired, truncated, or silently upgraded.

### Company knowledge overlay

Only active, confirmed company facts and active, confirmed selected-hotel facts are eligible. Company policy, vendors, standards, terminology, organizational structure, and notes are inherited only inside the freshly resolved organization. Hotel-specific facts do not win by textual similarity. Migration 0380 requires an explicit provenance link to exactly one confirmed company fact and verifies that the hotel is currently governed by that organization. Migration 0383 stamps new property memory with its immutable authoring organization and exposes one bounded RPC that atomically validates every requested hotel against current company topology before returning at most 1,000 facts. Historical rows whose authoring company cannot be proven remain `NULL` and are excluded; the migration never guesses provenance from present-day ownership. Without an explicit override link, conflicting facts are shown as a conflict and synthesis abstains. Transfer cannot carry old-company authored memory or override precedence into the acquiring company's overlay.

All knowledge and source text is untrusted data. It is tenant- and exact-property-set checked, length-bounded, escaped, and cannot alter system instructions or tool scope. A direct policy/vendor/standards/organization question uses a closed lexical planner and a deterministic renderer: selectable claims are opaque scope-bound IDs, while every visible fact, override/conflict state, source revision, and date comes from the verified overlay. No provider request is made or fabricated for that path. Migration 0403 stores a separate immutable deterministic-knowledge reproduction artifact, XOR-binds it with the real-model artifact field on the ordinary query receipt, and commits the user/assistant pair through the same receipt-bound atomic conversation function. Internal hotel/company UUIDs and authorization/scope hashes remain in service-only proof records rather than browser-visible prose.

Metric questions may include the same overlay as optional untrusted reference context after canonical evidence has been built. That load has a two-second sub-budget; a timeout or cancellation degrades to evidence-only synthesis instead of owning the route deadline. Knowledge never changes an aggregate, authorization, tool catalog, or action policy.

### Finding Patterns boundary

Portfolio chat does not implement the separate management-company Finding Patterns engine. Its tested consumer contract accepts only `portfolio-finding.v1` envelopes from producer `management-patterns` and validates organization, exact evaluated/affected authorized hotels, lifecycle/expiry, source and run versions, claim kind, evidence coverage, prompt safety, and cohort privacy. The load receipt is rebound to the current account, organization, authorization hash, scope receipt/hash, and exact selected hotel IDs; equal counts cannot transplant a receipt from another company, user, or selection. Loaded envelopes must match the receipt's engine/run/query identities and production, source-as-of, and validity timestamps exactly. Anonymous cohorts smaller than five are suppressed. The producer's organization, authorization hash, and scope hash may remain null only for the producer's exact pre-read, claim-free zero states: `unavailable` with an `authorization_before_read` outage, or `scope_changed` with the no-outage shape. Both require exactly one bounded authority exclusion while the current consumer account, receipt, selected IDs, and non-null outer scope remain authoritative; the original producer fingerprint is preserved rather than fabricating missing inputs.

One content-addressed projection is reused by the prompt, presentation catalog, plan validator, deterministic renderer, numeric allowlist, and durable receipt. It admits at most 40 Finding claims, further reduced when necessary so the complete presentation catalog remains at most 64 claims. Both the Finding prompt block and the presentation-plan contract are independently capped at 12,000 UTF-8 bytes; the compact durable projection receipt is capped at 65,536 bytes. The model selects opaque claim IDs only. Rejected, item/UTF-8-budget omitted, and merely projected-but-unselected findings cannot license answer numbers. The compact receipt preserves exact source partitions, status/run provenance, the producer fingerprint, pre-model and post-model omission sets, and a recomputable projection hash; it does not retain producer candidate IDs, selected hotel IDs, statements, or full finding DTOs. `loaded` with zero accepted claims is valid when every loaded candidate is rejected by either the producer or consumer, while every non-loaded status remains claim-free. Tests must prove the same projection/claim IDs flow unchanged through prompt, catalog, plan validation, deterministic rendering, numeric allowlisting, both artifact kinds, and the query receipt, including multibyte UTF-8, rejected, truncated, projected-but-unselected, and mounted-zero poison cases.

The route in this branch deliberately records `not_mounted` and supplies no findings until the independently owned, bounded active-only producer loader is integrated. Shadow candidates must never be exposed. Missing, empty, rejected, or unavailable findings do not block factual portfolio questions.

### LLM and cost boundary

The sequence is deterministic authorization → deterministic plan → bounded property reads → deterministic aggregation/evidence → one bounded synthesis call. The model receives the question plus a compact evidence envelope, not raw database records. Portfolio mode exposes no model-callable tools and no mutation catalog.

Current interactive budgets are:

- exact portfolio maximum: 250 hotels;
- pre-query rate limit: 10 attempts/minute and 120 attempts/hour per exact account + organization;
- distributed concurrency: one live query per exact account + organization, with a 75-second crash-recovery lease;
- property-read concurrency: 8;
- per-hotel timeout: 4 seconds;
- overall deterministic query timeout: 25 seconds;
- maximum detailed rows: 25, with exact aggregate/coverage retained;
- overall route/model deadline: 55 seconds;
- optional company/property knowledge budget: 2 seconds;
- OTB source freshness: 6 hours;
- snapshot acceleration TTL: at most 5 minutes.

The shared provider boundary caps each provider attempt at 8,192 output tokens. Portfolio mode performs one no-tool synthesis operation; a configured fallback may make one secondary provider attempt inside the same 55-second deadline, and both attempts are retained and billed. Before the provider call, the route atomically reserves a price-scaled worst-case hold against the configured primary/fallback plan. Shared daily spend ceilings are $5 for a free account, $50 for a pro account, $200 for an enterprise account, $25 per property, and $500 globally. An account-tier lookup failure falls back to the $5 free-account ceiling, while reservation-system failures fail closed. Success reconciles the hold to actual input, cache, and output usage; a pre-provider abort cancels it. These values are code contracts, not suggested alert thresholds: changing model prices, token ceilings, fallback plans, or account tiers requires re-deriving the reservation and rerunning cost/evaluation gates.

The atomic database admission happens after fresh company authorization but before hotel metadata or deterministic fanout. Busy attempts count against the rate window, limiter failures fail closed, and an exact random token releases the lease in `finally`; a different or newer token cannot be cleared. Timeouts and partial source failures become exclusions. Caches are property/source/version keyed; no key contains only a company name or user-provided label. Request cancellation and the absolute query deadline propagate into PostgREST `.abortSignal(...)`. Client cancellation stops assigning hotels, aborts active reads, and emits no answer. A deterministic read deadline preserves completed facts and creates explicit timeout evidence for every unfinished or unstarted hotel, in stable selected-scope order, before synthesis. Usage is recorded through the existing model usage ledger and the immutable portfolio receipt. Before release, a buffered number-honesty guard rejects synthesized numerals absent from deterministic evidence; user and conversation text never count as numeric evidence.

### Actions

Portfolio Intelligence is intentionally read-only. It cannot approve or execute a property or cross-hotel action. Organization-wide announcements are also disabled until they have the same safe-action contract. A future cross-hotel action protocol must be a separate contract with a deterministic preview, exact target hotel IDs, typed per-hotel operations, explicit user confirmation, authorization recheck at commit, idempotency key, immutable audit event, and per-hotel partial-failure result. Granting an autonomous mutation tool to portfolio synthesis is out of scope.

## Trust boundaries and threats

| Threat | Control |
| --- | --- |
| Cross-company leakage / IDOR | Fresh authoritative receipt; organization and every selected hotel validated in the database; exact post-read assertion; generic refusals. |
| Stale membership, revocation, hotel transfer, acquisition, or same-turn tool grant/revocation | Account authorization version + organization access epoch; topology triggers; pre/post-query and pre-release rechecks; per-tool active-account/standing plus uncached section/capability intersection; property-grain cache only. |
| Legacy `property_access` surviving normalized changes | Per-account exclusive authority mode; explicit migration bridges; no runtime union; bridges retire when real entitlements exist. |
| Conversation reuse across company | Immutable conversation organization/auth hash; atomic locked turn; client hard reset; portfolio history isolated from property history. |
| Direct hotel/portfolio ID tampering | Strict Zod input; all-or-nothing database selector validation; typed planner and tool schemas. |
| Prompt injection in notes, PMS text, or findings | Data is schema/length bounded, escaped and marked untrusted; no portfolio model tools; deterministic totals and claims. |
| SQL/tool injection | Closed metric/query vocabulary and parameterized scoped database adapter; the LLM never writes SQL or hotel IDs. |
| Cache-key mistakes | Property/source/metric/version/business-date keys only; no persisted company aggregate; authorization never cached as an answer key. |
| Retry storm / aborted 250-hotel fanout | Atomic account+organization pre-query rate admission; one distributed lease; eight active lanes; PostgREST abort signals; no new hotel scheduling after cancellation. |
| Small-cohort inference | Anonymous pattern cohorts require at least five; property-only users have no catalog or portfolio endpoint. Named authorized hotel comparisons remain explicit rather than pretending anonymity. |
| Export, log, and trace leakage | Receipts store hashes and bounded structured evidence, not raw chat; service logs use IDs/codes, not evidence payloads; browser roles are denied receipt/snapshot tables. |
| Overprivileged service credentials | Service-only tables/RPCs deny browser roles; SECURITY DEFINER functions set a fixed search path; all routes independently authorize before service-role reads. |
| UI-only or stale Admin gating | A self-RLS opaque version notification forces a fresh server verdict on subscription/reconnect/change; focus/visibility/interval are recovery paths. Every platform Admin page/API and lifecycle transaction independently checks active global-admin status. Customer hats never translate to global admin. |

## Test and evaluation coverage

The automated suites cover two-company isolation, company/region/hotel scopes, multiple companies, finance access, property-only GM isolation, duplicate hotel names, qualifiers, explicit subsets/all, direct-ID tampering, >30 and huge portfolios, empty scopes, newly acquired and transferred hotels, invite → grant → revoke, role changes and revocation during/open conversations, conversation reuse, committed-only resume across portfolio → hotel grain changes, failed-prep retry without dangling messages, question/answer hash tampering, 51-turn and multibyte replay bounds, maximum-turn inclusion, trigger-owned counter retention/cascade behavior, portfolio archive refusal without provenance loss, scheduled grants, same-turn tool/section/capability revocation and non-expansion, resolver/configuration outages, partial source outages, stale/backfilled sources, missing denominators, mixed timezones/currencies, knowledge conflicts/overrides, deterministic-artifact poisoning and legacy rollout compatibility, pattern contract rejection, small cohorts, admin visibility/direct-route denial/demotion, and company assignment preview/commit races.

The checked-in golden evaluator is deterministic and lexical: it scores factuality, exact scope disclosure, source/freshness fidelity, partial coverage, abstention, small-cohort privacy, and bounded call counts. The executable route tests retain real authorization and database contracts while injecting only the provider boundary. They prove exact aggregate → named-hotel drill-down, a six-sample normal baseline even when 140 current-stay curve rows exist, rejection of an unbacked model number, revocation during reconciliation and lease release, no metadata/readers after a pre-query 429, one-winner distributed concurrency, graceful mid-fanout deadline evidence, and client cancellation of a 250-hotel load without scheduling beyond the eight active lanes. A live-provider eval remains a release-environment gate rather than being misrepresented as a hermetic test. See `src/lib/agent/evals/portfolio.ts` and the portfolio suites under `src/lib/__tests__`.

## Residual risks and intentional exclusions

- Live in-house and final rooms-sold adapters remain unavailable; those requests abstain rather than substitute OTB.
- The independent Finding Patterns producer is owned by its separate task. This branch defines and tests the consumer boundary but leaves the route explicitly `not_mounted`; production deployment is gated on integration of the reviewed active-only loader and the combined migration chain.
- Cross-hotel mutations are intentionally absent.
- Cross-currency money aggregation is absent until a versioned rate source and accounting policy exist.
- Interactive all-hotel scopes above 250 require a product decision about asynchronous/export workflows; the API never truncates them.
- Portfolio conversations are not physically archived/restored until archive storage can preserve the immutable artifact → receipt → committed-message proof graph; 0399 rejects both operations without data loss.
- Live-provider factuality/cost evaluation must run in the release environment with the configured model; CI uses deterministic provider-boundary synthesis and never spends production model budget.
- Service-role compromise remains high impact and requires infrastructure controls, key rotation, database audit review, and least-privilege deployment credentials outside this repository.
- Migration 0404, the knowledge revision ledger, is a separately owned follow-on migration with its own reviewed candidate/hash. It is not part of this Access candidate or its 0403 hash and must not be copied, renumbered, or represented as included here.
