/**
 * Test-only env bootstrap.
 *
 * Importing this module at the very top of a `.test.ts` file ensures
 * `process.env` is populated BEFORE env.ts validates. The older tests
 * in this directory use `process.env.X ??= 'placeholder'` at the top of
 * the file expecting CJS execution order, but ESM hoists imports above
 * top-level statements — so env.ts ends up parsing an empty
 * `process.env` and throws.
 *
 * This file solves that for new tests: ESM hoists imports per source
 * order, so this module's side effects run before any subsequent
 * `import` in the same file. The body below only RUNS if the
 * environment isn't already populated (CI does provide real values).
 */

const placeholders: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key-min-20-chars',
  ANTHROPIC_API_KEY: 'sk-ant-placeholder-for-tests',
};

for (const [k, v] of Object.entries(placeholders)) {
  if (!process.env[k]) process.env[k] = v;
}

// Default to critic-enabled so the happy-path tests exercise the real
// code path. Individual tests flip this between cases to verify the
// disable behavior.
process.env.CUA_CRITIC_ENABLED ??= 'true';
