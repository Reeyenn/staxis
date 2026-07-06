/**
 * Backfill: enqueue OCR for scans that were uploaded BEFORE OCR support shipped.
 *
 * Before this feature, a scanned/image-only PDF dead-ended at
 * extraction_status='unsupported' with an extract_error mentioning "scanned
 * image". This script finds those rows and enqueues a `doc_ocr` workflow job for
 * each, so the Fly vision worker transcribes them and they become AI-searchable.
 *
 * The reviewer runs this MANUALLY at ship time (after the web + Fly deploys are
 * live). It is idempotent: the doc_ocr idempotency_key is stable-per-document,
 * so a second run (or a doc that already has an in-flight job) is a no-op.
 *
 * Usage:
 *   # dry run — list what WOULD be enqueued, change nothing:
 *   tsx scripts/enqueue-ocr-backfill.ts
 *   # actually enqueue:
 *   tsx scripts/enqueue-ocr-backfill.ts --apply
 *   # limit to one property:
 *   tsx scripts/enqueue-ocr-backfill.ts --apply --pid <property-uuid>
 *
 * Needs (loaded from ~/.config/staxis/tokens.env or the shell env):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';

// Mirrors src/lib/knowledge/ocr.ts (buildDocOcrJobRow) — that module is
// 'server-only' so this script keeps its own copy of the two constants.
const DOC_OCR_JOB_KIND = 'doc_ocr';
const DOC_OCR_TIMEOUT_MS = 900_000;

interface DocRow {
  id: string;
  property_id: string;
  file_path: string;
  mime_type: string | null;
  extract_error: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pidArg = (() => {
    const i = process.argv.indexOf('--pid');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Source ~/.config/staxis/tokens.env first.');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // Scanned-image docs that dead-ended as `unsupported` before OCR shipped.
  // The extract_error for that path contained "scanned image" (see the old
  // extraction.ts copy). We match it explicitly so we don't sweep in legacy
  // .doc or "This file type can't be read" unsupported rows.
  let q = supabase
    .from('knowledge_documents')
    .select('id, property_id, file_path, mime_type, extract_error')
    .eq('extraction_status', 'unsupported')
    .ilike('extract_error', '%scanned image%');
  if (pidArg) q = q.eq('property_id', pidArg);

  const { data, error } = await q.limit(5000);
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as DocRow[];
  console.log(`Found ${rows.length} scanned-image doc(s) to backfill${pidArg ? ` for property ${pidArg}` : ''}.`);
  if (rows.length === 0) return;

  if (!apply) {
    for (const r of rows) {
      console.log(`  [dry-run] would enqueue doc_ocr: doc=${r.id} pid=${r.property_id} mime=${r.mime_type ?? 'application/pdf'}`);
    }
    console.log('\nDry run only. Re-run with --apply to enqueue.');
    return;
  }

  let enqueued = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    const mime = r.mime_type ?? 'application/pdf';
    // Dedupe: skip if an unfinished doc_ocr job already exists for this doc.
    const { data: existing } = await supabase
      .from('workflow_jobs')
      .select('id')
      .eq('property_id', r.property_id)
      .eq('kind', DOC_OCR_JOB_KIND)
      .contains('payload', { documentId: r.id })
      .in('status', ['queued', 'running'])
      .limit(1)
      .maybeSingle();
    if (existing) { skipped++; continue; }

    const { error: insErr } = await supabase
      .from('workflow_jobs')
      .insert({
        property_id: r.property_id,
        kind: DOC_OCR_JOB_KIND,
        idempotency_key: `${DOC_OCR_JOB_KIND}:${r.id}`,
        max_attempts: 1,
        triggered_by: 'backfill:enqueue-ocr',
        // pageCount null — the old rows never stored a page count. The worker
        // then skips the 60-page cap instruction; the 10MB upload cap bounds
        // real scan sizes well below the API's 600-page limit anyway.
        payload: {
          propertyId: r.property_id, documentId: r.id, filePath: r.file_path, mime,
          pageCount: null, timeout_ms: DOC_OCR_TIMEOUT_MS,
        },
      });
    if (insErr) {
      // 23505 = the stable-per-doc key already exists → treat as already-enqueued.
      if ((insErr as { code?: string }).code === '23505') { skipped++; continue; }
      console.error(`  FAILED to enqueue doc=${r.id}: ${insErr.message}`);
      failed++;
      continue;
    }
    // Flip the doc to processing so the UI shows "Reading scan…" immediately.
    await supabase
      .from('knowledge_documents')
      .update({ extraction_status: 'processing', extract_error: null })
      .eq('id', r.id)
      .eq('property_id', r.property_id);
    enqueued++;
  }
  console.log(`\nDone. Enqueued ${enqueued}, skipped ${skipped} (already in flight), failed ${failed}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
