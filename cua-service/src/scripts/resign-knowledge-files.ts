/**
 * One-off backfill — re-sign every pms_knowledge_files row with the CORRECT
 * bytea hex signature.
 *
 * Bug: saveDraftKnowledgeFile passed the raw HMAC Buffer to supabase-js, which
 * JSON-serialized it as {"type":"Buffer","data":[…]} and persisted THAT TEXT
 * into the `signature` bytea column. So every stored signature was JSON garbage
 * and verifyRecipe (a 32-byte HMAC) never matched — under RECIPE_SIGNING_ENFORCE
 * the worker refused to load the active recipe (no polling). Fixed at the write
 * site; this re-signs the existing rows.
 *
 * Re-signs over the stored `knowledge` envelope — EXACTLY what loadActive /
 * verifyRecipe canonical-JSON over at load — and writes the signature as the
 * '\xHEX' bytea literal (the same shape seed-write-recipe already uses).
 * Idempotent. MUST run where RECIPE_SIGNING_KEY is set (the Fly worker).
 *
 * Run:  flyctl ssh console -a staxis-cua -C "node /app/dist/scripts/resign-knowledge-files.js"
 */
import { supabase } from '../supabase.js';
import { signRecipe, isRecipeSigningConfigured } from '../recipe-signing.js';
import type { Recipe } from '../types.js';

async function main(): Promise<void> {
  if (!isRecipeSigningConfigured()) {
    console.error('FATAL: RECIPE_SIGNING_KEY is not set in this environment — cannot re-sign. Run on the Fly worker.');
    process.exit(1);
  }
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, knowledge')
    .order('pms_family', { ascending: true })
    .order('version', { ascending: true });
  if (error) {
    console.error('FATAL: could not load knowledge files:', error.message);
    process.exit(1);
  }
  const rows = data ?? [];
  console.log(`Re-signing ${rows.length} knowledge file(s)…`);
  let ok = 0;
  for (const row of rows) {
    try {
      const sig = signRecipe(row.knowledge as unknown as Recipe);
      const { error: upErr } = await supabase
        .from('pms_knowledge_files')
        .update({
          signature: '\\x' + sig.signature.toString('hex'),
          signed_with_key_id: sig.signedWithKeyId,
          signed_at: sig.signedAt,
        })
        .eq('id', row.id);
      if (upErr) {
        console.error(`  FAIL ${row.pms_family} v${row.version}: ${upErr.message}`);
        continue;
      }
      ok++;
      console.log(`  re-signed ${row.pms_family} v${row.version} (${row.status})`);
    } catch (e) {
      console.error(`  FAIL ${row.pms_family} v${row.version}: ${(e as Error).message}`);
    }
  }
  console.log(`Done. Re-signed ${ok}/${rows.length}.`);
  process.exit(ok === rows.length ? 0 : 1);
}

void main();
