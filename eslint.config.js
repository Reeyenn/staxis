/**
 * ESLint flat config (ESLint 8.57+).
 *
 * eslint-config-next ships an old-style config object with `extends` and
 * `plugins` keys, which ESLint flat config rejects. Bridge it with
 * @eslint/eslintrc's FlatCompat helper, which translates extends/plugins
 * into the equivalent flat-config plugin objects at runtime.
 *
 * The end result is the same set of rules `next lint` would have applied:
 * Next's recommended rules + react-hooks rules + a11y best practices.
 */

const { FlatCompat } = require('@eslint/eslintrc');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

module.exports = [
  // Translate eslint-config-next + the core-web-vitals subset into flat config.
  ...compat.extends('next/core-web-vitals'),

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
    // Promise-safety rules. Type-aware, so we opt into projectService for
    // the src/ tree only — scraper/ is JS and cua-service/ is its own
    // tsconfig (already excluded by the top-level tsconfig.json).
    //
    // Reason: pre-audit (May 2026) we had several floating promises and
    // missing .catch() chains that surfaced as "unhandled promise rejection"
    // in production. These rules catch them at lint time. Audit doc at
    // /Users/reeyen/.claude/plans/audit-error-handling-find-snug-koala.md.
    //
    // We register the plugin explicitly here because the compat.extends()
    // shim only attaches it to the next/core-web-vitals blocks above;
    // this standalone block needs its own reference to look up rules.
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
