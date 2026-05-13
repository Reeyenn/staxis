# Activating Sentry source-map uploads

**Status:** the `next.config.ts` wrapper is already in place. Sentry uploads activate as soon as `SENTRY_AUTH_TOKEN` is set in Vercel's production environment.

**Why this matters:** without source-map uploads, prod errors in Sentry show up as `chunks/3-xy7.js:1:2391` instead of `src/app/api/agent/command/route.ts:241`. The first form is unreadable; the second form is debuggable.

**Effort:** ~2 minutes. Done once.

## Steps

1. Open the Sentry auth-token page: <https://staxis.sentry.io/settings/auth-tokens/>.
2. Click **Create New Token**. Name it something like `vercel-sourcemaps-staxis-app`.
3. Grant exactly two scopes (no more, no less):
   - `project:releases`
   - `org:read`
   
   Then click **Create Token**. Sentry shows the token once — copy it.
4. In Vercel: <https://vercel.com/staxis/staxis/settings/environment-variables>.
   - Click **Add New**.
   - Name: `SENTRY_AUTH_TOKEN`
   - Value: paste the token from step 3.
   - Environments: **Production only** (uncheck Preview + Development — local dev doesn't upload source maps, and preview deploys would burn your Sentry quota).
   - Click **Save**.
5. Redeploy. Either push any commit to `main`, or hit **Redeploy** in the Vercel dashboard on the latest deployment.

## How to verify it worked

After the deploy completes:

- The Vercel build log should include a `Sentry: Uploaded source maps for release …` line.
- Open Sentry → Releases → your newest commit SHA should appear with source maps attached.
- The next time a real error fires in prod, the stack frame at the top should show the actual source file + line number (e.g. `src/app/.../route.ts:241`), not a chunk hash.

## If it doesn't work

- **Build fails with "auth token invalid"**: token may have been pasted with whitespace, or the wrong scopes were granted. Re-create with exactly the two scopes above.
- **Build succeeds but no "Uploaded source maps" line**: check that the env var name is exactly `SENTRY_AUTH_TOKEN` (case-sensitive) and that it's scoped to Production.
- **Source maps upload but Sentry still shows minified frames**: the `next.config.ts` wrapper sets `deleteSourcemapsAfterUpload: true` deliberately — the maps live only in Sentry, not in the browser bundle. Sentry needs ~30 seconds after upload to index a release; try the failing action again after a minute.

## Costs

Sentry charges per uploaded artifact, not per query. One Next production build uploads ~50–200 source-map files. At Staxis's deploy frequency (~5 deploys/day), that's ~25k artifacts/month — well within the free tier.

The wrapper also sets `disableLogger: true` and `sourcemaps.deleteSourcemapsAfterUpload: true` so the production browser bundle does not ship source maps to clients. Only Sentry sees them.
