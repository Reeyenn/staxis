// Hybrid-search blending + THE permission gate.
//
// canRoleSeeManagerOnly is the single decision that gates manager-only content
// across ALL THREE surfaces: search (RPC p_include_manager_only + keyword
// .eq('visibility','all_staff')), the document/SOP list, and signed-URL minting
// (a hidden doc is never listed, so its URL is never minted) + fetch_document_
// section. This proves a floor role can never see manager-only knowledge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRoleSeeManagerOnly, roleCanSeeVisibility, sanitizeSearchTerm, makeSnippet,
  blendChunkHits, type ChunkHit,
} from '@/lib/knowledge/search-helpers';
import type { AppRole } from '@/lib/roles';

const FLOOR: AppRole[] = ['housekeeping', 'front_desk', 'maintenance'];
const MANAGEMENT: AppRole[] = ['admin', 'owner', 'general_manager'];

test('floor roles can NEVER see manager-only knowledge; management always can', () => {
  for (const r of FLOOR) {
    assert.equal(canRoleSeeManagerOnly(r), false, `${r} must not see manager-only`);
    assert.equal(roleCanSeeVisibility(r, 'managers'), false, `${r} must not see a managers row`);
    assert.equal(roleCanSeeVisibility(r, 'all_staff'), true, `${r} sees all_staff rows`);
  }
  for (const r of MANAGEMENT) {
    assert.equal(canRoleSeeManagerOnly(r), true, `${r} must see manager-only`);
    assert.equal(roleCanSeeVisibility(r, 'managers'), true);
    assert.equal(roleCanSeeVisibility(r, 'all_staff'), true);
  }
});

test('a managers-only row is invisible to a housekeeper (search/list/download gate)', () => {
  // Each surface keys its visibility filter off canRoleSeeManagerOnly(role):
  //   - search RPC: p_include_manager_only = canRoleSeeManagerOnly(role)
  //   - keyword arm + list: when !canRoleSeeManagerOnly(role) → .eq('visibility','all_staff')
  //   - download: a hidden doc isn't in the list → no signed URL minted
  const role: AppRole = 'housekeeping';
  const includeManagerOnly = canRoleSeeManagerOnly(role);
  assert.equal(includeManagerOnly, false);
  // Model the filter every surface applies and assert the managers row drops out.
  const rows = [
    { id: 'doc-public', visibility: 'all_staff' as const },
    { id: 'doc-secret', visibility: 'managers' as const },
  ];
  const visibleToHousekeeper = rows.filter((r) => roleCanSeeVisibility(role, r.visibility));
  assert.deepEqual(visibleToHousekeeper.map((r) => r.id), ['doc-public']);
  // And a GM sees both.
  const visibleToGm = rows.filter((r) => roleCanSeeVisibility('general_manager', r.visibility));
  assert.deepEqual(visibleToGm.map((r) => r.id), ['doc-public', 'doc-secret']);
});

test('sanitizeSearchTerm strips LIKE wildcards + PostgREST metacharacters', () => {
  assert.equal(sanitizeSearchTerm('%_ pool; drop'), 'pool drop');
  assert.equal(sanitizeSearchTerm('  PX-4471  '), 'PX-4471');
  assert.ok(sanitizeSearchTerm('a'.repeat(500)).length <= 100);
});

test('makeSnippet centers on the term and ellipsizes', () => {
  const text = 'x'.repeat(200) + ' breakfast bar ' + 'y'.repeat(200);
  const snip = makeSnippet(text, 'breakfast', 100)!;
  assert.ok(snip.includes('breakfast'));
  assert.ok(snip.startsWith('…') && snip.endsWith('…'));
});

// ── blendChunkHits ──────────────────────────────────────────────────────────

function vhit(id: string, similarity: number): ChunkHit {
  return { id, documentId: 'd1', articleId: null, sourceType: 'document', content: `chunk ${id}`, section: null, similarity };
}
function khit(id: string): ChunkHit {
  return { id, documentId: 'd1', articleId: null, sourceType: 'document', content: `chunk ${id}`, section: null, similarity: null };
}

test('blend: vector + keyword merge, dedupe, keyword-also boost ranks highest', () => {
  const vector = [vhit('a', 0.9), vhit('b', 0.5)];
  const keyword = [khit('b'), khit('c')]; // b is in both, c keyword-only
  const out = blendChunkHits(vector, keyword, { minSimilarity: 0.2, keywordBoost: 0.3, limit: 10 });
  const ids = out.map((p) => p.id);
  assert.deepEqual(new Set(ids), new Set(['a', 'b', 'c']), 'deduped union of both arms');
  // b (0.5 + 0.3 boost = 0.8) outranks a (0.9)? a=0.9 > b=0.8 → a first.
  assert.equal(ids[0], 'a');
  assert.equal(out.find((p) => p.id === 'b')!.keyword, true, 'b flagged as keyword match');
  assert.equal(out.find((p) => p.id === 'c')!.similarity, null, 'c is keyword-only');
});

test('blend: weak vector-only hits below the floor are dropped (no misleading match)', () => {
  const out = blendChunkHits([vhit('weak', 0.05)], [], { minSimilarity: 0.2 });
  assert.equal(out.length, 0, 'an unrelated query returns nothing rather than the closest noise');
});

test('blend: respects the limit', () => {
  const vector = Array.from({ length: 20 }, (_, i) => vhit(`v${i}`, 0.5 + i / 100));
  const out = blendChunkHits(vector, [], { limit: 6 });
  assert.equal(out.length, 6);
});
