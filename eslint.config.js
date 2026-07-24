/**
 * ESLint flat config (ESLint 10+).
 *
 * eslint-config-next ^16 ships native flat-config — `eslint-config-next`
 * itself is the base set, and `eslint-config-next/core-web-vitals` adds
 * the Core Web Vitals subset on top. Both export a flat-config array,
 * so we can spread them directly instead of going through @eslint/eslintrc's
 * FlatCompat bridge (which the previous ESLint 8 / eslint-config-next 15
 * setup needed).
 *
 * End result: the same set of rules `next lint` would have applied —
 * Next's recommended rules + react-hooks rules + a11y best practices.
 */

const nextCoreWebVitalsConfig = require('eslint-config-next/core-web-vitals');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  // Next.js recommended + Core Web Vitals (already a flat-config array).
  ...nextCoreWebVitalsConfig,

  {
    // Project-wide ignores. Keep this minimal — anything we want lint-checked
    // should fall through to the rules defined above.
    ignores: [
      '.next/**',
      '**/.next/**',          // catches .claude/worktrees/*/.next/** etc.
      'node_modules/**',
      '**/node_modules/**',
      '.claude/**',           // worktrees, plans, MCP state — not source
      'dist/**',
      'build/**',
      'coverage/**',
      'public/**',
      'scraper/node_modules/**',
    ],
  },

  {
    // Project-wide rule tuning.
    rules: {
      // react/no-unescaped-entities flags every literal apostrophe and
      // quote inside JSX text ("Mario's hotel" → "Mario&apos;s hotel").
      // This catches a near-zero percentage of real bugs and creates a
      // mountain of noise on legal / marketing pages. Most React shops
      // turn this off; we do the same. If a literal HTML entity actually
      // causes a render bug in the future, the grep will be obvious.
      'react/no-unescaped-entities': 'off',

      // The eslint-plugin-react-hooks v7 family of "React Compiler" rules
      // were introduced after this codebase was written. They flag valid
      // (if old-school) patterns like setState-in-effect for hydration,
      // ref reads during render, and manual memoization that the compiler
      // would otherwise do. Fixing the ~77 flagged sites is a dedicated
      // refactor; for the deps upgrade we keep behaviour identical.
      // Re-enable rule-by-rule when each pattern is migrated.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },

  {
    // Per-file rule tuning. Tests intentionally use `any`-ish patterns
    // (mocking shapes loosely), so don't fail those for the rule that
    // would otherwise be useful to keep on production code.
    //
    // no-floating-promises is also off in tests: node:test's `test(name,
    // async () => {...})` returns a promise that the runner consumes, but
    // eslint sees it as a floating promise. Re-enable manually if you
    // want it for a specific test file.
    files: ['**/__tests__/**/*.{ts,tsx,js}', '**/*.test.{ts,tsx,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },

  {
    // ─── The AI layer's one-hotel boundary (INV-25) ────────────────────────
    // Everything under src/lib/agent/** must reach the database through
    // `ctx.db` / `scopedDb(propertyId)` so the hotel filter cannot be
    // forgotten. Importing the service-role client directly bypasses that.
    //
    // `patterns` is NOT redundant with `paths`: `paths` only matches the exact
    // specifier '@/lib/supabase-admin', so a relative '../supabase-admin'
    // would sail straight through.
    //
    // TYPE-ONLY IMPORTS ARE BANNED TOO (decided up front rather than settled
    // ad hoc at the first violation): supabase-admin exports no type worth
    // importing — take `SupabaseClient` from '@supabase/supabase-js'.
    //
    // The `ignores` list is an explicitly shrinking allowlist. scoped-db.ts is
    // permanent (it IS the door). The rest are the cron/route-driven modules
    // that have not been converted yet; deleting an entry is how that work
    // lands. scripts/audit-service-role-imports.mjs fails if an entry is stale.
    files: ['src/lib/agent/**/*.ts'],
    ignores: [
      'src/lib/agent/scoped-db.ts',
      // ── not yet converted (cron/route-driven, not model-driven) ──
      'src/lib/agent/activity.ts',
      'src/lib/agent/archival.ts',
      'src/lib/agent/context.ts',
      'src/lib/agent/cost-controls.ts',
      'src/lib/agent/evals/runner.ts',
      'src/lib/agent/memory.ts',
      'src/lib/agent/memory-consolidate.ts',
      'src/lib/agent/nudges.ts',
      'src/lib/agent/operational-signals.ts',
      'src/lib/agent/pending-actions.ts',
      'src/lib/agent/prompts-store.ts',
      'src/lib/agent/summarizer.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@/lib/supabase-admin',
          message:
            'The AI layer must query through ctx.db / scopedDb(propertyId). ' +
            'For a genuine exception, import unscopedBecause from ' +
            '@/lib/agent/scoped-db with an enumerated reason and bump the ' +
            'pinned count in scripts/audit-service-role-imports.mjs.',
        }],
        patterns: [{
          group: ['**/supabase-admin'],
          message:
            'The AI layer must query through ctx.db / scopedDb(propertyId). ' +
            'For a genuine exception, import unscopedBecause from ' +
            '@/lib/agent/scoped-db with an enumerated reason and bump the ' +
            'pinned count in scripts/audit-service-role-imports.mjs.',
        }],
      }],
    },
  },

  {
    // Promise-safety rules. Type-aware, so we opt into projectService for
    // the src/ tree only — scraper/ is JS and cua-service/ is its own
    // tsconfig (already excluded by the top-level tsconfig.json).
    //
    // Reason: pre-audit (May 2026) we had several floating promises and
    // missing .catch() chains that surfaced as "unhandled promise rejection"
    // in production. These rules catch them at lint time. Audit doc at
    // /Users/reeyen/.claude/plans/audit-error-handling-find-snug-koala.md.
    //
    // We register the plugin + parser explicitly here so the
    // type-aware lookup works even if eslint-config-next's parser
    // doesn't provide type info on every file.
    files: ['src/**/*.{ts,tsx}'],
    // Tests use node:test's `test(name, async () => {...})` which the runner
    // consumes but eslint doesn't recognize — would generate hundreds of
    // false positives. Test files keep the rule off (see test-tuning block
    // above).
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // checksVoidReturn: false keeps onClick={() => doAsync()} legal —
      // the Promise is implicitly discarded by the void return type. We
      // can tighten this later as a separate cleanup pass.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
];
