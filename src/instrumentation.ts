/**
 * Next.js instrumentation hook (auto-loaded once per server runtime).
 *
 * Currently used to wire Sentry when SENTRY_DSN is set. Stays a no-op when
 * SENTRY_DSN is empty so the @sentry/nextjs dep stays out of the runtime
 * unless we're actually emitting events.
 *
 * To enable Sentry:
 *   1. npm install @sentry/nextjs
 *   2. Set SENTRY_DSN in Vercel env (Production + Preview)
 *   3. Redeploy
 *
 * This file MUST be at `src/instrumentation.ts` (Next 13.4+) or the root
 * `instrumentation.ts` file. Renaming or moving it disables this hook.
 */

import { setCaptureImpl } from '@/lib/sentry';

export async function register() {
  // The instrumentation hook runs in BOTH the Node and Edge runtimes. We
  // only have a Node-runtime Sentry path, and Edge Runtime forbids
  // `eval` / `new Function` syntactically (Vercel rejects the build even
  // if the eval is never reached at runtime). Bail early on Edge so the
  // bundler never has to parse the eval below.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Sentry not configured — leave the no-op in place. This is the
    // expected state until Reeyen has signed up + filled in env vars.
    return;
  }

  // Dynamically import so the dep stays out of the bundle when we're not
  // using it. We use eval('require')('...') here (instead of the more
  // idiomatic dynamic `import()`) deliberately: this hides the module
  // path from the bundler's static analyzer entirely, so Next.js never
  // tries to resolve `@sentry/nextjs` at build time. Edge runtime is
  // explicitly excluded above so the eval is only ever parsed by Node.
  let SentryModule: unknown;
  try {
    // eslint-disable-next-line no-eval
    const nodeRequire = eval('require') as (id: string) => unknown;
    SentryModule = nodeRequire('@sentry/nextjs');
  } catch (err) {
    // @sentry/nextjs is not installed even though SENTRY_DSN is set. Log
    // loudly so Vercel's deploy log makes the misconfiguration obvious,
    // then keep the no-op so the app still runs.
    // eslint-disable-next-line no-console
    console.error(
      `[instrumentation] SENTRY_DSN is set but @sentry/nextjs is not installed. ` +
        `Run \`npm install @sentry/nextjs\` to enable Sentry. err=${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return;
  }

  // Lightly-typed handle to the module — we only need init + captureException.
  type SentryShape = {
    init: (opts: Record<string, unknown>) => void;
    captureException: (err: unknown, ctx?: { extra?: Record<string, unknown> }) => void;
  };
  const Sentry = SentryModule as SentryShape;

  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    // Keep volume modest until we know the steady-state error rate.
    tracesSampleRate: 0.1,
    // Server-side only at this layer; the client.config.ts (if added
    // later via @sentry/wizard) will configure the browser SDK.
  });

  setCaptureImpl((err, extra) => {
    Sentry.captureException(err, { extra });
  });
}
