/**
 * CI guard for Pattern C: every `/api/admin/*` route must use `requireAdmin`
 * or `requireAdminOrCron` — never `requireCronSecret` alone.
 *
 * Closes Codex 2026-05-16 P1: `/api/admin/diagnose` was gated on
 * `requireCronSecret` only, which let any holder of the shared CRON_SECRET
 * (Vercel cron, GitHub Actions, scripts, workers) read cross-tenant SMS
 * PII + capability tokens. The fix wasn't just to patch diagnose — it was
 * to declare the contract: cron-secret alone is too loose for `/api/admin/*`
 * routes that return data, because "admin/" path-prefix implies admin-level
 * trust and CRON_SECRET is shared across too many holders.
 *
 * EXCEPTIONS lists the one route that legitimately is cron-only AND returns
 * no tenant data (it's a synthetic Sentry probe). Add new exceptions ONLY
 * when (a) the route is genuinely cron-driven (a GitHub Action or Vercel
 * cron call site exists) AND (b) its response shape contains no PII,
 * tenant data, or capability tokens — only acknowledgments + counters.
 *
 * Run via: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ADMIN_ROUTES_ROOT = join(process.cwd(), 'src', 'app', 'api', 'admin');

// Routes allowed to gate on `requireCronSecret` alone. Each entry must
// satisfy: (1) actively called by a cron/GHA workflow we own; (2) the
// response contains no tenant data, PII, or capability tokens.
const EXCEPTIONS = new Set<string>([
  // Synthetic Sentry probe — fires `log.error(...)` to verify the Sentry
  // pipeline. Response only carries the synthetic event id, no tenant data.
  // GitHub Actions: .github/workflows/sentry-test.yml
  'sentry-test/route.ts',
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      await walk(full, out);
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      out.push(full);
    }
  }
  return out;
}

function usesCronSecretOnly(source: string): boolean {
  // Look for an active import of requireCronSecret (skip pure comments).
  // The pattern: an `import { ... requireCronSecret ... }` line + a call
  // site in the route body. We don't try to AST-parse — a grep is enough
  // because the pattern is unambiguous in this codebase.
  const hasImport = /import\s*\{[^}]*\brequireCronSecret\b[^}]*\}\s*from\s*['"]@\/lib\/api-auth['"]/m.test(source);
  if (!hasImport) return false;
  // Also import any of the stricter helpers? If so, this route is using
  // requireCronSecret as a fallback or for a different purpose, not "alone."
  const usesStricter = /\brequireAdmin\b|\brequireAdminOrCron\b/.test(source);
  if (usesStricter) return false;
  // Confirm there's an actual call site (not just an import for tests).
  const hasCall = /\brequireCronSecret\s*\(/.test(source);
  return hasCall;
}

test('no /api/admin/* route uses requireCronSecret alone (Pattern C regression guard)', async () => {
  const files = await walk(ADMIN_ROUTES_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const rel = relative(ADMIN_ROUTES_ROOT, file);
    if (EXCEPTIONS.has(rel)) continue;
    const src = await readFile(file, 'utf8');
    if (usesCronSecretOnly(src)) {
      offenders.push(rel);
    }
  }

  if (offenders.length > 0) {
    const detail = offenders.map(r => `  src/app/api/admin/${r}`).join('\n');
    assert.fail(
      `Found /api/admin/* route(s) gated on requireCronSecret alone. ` +
      `Use requireAdmin (for data-returning routes) or requireAdminOrCron ` +
      `(if both admin UI and cron drive it). Pattern C — shared bearer ` +
      `secrets must not gate routes that return tenant data or capability ` +
      `tokens, because CRON_SECRET leaks across every holder.\n` +
      `If a new exception is genuinely needed, add it to EXCEPTIONS in this ` +
      `test with a justification comment.\nOffenders:\n${detail}`,
    );
  }
});
