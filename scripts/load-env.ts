// ─── Env loader for the CLI eval scripts ─────────────────────────────────
// Replaces `import 'dotenv/config'`, which was broken in two ways at once and
// is the reason `agent_eval_baselines` sat at ZERO rows forever:
//
//   1. WRONG FILE. `dotenv/config` reads `.env`. This repo has never had a
//      `.env` — the real secrets live in `.env.local` (the Next.js
//      convention, and what `.gitignore` covers). dotenv found nothing,
//      silently set nothing, and every eval script died on its own
//      "Missing NEXT_PUBLIC_SUPABASE_URL" guard before running a single case.
//   2. UNDECLARED DEP. `dotenv` is not in package.json. It resolved only
//      because @sentry/nextjs happens to hoist it. A Sentry bump that drops
//      it would have turned the silent misconfiguration into a hard
//      module-not-found.
//
// This mirrors the loader `scripts/seed-supabase.js` has always used, so the
// two agree on parsing. Precedence matches Next.js and 12-factor: a variable
// already present in `process.env` (CI secret, inline `FOO=bar npm run …`)
// always wins over a file, and `.env.local` wins over `.env`.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse the contents of a dotenv-style file into a plain object.
 *
 * Deliberately small — it handles what this repo's `.env.local` actually
 * contains and nothing more. Exported so the parsing rules can be tested
 * without touching the filesystem or `process.env`.
 *
 * Recognised:
 *   - `KEY=value`, with surrounding whitespace trimmed
 *   - an optional `export ` prefix (people paste these out of shells)
 *   - single- or double-quoted values, with `\n` unescaped inside them
 *   - `#` comments on their own line, and blank lines
 *   - `=` inside the value (only the FIRST `=` splits)
 *
 * Ignored: lines with no `=`, and lines with an empty key.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    }
    out[key] = val;
  }
  return out;
}

/**
 * Walk up from `startDir` looking for the directory that holds package.json.
 * Used instead of `__dirname` so this module behaves the same whether tsx
 * loads it as CJS or ESM, and regardless of the caller's cwd.
 */
function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Load `.env.local` then `.env` into `process.env`, without clobbering
 * anything already set. Returns the files that were actually read, so a
 * caller can say "I found no env file" rather than reporting a confusing
 * missing-variable error.
 */
export function loadEnv(startDir: string = process.cwd()): string[] {
  const root = findRepoRoot(startDir);
  const loaded: string[] = [];
  // `.env.local` first: first writer wins below, so this gives it precedence.
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in process.env)) process.env[k] = v;
    }
    loaded.push(file);
  }
  return loaded;
}
