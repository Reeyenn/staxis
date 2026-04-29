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
      'node_modules/**',
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
    files: ['**/__tests__/**/*.{ts,tsx,js}', '**/*.test.{ts,tsx,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
