# Type Safety Audit — HotelOps AI

Read-only audit (2026-05-17). Branch: `audit/type-safety`.

Scope: `src/`, `cua-service/src/`, `scraper/`, `scripts/`, `tools/`. `ml-service/` (Python) is out of scope. Tests (`**/__tests__/**`, `*.test.ts`) are surveyed but treated as low blast radius.

## Status — fixes applied 2026-05-17

| Finding | Commit | One-liner |
|---|---|---|
| Foundation | `631e787` | Generate `src/types/database.types.ts` from supabase schema + add `npm run db:types`. |
| Foundation | `6baba63` | `src/lib/db-mappers.ts` gains `parseStringField`, `parseUnionField`, `parseArrayField`, `parseRecordField`, etc. — runtime narrowers with unit tests. `src/types/api.ts` created for shared client/server response shapes. |
| H1 | `eb1cf41` | Every `fromXxxRow` mapper switched to the runtime narrowers — union/JSONB/array columns now validated, no more inline casts. |
| H2 | `eb1cf41` | `findRoomByNumber` / `findStaffByName` now validate row shape via `parseRoomRow` / `parseStaffRow` predicates. Agent tool dispatch is no longer downstream of a double-bridge cast. |
| H3 | `eb1cf41` | Cron routes (seed-rooms-daily, schedule-auto-fill, ml-shadow-evaluate) parse each row at the SELECT boundary; bad rows are skipped, not silently seeded. |
| H4 | `eb1cf41` | `idempotency.ts` declares one `IdempotencyRow` interface and parses at the cache boundary. Four inline `as { ... }` casts collapsed to one validated read. |
| M1 | `9644508` | `sync-room-assignments` reads `body.allowClearAll` directly; double-cast deleted (the field was already declared on `RequestBody`). |
| M2 | `9644508` | `sms-reply` JSON branch uses per-field `typeof` narrowing, matching the form-encoded branch. |
| M3 | `9644508` | `sms-reply` validates the `shift_confirmations` row at the SELECT boundary; four downstream `as string` casts removed. |
| M4 | `9644508` | `admin/ml-health` typeof-guards the dynamic column read; missing columns now produce `null` instead of `undefined as string`. |
| M5 | `9644508` | `inventory-accounting.ts` adds `received_at?` to `OrderRow` and `discarded_at` to a new `YtdDiscardRow`; intersection-type cast + per-iter double cast deleted. |
| M6 | `9644508` | `WalkthroughOverlay` imports `WalkthroughStartResponse` / `WalkthroughStepResponse` from `src/types/api.ts`; client and server now share one canonical shape. Foundation in place for the other client/server pairs to follow. |
| M7 | `9644508` | Stripped `as unknown as Error` from 22 `log.error` call sites — `LogFields`'s index signature already accepts `unknown`. |
| M8 | `9644508` | `stripe/create-checkout` parses the `properties` SELECT once via `parseStringField`; four inline `as string` casts gone. |
| LOW | — | All 11 LOW findings deliberately left as-is per Appendix B (documented SDK quirks: Stripe v22 pin, Picovoice, Anthropic Beta API, HMR-safe globalThis singletons, etc.). |

**Verification:** `npx tsc --noEmit` clean; all 615 unit tests pass (Phase 0/1/2/3). Pre-existing lint break in `eslint.config.js` (`nextCoreWebVitalsConfig is not iterable`) is unrelated to this audit — present on main before the branch.

**Deferred to follow-up:**
- Wire `Database` type into the supabase admin client (`createClient<Database>(...)`) — exposes ~266 additional drift/typing issues not in this audit's scope (schema-drift in `github_events.created_at`, `scraper_credentials.ca_username`, `schedule_assignments.staff_id`, plus many dynamic-table-name routes). Worth a dedicated PR.
- Migrate the remaining ~9 client `.json()` consumers to import from `src/types/api.ts` (M6 — pattern established with WalkthroughOverlay; mechanical sweep for the rest).

---

## Executive summary

**Headline: the codebase is in unusually good shape for type safety.** Strict mode is on, `any` is effectively banned (zero raw annotations), no `@ts-ignore` or `@ts-nocheck` anywhere, only one `as any` (cosmetic), and webhooks all verify signatures before parsing. The hand-rolled [src/lib/api-validate.ts](src/lib/api-validate.ts) is the canonical runtime-validation helper — used by ~30 routes — and it works.

The real risk is **systemic casting of Supabase rows to local TS interfaces without runtime validation**. Every `fromXxxRow` mapper, every agent-tool helper, every cron route does the same pattern: SELECT some columns, cast the result to a typed shape, never check. If a migration renames a column or changes a type, the cast silently lies and downstream code reads `undefined`.

### Raw counts (production code only; excludes `**/__tests__/**` and `*.test.ts`)

| Category | Count | Notes |
|---|---|---|
| Explicit `: any` / `<any>` / `any[]` annotations | **0** | Zero. Strict mode + lint clearly enforced. |
| `Record<string, any>` | **0** | Code uses `Record<string, unknown>` (~70 files) — the safe form. |
| `as any` casts | **1** | [src/app/settings/pms/page.tsx:293](src/app/settings/pms/page.tsx:293) (a `lastSyncedAt` formatter). |
| `as unknown as X` (double-bridge) | **~50** | Half are documented SDK-shim casts; the rest are DB-row → interface coercions. |
| `as X` (single-cast type assertions) | **~441** | Most are benign narrowing after a `typeof` check; ~70 are unchecked column-by-column DB casts. |
| `@ts-ignore` | **0** | |
| `@ts-nocheck` | **0** | |
| `@ts-expect-error` | **14** | All documented; all in tests except 2 in [src/lib/stripe.ts](src/lib/stripe.ts) (Stripe SDK version pinning). |
| `eslint-disable @typescript-eslint/no-explicit-any` | **0** | |
| `: object` / `: Function` / `: {}` annotations | **0** | None outside spread-collapse patterns like `... : {}`. |
| Generic defaults | **1** | `ApiResponse<T = unknown>` — the safe form (forces narrowing). No `<T = any>` or `<T extends any>` found. |
| `: unknown` declarations | **182** | The safe alternative to `any`. |
| Browser `.json()` calls without runtime shape validation | **~117** | All trust the server. See Category 3 below. |
| Webhook routes | **4** | Stripe, GitHub, Sentry, Twilio (sms-reply). All verify signatures BEFORE parsing. |

### Severity breakdown

- **critical**: 0
- **high**: 4 (all are systemic patterns rather than single lines)
- **medium**: 8
- **low**: 11 (listed for completeness; no action recommended)

### Top 5 findings by blast radius

1. **db-mappers.ts** — ~30 `fromXxxRow` functions cast every column without runtime validation. A renamed column silently produces `undefined`/wrong-typed domain objects everywhere. **High.** [Finding H1](#h1)
2. **agent/tools/_helpers.ts** — `data[0] as unknown as RoomRow` (and `StaffRow`). Agent tool helpers feed the LLM with cast DB rows; a stale interface produces stale answers to housekeepers. **High.** [Finding H2](#h2)
3. **cron/seed-rooms-daily** — three `as unknown as PropertyRow` casts on the SELECT result. Cron fails silently; nobody notices the next day's rooms aren't seeded. **High.** [Finding H3](#h3)
4. **idempotency.ts** — four separate `as { ... }` casts on a single `data` object. Brittle and signals the helper should declare a local row interface once. **High.** [Finding H4](#h4)
5. **sync-room-assignments:127** — `(body as unknown as Record<string, unknown>).allowClearAll` reads a field that isn't declared on `RequestBody`. The TS interface lies; a refactor of `RequestBody` won't catch the hidden field read. **Medium.** [Finding M1](#m1)

---

## Methodology + canonical fix patterns

### Helpers already in the tree (any fix should lean on these)

- [src/lib/api-validate.ts](src/lib/api-validate.ts) — `validateUuid`, `validateString`, `validatePhone`, `validateRoomNumbers`, `safeBaseUrl`, `redactPhone`. The header comment says "we don't pull in Zod for this — the API surface is small enough that a handful of focused helpers covers everything". **Fix recommendations stay within this helper set.** Where a new shape needs checking, extend api-validate (`validateBody<T>(raw: unknown, schema: …)`) rather than introducing a new dependency.
- [src/lib/pms/recipe.ts](src/lib/pms/recipe.ts) — exports `isRecipeShape(value: unknown): value is Recipe`. **This is the textbook pattern** for trust-boundary validation: a `value is T` predicate that narrows the type. Every cast-after-DB-read should ideally have one of these.
- [src/lib/db-mappers.ts](src/lib/db-mappers.ts) — already does defensive coercion (`String(r.id ?? '')`, `Number(r.x ?? 0)`, `toDate`/`toISO`) for primitives. The gap is structured fields (string-union columns, JSONB columns, array columns).
- [src/lib/vision-extract.ts:248](src/lib/vision-extract.ts:248) — `visionExtractJSON<T>(image, prompt, validate?: (raw: unknown) => T)`. **Another textbook pattern** for caller-supplied validators on LLM output.

### Severity scale (used below)

- **critical** — silent money loss, auth bypass, mass data corruption, or a single bad cast that cascades through every API request.
- **high** — wrong data persisted, wrong data shown to user, or one cast in a shared util fans out to dozens of callers.
- **medium** — single-route or single-component breakage; user sees an error but no state is corrupted.
- **low** — tests/scripts/devtools; or a cast that's documented as a deliberate escape for an SDK type quirk.

---

## Findings — ranked by blast radius

### CRITICAL

**None found.** The high-risk surfaces (Stripe webhook, Twilio webhook, GitHub webhook, Sentry webhook, auth helpers, idempotency helper) all do signature verification or auth checks BEFORE parsing JSON, and then narrow with `typeof` or `validate*` helpers from `api-validate.ts`. The Stripe-SDK-pattern casts (`event.data.object as Stripe.Checkout.Session`) are documented Stripe-API contract: `event.type` is trusted post-signature-verification, so the cast is sound.

### HIGH

#### <a name="h1"></a>H1. `fromXxxRow` mappers cast columns without runtime validation

| file:line | cast | what could go wrong | fix |
|---|---|---|---|
| [src/lib/db-mappers.ts:113-119](src/lib/db-mappers.ts:113) | `(r.morning_briefing_time as string) ?? undefined` (and 5 sibling string casts on Property) | A migration changes the column type to e.g. `time`/`timestamptz` — Supabase returns a non-string. The cast says "string", code downstream calls `.slice(0,5)` and throws. | Wrap in `typeof r.x === 'string' ? r.x : undefined` (already the pattern for the `name`/`id` casts via `String(r.x ?? '')`). |
| [src/lib/db-mappers.ts:220-222](src/lib/db-mappers.ts:220) | `(r.type as Room['type']) ?? 'checkout'`, `(r.priority as Room['priority']) ?? 'standard'`, `(r.status as Room['status']) ?? 'dirty'` | Union-type column drift. A new status `'inspected'` is added to the DB but the union hasn't been updated → cast claims it's `'dirty'`/`'clean'`/`'inspected'` but TS narrowing later excludes it, so the new status reads as a fall-through case. | Centralize: `parseUnion<T>(raw: unknown, allowed: readonly T[], fallback: T)`. Each `fromXxxRow` calls it instead of bare casts. |
| [src/lib/db-mappers.ts:348](src/lib/db-mappers.ts:348) | `(r.public_areas_due_today as string[]) ?? []` | Column drift — if shape changes from `text[]` to JSON or null, code calls `.map(s => …)` on non-array → throws. | `Array.isArray(r.public_areas_due_today) ? r.public_areas_due_today.map(String) : []` (pattern already used at line 125-127 for `room_inventory`). |
| [src/lib/db-mappers.ts:238](src/lib/db-mappers.ts:238) | `(r.checklist as Record<string, boolean>) ?? undefined` | Checklist column is JSONB. If a row has a corrupted/empty object, downstream UI iterates `Object.entries(checklist)` — undefined entries render as broken rows. | `typeof r.checklist === 'object' && r.checklist != null ? r.checklist as Record<string, boolean> : undefined`. |
| **Blast radius:** Every UI render that uses Room/Property/StaffMember/InventoryItem/WorkOrder flows through these mappers. They're the choke point for DB → domain conversion. | | | |

**Severity: high.** This isn't one cast; it's a systemic pattern across ~30 mappers. Single fix: add `parseUnion` + `parseStringField` + `parseArrayField` helpers in `db-mappers.ts` and replace the inline casts. No new dependency, no new validation library, no behavior change for happy-path rows.

---

#### <a name="h2"></a>H2. Agent tool helpers cast DB rows to LLM-facing interfaces

| file:line | cast | what could go wrong | fix |
|---|---|---|---|
| [src/lib/agent/tools/_helpers.ts:146](src/lib/agent/tools/_helpers.ts:146) | `return data[0] as unknown as RoomRow;` in `findRoomByNumber` | Every room-action agent tool (`mark_room_clean`, `reset_room`, `toggle_dnd`, `flag_room_issue`, `request_help`) calls this. If the SELECT drops a column the `RoomRow` interface declares (e.g. `is_dnd`), `room.is_dnd` reads as `undefined`, `assertFloorRoleCanMutateRoom` may allow a mutation that should have been blocked. | Replace with a typed select via [src/lib/db.ts](src/lib/db.ts) or add `isRoomRow(value: unknown): value is RoomRow` predicate before return. |
| [src/lib/agent/tools/_helpers.ts:206](src/lib/agent/tools/_helpers.ts:206) | `if (exact) return exact as unknown as StaffRow;` in `findStaffByName` | Same risk for staff lookups. Used by `assign_room`, agent context summarization, nudges. A stale row → agent tells the GM "Maria has 8 weekly hours" when she actually has 32. | Same fix as 146 — runtime predicate. |
| [src/lib/agent/tools/_helpers.ts:208](src/lib/agent/tools/_helpers.ts:208) | `return (partial as unknown as StaffRow) ?? null;` | Same. | Same. |
| **Blast radius:** Agent tool layer is the LLM's interface to the database. Wrong data → wrong housekeeper assignments, missed scope checks, hallucinated answers. | | | |

**Severity: high.** Agent helpers feed the LLM with cast rows that drive both reads (Claude tells the user "room 302 is clean") and writes (`assertFloorRoleCanMutateRoom` gates writes on `room.assigned_to`). A type drift here is not silent — it shows up as wrong agent answers — but the cast bypasses the compile-time check that would have caught it.

---

#### <a name="h3"></a>H3. Cron route casts `properties` SELECT to `PropertyRow` three times

| file:line | cast | what could go wrong | fix |
|---|---|---|---|
| [src/app/api/cron/seed-rooms-daily/route.ts:85](src/app/api/cron/seed-rooms-daily/route.ts:85) | `const inv = (p as unknown as PropertyRow).room_inventory;` | Inside `.filter()` — if `PropertyRow` drifts vs. the actual SELECT `('id, timezone, room_inventory, total_rooms')`, the filter silently returns the wrong subset → some hotels get no daily seed → housekeepers open the app to an empty rooms tab. | One typed local interface declared inline matching the SELECT columns, used by both the filter and the body of the for-loop. |
| [src/app/api/cron/seed-rooms-daily/route.ts:86](src/app/api/cron/seed-rooms-daily/route.ts:86) | `const total = (p as unknown as PropertyRow).total_rooms;` | Same. | Same. |
| [src/app/api/cron/seed-rooms-daily/route.ts:102](src/app/api/cron/seed-rooms-daily/route.ts:102) | `const prop = propRaw as unknown as PropertyRow;` | Same — and this `prop` is what's passed to `seedRoomsForDate(prop.id, localDate)`. If `prop.id` is somehow missing, the seed silently writes for an undefined property_id (Postgres rejects, but the per-row try/catch swallows). | Same — one cast at the top of the loop, not three. |
| **Blast radius:** Daily seed for every onboarded hotel. A silent failure = empty rooms tab the next morning = HKs can't start work. | | | |

**Severity: high.** The same pattern appears in several other cron routes ([src/app/api/cron/schedule-auto-fill/route.ts:317](src/app/api/cron/schedule-auto-fill/route.ts:317), [src/app/api/cron/ml-shadow-evaluate/route.ts:94](src/app/api/cron/ml-shadow-evaluate/route.ts:94)). Worth a sweep.

---

#### <a name="h4"></a>H4. `idempotency.ts` casts four times on a single row

| file:line | cast | what could go wrong | fix |
|---|---|---|---|
| [src/lib/idempotency.ts:95](src/lib/idempotency.ts:95) | `(data as { route?: string }).route !== route` | If the `idempotency_log` SELECT ever drops the `route` column, this is `undefined !== route` → always true → cache becomes useless → every request retries, fires duplicate SMS/Stripe calls. **This is one of the few places where a type drift could cause user-visible damage** (duplicate SMS to housekeepers, duplicate Stripe customers). | Declare one local interface: `type IdempotencyRow = { route: string; response: unknown; status_code?: number; expires_at: string; };` and cast once: `const row = data as IdempotencyRow;`. |
| [src/lib/idempotency.ts:101](src/lib/idempotency.ts:101) | `(data as { expires_at: string }).expires_at` | Same risk: `new Date(undefined).getTime()` → `NaN`, `NaN < Date.now()` → false → cached response served from past TTL. | Same. |
| [src/lib/idempotency.ts:107-108](src/lib/idempotency.ts:107) | `(data as { response: unknown }).response`, `(data as { status_code?: number }).status_code` | If the cached response shape drifts, the client gets a malformed body. | Same. |
| **Blast radius:** Every route using Idempotency-Key (send-shift-confirmations, agent commands, anything Stripe-touching). | | | |

**Severity: high.** Idempotency is invisibly load-bearing: when it works nobody notices; when it breaks Twilio bills triple. The fix is one interface declaration and zero behavior change.

---

### MEDIUM

#### <a name="m1"></a>M1. Hidden field read via double-cast in `sync-room-assignments`

[src/app/api/sync-room-assignments/route.ts:127](src/app/api/sync-room-assignments/route.ts:127) — `const allowClearAll = (body as unknown as Record<string, unknown>).allowClearAll === true;`

The route declares a `RequestBody` interface (line 69 reads `body as RequestBody | null`). The interface does **not** include `allowClearAll`. The route then bypasses its own interface with a double-cast to read the undeclared field. **The interface lies.**

- **What could go wrong:** A refactor of `RequestBody` (adding/renaming fields) won't catch the `allowClearAll` reader because it's hidden behind the cast. Conversely, a search for "fields the route accepts" won't find this one.
- **Fix:** Add `allowClearAll?: boolean` to `RequestBody`. Drop the double-cast: `const allowClearAll = body.allowClearAll === true;`.

---

#### M2. JSON body cast without per-field runtime narrowing in Twilio webhook

[src/app/api/sms-reply/route.ts:188](src/app/api/sms-reply/route.ts:188) — `const body = JSON.parse(jsonText) as { fromNumber?: string; From?: string; text?: string; Body?: string };`

- **What could go wrong:** If a field arrives as `number` (`{ "From": 15551234567 }`), the cast says "string" but the runtime value is a number; downstream `fromNumber.replace(/\D/g, '')` throws because `.replace` doesn't exist on Number. The handler catches and 200s back, so user-facing impact is just "language switch SMS doesn't go through." Mitigation: the JSON-path is rejected in production (line 222: `return forbidden('json payloads not accepted in production')`), so this only matters for dev SMS tests.
- **Fix:** `const fromNumber = typeof body.fromNumber === 'string' ? body.fromNumber : (typeof body.From === 'string' ? body.From : undefined);` — same pattern the form-encoded branch uses.

---

#### M3. Supabase row casts in route body (sms-reply)

| file:line | cast | risk |
|---|---|---|
| [src/app/api/sms-reply/route.ts:356](src/app/api/sms-reply/route.ts:356) | `${baseUrl}/housekeeper/${staff.id}?pid=${encodeURIComponent(conf.property_id as string)}` | `conf.property_id` is typed `unknown` by supabase-js. If migration renames the column, the cast lies and the URL becomes `…?pid=undefined`. Housekeeper opens a broken page. |
| [src/app/api/sms-reply/route.ts:359](src/app/api/sms-reply/route.ts:359) | `formatShiftDate(conf.shift_date as string, targetLang)` | `formatShiftDate` calls `.split('-')` — if shift_date isn't a string this throws. Caught by outer try/catch but housekeeper gets a generic "thanks" instead of a link. |
| [src/app/api/sms-reply/route.ts:372](src/app/api/sms-reply/route.ts:372) | `.eq('token', conf.token as string)` | If `conf.token` isn't a string the update is `WHERE token = null` → no rows updated → language preference doesn't mirror. |
| [src/app/api/sms-reply/route.ts:393](src/app/api/sms-reply/route.ts:393) | `const lang: 'en' \| 'es' = (conf.language as 'en' \| 'es') ?? 'en';` | Union-cast on a column that PG schema enforces — low practical risk, but still unchecked. |
| **Fix:** Declare a local `ShiftConfirmationRow` interface matching the SELECT on line 320, then cast once at the call site. | | |

---

#### M4. Dynamic-column read in `admin/ml-health` route

[src/app/api/admin/ml-health/route.ts:113](src/app/api/admin/ml-health/route.ts:113) — `lastPredictionAt: latest ? ((latest as unknown as Record<string, unknown>)[predictedAtColumn] as string) : null,`

- **What could go wrong:** `predictedAtColumn` is a runtime-resolved column name. If the column doesn't exist on `latest`, `[col]` is `undefined`, then `undefined as string` is structurally fine for TS but the JSON serialization sends `null` (correct) vs. the admin dashboard expecting a timestamp. Admin sees "last prediction: never" when it actually ran 5 minutes ago.
- **Fix:** `typeof latest[predictedAtColumn] === 'string' ? latest[predictedAtColumn] : null` — extra runtime guard since `predictedAtColumn` is dynamic.

---

#### M5. `inventory-accounting.ts` double-cast on intersection types

| file:line | cast | risk |
|---|---|---|
| [src/lib/db/inventory-accounting.ts:290](src/lib/db/inventory-accounting.ts:290) | `for (const o of (ytdOrders ?? []) as OrderRow[] & Array<{ received_at: string }>) {` | Intersection cast smells like the first cast resisted; the `& Array<{ … }>` is fighting the type system. |
| [src/lib/db/inventory-accounting.ts:293](src/lib/db/inventory-accounting.ts:293) | `const at = new Date((o as unknown as { received_at: string }).received_at);` | Inside the same loop, AGAIN casts `o` even though line 290 already cast it. The repeat cast says "I don't trust the previous cast." Risk: if `received_at` was dropped from the SELECT, `new Date(undefined)` → `Invalid Date` → all YTD buckets are off. |
| [src/lib/db/inventory-accounting.ts:303](src/lib/db/inventory-accounting.ts:303) | `for (const d of (ytdDiscards ?? []) as Array<{ cost_value: number \| null; discarded_at: string }>) {` | Same pattern — unchecked cast. |
| **Fix:** Declare `OrderRow`/`DiscardRow` properly to include `received_at`/`discarded_at`. Remove the inline intersection. | | |

---

#### M6. Browser `.json()` consumers without runtime shape checks

The pattern across ~117 callers is `(await res.json()) as ResponseShape`. Examples:

- [src/components/walkthrough/WalkthroughOverlay.tsx:257](src/components/walkthrough/WalkthroughOverlay.tsx:257) — `(await startRes.json()) as { ok: true; runId: string }`
- [src/app/signup/page.tsx:64](src/app/signup/page.tsx:64) — `await res.json() as { ok?: boolean; error?: string }`
- [src/app/settings/accounts/page.tsx:92](src/app/settings/accounts/page.tsx:92) — `await res.json() as { data?: { invites?: InviteRow[] } }`
- [src/app/housekeeper/[id]/page.tsx:594](src/app/housekeeper/[id]/page.tsx:594) — `(await res.json().catch(() => ({}))) as { … }`

**What could go wrong:** Server route changes its response shape (e.g. renames `data` → `result`). TS compiler doesn't catch it because the client is in a separate file and only sees the cast. UI renders blank or shows undefined.

**Fix:** Two options, in order of pragmatism:
1. **Move shared response shapes into [src/types/](src/types/) and import them on both client and server.** Then the TS compiler does catch the drift. No runtime cost. This is the cheapest high-value win.
2. **Add a per-response validate-helper for the few cross-team boundaries** (e.g. the public housekeeper page that's used by people not on the engineering team). Lean on `api-validate.ts` — add a `validateObject<T>(raw, fields)` helper if needed.

Don't go the Zod route — the api-validate header comment is explicit about the trade-off. Sharing types between client and server is 90% of the win at zero cost.

---

#### M7. `err as unknown as Error` for log payloads (×22)

Pattern: `log.error('foo failed', { err: someErr as unknown as Error })`. Examples in [src/app/api/refresh-from-pms/route.ts:238,261,354,432](src/app/api/refresh-from-pms/route.ts:238), [src/lib/ml-failure-counters.ts:94,121,127](src/lib/ml-failure-counters.ts:94), [src/lib/cron-heartbeat.ts:72](src/lib/cron-heartbeat.ts:72), [src/lib/ml-misconfigured-events.ts:91](src/lib/ml-misconfigured-events.ts:91).

- **What could go wrong:** Very little — `log.error` auto-ships to Sentry and treats the err as `unknown` anyway. The cast satisfies the TS signature, not a runtime invariant.
- **Fix:** Update `LogFields.err` to accept `unknown` (in [src/lib/log.ts](src/lib/log.ts)). One signature change, 22 casts deleted.

---

#### M8. Stripe payment-button stragglers

[src/app/api/stripe/create-checkout/route.ts:62-68](src/app/api/stripe/create-checkout/route.ts:62) — `property.owner_id`, `property.stripe_customer_id`, `property.name` each cast `as string` / `as string | null` without runtime check.

- **What could go wrong:** Migration changes column. The route is auth-gated (`requireSession` + `userHasPropertyAccess`), so worst case is a 500 error during checkout — recoverable, user retries.
- **Fix:** Declare a `PropertyRow` type matching the SELECT on line 58 (the same fix as H3). One cast not three.

---

### LOW (listed for completeness, no action recommended)

| file:line | pattern | reason it's correct as-is |
|---|---|---|
| [src/lib/stripe.ts:45,50](src/lib/stripe.ts:45) | `@ts-expect-error` on `apiVersion` | Documented Stripe SDK v22 pin: the comment cites a concrete `LatestApiVersion` narrowing in `@types/stripe`. |
| [src/lib/__tests__/stripe-sdk-init.test.ts:49,62](src/lib/__tests__/stripe-sdk-init.test.ts:49) | `@ts-expect-error` for stripe API-version pinning test | Tests the prod cast intentionally. |
| [src/lib/__tests__/walkthrough-validate-action.test.ts:121,127](src/lib/__tests__/walkthrough-validate-action.test.ts:121) | `@ts-expect-error — testing the runtime check` | Comment says it. |
| [src/lib/__tests__/email-resend-send.test.ts:59,65,241](src/lib/__tests__/email-resend-send.test.ts:59) | `@ts-expect-error monkey-patching singleton` | Standard test pattern for module-level singletons. |
| [src/lib/__tests__/api-auth-property-access.test.ts:43](src/lib/__tests__/api-auth-property-access.test.ts:43) | `@ts-expect-error monkey-patching the singleton for the test` | Same. |
| [src/lib/__tests__/api-ratelimit.test.ts:45](src/lib/__tests__/api-ratelimit.test.ts:45) | `@ts-expect-error monkey-patching singleton for the test` | Same. |
| [src/lib/__tests__/idempotency.test.ts:53](src/lib/__tests__/idempotency.test.ts:53) | `@ts-expect-error monkey-patching singleton for the test` | Same. |
| [src/lib/__tests__/ml-invoke.test.ts:29](src/lib/__tests__/ml-invoke.test.ts:29) | `@ts-expect-error overriding global fetch for the test` | Same. |
| [src/lib/supabase.ts:62](src/lib/supabase.ts:62), [src/lib/supabase-admin.ts:33](src/lib/supabase-admin.ts:33) | `globalThis as unknown as { __supabase…?: SupabaseClient }` | HMR-safe singleton pattern (Next.js dev). Documented in code. |
| [cua-service/src/mapper.ts:396,397,417,606,621](cua-service/src/mapper.ts:396) | `BROWSER_TOOL as unknown as Anthropic.Beta.Messages.BetaToolUnion`, `response.content as unknown as Anthropic.Messages.ContentBlock[]` | Documented at line 414-416: "Beta and non-beta content shapes are structurally identical at the wire layer; only the SDK's TypeScript types differ." Anthropic SDK quirk. |
| [cua-service/src/pull-job-runner.ts:238,259,281](cua-service/src/pull-job-runner.ts:238) | `RUNNING_STATUSES as unknown as string[]` | `RUNNING_STATUSES` is a `readonly string[]`/`as const` tuple; Supabase's `.in()` wants mutable `string[]`. SDK quirk; readonly→mutable cast is sound. |
| [cua-service/src/browser-tool.ts:530](cua-service/src/browser-tool.ts:530) | `window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> }` | Page-script-injected global. Lives in Playwright's `evaluate()` context. |
| [src/components/agent/WakeWord.tsx:127,134,161](src/components/agent/WakeWord.tsx:127) | Picovoice SDK casts | Picovoice's TS types are notoriously incomplete; the cast pattern matches the upstream README. |
| [src/lib/utils.ts:86](src/lib/utils.ts:86) | `new Date(date as unknown as string)` | Inside a function that already `typeof`-narrowed `date instanceof Date`; this branch only runs when `date` is a `string` or `number`. The cast just collapses both. |
| [src/lib/agent/summarizer.ts:318](src/lib/agent/summarizer.ts:318) | `summaryId as unknown as string` | The variable is a typed brand the helper unwraps. Local to one function. |
| [src/lib/pms/recipe-loader.ts:75](src/lib/pms/recipe-loader.ts:75) | `args.recipe as unknown as Record<string, unknown>` | The `.rpc()` signature wants `Record<string, unknown>` for its `p_recipe` param. `Recipe` is structurally compatible. Single SDK-shim cast. |
| [src/app/settings/pms/page.tsx:293](src/app/settings/pms/page.tsx:293) | `activeProperty.lastSyncedAt as any` | Cosmetic — the call site is `formatDistanceToNow(ts ?? new Date())` and works for `Date \| string \| null`. **The single `as any` in the codebase.** Could trivially become `as Date \| string \| null`. Not worth a change for one line. |

---

## Category coverage map (back to the user's seven asks)

1. **`any` / `unknown` without narrowing / `as` casts / `@ts-ignore` / `@ts-expect-error`** — Categories 1 + 5 enumerated above. `any`: ~0 production uses. `unknown`: heavily used (the safe pattern). Casts: ~441 single + ~50 double. `@ts-ignore`: 0. `@ts-expect-error`: 14, all documented (Findings L1-L11).
2. **Loose function signatures (`object`, `Record<string, any>`, etc.)** — Zero `object`, zero `Function`, zero `Record<string, any>`. The codebase uses `Record<string, unknown>` consistently — the safe form.
3. **API response handlers that don't validate** — Finding M6 covers the browser-side ~117 `.json()` callers. Server-side parsing is mostly fine because of `api-validate.ts`.
4. **Data crossing trust boundaries without runtime validation** — All four webhook routes verify signatures first. LLM tool inputs use `Record<string, unknown>` + handler narrowing. ML service responses use `Record<string, unknown>` + per-field narrowing. PMS data (cua-service) uses `tryParseJson` + per-field `typeof` checks. The DB boundary is the weakest link — findings H1-H4 + M3 + M5.
5. **Generic types that defeat themselves (`<T = any>`)** — Zero found. The one generic default in `api-response.ts` uses `T = unknown` which is the SAFE form.

---

## Appendix A — Full grep enumeration (production code, excluding tests)

### `@ts-expect-error` (14 total, 2 in production, 12 in tests)

```
src/lib/stripe.ts:45      // Stripe SDK v22 LatestApiVersion pin
src/lib/stripe.ts:50      // (continuation of same expect-error block)
src/lib/__tests__/stripe-sdk-init.test.ts:49,62
src/lib/__tests__/email-resend-send.test.ts:59,65,241
src/lib/__tests__/api-auth-property-access.test.ts:43
src/lib/__tests__/api-ratelimit.test.ts:45
src/lib/__tests__/walkthrough-validate-action.test.ts:121,127
src/lib/__tests__/idempotency.test.ts:53
src/lib/__tests__/ml-invoke.test.ts:29
```

### `as any` (1 total)

```
src/app/settings/pms/page.tsx:293   const ts = activeProperty.lastSyncedAt as any;
```

### `as unknown as ...` double-bridge casts (production code, ~50)

cua-service (14):
```
cua-service/src/pull-job-runner.ts:238,259,281  RUNNING_STATUSES as unknown as string[]
cua-service/src/mapper.ts:396,417,606,621       Anthropic SDK type-shim casts
cua-service/src/browser-tool.ts:530             window as unknown as { … } (injected global)
```

src/lib (production, ~16):
```
src/lib/utils.ts:86                              date coercion (typeof-narrowed branch)
src/lib/ml-misconfigured-events.ts:68,91         AppEventsClient + err narrowing
src/lib/ml-failure-counters.ts:94,121,127        err narrowing for log payloads
src/lib/supabase.ts:62                           HMR-safe singleton (globalThis)
src/lib/supabase-admin.ts:33                     HMR-safe singleton (globalThis)
src/lib/pms/recipe-loader.ts:75                  Recipe → Record<string,unknown> for .rpc()
src/lib/cron-heartbeat.ts:72                     err narrowing for log
src/lib/agent/summarizer.ts:318                  summaryId brand unwrap
src/lib/agent/tools/_helpers.ts:146,206,208      RoomRow/StaffRow DB-row casts (H2)
src/lib/db/_common.ts:148                        WithState channel introspection
src/lib/db/inventory-accounting.ts:293           received_at field cast (M5)
src/lib/db/ml-inventory-cockpit.ts:592           AutoFillReadClient cast
```

src/app + src/components (production, ~20):
```
src/components/agent/WakeWord.tsx:127,134,161    Picovoice SDK casts
src/app/api/refresh-from-pms/route.ts:238,261,354,432  err narrowing for log
src/app/api/admin/scraper-instances/route.ts:92,107,149  err narrowing for log
src/app/api/admin/scraper-assign/route.ts:97,123  err narrowing for log
src/app/api/cron/ml-shadow-evaluate/route.ts:94  err narrowing for log
src/app/api/admin/doctor/route.ts:2304           autoFillMap clients fan-in
src/app/api/cron/schedule-auto-fill/route.ts:317  property cast in cron (H3 sibling)
src/app/api/admin/ml-health/route.ts:113         dynamic-column read (M4)
src/app/api/sync-room-assignments/route.ts:127   hidden field via double-cast (M1)
src/app/api/cron/seed-rooms-daily/route.ts:85,86,102  PropertyRow casts (H3)
src/app/api/housekeeper/room-action/route.ts:380,427,484  err narrowing for log
```

### `Record<string, unknown>` usages by file (top 10)

```
src/lib/db/plan-snapshots.ts:6
src/lib/rooms/seed.ts:5
src/lib/agent/llm.ts:3
src/lib/agent/memory.ts:3
src/lib/agent/nudges.ts:3
src/lib/agent/tools/_helpers.ts:3 (but appears as ToolDefinition's TArgs default — safe)
src/lib/ml-failure-counters.ts:3
src/lib/sms-jobs.ts:4
cua-service/src/sentry.ts:5
src/lib/audit.ts:2
```

All uses of `Record<string, unknown>` are safe — forces the consumer to narrow each field.

### `: unknown` declarations (182 production-code uses)

This is the SAFE alternative to `any`. The codebase uses `unknown` correctly: as a function-parameter type that forces the body to narrow before use, as a return type for "I don't know the shape," as a JSON-blob type. No findings here — `unknown` is the goal, not a problem.

### Loose object/Function types

```
: object       0 hits
: Function     0 hits
Record<string, any>  0 hits
```

### Generic defaults

```
<T = unknown>   src/lib/api-response.ts:33  (SAFE form)
<T = any>       0 hits
<T extends any> 0 hits
```

### `JSON.parse(...)` call sites (production code)

```
cua-service/src/mapper.ts:805,820      LLM output recovery (then narrowed)
src/app/api/github-webhook/route.ts:61 Record<string, unknown> + per-field typeof (signature-verified first)
src/lib/db/ml-inventory-cockpit.ts:911 JSON column → ?
src/app/api/sms-reply/route.ts:188     {fromNumber?,From?,text?,Body?} cast (M2)
src/app/api/sentry-webhook/route.ts:126 SentryWebhookPayload (signature-verified first)
src/lib/api-auth.ts:80                 Record<string, unknown> + per-field typeof (SAFE)
src/lib/vision-extract.ts:262,272,284  caller-supplied validator (SAFE)
src/components/agent/useAgentChat.ts:192 SSE line parse (then narrowed)
src/components/agent/MessageList.tsx:184 tool-result render
src/app/api/admin/doctor/route.ts:420,502,1134  JWT/Stripe payload casts
```

---

## Appendix B — Verified false positives

Patterns that look unsafe at first grep but are documented as deliberate and correct:

1. **All four webhook routes (Stripe, GitHub, Sentry, Twilio)** — every one verifies the HMAC/signature on the raw body BEFORE parsing JSON, and the subsequent `JSON.parse(body) as X` casts are sound under the post-verification trust model. See [src/app/api/stripe/webhook/route.ts:54-60](src/app/api/stripe/webhook/route.ts:54), [src/app/api/github-webhook/route.ts:38-57](src/app/api/github-webhook/route.ts:38), [src/app/api/sentry-webhook/route.ts:117-122](src/app/api/sentry-webhook/route.ts:117), [src/app/api/sms-reply/route.ts:220-253](src/app/api/sms-reply/route.ts:220).
2. **Stripe SDK event-discriminated-union casts** — `event.data.object as Stripe.Checkout.Session` etc. The Stripe SDK doesn't narrow `event.data.object` automatically on `event.type`; the cast is documented Stripe-Node pattern. Sound because `event.type` is from a signature-verified payload.
3. **`as const` and `satisfies SessionFailureCode`** — these aren't type assertions, they're TS literal-narrowing primitives. Safe by design.
4. **Test-file `as unknown as X` casts (~80 hits)** — monkey-patching singletons or shaping mock Request objects for tests. Tests are blast-radius zero (don't run in prod).
5. **`tools/` and `scripts/`** — one-shot tsx tools. Same blast-radius reasoning.
6. **`globalThis as unknown as { __supabaseAdmin?: SupabaseClient }`** in `supabase.ts:62` and `supabase-admin.ts:33` — HMR-safe singleton pattern from the Next.js docs. Documented at the call site.
7. **`api-response.ts`'s `ApiResponse<T = unknown>` generic default** — the SAFE form. `T = unknown` forces narrowing on consumption; the alternative (`T = any`) would defeat itself.
8. **The 22 `err as unknown as Error` casts for `log.error(…, { err })`** — these satisfy a `LogFields.err: Error` signature; the runtime payload is whatever was thrown and Sentry handles it. Cosmetic and safe; fix is to relax the signature (M7), not to change the call sites.
9. **`(p as PropertyRow).x` casts inside iteration over a typed-by-SELECT supabase return** — sound IF the SELECT and the interface stay in sync. They don't always, which is why this is flagged in H1/H3 — but the pattern itself isn't unsafe in isolation.

---

## What this audit is NOT (out of scope)

- **Fixing the findings.** No source files were modified per user instruction. Each finding above has a one-line fix; a separate PR could land H1+H3+H4+M1 in well under an hour with no behavior change.
- **The ml-service Python codebase** — different type system, different audit shape.
- **Recommending Zod / valibot / io-ts** — the codebase has already rejected this. The hand-rolled `api-validate.ts` is the canonical pattern; the recommendations above extend it rather than replace it.
- **The 132 routes' route-level handlers** — most are well-formed and reuse `validateUuid` / `validateString` / `requireSession`. A few are flagged above; the rest were spot-checked and not enumerated.

## How to test the fixes (when a follow-up PR is written)

For H1 (db-mappers): unit-test each `parseUnion`/`parseStringField`/`parseArrayField` helper with valid, mistyped, and null inputs. Existing tests in [src/lib/__tests__/](src/lib/__tests__/) follow the same node-test pattern.

For H2-H4: add a single positive-path test that round-trips a real Supabase row through the helper, and a single negative-path test that hands the helper a row missing a column.

For M6: extract response shapes to `src/types/api.ts`, re-import on client and server. No runtime test; the TS compiler does the check.

For M7: change `LogFields.err: Error | undefined` to `LogFields.err: unknown`. The 22 cast sites delete themselves. Run `npx tsc --noEmit` to confirm.

`npm run lint` and `npm run test` should pass cleanly after any of these fixes.
