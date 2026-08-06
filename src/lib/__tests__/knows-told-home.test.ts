/**
 * The told half of the Knows tab — the contact directory, the procedures and
 * the document cabinet that moved off the Communications section.
 *
 * These exercise the decisions themselves rather than asserting against
 * component source. The suite runs under `--conditions=react-server`, where
 * react-dom/server refuses to load, so the house pattern (see
 * concourse-queue-honesty.test.ts) is to keep the decisions in a plain module
 * and drive THOSE. told-knowledge.ts exists for exactly that reason.
 *
 * What is being protected, in order of how badly it hurts when it breaks:
 *
 *   1. UPLOAD. This is the ONLY way a human puts a document into the
 *      copilot's corpus, and search_knowledge instructs the model to always
 *      consult it. When it breaks the symptom is not an error anybody sees —
 *      the copilot just answers worse, quietly, forever. So the three steps
 *      are driven end to end here, including every way they can fail.
 *   2. EMERGENCY CONTACTS. Reachable by the people who need them, sorted
 *      first, with a phone href that actually dials.
 *   3. WHO SEES WHAT. Per-document access is a permission, and the two halves
 *      of this screen have deliberately different audiences.
 *   4. THE EXTRACTION BADGE. The only place in the app that admits a scanned
 *      PDF never became text.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EnvelopeResult } from '@/lib/api-envelope';
import type { KnowledgeContactDTO, KnowledgeDocumentDTO } from '@/lib/knowledge/types';
import { CONTACT_CATEGORIES, LOCAL_CATEGORIES } from '@/lib/knowledge/types';
import type { AppRole } from '@/lib/roles';
import {
  ACCESS_OPTIONS,
  CONTACT_GROUP_ORDER,
  UPLOAD_MAX_BYTES,
  accessToPayload,
  anyExtractionInFlight,
  canEditTold,
  canReadLearned,
  canReadTold,
  docAccessVal,
  extractionBadge,
  fileCountLabel,
  groupContacts,
  localSubGroups,
  mailtoHref,
  mapHref,
  telHref,
  titleFromFilename,
  uploadDocument,
  type AccessVal,
  type PresignData,
  type UploadDeps,
} from '@/components/concourse/told-knowledge';

const PID = 'aaaaaaaa-0000-4000-8000-000000000001';

const MANAGERS: AppRole[] = ['admin', 'owner', 'general_manager'];
const LINE_STAFF: AppRole[] = ['front_desk', 'housekeeping', 'maintenance'];

// ─── A recording stand-in for the three network steps ───────────────────────

interface Recorded {
  presign: { pid: string; filename: string }[];
  put: { signedUrl: string; contentType: string }[];
  register: Record<string, unknown>[];
}

function harness(overrides: {
  presign?: EnvelopeResult<PresignData>;
  put?: boolean;
  register?: EnvelopeResult<{ id: string }>;
  throwOn?: 'presign' | 'put' | 'register';
} = {}): { deps: UploadDeps; calls: Recorded } {
  const calls: Recorded = { presign: [], put: [], register: [] };
  const deps: UploadDeps = {
    presign: async (body) => {
      calls.presign.push(body);
      if (overrides.throwOn === 'presign') throw new Error('offline');
      return (
        overrides.presign ?? {
          data: {
            path: `${PID}/knowledge/generated.pdf`,
            signedUrl: 'https://storage.example/signed/abc',
            // The SERVER's answer. A browser handing back '' or the wrong
            // type must never be what gets PUT — the bucket allow-lists on
            // this value.
            contentType: 'application/pdf',
          },
        }
      );
    },
    put: async (signedUrl, contentType) => {
      calls.put.push({ signedUrl, contentType });
      if (overrides.throwOn === 'put') throw new Error('offline');
      return overrides.put ?? true;
    },
    register: async (body) => {
      calls.register.push(body as unknown as Record<string, unknown>);
      if (overrides.throwOn === 'register') throw new Error('offline');
      return overrides.register ?? { data: { id: 'doc-1' } };
    },
  };
  return { deps, calls };
}

const FILE = { name: 'Fire evacuation plan.pdf', size: 24_000 };

// ═══════════════════════ 1. the upload flow ════════════════════════════════

describe('putting a document into the copilot’s corpus', () => {
  test('the happy path presigns, uploads, then registers — in that order', async () => {
    const { deps, calls } = harness();
    const result = await uploadDocument(deps, {
      pid: PID, file: FILE, access: 'all_staff', folderId: null,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.presign.length, 1);
    assert.equal(calls.put.length, 1);
    assert.equal(calls.register.length, 1);
    assert.deepEqual(calls.presign[0], { pid: PID, filename: 'Fire evacuation plan.pdf' });
  });

  test('the bytes are PUT with the content type the SERVER resolved', async () => {
    // Safari reports an empty File.type for several accepted extensions, and
    // Supabase Storage rejects a PUT whose type is not on the bucket's list.
    // The presign answer is the only trustworthy source.
    const { deps, calls } = harness();
    await uploadDocument(deps, { pid: PID, file: FILE, access: 'all_staff', folderId: null });

    assert.equal(calls.put[0].contentType, 'application/pdf');
    assert.equal(calls.put[0].signedUrl, 'https://storage.example/signed/abc');
  });

  test('the registered row points at the presigned path and repeats that type', async () => {
    const { deps, calls } = harness();
    await uploadDocument(deps, { pid: PID, file: FILE, access: 'all_staff', folderId: 'folder-7' });

    assert.deepEqual(calls.register[0], {
      pid: PID,
      title: 'Fire evacuation plan',   // extension dropped
      path: `${PID}/knowledge/generated.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 24_000,
      visibility: 'all_staff',
      visibleDept: null,
      folderId: 'folder-7',
    });
  });

  test('a department upload registers as dept-scoped, not as everyone', async () => {
    // The regression this guards: collapsing the access picker to a label and
    // registering every upload as all_staff, which would silently publish a
    // managers-only or housekeeping-only document to the whole hotel.
    const { deps, calls } = harness();
    await uploadDocument(deps, { pid: PID, file: FILE, access: 'housekeeping', folderId: null });

    assert.equal(calls.register[0].visibility, 'dept');
    assert.equal(calls.register[0].visibleDept, 'housekeeping');
  });

  test('a managers-only upload never becomes a dept row', async () => {
    const { deps, calls } = harness();
    await uploadDocument(deps, { pid: PID, file: FILE, access: 'managers', folderId: null });

    assert.equal(calls.register[0].visibility, 'managers');
    assert.equal(calls.register[0].visibleDept, null);
  });

  test('an oversize file is refused before anything leaves the browser', async () => {
    const { deps, calls } = harness();
    const result = await uploadDocument(deps, {
      pid: PID, file: { name: 'huge.pdf', size: UPLOAD_MAX_BYTES + 1 }, access: 'all_staff', folderId: null,
    });

    assert.deepEqual(result, { ok: false, reason: 'too_big' });
    assert.equal(calls.presign.length, 0, 'must not ask for a signed URL it cannot use');
  });

  test('a refused presign stops the flow and says so', async () => {
    const { deps, calls } = harness({ presign: { error: 'Unsupported file type', status: 400 } });
    const result = await uploadDocument(deps, {
      pid: PID, file: { name: 'notes.pages', size: 100 }, access: 'all_staff', folderId: null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'presign_failed');
    assert.equal(result.ok === false && result.serverError, 'Unsupported file type');
    assert.equal(calls.put.length, 0);
    assert.equal(calls.register.length, 0);
  });

  test('a file whose bytes never landed is NOT registered', async () => {
    // The nastiest failure available here: registering a row for a file that
    // is not in the bucket. The cabinet would list a document that cannot be
    // downloaded and that the copilot can never read — a phantom.
    const { deps, calls } = harness({ put: false });
    const result = await uploadDocument(deps, {
      pid: PID, file: FILE, access: 'all_staff', folderId: null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'put_failed');
    assert.equal(calls.register.length, 0, 'a failed upload must never produce a row');
  });

  test('a refused registration is reported, not swallowed', async () => {
    const { deps } = harness({ register: { error: 'rate_limited', code: 'rate_limited' } });
    const result = await uploadDocument(deps, {
      pid: PID, file: FILE, access: 'all_staff', folderId: null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'register_failed');
    assert.equal(result.ok === false && result.serverError, 'rate_limited');
  });

  test('a dropped connection at any step becomes a failure, never a silent success', async () => {
    for (const step of ['presign', 'put', 'register'] as const) {
      const { deps } = harness({ throwOn: step });
      const result = await uploadDocument(deps, {
        pid: PID, file: FILE, access: 'all_staff', folderId: null,
      });
      assert.equal(result.ok, false, step);
      assert.equal(result.ok === false && result.reason, 'threw', step);
    }
  });

  test('a filename with no extension, or only an extension, still gets a title', () => {
    assert.equal(titleFromFilename('Vendor list.xlsx'), 'Vendor list');
    assert.equal(titleFromFilename('README'), 'README');
    assert.equal(titleFromFilename('.env'), '.env'); // strips to '' → falls back
    assert.equal(titleFromFilename('a.b.c.pdf'), 'a.b.c');
  });
});

// ═══════════════════ 2. who can see what (the reconciliation) ══════════════

describe('who reaches which half', () => {
  test('everybody signed in can read what the hotel has told Staxis', () => {
    // This is the whole point of the port. In Communications the directory was
    // readable by every signed-in person; moving it onto a manager-gated
    // screen would have taken the emergency numbers off the front desk.
    for (const role of [...MANAGERS, ...LINE_STAFF]) {
      assert.equal(canReadTold(role), true, role);
    }
  });

  test('nobody signed out reads anything', () => {
    assert.equal(canReadTold(null), false);
    assert.equal(canReadTold(undefined), false);
    assert.equal(canReadLearned(null), false);
    assert.equal(canEditTold(null), false);
  });

  test('what Staxis inferred stays a manager view', () => {
    for (const role of MANAGERS) assert.equal(canReadLearned(role), true, role);
    for (const role of LINE_STAFF) assert.equal(canReadLearned(role), false, role);
  });

  test('only managers get the add/edit/delete buttons', () => {
    for (const role of MANAGERS) assert.equal(canEditTold(role), true, role);
    for (const role of LINE_STAFF) assert.equal(canEditTold(role), false, role);
  });

});

// ═══════════════════ 3. reaching an emergency number fast ══════════════════

describe('an emergency number under pressure', () => {
  test('emergency sorts above every other kind of contact', () => {
    // The regression this locks down: the old pane rendered in declaration
    // order — vendor, emergency, brand, local — so the fire department sat
    // underneath the linen supplier.
    assert.equal(CONTACT_GROUP_ORDER[0], 'emergency');

    const groups = groupContacts([
      contact({ id: 'v', name: 'ABC Linen', category: 'vendor' }),
      contact({ id: 'e', name: 'Fire dept', category: 'emergency', phone: '911' }),
      contact({ id: 'b', name: 'Brand rep', category: 'brand' }),
    ]);
    assert.equal(groups[0].key, 'emergency');
    assert.equal(groups[0].urgent, true);
    assert.equal(groups.some((g) => g.key !== 'emergency' && g.urgent), false);
  });

  test('every contact category has a bucket to land in', () => {
    // groupContacts matches on this list, so a category missing from it makes
    // those contacts vanish from the directory with no error anywhere.
    for (const cat of CONTACT_CATEGORIES) {
      assert.ok(CONTACT_GROUP_ORDER.includes(cat), `${cat} has no group`);
      const groups = groupContacts([contact({ id: 'x', name: 'Somebody', category: cat })]);
      assert.equal(groups.length, 1, cat);
      assert.equal(groups[0].rows.length, 1, cat);
    }
    assert.ok(CONTACT_GROUP_ORDER.includes('other'));
  });

  test('a formatted number still produces a dialable href', () => {
    // The old card interpolated the stored string straight into tel:, so a
    // number saved the way a human types it carried spaces and brackets.
    assert.equal(telHref('(409) 555-1234'), 'tel:4095551234');
    assert.equal(telHref('+1 409 555 1234'), 'tel:+14095551234');
    assert.equal(telHref('409.555.1234'), 'tel:4095551234');
    assert.equal(telHref('911'), 'tel:911');
    assert.equal(telHref(null), null);
    assert.equal(telHref('   '), null);
  });

  test('an address becomes directions and an email becomes a compose link', () => {
    assert.equal(
      mapHref('1200 Main St', 'Beaumont, TX 77701'),
      'https://maps.google.com/?q=1200%20Main%20St%2C%20Beaumont%2C%20TX%2077701',
    );
    assert.equal(mapHref(null, null), null);
    assert.equal(mailtoHref('rep@example.com'), 'mailto:rep@example.com');
    assert.equal(mailtoHref(''), null);
  });
});

// ═══════════════════ 4. the local directory's 14 buckets ═══════════════════

describe('the local directory keeps its shape', () => {
  test('local contacts sub-group by type, in the published order', () => {
    const groups = groupContacts([
      contact({ id: '1', name: 'CVS', category: 'local', localCategory: 'Pharmacy' }),
      contact({ id: '2', name: 'Baptist', category: 'local', localCategory: 'Hospitals/Clinics' }),
      contact({ id: '3', name: 'Kroger', category: 'local', localCategory: 'Grocery Store' }),
    ]);
    const local = groups.find((g) => g.key === 'local');
    assert.ok(local?.subGroups);
    // LOCAL_CATEGORIES order: Grocery Store, then Hospitals/Clinics, then Pharmacy.
    assert.deepEqual(local.subGroups.map((s) => s.key), ['Grocery Store', 'Hospitals/Clinics', 'Pharmacy']);
  });

  test('all fourteen buckets are still addressable', () => {
    assert.equal(LOCAL_CATEGORIES.length, 14);
    const rows = LOCAL_CATEGORIES.map((lc, i) =>
      contact({ id: `l${i}`, name: lc, category: 'local', localCategory: lc }),
    );
    assert.equal(localSubGroups(rows).length, 14);
  });

  test('a local contact with no type, or an unknown one, lands in Other local', () => {
    const subs = localSubGroups([
      contact({ id: 'a', name: 'No type', category: 'local', localCategory: null }),
      contact({ id: 'b', name: 'Retired type', category: 'local', localCategory: 'Nightclub' }),
    ]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].key, '__other');
    assert.equal(subs[0].rows.length, 2, 'an unrecognised type must not vanish');
  });

  test('an uncategorised contact is shown, not dropped', () => {
    const groups = groupContacts([contact({ id: 'x', name: 'Somebody', category: null })]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'other');
  });

  test('empty buckets do not render as headings over nothing', () => {
    assert.deepEqual(groupContacts([]), []);
  });
});

// ═══════════════════ 5. per-document access round-trips ════════════════════

describe('who can see a document survives a save', () => {
  test('every choice in the picker round-trips through the two stored columns', () => {
    for (const opt of ACCESS_OPTIONS) {
      const stored = accessToPayload(opt.value);
      const back = docAccessVal({ visibility: stored.visibility, visibleDept: stored.visibleDept });
      assert.equal(back, opt.value, `${opt.value} did not survive the round trip`);
    }
  });

  test('the picker offers everyone, each department, and managers only', () => {
    assert.deepEqual(
      ACCESS_OPTIONS.map((o) => o.value),
      ['all_staff', 'front_desk', 'housekeeping', 'maintenance', 'managers'] satisfies AccessVal[],
    );
  });

  test('a dept row that lost its department reads as everyone, not as a crash', () => {
    assert.equal(docAccessVal({ visibility: 'dept', visibleDept: null }), 'all_staff');
  });
});

// ═══════════════════ 6. the extraction badge ═══════════════════════════════

describe('whether Staxis could actually read the file', () => {
  test('a scan that failed says so, and says it as a warning', () => {
    // If this badge disappears, a manager has NO other way to learn that a
    // scanned PDF never became text. The copilot just answers worse.
    const failed = extractionBadge('failed');
    assert.ok(failed);
    assert.equal(failed.tone, 'warn');
    assert.match(failed.label.en, /read/i);
  });

  test('each of the six states says something different', () => {
    const states = ['ready', 'partial', 'pending', 'processing', 'failed', 'unsupported'] as const;
    const seen = new Set<string>();
    for (const s of states) {
      const b = extractionBadge(s);
      assert.ok(b, s);
      seen.add(b.label.en);
    }
    assert.equal(seen.size, states.length, 'two states collapsed into one sentence');
  });

  test('only a searchable document reads as good news', () => {
    const tone = (s: KnowledgeDocumentDTO['extractionStatus']) => {
      const b = extractionBadge(s);
      assert.ok(b, s);
      return b.tone;
    };
    // "Not text-searchable" is the honest muted state, NOT a green tick: the
    // file is stored but the copilot cannot read a word of it.
    assert.equal(tone('ready'), 'good');
    assert.equal(tone('partial'), 'good');
    assert.equal(tone('unsupported'), 'muted');
    assert.equal(tone('pending'), 'muted');
  });

  test('a folder holding one file does not say "1 files"', () => {
    assert.equal(fileCountLabel(1).en, '1 file');
    assert.equal(fileCountLabel(0).en, '0 files');
    assert.equal(fileCountLabel(4).en, '4 files');
  });

  test('the list keeps refreshing only while something is still being read', () => {
    assert.equal(anyExtractionInFlight([doc('pending')]), true);
    assert.equal(anyExtractionInFlight([doc('processing')]), true);
    assert.equal(anyExtractionInFlight([doc('ready'), doc('processing')]), true);
    assert.equal(anyExtractionInFlight([doc('ready'), doc('failed')]), false);
    assert.equal(anyExtractionInFlight([]), false);
  });
});

// ─── fixtures ───────────────────────────────────────────────────────────────

function contact(over: Partial<KnowledgeContactDTO> & { id: string; name: string }): KnowledgeContactDTO {
  return {
    company: null, phone: null, email: null, notes: null, category: null,
    address: null, cityStateZip: null, hours: null, localCategory: null,
    createdByName: null, createdAt: '2026-07-27T00:00:00Z',
    ...over,
  };
}

function doc(status: KnowledgeDocumentDTO['extractionStatus']): Pick<KnowledgeDocumentDTO, 'extractionStatus'> {
  return { extractionStatus: status };
}
