/**
 * Next.js instrumentation hook (auto-loaded once per server runtime).
 *
 * Splits Sentry initialization by runtime: the Node-runtime config gets the
 * full SDK; the Edge-runtime config gets the Edge-compatible subset. Each
 * runtime only loads its own file, so the bundler never has to evaluate
 * Node-only code (Buffer, process.binding, native modules) for the Edge
 * build, which is what kills the build otherwise.
 *
 * If SENTRY_DSN is empty, the config files initialize the SDK with no DSN
 * and the SDK becomes a runtime no-op — same effect as not loading at all,
 * just no `if (dsn)` branch needed here.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

/**
 * Sentry's recommended hook for capturing nested-route errors. Wired up
 * because @sentry/nextjs exports the right helper, and skipping this
 * means React Server Component errors slip past the SDK.
 */
export { captureRequestError as onRequestError } from '@sentry/nextjs';
