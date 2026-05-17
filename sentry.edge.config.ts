/**
 * Sentry Edge-runtime configuration.
 *
 * Loaded by src/instrumentation.ts only when NEXT_RUNTIME === 'edge'.
 * The Edge SDK has a smaller surface than the Node SDK (no native
 * modules, fewer integrations) but the init contract is the same.
 *
 * If SENTRY_DSN is empty, init runs and the SDK becomes a no-op —
 * downstream call sites don't need a DSN check.
 */

import * as Sentry from '@sentry/nextjs';
import { getBaseSentryOptions } from '@/lib/sentry-base';

Sentry.init({
  ...getBaseSentryOptions(),
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
});
