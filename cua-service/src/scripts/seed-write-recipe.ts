/**
 * Phase-3 write-recipe PRODUCER (the missing piece the pre-test review flagged:
 * "nothing in the repo ever creates or signs a row into pms_writeback_recipes",
 * so the first real write-back no-ops with `no_active_write_recipe").
 *
 * This script builds the `room_status` WriteActionRecipe for a PMS family,
 * signs it with the active RECIPE_SIGNING_KEY, locally re-verifies the
 * signature (catches any canonical-JSON / jsonb round-trip surprise BEFORE it
 * reaches the worker), and inserts it into pms_writeback_recipes with the
 * signature stored as a Postgres `\xHEX` bytea literal (the exact shape the
 * worker's decodeBytea expects).
 *
 * SAFETY (deliberately strict — a wrong recipe drives a real PMS):
 *   - The recipe selectors below are TODO placeholders. They MUST be filled in
 *     from the target PMS's real room-status screen before activation.
 *   - You can only insert status='active' with verified_against='practice_room'
 *     (matches the worker's provenance gate — a live write refuses anything
 *     less). And activation is REFUSED while any TODO placeholder remains.
 *   - Activating demotes the prior active recipe for (family, action) to
 *     'deprecated' first, so the one-active partial unique index is honored.
 *   - Signing must be configured; an unsigned active recipe is refused.
 *
 * Usage (run with tsx; RECIPE_SIGNING_KEY + Supabase env must be set):
 *   # Inspect the signed recipe without touching the DB:
 *   tsx src/scripts/seed-write-recipe.ts --print
 *   # Seed a draft (safe default — never used by a live write):
 *   tsx src/scripts/seed-write-recipe.ts --family=choice_advantage --status=draft --verified-against=mock --yes
 *   # Activate, ONLY after the selectors are filled in + rehearsed on a CA practice room:
 *   tsx src/scripts/seed-write-recipe.ts --family=choice_advantage --status=active --verified-against=practice_room --yes
 *
 * Rehearsal note: the write-replay engine + signing round-trip are proven
 * headlessly against the built-in mock PMS by the test suite
 * (write-runner.test.ts + write-recipe-roundtrip.test.ts). The REAL recipe must
 * additionally be exercised against a real PMS practice room before activation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { signWriteRecipe, verifyRecipe, isRecipeSigningConfigured } from '../recipe-signing.js';
import type { Recipe, WriteActionRecipe } from '../types.js';

// The Supabase client is imported LAZILY (inside the DB path) so `--print`
// builds + signs + verifies a recipe with no DB client at all — handy on
// runtimes without native WebSocket and for offline inspection.

/** Sentinel marking a selector/URL that still needs to be filled in from the
 *  target PMS's real screen. Activation is refused while any remain. */
const TODO = 'TODO_FROM_PMS_SCREEN';

/** Internal Staxis status values statusToLogValue can emit — every one MUST be
 *  covered by valueMap so the worker's valueMap-completeness gate passes and an
 *  occupied-room push can never crash mid-replay. */
const INTERNAL_STATUSES = [
  'vacant_clean',
  'vacant_dirty',
  'occupied_clean',
  'occupied_dirty',
  'inspected',
  'out_of_order',
];

/**
 * The room_status write recipe TEMPLATE. Fill the TODO selectors/URL and the
 * valueMap right-hand sides from the PMS's actual housekeeping screen, then
 * activate. The shape is validated end-to-end against the mock PMS in the test
 * suite — this is the same shape with real-PMS selectors.
 */
function buildRoomStatusRecipe(): WriteActionRecipe {
  return {
    key: 'set_room_status',
    description: 'Push a Staxis room-status change back into the PMS housekeeping screen.',
    requiredParams: ['room_number', 'target_status'],
    // The payload carries INTERNAL values; validate against those, then valueMap
    // translates each to the PMS on-screen string for the select + verify.
    paramEnums: { target_status: INTERNAL_STATUSES },
    valueMap: {
      vacant_clean: TODO, // e.g. 'Clean'
      vacant_dirty: TODO, // e.g. 'Dirty'
      occupied_clean: TODO, // e.g. 'Occupied Clean'
      occupied_dirty: TODO, // e.g. 'Occupied Dirty'
      inspected: TODO, // e.g. 'Inspected'
      out_of_order: TODO, // e.g. 'Out of Order'
    },
    pageUrl: TODO, // the PMS housekeeping page URL hosting the editable room rows
    loggedInSelector: TODO, // a selector present ONLY when logged in (fail-closed session guard)
    rowLocator: {
      rowSelector: TODO, // selector matching each room row, e.g. '#hk tbody tr'
      matchCell: TODO, // cell within the row holding the room number, e.g. 'td.room'
      matchParam: 'room_number',
    },
    steps: [
      // Open/choose the status control on the matched row, then commit.
      { kind: 'select', selector: TODO, value: '$payload.target_status', scope: 'row' },
      { kind: 'save', selector: TODO, scope: 'row' },
    ],
    // After save, re-locate the row and assert the current status now equals the
    // (mapped) target — both in-page and via an authoritative reload.
    verifyInPage: { selector: TODO, scope: 'row', equals: '$payload.target_status' },
    verifiedAgainst: 'mock',
  };
}

/** Recursively collect any TODO sentinels left in the recipe. */
function findPlaceholders(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return value === TODO ? [path || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, path ? `${path}.${k}` : k));
  }
  return [];
}

interface Flags {
  family: string;
  action: string;
  status: 'draft' | 'active' | 'deprecated';
  verifiedAgainst: 'mock' | 'practice_room' | 'path_only';
  notes: string;
  print: boolean;
  yes: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string, def: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const status = get('status', 'draft');
  const verifiedAgainst = get('verified-against', 'mock');
  if (status !== 'draft' && status !== 'active' && status !== 'deprecated') {
    throw new Error(`--status must be draft|active|deprecated, got "${status}"`);
  }
  if (verifiedAgainst !== 'mock' && verifiedAgainst !== 'practice_room' && verifiedAgainst !== 'path_only') {
    throw new Error(`--verified-against must be mock|practice_room|path_only, got "${verifiedAgainst}"`);
  }
  return {
    family: get('family', 'choice_advantage'),
    action: get('action', 'room_status'),
    status,
    verifiedAgainst,
    notes: get('notes', ''),
    print: has('print'),
    yes: has('yes'),
  };
}

async function nextVersion(db: SupabaseClient, family: string, action: string): Promise<number> {
  const { data, error } = await db
    .from('pms_writeback_recipes')
    .select('version')
    .eq('pms_family', family)
    .eq('action_key', action)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw new Error(`version lookup failed: ${error.message}`);
  const max = data && data.length > 0 ? (data[0].version as number) : 0;
  return max + 1;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const recipe = buildRoomStatusRecipe();
  const placeholders = findPlaceholders(recipe);

  // Sign + locally re-verify (proves the canonical-JSON / jsonb round-trip
  // before the worker ever sees it). WRITE recipes are signed v2 — the HMAC
  // binds the provenance/routing columns (action_key, pms_family,
  // verified_against) ALONGSIDE the recipe body, so a service-role attacker
  // can't flip verified_against or transplant the recipe onto another action
  // row without breaking verification. The bound meta below MUST match the
  // exact columns inserted (see the insert() call) or the worker's v2 verify
  // fails closed.
  if (!isRecipeSigningConfigured()) {
    throw new Error('RECIPE_SIGNING_KEY is not set — refusing to produce an unsigned write recipe.');
  }
  const boundMeta = {
    actionKey: flags.action,
    pmsFamily: flags.family,
    verifiedAgainst: flags.verifiedAgainst,
  };
  const sig = signWriteRecipe(recipe as unknown as Recipe, boundMeta);
  const stored = JSON.parse(JSON.stringify(recipe)) as WriteActionRecipe; // jsonb round-trip shape
  const verify = verifyRecipe(stored as unknown as Recipe, sig.signature, sig.signedWithKeyId, boundMeta);
  if (!verify.ok) {
    throw new Error(`local signature re-verify FAILED (${verify.reason}) — would fail closed in the worker.`);
  }
  if (verify.version !== 2) {
    throw new Error(`local re-verify returned v${verify.version} — write recipes must be v2 (the worker rejects v1 writes).`);
  }
  const signatureBytea = `\\x${sig.signature.toString('hex')}`;

  if (flags.print) {
    console.log(JSON.stringify({ recipe, signedWithKeyId: sig.signedWithKeyId, signatureBytea, placeholders }, null, 2));
    console.log(`\nLocal signature re-verify: OK (${verify.keyGeneration} key). Placeholders remaining: ${placeholders.length}.`);
    return;
  }

  // Activation safety gates.
  const activating = flags.status === 'active';
  if (activating && flags.verifiedAgainst !== 'practice_room') {
    throw new Error("Refusing: an 'active' recipe must be verified_against='practice_room' (the worker's live-write provenance gate rejects anything less).");
  }
  if ((activating || flags.verifiedAgainst === 'practice_room') && placeholders.length > 0) {
    throw new Error(
      `Refusing to activate an un-authored recipe — ${placeholders.length} TODO placeholder(s) remain:\n  - ${placeholders.join('\n  - ')}\n` +
        'Fill these from the PMS room-status screen and rehearse against a practice room first.',
    );
  }
  if (!flags.yes) {
    throw new Error('Dry by default. Re-run with --yes to write to pms_writeback_recipes (or use --print to inspect).');
  }

  const { supabase: db } = await import('../supabase.js');
  const version = await nextVersion(db, flags.family, flags.action);

  // One active per (family, action): demote any current active before activating.
  if (activating) {
    const { error: demoteErr } = await db
      .from('pms_writeback_recipes')
      .update({ status: 'deprecated', updated_at: new Date().toISOString() })
      .eq('pms_family', flags.family)
      .eq('action_key', flags.action)
      .eq('status', 'active');
    if (demoteErr) throw new Error(`failed to demote prior active recipe: ${demoteErr.message}`);
  }

  const { data: inserted, error: insErr } = await db
    .from('pms_writeback_recipes')
    .insert({
      pms_family: flags.family,
      action_key: flags.action,
      version,
      status: flags.status,
      recipe,
      signature: signatureBytea,
      signed_with_key_id: sig.signedWithKeyId,
      signed_at: sig.signedAt,
      verified_against: flags.verifiedAgainst,
      notes: flags.notes || `Seeded by seed-write-recipe.ts (placeholders left: ${placeholders.length}).`,
      created_by: 'seed-write-recipe.ts',
    })
    .select('id, version, status, verified_against')
    .single();
  if (insErr || !inserted) throw new Error(`insert failed: ${insErr?.message ?? 'unknown'}`);

  console.log(
    `Inserted pms_writeback_recipes ${flags.family}/${flags.action} v${inserted.version} ` +
      `status=${inserted.status} verified_against=${inserted.verified_against} id=${inserted.id}`,
  );
  if (placeholders.length > 0) {
    console.log(`NOTE: ${placeholders.length} TODO placeholder(s) remain — this draft cannot drive a real PMS until filled in.`);
  }
}

// Only run when invoked directly (never as an imported module).
const entry = process.argv[1] ?? '';
if (/seed-write-recipe\.(ts|js)$/.test(entry)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
