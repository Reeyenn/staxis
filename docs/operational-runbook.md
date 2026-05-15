# Operational runbook

Append-only session log for **manual production changes** — anything that
doesn't pass through git history. Migrations applied by hand, env vars
touched in dashboards, secrets rotated, one-off SQL fixes, etc.

**Why this file exists:** Round 18 review surfaced that several
production changes today were invisible to anyone reading the repo:
3 migrations applied via `psql`, 11 rows deleted from
`inventory_rate_priors`, 1 Vercel env var added, 3 GitHub Actions
secrets created and later moved into a `production` environment.
Without a paper trail, the next on-call has no way to reconstruct
prod state.

**Rules:**

1. Add a date-stamped section every time you touch prod outside git.
2. List what changed, why, and how to revert.
3. Newest entries at the top. Don't edit old entries.
4. If the change is reversible via a checked-in script, link the script.
5. If the change is `gh`/`vercel`/`supabase`-CLI driven, paste the
   exact command (with secrets redacted).
6. Hooks/CI/process changes belong in code, not here. This log is for
   the irreversible-from-git ops.

---

## 2026-05-15 — Round 18 hardening session

### Migrations applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0124_accounts_skip_2fa.sql` | `accounts.skip_2fa` bool column for the shared demo login | `select skip_2fa from accounts limit 1` |
| `0125_total_rooms_inventory_invariant.sql` | Trigger keeps `properties.total_rooms = array_length(room_inventory)` | `\d properties` shows trigger |
| `0126_staxis_api_limit_cleanup_recreate.sql` | Recreates `staxis_api_limit_cleanup()` that drifted from 0008 | `select staxis_api_limit_cleanup()` returns int |
| `0129_schedule_auto_fill_if_absent.sql` | RPC for atomic schedule-auto-fill insert | `\df staxis_schedule_auto_fill_if_absent` |
| `0130_model_runs_cold_start_flag.sql` | `model_runs.cold_start` boolean + backfill | `select count(*) from model_runs where cold_start = true` should be ≥14 |

Roll back: drop the columns/functions, then `delete from applied_migrations where version in ('0124', ..., '0130')`. Note that 0125's trigger guards an invariant — dropping it without a code change would let `total_rooms ≠ array_length(room_inventory)` drift back in.

### Data cleanups

| When | What | Why | Reversibility |
|---|---|---|---|
| 2026-05-15 ~05:30 UTC | `delete from inventory_rate_priors where prior_rate_per_room_per_day < 0.001 or > 10` | 11 poisoned priors from a single-hotel cohort with n=1 incident logs were skewing cold-start predictions for the entire `comfort-suites-south-medium` cohort | The trainer regenerates priors on its weekly run; deleted rows reappear iff the trainer thinks they're sane (post-fix, they won't) |

### Vercel env vars

| When | Var | Action | Why |
|---|---|---|---|
| 2026-05-15 ~18:00 UTC | `NEXT_PUBLIC_SENTRY_DSN` | Added on production (encrypted) + preview (initially plain, re-set as encrypted at 19:30 UTC via REST API) | Client-side browser errors were disappearing silently because the env var was missing |

DSN value lives in Sentry → `staxis.sentry.io/settings/projects/javascript-nextjs/keys/`. Recover via Vercel dashboard if accidentally cleared.

### GitHub Actions secrets

| When | Secret | Scope | Action |
|---|---|---|---|
| 2026-05-15 ~18:15 UTC | `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` | Repo-scoped | Added (for `check-migrations-applied` workflow) |
| 2026-05-15 ~19:30 UTC | Same 3 secrets | **Moved to `production` environment-scoped** | Limits blast radius: only workflows that opt-in to `environment: production` can read them |

Recover: `gh secret set --env production --repo Reeyenn/staxis ...` with values sourced from `~/.config/staxis/tokens.env`.

### Doctor / cron heartbeats: things to watch

After today's changes, the doctor's hourly run should report all-green with these warns:
- `stripe_billing_configured` (expected — trial-only mode)
- `inventory_priors_in_range` (may persist briefly if the deleted-row backfill didn't catch every outlier)

The `schedule-auto-fill` cron is new; first heartbeat lands when GH Actions next fires the 12:00 or 01:00 UTC slot.

---

## Template (copy + paste for new sessions)

```markdown
## YYYY-MM-DD — short title

### Migrations
| File | What | How to verify |
|---|---|---|

### Data cleanups
| When | What | Why | Reversibility |
|---|---|---|---|

### Env vars (Vercel / Railway / Fly)
| When | Var | Action | Why |
|---|---|---|---|

### Secrets (GitHub Actions / elsewhere)
| When | Secret | Scope | Action |
|---|---|---|---|

### Notes for the next on-call
- …
```
