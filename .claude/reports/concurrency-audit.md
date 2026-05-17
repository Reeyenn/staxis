# Concurrency & Race Condition Audit

**Date:** 2026-05-17
**Branch:** `audit/concurrency`
**Scope:** Read-only audit of the Staxis codebase for the 7 concurrency-risk categories: lost-update bugs, optimistic-UI desync, out-of-order webhooks/jobs, shared in-memory server state, cache/DB races, missing idempotency keys, unsafe `Promise.all`.
**Method:** Three parallel Explore agents (backend mutations / external integrations / frontend & shared state) + targeted source verification of the top-severity findings.

## Summary

17 findings. Two **HIGH** (auth-bypass + multi-device data inconsistency), eleven **MEDIUM** (recoverable inconsistency, duplicate sends, lost observability data), four **LOW** (cost-only or cosmetic).

| # | Severity | Area | Title |
|---|---|---|---|
| 1 | HIGH | Backend | Property-access array read-modify-write race |
| 2 | HIGH | Frontend | Shift-start anchor lives in `localStorage`, not DB |
| 3 | MEDIUM | Backend | Join-code slot leak in `releaseSlot()` precondition |
| 4 | MEDIUM | Backend | `Promise.all` partial-failure on room reassignment |
| 5 | MEDIUM | Backend | ML failure counter lost-update on JSON array |
| 6 | MEDIUM | Email | Resend `fetch` missing `Idempotency-Key` header |
| 7 | MEDIUM | SMS | `/api/sms-reply` no Twilio event dedup |
| 8 | MEDIUM | CUA | Recipe-version race fails permanently after 5 collisions |
| 9 | MEDIUM | SMS | Stuck-job watchdog 5-min blindness → duplicate SMS |
| 10 | MEDIUM | Cache | Property-config in-memory cache stampede + multi-instance drift |
| 11 | MEDIUM | Cache | Agent context cache stampede |
| 12 | MEDIUM | Frontend | `LanguageContext` no cross-tab sync |
| 13 | MEDIUM | Frontend | `PropertyContext` no cross-tab sync |
| 14 | LOW | Frontend | Realtime callback can overwrite fresh `refetchRooms` |
| 15 | LOW | CUA | Anthropic SDK calls missing `request_id` dedup |
| 16 | LOW | LLM | `vision-extract` SDK timeout doesn't abort orphaned calls |
| 17 | LOW | Webhook | `/api/sentry-webhook` no event dedup |

Findings that were initially flagged but **ruled out as false positives** are listed at the end.

---

## HIGH

### 1. Property-access array read-modify-write race

**File:** [src/app/api/auth/team/route.ts:235-259](src/app/api/auth/team/route.ts:235)
**Category:** Lost-update
**Verified:** ✅ read source

**Scenario.** Two managers (or one manager acting in two tabs) issue concurrent `DELETE`s removing the same user from different hotels.

- Both fetch `accounts.property_access = ['hotel-1', 'hotel-2', 'hotel-3']` at line 235-239.
- Manager A computes `next = ['hotel-2', 'hotel-3']` (removed `hotel-1`).
- Manager B computes `next = ['hotel-1', 'hotel-3']` (removed `hotel-2`).
- Manager B's write lands last → final state is `['hotel-1', 'hotel-3']`. The user **regains access to `hotel-1`** that Manager A successfully removed.

**Inconsistent data.** `accounts.property_access` silently re-grants access. An offboarded user could retain access to a hotel they were supposed to lose.

**Fix.** Replace the read-modify-write with an atomic SQL operation:

```sql
UPDATE accounts
SET property_access = array_remove(property_access, $1)
WHERE id = $2
RETURNING property_access;
```

Wrap as a Supabase RPC and call it from the route. The check at line 251 (`if (next.length === current.length)`) can be reimplemented from the `RETURNING` row vs the original read.

---

### 2. Shift-start anchor stored in `localStorage`, not in DB

**File:** [src/app/housekeeper/[id]/page.tsx:148](src/app/housekeeper/[id]/page.tsx:148)
**Category:** Storage / multi-device inconsistency

**Scenario.** A housekeeper starts shift at 7:00 AM on Phone A — `staxis:shift_start:<hotel>:<staff>:<date>` is written to Phone A's `localStorage`. Mid-shift the phone dies and the housekeeper continues on Phone B. Phone B has no shift-start in its `localStorage`, so it either prompts a fresh start (7:05 AM) or runs anchorless.

Every subsequent room mark-done event uses a different `started_at` reference depending on which device made the call. The cleaning-events table ends up with internally inconsistent durations for the same housekeeper for the same shift.

**Inconsistent data.** `cleaning_events.duration_seconds` (and any analytics built on it: per-housekeeper KPI, shift productivity report, manager dashboards). Affects the ML feature derivation that's already known to be sensitive.

**Fix.** Server-source the shift start. The schedule already lives in `staff_assignments` (or similar — verify). On page mount, `/api/housekeeper/rooms` should return `shift_start_at` from the DB; the client uses it instead of `localStorage`. If no shift has been claimed yet, the first room action creates the row server-side (atomic `INSERT … ON CONFLICT DO NOTHING`).

---

## MEDIUM

### 3. Join-code slot leak in `releaseSlot()` precondition

**File:** [src/app/api/auth/use-join-code/route.ts:115-183](src/app/api/auth/use-join-code/route.ts:115)
**Category:** Lost-update (subtle — leaks, doesn't over-grant)

**Scenario.** The CAS increment at line 115 is correct: `UPDATE … SET used_count = row.used_count + 1 WHERE used_count = row.used_count` is atomic. Concurrent signups cannot both succeed.

The bug is in the failure-recovery path:

```ts
const releaseSlot = async () => {
  await supabaseAdmin
    .from('hotel_join_codes')
    .update({ used_count: row.used_count })             // ← target = original read
    .eq('id', row.id)
    .eq('used_count', row.used_count + 1);              // ← matches only if NO one else incremented
};
```

If signup A increments 0→1, then signup B arrives, sees `used_count=1`, increments 1→2 (CAS succeeds). Now signup A's `createUser` fails and `releaseSlot()` runs — but it predicates on `used_count = 1`, and the row is now `2`. The UPDATE matches zero rows, the release silently no-ops, and the slot stays burned.

**Net effect:** the join code shows "used up" while having unused slots. A `max_uses=3` code that fires three failures + three successes ends up at `used_count=6` but only 3 real signups.

> Note: an Explore agent initially classified this as an **over-grant** (allowing more users than `max_uses`). That's wrong — the CAS guard prevents that. The real bug is the opposite: **silent slot leakage**, capped at `max_uses` (legitimate signups always block once `used_count >= max_uses`).

**Inconsistent data.** `hotel_join_codes.used_count` drifts upward of the true count of real signups; codes appear exhausted prematurely.

**Fix.** Have the CAS step return the new count (via `.select('used_count')`) and decrement against that, with retry on conflict. Even better: move both the CAS increment and the `auth.admin.createUser` into a single Postgres transaction so the release becomes automatic on rollback. (Note: `createUser` is a network call to Supabase Auth, so a true SQL transaction isn't possible — but the slot can be claimed via an "intent" row keyed on a UUID, then resolved/expired by a sweep job.)

---

### 4. `Promise.all` partial-failure on room reassignment

**File:** [src/app/api/send-shift-confirmations/route.ts:288-318](src/app/api/send-shift-confirmations/route.ts:288)
**Category:** Promise.all partial failure
**Verified:** ✅ read source

**Scenario.** When a manager hits "Send Shift Confirmations" for a crew, up to ~15 `UPDATE rooms SET assigned_to = …, assigned_name = …` statements fire in parallel via `Promise.all(updates)` at line 317. There is no transaction. If one update fails (transient DB error, constraint violation), `Promise.all` rejects, the route returns 500 — but the updates that already committed stay committed.

The SMS-send block follows (lines ~485+) and may have already fired for some housekeepers. The manager sees a 500, refreshes, and tries again — re-firing SMS to housekeepers who already received them and re-committing partial updates on top of partial old state.

**Inconsistent data.** `rooms.assigned_to` and `rooms.assigned_name` end up mixed (some new, some old). `shift_confirmations` rows may exist for housekeepers whose rooms didn't actually get reassigned. Re-send doubles SMS.

**Fix.** Move the entire assignment block into a Postgres RPC that does the upsert + per-room updates inside a transaction. Sketch:

```sql
CREATE FUNCTION staxis_apply_shift_assignments(
  p_property uuid,
  p_date date,
  p_assignments jsonb  -- [{number, staff_id, staff_name}, ...]
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- upsert new rows, update existing, clear stale — all in one tx
END $$;
```

Then the route calls `.rpc('staxis_apply_shift_assignments', ...)` and only fires SMS after the RPC succeeds.

---

### 5. ML failure counter lost-update

**File:** [src/lib/ml-failure-counters.ts:76-130](src/lib/ml-failure-counters.ts:76)
**Category:** Lost-update on JSON array

**Scenario.** `incrementMLFailureCounter` reads `scraper_status.data.ml_failures:<kind>`, mutates the `recent[]` array in JavaScript, increments `total`, and upserts the whole JSON blob back. Two concurrent housekeeper actions that both fail feature derivation on the same property within milliseconds race:

- Thread 1 reads `{recent: [oldA], total: 5}`, computes `{recent: [newT1, oldA], total: 6}`.
- Thread 2 reads `{recent: [oldA], total: 5}` (before T1 writes), computes `{recent: [newT2, oldA], total: 6}`.
- Whichever writes second wins. The other thread's failure is silently lost.

**Inconsistent data.** `scraper_status.data.ml_failures.<kind>.recent` is missing entries; `total` stays low. The doctor's 24h rolling-window alert (which is the whole reason this counter exists) misses failures.

**Fix.** Move the read-modify-write into a Postgres function:

```sql
CREATE FUNCTION staxis_record_ml_failure(p_pid uuid, p_kind text, p_err text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE scraper_status
  SET data = jsonb_set(
    COALESCE(data, '{}'::jsonb),
    ARRAY['ml_failures', p_kind, 'recent'],
    (
      jsonb_build_array(
        jsonb_build_object('ts', now(), 'error', p_err)
      ) || COALESCE(data #> ARRAY['ml_failures', p_kind, 'recent'], '[]'::jsonb)
    )[0:100]
  )
  WHERE property_id = p_pid;
END $$;
```

The codebase already does this pattern for `staxis_api_limit_hit` and `staxis_walkthrough_step` — re-use the convention.

---

### 6. Resend `fetch` missing `Idempotency-Key` header

**File:** [src/lib/email/resend.ts:111-121](src/lib/email/resend.ts:111)
**Category:** Missing idempotency
**Verified:** ✅ read source — `headers` block has only `Authorization` and `Content-Type`.

**Scenario.** Any flow that retries the email send (Next.js fetch-level retry, manual retry on `ok: false`, a webhook re-delivery that runs the email path) will deliver the same transactional email twice. Resend has supported the `Idempotency-Key` header since 2024; it's not being passed.

**Inconsistent data.** Recipients receive duplicate onboarding invites / password resets / shift summaries.

**Fix.** Add to the headers at line 115:

```ts
'Idempotency-Key': params.idempotencyKey
  ?? hash([params.to, params.subject, Math.floor(Date.now() / 60_000)].join('|')),
```

Make `idempotencyKey?: string` a field on `SendEmailParams` so callers in retry-prone paths (webhooks, jobs) can pass a deterministic key.

---

### 7. `/api/sms-reply` no Twilio event dedup

**File:** [src/app/api/sms-reply/route.ts:378-397](src/app/api/sms-reply/route.ts:378)
**Category:** Webhook race

**Scenario.** Twilio re-delivers inbound-SMS webhooks on network issues or 5xx responses. The handler calls `sendSms()` for command responses (language switch, help, opt-out confirmation) without first checking whether this `MessageSid` has already been processed. The route does log to `webhook_log`, but the log write is independent of the SMS send — both will happen twice.

**Inconsistent data.** Housekeeper receives the same response SMS twice; confusing UX, potential metric double-counts if any analytics fire from the reply path.

**Fix.** Add a `processed_sms_webhooks` table with `PRIMARY KEY (message_sid)`. At the top of the route:

```ts
const { error: dupErr } = await supabaseAdmin
  .from('processed_sms_webhooks')
  .insert({ message_sid: body.MessageSid, received_at: new Date().toISOString() });
if (dupErr?.code === '23505') return new Response('OK'); // duplicate, ack and exit
```

Mirror the pattern the Stripe webhook handler already uses.

---

### 8. CUA recipe-version race fails permanently after 5 collisions

**File:** [cua-service/src/job-runner.ts:330-398](cua-service/src/job-runner.ts:330)
**Category:** Job race / version-number CAS

**Scenario.** `saveDraftRecipe()` reads `MAX(version)` for the PMS type, increments, INSERTs. Two concurrent mappers race on the unique constraint; the loser retries with the next number. The retry loop is capped at 5. If six or more concurrent mappers run for the same PMS at deploy time (e.g., backfilling onboardings or a heavy day for the same PMS type), the 6th exhausts retries and the entire onboarding job is marked `failed` — a terminal status that the cron doesn't recover from.

**Inconsistent data.** A property's onboarding sits permanently in `failed` even though the underlying mapping work succeeded.

**Fix.** Two options:

1. **Postgres `SEQUENCE`** — one per PMS type, `nextval()` is atomic and never collides.
2. **`INSERT … ON CONFLICT DO NOTHING RETURNING id`** with a fallback `SELECT … WHERE …` to find the existing winner.

Option 2 is closer to the current code shape and lower risk to land.

---

### 9. SMS stuck-job watchdog 5-min blindness → duplicate SMS

**File:** [src/lib/sms-jobs.ts:361](src/lib/sms-jobs.ts:361)
**Category:** Job race / claim recovery window

**Scenario.** Worker calls `staxis_claim_sms_jobs` which marks the row `status='sending'`. The send-then-write block has a fix already in place (the 2026-05-12 Codex audit comment at line 199-204 acknowledges) so the row can't bounce back to `queued` after a successful Twilio send. But if the worker process dies between the Twilio send and any DB write — power loss, OOM kill, container restart during deploy — the row stays in `sending` forever from the worker's perspective.

`resetStuckSmsJobs(300)` runs at line 361 with a 5-minute timeout. During that 5-minute window, a fresh worker tick won't pick up the stuck row (it's claimed), and the watchdog hasn't unstuck it yet. Once it does unstick, the row goes back to `queued` and gets sent again → the housekeeper receives the SMS twice, 5+ minutes apart.

**Inconsistent data.** Duplicate SMS delivery on worker crash. Twilio billing increment.

**Fix.** Tighten the stuck-claim TTL to `120` seconds (line 361). The cron tick processes up to 50 jobs and a Twilio call averages ~1-3s; a healthy tick finishes well under 60s, so anything past 2 minutes is genuinely stuck and worth re-trying. The trade-off (a slow Twilio response inside the 60-120s window being treated as stuck and re-fired) is bounded by the existing per-attempt `max_attempts` cap.

---

### 10. Property-config in-memory cache stampede + multi-instance drift

**File:** [src/lib/property-config.ts:47-100](src/lib/property-config.ts:47)
**Category:** Cache/DB race + shared in-memory state
**Verified:** ✅ read source — `const cache = new Map<string, CacheEntry>()` at module scope.

**Scenario A — stampede.** Two concurrent requests for the same `pid` both miss cache, both fire the same Supabase SELECT, and write to the cache one after the other. The second write overwrites the first. Benign if the data is identical, but wasteful and not safe against writes that landed in between.

**Scenario B — multi-instance staleness.** Each Vercel function instance has its own `Map`. A write to the `properties` table that calls `invalidateConfig(pid)` only clears the cache on the **same instance** that made the write. Other instances continue serving stale config for up to 60s.

**Inconsistent data.** Operator changes `dashboard_stale_minutes`; some users see the new value immediately, others see the old value for up to a minute. For `scraper_window_*` changes this is more material — the scraper may run outside the intended window for a minute.

**Fix.** Two acceptable paths:

1. **Document the 60s eventual-consistency SLA** explicitly in the file header and accept it. The cache is too useful to remove; the staleness is bounded.
2. **Move to Upstash Redis** with `del`-on-write. The codebase already has Upstash for rate-limiting elsewhere. A single shared cache eliminates the drift.

Recommend option 1 unless there's a concrete config-change incident that motivates option 2.

---

### 11. Agent context cache stampede

**File:** [src/lib/agent/context.ts:52](src/lib/agent/context.ts:52)
**Category:** Cache/DB race + shared in-memory state

**Scenario.** Same shape as #10. `buildHotelSnapshot()` is the per-turn input to the realtime agent. Two concurrent agent turns for the same `(propertyId, role, staffId)` both miss the 30s cache, both run the snapshot query batch, both write to the cache; the second wins. Stale data served for 30s post-write; multi-instance drift as in #10.

The `cacheKey()` function correctly includes `staffId` so role-mixing across users is prevented, but per-snapshot races for the same key are possible.

**Inconsistent data.** Agent answers based on a snapshot up to 30s out of date. For the housekeeping path this matters more — a "what's next?" turn might claim a room that was just marked done elsewhere.

**Fix.** Add in-flight dedup so concurrent same-key misses share one query:

```ts
const inflight = new Map<string, Promise<HotelSnapshot>>();
async function getSnapshot(key: string) {
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.snap;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const snap = await loadSnapshot(...);
      cache.set(key, { snap, expiresAtMs: Date.now() + 30_000 });
      inflight.delete(key);
      return snap;
    })();
    inflight.set(key, pending);
  }
  return pending;
}
```

Doesn't fix the multi-instance issue (see #10) but kills the per-instance stampede cheaply.

---

### 12. `LanguageContext` no cross-tab sync

**File:** [src/contexts/LanguageContext.tsx:19-50](src/contexts/LanguageContext.tsx:19)
**Category:** Storage race

**Scenario.** User has the admin UI in Tab A (English) and the housekeeper public link in Tab B (Spanish). The `setLang` call in Tab B writes `localStorage['hotelops-lang'] = 'es'`. Tab A is now `'en'` in component state but `'es'` in the underlying storage. The Context only hydrates from `localStorage` on initial mount — it never re-reads.

**Inconsistent data.** Tabs disagree on the user's language preference; the next refresh of either tab uses whichever value was most recently written.

**Fix.** Subscribe to the `storage` event in the Provider:

```ts
useEffect(() => {
  const handler = (e: StorageEvent) => {
    if (e.key === 'hotelops-lang' && e.newValue) {
      setLangState(e.newValue as Language);
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}, []);
```

The `storage` event fires in **other** tabs when one tab calls `localStorage.setItem`, so each tab stays in sync without round-tripping the server.

---

### 13. `PropertyContext` no cross-tab sync

**File:** [src/contexts/PropertyContext.tsx:72](src/contexts/PropertyContext.tsx:72)
**Category:** Storage race

**Scenario.** Same shape as #12. User has multiple properties; opens Property A in Tab A, switches Tab A to Property B. Tab B's `PropertyContext` still has Property A active because the change only hit `localStorage` and Tab B doesn't listen. Tab B's dashboard / rooms list / staff list all show the wrong property until reload.

**Fix.** Same `storage` event listener pattern as #12, keyed on whatever `PropertyContext` writes to `localStorage` (likely `staxis:active_property_id`).

---

## LOW

### 14. Realtime callback can overwrite fresh `refetchRooms`

**File:** [src/app/housekeeper/[id]/page.tsx:280, 451-452](src/app/housekeeper/[id]/page.tsx:280)
**Category:** Subscription + manual fetch ordering

**Scenario.** The page subscribes to room changes via `subscribeToRoomsForStaff()` (line 280). After a mark-done action the page also calls `refetchRooms()` (line 452) fire-and-forget. If the Postgres-emitted realtime event was queued before the refetch completes, the realtime handler may call `setRooms()` with the pre-mark-done snapshot **after** the refetch already set the post-mark-done snapshot. The room briefly reverts on screen.

The next poll/event/refetch corrects it. Pure visual flicker, no server-side inconsistency.

**Fix.** Track an `inflightRefetchAt` timestamp; in the realtime handler, drop events older than the most recent successful refetch. Or just disable the realtime handler for ~200ms after a manual refetch returns.

---

### 15. Anthropic SDK calls missing `request_id` dedup

**File:** [cua-service/src/mapper.ts:386-399](cua-service/src/mapper.ts:386)
**Category:** Missing idempotency (cost-only)

**Scenario.** A network drop after Anthropic processes a `messages.create` but before the response arrives triggers SDK-level retry. The retry is billed independently. For the mapper, a typical PMS exploration is 50-100 turns at ~$0.01-0.10/turn — duplication is real money over a fleet.

**Fix.** Thread a deterministic `request_id` keyed on `${jobId}:turn:${turnCounter}` through to the SDK call options. Anthropic dedupes within a 24h window.

---

### 16. `vision-extract` SDK timeout doesn't abort orphaned calls

**File:** [src/lib/vision-extract.ts:25-36](src/lib/vision-extract.ts:25)
**Category:** Missing abort signal (cost-only)

**Scenario.** The SDK is initialized with `timeout: VISION_REQUEST_TIMEOUT_MS` (30s), but this only controls when the SDK gives up waiting — it does not abort the HTTP request. If Vercel's route `maxDuration` fires before the SDK timeout, the route returns to the caller while the Anthropic call continues running server-side, still billing.

**Fix.** Pass `signal: AbortSignal.timeout(25_000)` to `messages.create({ ... }, { signal })`. The SDK supports this in recent versions.

---

### 17. `/api/sentry-webhook` no event dedup

**File:** `src/app/api/sentry-webhook/route.ts`
**Category:** Webhook race
**Confidence:** Lower — flagged by grep, not source-verified line-by-line.

**Scenario.** Sentry, like Stripe and Twilio, re-delivers webhooks on failure. Without dedup by event ID, duplicate Sentry events trigger duplicate downstream side effects (whatever the handler does — likely Slack alerts or log writes).

**Fix.** Same pattern as #7 — `processed_sentry_webhooks` table with PK on event ID, insert-then-check.

---

## Audited and ruled out

These were flagged by exploration but turn out to be non-issues:

- **`src/lib/api-fetch.ts` token-refresh dedup** — the `inFlightRefresh` promise pattern is correct; concurrent refresh attempts share the same promise.
- **`src/lib/supabase-admin.ts` preflight** — the racing initialization is benign (idempotent read with no side effects).
- **`src/app/api/stripe/webhook/route.ts` event dedup** — `stripe_processed_events` already has PK on `event_id`, processing is idempotent.
- **`src/lib/stripe.ts` lazy customer creation** — already uses `idempotencyKey: propertyId` so concurrent calls converge on the same Stripe customer.
- **CUA job claiming** — uses `FOR UPDATE SKIP LOCKED` in the RPC, two workers cannot grab the same row.
- **`src/app/settings/voice/page.tsx` optimistic toggle** — already has rollback in `onError` (line 81); double-clicks are mitigated by the `saving` disabled state.

---

## Recommended remediation order

1. **#1** (HIGH, auth bypass) — small atomic-SQL change, big correctness win.
2. **#6** (Resend idempotency) — one-header fix, prevents duplicate transactional emails.
3. **#7** (SMS-reply dedup) — small table + 2-line check, prevents duplicate SMS to staff.
4. **#4** (`Promise.all` partial failure) — needs an RPC, but the route is already a hot path.
5. **#2** (shift-start to server) — larger refactor; schedule with the next housekeeping milestone.
6. **#5** (ML failure counter RPC) — straightforward Postgres function, restores observability.
7. **#12 / #13** (cross-tab sync) — two `useEffect` additions, ship together.
8. **#9** (SMS watchdog TTL) — one-line constant change.
9. Everything else — opportunistic.

Patterns to apply repo-wide: **(a)** atomic SQL or RPCs for read-modify-write on shared rows; **(b)** an `Idempotency-Key` header on every outbound mutation to an external API; **(c)** event-ID dedup tables for every webhook receiver.
