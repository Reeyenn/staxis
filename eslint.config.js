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
    files: ['**/__tests__/**/*.{ts,tsx,js}', '**/*.test.{ts,tsx,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
