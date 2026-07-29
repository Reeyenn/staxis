# Portfolio Intelligence deployment and operations runbook

This runbook deploys the authoritative company-access model and Portfolio Intelligence together. Database contracts normally deploy before the application that consumes them. Migration `0398` is the one reviewed exception: closing direct join-code storage requires an application-first compatibility stage and a full old-instance drain, described below.

## Pre-deployment gates

1. Confirm the release contains the authoritative-access and Portfolio Intelligence migrations listed below and the independently owned Finding Patterns migrations at their globally assigned numbers (`0389` and `0392`). Validate one combined chain; do not copy or renumber another task's files inside this branch.
2. Run `npm run lint`, `npm test`, `npm run test:integration`, and `npm run build` with production-equivalent Node and environment validation.
3. Run the CUA service TypeScript and test suites; PMS lineage is part of source provenance.
4. Replay all migrations against a disposable database and run the SECURITY DEFINER, RLS, service-import, and API tenant-scope audits.
5. Exercise the two-company fixture: owner/VP/finance/region manager, one-hotel GM, revoked user, moved hotel, newly acquired hotel, duplicate names, 20-hotel partial outage, and direct foreign IDs.
6. Verify a current global admin sees `/admin/properties#live`; company owner/VP/GM/finance accounts neither see the entry nor pass direct page/API authorization. Remove the admin role in the database and verify the open session receives its self-only authorization-version notification, refreshes the no-store verdict, removes the entry, and is independently denied by the open page/direct API.

## Combined-release integration boundary

This branch is an Access candidate rooted at `24d330cc228c261c3e674425fcffc166025df72f`. It is not an independently deployable release. Integrate the reviewed candidates in this ancestry-aware order:

1. certified Access candidate based on `24d330cc`;
2. Finding Patterns v2 `0029edb0d66a18e4036a15f49cb0570ed8a6a7b5`
   (`codex/management-finding-patterns-v2`, tree
   `18d96d5c31b0bd299b77d1af8c027657d90aa7e3`);
3. Next 16 compatibility `ad623a676b8aa2400c6b438491335c7d390061cf`;
4. Navigation/Loading `5eda8012e22029bad1b32d1cd49327328f085090`;
5. the separately certified `0406` company-knowledge revision-ledger commit,
   cherry-picked after Navigation while retaining its certified Access parent;
6. the combined-only `0407` company-finding verdict CAS migration and route/UI wiring;
7. VP semantic merge and the full combined release gates.

Do not copy files between dirty worktrees or deploy an intermediate hash. The semantic merge must preserve both the compatibility branch's extracted `normalizeBoardExtraction` helper and this branch's fresh, exact-hotel capability checks around board-photo processing. It must also preserve the authoritative scope/property-standing APIs while adding Finding Patterns' strict topology and queue helpers, then regenerate cumulative database types and the Admin Doctor migration catalog through `0407`.

Migration `0406` (knowledge revision ledger) remains a separately certified
child of the Access commit. In the combined release it is cherry-picked after
Navigation so its independent parentage remains auditable without weakening
the locked Access → Finding Patterns → compatibility → Navigation sequence.
Migration `0407` exists only at the final combined boundary because it depends
on both authoritative Access and the Finding Patterns company-finding shape.

After the final merge, run a fresh clean install and the default Turbopack production build, not only a webpack compatibility build or a build against a shared `node_modules` symlink. Re-run the combined migration chain, browser/RLS/security audits, API and integration suites, AI evaluations, and the multi-tenant browser smoke before any merge or deploy.

## Migration order

Apply in one release window:

1. `0378_authoritative_company_access.sql` — authority modes, bridge rows, normalized entitlements, epochs, immutable scope receipts, and resolver RPCs.
2. `0379_agent_portfolio_conversation_scope.sql` — first-class portfolio conversation binding and property/portfolio route separation.
3. `0380_portfolio_intelligence_snapshots.sql` — property metric snapshots and immutable query receipts.
4. `0381_company_structure_management.sql` — preview/confirm assignment contract, authorization, idempotency, epochs, and audit.
5. `0382_portfolio_knowledge_overrides.sql` — explicit hotel-over-company fact provenance.
6. `0383_company_access_management.sql` — existing-person whole-company, portfolio/region, and selected-hotel access editing with preview/confirmation/idempotency/audit.
7. `0384_admin_hotel_relationship_lifecycle.sql` — platform-admin hotel link/acquire, relationship type, deactivate, and transfer lifecycle inside the existing Hotels tab.
8. `0385_agent_memory_organization_provenance.sql` — immutable memory authoring organization and one bounded current-topology company overlay RPC.
9. `0386_portfolio_receipt_provenance.sql` — exact prompt hash plus actual model, knowledge, and finding provenance.
10. `0387_account_authorization_notifications.sql` — non-sensitive self-only Realtime invalidation for open-session role/scope changes.
11. `0388_active_primary_relationship_transfer_guard.sql` — temporal current-primary relationship enforcement and safe hotel transfer guard.
12. `0390_authoritative_people_access_bridge.sql` — authoritative selected-scope people roster and safe hat-to-normalized access transition.
13. `0391_portfolio_query_admission.sql` — atomic account+organization pre-query rate limits and one bounded distributed query lease.
14. `0393_transactional_invite_and_join_acceptance.sql` — commit-time actor/topology checks and atomic normalized invite/join acceptance.
15. `0394_portfolio_booked_room_points.sql` — bounded service-only current OTB point plus exact lead-zero baseline projection for one hotel.
16. `0395_authoritative_people_lifecycle.sql` — actor-bound authoritative invitation, membership, reassignment, and revocation lifecycle.
17. `0396_authoritative_browser_mutation_boundary.sql` — browser-facing hotel writes recheck the caller's live per-hotel standing in PostgreSQL; service-only integrations remain explicit.
18. `0397_property_scoped_nudge_recipients.sql` — nudge recipients are projected from the exact authoritative hotel standing instead of stale legacy arrays.
19. `0398_privileged_onboarding_join_codes.sql` — RPC-only join-code storage, atomic signup finalization, code-kind separation, transfer/revocation invalidation, and bearer-free audit history.
20. `0399_portfolio_model_request_artifacts.sql` — immutable model-request reproduction artifacts, receipt-bound atomic portfolio turn commits, and trigger-owned exact replay counters; conversation prep reads at most the newest 24 complete turns and no longer writes user messages.
21. `0400_privileged_rpc_tenant_boundaries.sql` — browser room-work/count reads intersect `auth.uid()` with current hotel reach, while global maintenance helpers remain service-only.
22. `0401_portfolio_conversation_archive_boundary.sql` — fail-closed portfolio archive/restore until immutable turn-link provenance can be archived without loss; property chat archive behavior is unchanged.
23. `0402_company_structure_manager_entitlement_boundary.sql` — structure preview/commit requires the actor's own managerial entitlement for every affected hotel; disjoint viewer reach cannot be combined with a manager grant.
24. `0403_recursive_portfolio_access_scope.sql` — cycle-safe recursive descendant expansion for region/portfolio reach and delegation.
25. `0405_deterministic_portfolio_knowledge_artifacts.sql` — exact no-provider company-knowledge reproduction artifacts, XOR-bound to query receipts and atomic conversation replay without fabricating a model attempt.
26. `0406_company_knowledge_revision_ledger.sql` — append-only hash-chained organization knowledge revisions, optimistic current-revision/CAS mutation, safe compatibility/finalization phases, and genesis backfill.
27. `0407_company_finding_verdict_cas.sql` — exact affected-hotel authority, action capability/section checks, row CAS, rolling old-writer denial, and immutable company-finding verdict audit.

The combined release also places the independently owned Finding Patterns source migration at `0389` and evidence migration at `0392`. Migration `0404` belongs to Navigation/Loading and sorts immediately before `0405`. The active-only findings loader is mounted only after a selector-specific receipt is prepared; every accepted package is rebound to that exact scope, and a final receipt assertion still occurs before provider egress and response release.

The v2 Finding Patterns candidate supersedes its earlier standalone candidate.
Before applying its amended `0389`/`0392` SQL, verify those versions have not
already been recorded in the target database. If either version was previously
applied, preserve it and ship the delta under new forward-only migration
numbers; never rewrite an applied migration in place.

Migrations are additive and browser roles are denied new internal tables. Do not manually flip accounts to normalized mode before shadow drift and bridge output has been reviewed. Never restore access by unioning the legacy array into a normalized runtime query.

## 0398 join-code credential-boundary rollout

`0398` intentionally revokes direct `service_role` DML on `hotel_join_codes`. It therefore cannot provide zero-downtime compatibility to an old instance that still queries the table directly. Use this staged order; do not reverse it:

1. Deploy the compatibility application paths that use only the closed join-code resolver/management/resume/transition/finalization RPCs. Before `0398` exists, these endpoints must return a retryable `503`; they must never fall back to direct table access. If signup already created a new Auth identity, it must prove that no relational link committed and delete that unlinked identity before returning.
2. Drain every old application instance and verify no in-flight process can call the historical direct table path or the pre-finalizer claim/account saga.
3. Apply `0398`. The migration revokes every still-live untyped pre-`0398` bearer because its relationship provenance is unprovable, recursively removes case-insensitive bearer keys from historical join-code audit metadata, denies direct service/browser DML, and enables the typed RPCs plus relationship-end revocation trigger.
4. Verify direct `service_role` SELECT/INSERT/UPDATE/DELETE all fail. Verify an old staff link is revoked, its manager can mint a replacement through the guarded RPC, the replacement works, and hotel transfer/revocation makes both staff and privileged bearers unusable before the next finalization/tool boundary.

A database-first rollout against an old application is intentionally fail-closed (permission/RPC errors) and is not the supported zero-downtime order. If the compatibility application cannot be staged and drained first, postpone `0398`; do not temporarily restore direct table grants.

## 0405 rolling-deploy and legacy-provenance policy

0405 narrows only new validated `finding_versions` projections from the prior 262,144-byte ceiling to 65,536 bytes. It must never truncate, rewrite, or ambiguously reclassify an existing receipt.

1. Before the release window, inventory every existing `portfolio_query_receipts` row by ID, `octet_length(finding_versions::text)`, and a stable digest. Preserve this preflight output with the deployment evidence. Any row over 262,144 bytes or any malformed/non-object value is a failed preflight requiring a separately reviewed forward repair; do not edit or truncate it in place.
2. Identify the application writer currently serving portfolio traffic. DB-first compatibility is one-way: the prior writer must already persist a real signed finding receipt in the model artifact. 0405 may derive only the newly added authorized/selected scope arrays from the live authorization receipt and may copy only an already signed, scope-validated `not_mounted` receipt into an old writer's query receipt. If the deployed writer cannot satisfy that contract, disable the Portfolio Intelligence feature gate and drain in-flight portfolio requests before applying 0405; do not accept an outage window that creates unreceipted turns.
3. Apply 0405. Existing receipts must become read-only `finding_binding_status = 'legacy_unbound'`, keep their original bytes/digests, and retain the 262,144-byte ceiling. New inserts default to `validated`, are capped at 65,536 bytes, and cannot request `legacy_unbound` or `receipt_kind = 'legacy_unbound'`.
4. Compare the post-migration legacy IDs, byte lengths, and digests with the preflight output. The sets and bytes must match exactly. Confirm every new model/deterministic artifact and query receipt cross-bind account, organization, authorization receipt/hash, scope hash, authorized/selected hotel arrays, finding receipt, and the appropriate XOR artifact ID.
5. If step 2 required disabling the feature gate, keep it disabled until the current writer is deployed and one validated model turn plus one validated deterministic-knowledge turn commit successfully. Continue monitoring the `legacy_unbound` count; it may decline only through the approved retention purge, never through mutation or silent reprojection.

## 0406 knowledge-ledger cutover

0406 starts in `compat` mode so either application/database deployment order is safe. Existing rows receive genesis revisions without rewriting the active projection, and legacy service writers are trigger-journaled during the transition.

1. Apply 0406 and verify `staxis_company_knowledge_ledger_capability()` reports the expected schema and `compat` mode.
2. Deploy the ledger-aware writer and smoke intake, confirmed insert, confirm, edit, remove, merge, and structured authority-rule changes. Every response must carry the current optimistic revision; a stale revision must leave both facts and rule projection unchanged.
3. Verify browser denial, cross-tenant/actor denial, append-only revision/head behavior, and the organization hash chain from each genesis entry to the newest revision.
4. Call `staxis_finalize_company_knowledge_revision_ledger()` with the exact schema version. This one-way step revokes legacy projection/authority writes and the old mutation RPC. Confirm only the receipt-bound v1 mutation RPC can write afterward.
5. After finalization, roll back only to another 0406-aware application. Never re-enable direct legacy writes to recover an old build.

## 0407 company-finding verdict cutover

0407 is DB-first safe: old direct service-role verdict updates are rejected while detector refresh/escalation/expiry updates continue and advance the revision token. The new application must use only `staxis_set_company_finding_verdict_cas` for company-card verdicts.

1. Apply 0407 and verify existing legacy rows have either a current, topology-validated affected-hotel set or an empty set that is visibly non-actionable. Never resolve a hotel name back to an ID during backfill.
2. Deploy the route/UI writer that sends the exact organization, finding ID, current status/timestamp/revision, action, actor, and fresh prepared property-subset receipt.
3. Verify company Owner/VP read access separately from hotel mutation. A company title alone, finance role, partial hotel standing, transferred hotel, stale receipt, and stale CAS token must all leave the row unchanged.
4. Verify the immutable event binds the exact affected hotels, receipt/hash/epochs, required capabilities/sections, detector/semantic family, old/new status, and old/new revision. Browser roles cannot read it and ordinary service paths cannot update or delete it.

## Rollout

1. Follow the staged `0398` exception above; otherwise apply database migrations before their consuming application and confirm all entries exist in `applied_migrations`.
2. Verify normalized resolver RPC access is granted only to `service_role` and SECURITY DEFINER functions have fixed search paths.
3. Run the access shadow/drift report. Investigate every unexpected lost or added hotel. Create only explicit, attributable migration bridges; do not copy a broad legacy array without review.
4. Verify the mounted active-only Finding Patterns loader rebinds its load receipt to the current account, organization, authorization hash, scope receipt/hash, and exact selected hotel IDs before any envelope is projected. Confirm `loaded` can persist zero displayed claims when all candidates are producer- or consumer-rejected, every non-loaded status is claim-free, and shadow candidates never appear. Prove one shared content-addressed projection feeds prompt, presentation catalog, plan validation, deterministic rendering, numeric allowlisting, both artifact kinds, and the query receipt: no more than 40 producer candidates, 10 displayed Finding claims, 64 total presentation claims, 12,000 UTF-8 bytes for each Finding prompt/plan/render boundary, and 65,536 bytes for the durable projection receipt. Run rejected, truncated, multibyte, projected-but-unselected, scope/hash transplant, mounted-zero, and out-of-scope numeric poison cases.
5. Deploy the application.
6. Enable Portfolio Intelligence only for the intended organizations through the existing company setting.
7. Test from a real 20-hotel manager account:
   - ask the all-hotel booked-rooms question;
   - verify exact selected/authorized counts, local business dates, sources, freshness, and comparison exclusions;
   - drill into one named hotel in the same conversation;
   - switch to a region and back to all hotels;
   - reload the saved conversation and verify every answer restores with its original visible scope disclosure;
   - seed more than 50 complete turns and verify provider replay contains only the newest chronological suffix, no more than 24 turns or 65,536 accounted UTF-8 bytes, with exact internal omission counters;
   - simulate or identify a missing feed and verify exact partial coverage.
8. Test one property-only GM and one user in another company. Both must receive generic denial for direct-ID, reused-conversation, and sister-hotel attempts.
9. In My Hotel → People, create and preview one invitation at each supported scope used by the release fixture, then exercise cancellation, existing-account acceptance, new-account registration, and membership suspend/resume/remove. Verify email/single-use/idempotency behavior, exact normalized scope, immediate epoch/receipt invalidation, least-privileged registration (`staff`, no legacy hotel IDs), compensation or reconciliation after a failed registration, and immutable audit events.
10. In My Hotel → Access, preview and confirm one scoped grant change, then verify immediate resolver output and the immutable audit event. In My Hotel → Hotels as a verified platform admin, preview a test relationship lifecycle change and verify its exact revocation impact; do not exercise a production transfer without an approved target and change window.
11. Verify `/feed` organization-wide reads require `queueAvailable`, narrow/mixed grants cannot expose opaque company cards, finance remains read-only, and every company-card verdict goes only through `staxis_set_company_finding_verdict_cas`. Exercise a 61-hotel read; a mixed-authority multi-hotel finding; stale status/timestamp/revision; hotel transfer and revocation immediately before commit; direct service-role/GUC bypass; and cross-tenant IDs. Every denial must leave the row unchanged and remain anti-enumerating. Keep climbed hotel-local cards read-only in the company UI.
12. In a production-equivalent staging account, verify portfolio synthesis reserves against the configured primary/fallback price plan, cap refusals fail closed, pre-provider aborts cancel the hold, and completed/fallback calls reconcile to actual tokens and cost. Do not exhaust production customer or global budgets to perform this check.

## Runtime signals

Monitor:

- authorization resolver refusals by reason, never with raw evidence;
- receipt assertion failures and `authorization_changed` candidates;
- access epoch/version churn and unusually persistent bridge rows;
- selected, reported, and omitted hotel counts;
- omission codes: timeout, source unavailable, stale, invalid timezone, missing denominator, unsupported metric;
- snapshot hit/miss/write-failure rate;
- deterministic read and synthesis latency against the 25-second/55-second budgets;
- admission outcomes (`admitted`, `busy`, `rate_limited`, `unavailable`), lease age, and release failures;
- per-turn input/cache/output tokens, actual cost, reservation amount, reconciliation/cancellation failures, cap refusals by account/property/global reason, and spend saturation against the $5 free / $50 pro / $200 enterprise account, $25 property, and $500 global daily ceilings;
- hotel-tool reauthorization refusals by changed/unavailable standing, section, and capability, plus attempts to invoke a tool outside the turn's issued catalog;
- deterministic-knowledge artifact insert/refusal volume, `receipt_kind` and `finding_binding_status` counts, legacy-unbound receipt byte/digest drift, any new attempted `legacy_unbound` insert, and any artifact/receipt/account/organization/scope/finding-binding validation failure;
- portfolio turn-commit count versus completed/partial receipt count, replay-ledger turn/byte drift, bounded-replay omissions, and any attempted portfolio archive/restore refusal;
- planner clarification/unsupported rates;
- company structure preview/commit epoch conflicts and idempotent retries;
- Finding Patterns mount state, zero/truncation/outage receipts, producer/query/contract versions, and any attempted shadow-row exposure;
- authoritative People invitation preview/create/cancel/accept/register outcomes, single-use/idempotency conflicts, membership lifecycle outcomes, epoch changes, and identity compensation/reconciliation failures, without tokens, emails, or other invitation secrets in logs;
- after downstream mounting, `/feed` organization-read refusals separately from fresh per-hotel write/section/capability refusals; do not log card evidence or raw cross-tenant identifiers;
- global-admin authorization failures after a previously valid navigation check;
- account-authorization notification delivery/reconnect health and fallback revalidation latency;

Alert on any cross-organization receipt mismatch, evidence property outside the selected set, assertion failure after synthesis, repeated service-role RPC validation failure, or sudden increase in normalized-to-legacy drift. Treat these as security events.

The healthy replay envelope reads only the indexed newest 24 receipt-backed complete turns, includes at most 65,536 accounted UTF-8 bytes, and never omits the newest valid turn. Any mismatch between the trigger-owned currently retained ledger and the selected rows, any noncanonical pair, or any TypeScript byte/count mismatch must fail before a provider call. Receipt retention must decrement the ledger atomically. Do not bypass the ledger, grant direct service-role INSERT on `portfolio_query_turn_commits`, or substitute unreceipted summarizer rows.

The healthy admission envelope is at most one live query for an account-company pair, no lease older than 75 seconds, and no hotel metadata statement after a denied admission. Alert on repeated `unavailable` results or lease-release failures; do not fail open.

The healthy 0405 envelope has no new `legacy_unbound` rows, no digest change in preserved legacy rows, and no validated finding receipt above 65,536 bytes. The healthy cost envelope has no unreconciled hold beyond its recovery window and no unexplained divergence between provider usage, the immutable receipt, and the cost ledger. Alert on either condition before enabling another organization.

## Incident procedures

### Suspected cross-tenant exposure

1. Disable Portfolio Intelligence at the existing company feature gate.
2. Preserve query receipt IDs, conversation IDs, authorization versions/epochs, deployment SHA, and relevant audit events. Do not paste raw chat/evidence into a broad logging channel.
3. Re-resolve the account and organization at the incident time using the immutable receipt. Compare authorized/selected IDs, topology history, source versions, and conversation binding.
4. Rotate service credentials if compromise is plausible and follow the security incident process.
5. Add a two-company regression before re-enabling.

### Revocation or transfer did not take effect

1. Disable the affected organization feature gate.
2. Check the account authorization version and organization access epoch changed with the membership/grant/topology event.
3. Confirm the account is in exactly one authority mode and no unintended bridge remains.
4. Do not delete or rewrite an immutable receipt. Correct the entitlement/topology event, issue a new version, and verify old receipt assertion fails.

### Source outage or stale PMS feed

Keep chat available. The correct response is partial coverage or abstention. Do not increase snapshot TTL beyond the canonical source freshness window and do not replace the requested metric with a related measure. Confirm the omitted hotel and reason appear in the active-scope event and evidence header.

### Model/provider outage

The deterministic query may succeed even if synthesis fails, but no improvised answer should be emitted. Return the bounded unavailable response, retain the structured status/receipt where appropriate, and retry only within existing provider budget policy. The model is never required to calculate the aggregate.

### Admission or cancellation failure

If admission RPCs are unavailable, keep Portfolio Intelligence fail-closed; hotel-mode operations remain independent. A `busy` result should recover when the active request releases or the 75-second lease expires. For a suspected stuck lease, inspect the exact account + organization row and request logs before changing anything; never clear a different live token. If clients disconnect but property reads continue, disable the company feature gate, verify PostgREST requests received abort signals, and verify the worker pool stopped at the eight already-active lanes. A deterministic read deadline is different: completed facts must remain and every unfinished/unstarted hotel must appear as an explicit timeout omission. Do not raise concurrency or bypass admission during the incident.

### Authorization notification outage

Server routes and transaction RPCs remain the authority and continue to reject demoted or revoked accounts. Confirm focus/visibility/interval recovery is operating, inspect Realtime publication/subscription health for `account_authorization_notifications`, and never publish `accounts` as a shortcut because it contains password and legacy-scope fields.

### 0405 writer or provenance mismatch

Disable the Portfolio Intelligence feature gate and drain in-flight portfolio requests. Preserve the preflight/post-migration ID, byte-length, and digest reports plus rejected artifact/receipt IDs and deployment SHAs. Do not rewrite a `legacy_unbound` row, raise the validated 65,536-byte ceiling, fabricate a finding receipt, or bypass the binding trigger. Restore service only after the deployed writer persists the signed, exact-scope finding receipt through both model and deterministic-knowledge paths and the combined poison/rolling tests pass.

### People invitation lifecycle failure

Disable new organization invitations for the affected organization while leaving unrelated hotel access operational. Preserve the invitation ID, idempotency claim state, membership/grant IDs, authorization epoch, and audit request ID without copying the raw token or password into logs. Re-resolve inviter and invitee authority, distinguish a definitive transaction rollback from an uncertain transport result, and use the existing identity compensation/reconciliation path; never manually mint legacy `property_access` to complete a normalized invitation.

## Data retention

Use `staxis_purge_expired_portfolio_records` only with service credentials and approved retention cutoffs. It enforces a minimum one-day snapshot and 90-day query-receipt/model-artifact/knowledge-artifact retention boundary and a bounded batch size. Snapshot, query-receipt, turn-commit, model-artifact, and knowledge-artifact mutation otherwise remains unavailable to the service role and is rejected by immutability triggers. `legacy_unbound` rows leave only through this approved purge path; they are never rewritten into validated provenance. Coordinate legal retention requirements before changing these values.

## Rollback

The safe application rollback is to disable the feature gate and deploy the previous application while leaving additive migrations installed. Do not downgrade a normalized account to legacy: migration 0378 prevents that because doing so could resurrect stale `property_access`. Do not drop receipt, snapshot, bridge, or epoch tables during an incident. A schema rollback requires a separately reviewed forward migration and evidence-preservation plan.
