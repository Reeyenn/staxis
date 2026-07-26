/**
 * PROOF, against a real Postgres, that the findings layer can get SMALLER and
 * that a question it raises actually closes.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * Three of the four promises here are database-shaped:
 *
 *   • "shown" is once per hotel-DAY — enforced by a column (`last_shown_on`)
 *     and a read-modify-write, not by the route being polite.
 *   • demotion is PER HOTEL — enforced by a unique index on (property_id,
 *     detector_id). A fake would prove the code intends to scope; only a
 *     database proves hotel B's state is untouched.
 *   • an answered question moves the finding it came from — two tables, two
 *     writes, one transaction boundary the app does not control.
 *
 * The real routes, the real runner, the real drip pipeline and the real store
 * run unmodified against the production migrations applied to PGlite, with two
 * seeded hotels. Every hotel-B row is poisoned with `ZZLEAKB`.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET, POST } from '@/app/api/findings/route';
import { registerDetector } from '@/lib/findings/registry';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { rearmDetector } from '@/lib/findings/demotion';
import { answerDripQuestion, getDripQuestion } from '@/lib/agent/drip-questions';
import { findingQuestionTopic } from '@/lib/findings/ask-drip';
import type { Detector, DetectorParams, FindingDraft } from '@/lib/findings/types';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000e1';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── the probe ──────────────────────────────────────────────────────────────
// Starts at `propose`, the top of the ladder, so a demotion has somewhere to
// go. Everything else about it is what a real detector looks like.

let probeDrafts: FindingDraft[] = [];

const probe: Detector<DetectorParams> = {
  declaration: {
    id: 'probe_demote',
    description: 'probe detector for the demotion integration test',
    inputs: ['operational_signals'],
    requires: [{ feed: 'operational_signals', minRecords: 0, because: 'no operational records' }],
    receiptQueryId: 'probe_query',
    defaultDisposition: 'propose',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 10,
    staleAfterDays: 7,
    evalCases: [{ name: 'noop', feeds: { operational_signals: [] }, expectKeys: [] }],
  },
  detect: () => probeDrafts,
};

const ONLY_PROBE = { detectorIds: ['probe_demote'] as const, skipJudge: true };

function draft(magnitude = 4): FindingDraft {
  return {
    key: 'room_214:hvac',
    summary: `room 214 hvac: ${magnitude}`,
    severity: 'attention',
    magnitude,
    evidence: {
      queryId: 'probe_query',
      params: { room: '214' },
      values: { count: magnitude },
      basis: `${magnitude} hvac work orders in 30 days`,
    },
    price: null,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function getReq(propertyId: string): NextRequest {
  return new NextRequest(`https://staxis.test/api/findings?propertyId=${propertyId}`, {
    method: 'GET',
    headers: { authorization: 'Bearer learning-loop-test-token' },
  });
}

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/findings', {
    method: 'POST',
    headers: {
      authorization: 'Bearer learning-loop-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function insertFinding(opts: {
  propertyId: string;
  dedupeKey: string;
  detectorId?: string;
  disposition?: string;
  judgedDisposition?: string | null;
  judgedEn?: string | null;
  judgedEs?: string | null;
  summary?: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, judged_disposition,
        judged_summary_en, judged_summary_es)
     values ($1,$2,$3,$4,'attention',$5,'open','probe_receipt',
             '{"queryId":"probe_receipt","params":{},"values":{},"basis":"basis"}'::jsonb,
             4,$6,$7,$8)
     returning id`,
    [
      opts.propertyId,
      opts.detectorId ?? 'probe_demote',
      opts.dedupeKey,
      opts.summary ?? 'room 214 hvac: 4',
      opts.disposition ?? 'recommend',
      opts.judgedDisposition ?? null,
      opts.judgedEn ?? null,
      opts.judgedEs ?? null,
    ],
  );
  return r.rows[0].id;
}

async function counters(id: string) {
  const r = await pg.query<{
    shown_count: number; acted_count: number; ignored_count: number;
    last_shown_on: string | null; status: string;
  }>(
    `select shown_count, acted_count, ignored_count, last_shown_on, status
       from public.findings where id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function state(propertyId: string, detectorId = 'probe_demote') {
  const r = await pg.query<{
    steps_down: number; dormant: boolean; baseline_shown: number;
    baseline_acted: number; baseline_at: string; transitions: unknown;
  }>(
    `select steps_down, dormant, baseline_shown, baseline_acted, baseline_at, transitions
       from public.finding_detector_state
      where property_id = $1 and detector_id = $2`,
    [propertyId, detectorId],
  );
  return r.rows[0] ?? null;
}

/** Put engagement on the ledger directly: N distinct shows, M engagements. */
async function seedEngagement(propertyId: string, shown: number, acted: number): Promise<void> {
  await pg.query(
    `update public.findings
        set shown_count = $2, acted_count = $3,
            ignored_count = case when $3 = 0 then $2 else 0 end
      where property_id = $1 and detector_id = 'probe_demote'`,
    [propertyId, shown, acted],
  );
}

/** Age the state row's baseline so the "three weeks" rule can be satisfied. */
async function ageBaseline(propertyId: string, days: number): Promise<void> {
  await pg.query(
    `update public.finding_detector_state
        set baseline_at = now() - ($2 || ' days')::interval
      where property_id = $1 and detector_id = 'probe_demote'`,
    [propertyId, String(days)],
  );
}

async function latestRunRow(propertyId: string) {
  const r = await pg.query<{ detectors_checked: number; detectors_dormant: number }>(
    `select detectors_checked, detectors_dormant from public.finding_runs
      where property_id = $1 order by run_at desc limit 1`,
    [propertyId],
  );
  return r.rows[0] ?? null;
}

describe('the findings learning loop, against a real database', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    // @ts-expect-error minimal auth stub
    supabaseAdmin.auth.getUser = async () => ({
      data: { user: { id: GM_A_UID, email: 'gm.a@loop.test' } },
      error: null,
    });

    await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [
      GM_A_UID,
      'gm.a@loop.test',
    ]);
    await pg.query(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('loop.gm.a','Maria (GM)','general_manager',array[$1::uuid,$2::uuid],$3,'x')`,
      [PID_A, PID_B, GM_A_UID],
    );

    registerDetector(probe);
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.query('delete from public.findings');
    await pg.query('delete from public.finding_runs');
    await pg.query('delete from public.finding_detector_state');
    await pg.query('delete from public.agent_knowledge_questions');
    probeDrafts = [];
    shim.reset();
  });

  test('0362 applied — without it every test below would prove nothing', () => {
    assert.ok(catalog.tables.has('finding_detector_state'), 'finding_detector_state missing');
    assert.ok(catalog.tables.has('finding_sweep_runs'), 'finding_sweep_runs missing');
    assert.ok(
      catalog.tables.get('findings')?.byName.has('last_shown_on'),
      'findings.last_shown_on missing — the shown counter would count page loads',
    );
    assert.ok(
      catalog.tables.get('finding_runs')?.byName.has('detectors_dormant'),
      'finding_runs.detectors_dormant missing — resting would look like starved',
    );
    assert.ok(
      catalog.tables.get('agent_knowledge_questions')?.byName.has('finding_id'),
      'agent_knowledge_questions.finding_id missing — an answer could not resolve a finding',
    );
  });

  // ── engagement ───────────────────────────────────────────────────────────

  describe('what "shown", "acted" and "ignored" actually count', () => {
    test('opening the queue counts a show once, however many times it is refreshed', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:a' });

      await GET(getReq(PID_A));
      const first = await counters(id);
      assert.equal(first?.shown_count, 1);
      assert.equal(first?.ignored_count, 1, 'shown with nothing ever done about it');
      assert.ok(first?.last_shown_on, 'the hotel-day must be recorded, or the guard cannot work');

      await GET(getReq(PID_A));
      await GET(getReq(PID_A));
      const after = await counters(id);
      assert.equal(after?.shown_count, 1, 'a refresh is not a second reading');
      assert.equal(after?.ignored_count, 1);
    });

    test('a new hotel-day counts again', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:a' });
      await GET(getReq(PID_A));
      await pg.query(
        `update public.findings set last_shown_on = current_date - 1 where id = $1`, [id],
      );
      await GET(getReq(PID_A));
      assert.equal((await counters(id))?.shown_count, 2);
    });

    test('opening the numbers counts as engagement and changes nothing else', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:a' });

      const res = await POST(postReq({ propertyId: PID_A, findingId: id, action: 'receipt_opened' }));
      assert.equal(res.status, 200);

      const row = await counters(id);
      assert.equal(row?.acted_count, 1, 'a manager reading the receipt IS engagement');
      assert.equal(row?.status, 'open', 'and it is not a verdict — the card does not move');
    });

    test('a card engaged with is never counted as ignored again', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:a' });
      await POST(postReq({ propertyId: PID_A, findingId: id, action: 'receipt_opened' }));
      await GET(getReq(PID_A));
      const row = await counters(id);
      assert.equal(row?.shown_count, 1);
      assert.equal(row?.ignored_count, 0, 'they already told us it was worth reading');
    });

    test('every verdict counts as engagement — including "not doing this"', async () => {
      // REVERSED ON PURPOSE. `muted` used to be excluded here, on the theory
      // that counting a rejection as approval would keep a detector loud that
      // the manager plainly dislikes. That had the failure mode backwards:
      // these counters answer "does anybody at this hotel READ this check", and
      // a manager who read the card and decided against it read the card.
      // Excluding mute made a deliberate decision indistinguishable from a
      // scroll-past, which is the single thing this arithmetic exists to tell
      // apart. Silence is now the only ambiguous signal, which is what silence
      // means.
      const known = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:k' });
      const fixed = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:f' });
      const muted = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:m' });

      await POST(postReq({ propertyId: PID_A, findingId: known, action: 'known_problem' }));
      await POST(postReq({ propertyId: PID_A, findingId: fixed, action: 'resolved' }));
      await POST(postReq({ propertyId: PID_A, findingId: muted, action: 'muted' }));

      assert.equal((await counters(known))?.acted_count, 1);
      assert.equal((await counters(fixed))?.acted_count, 1);
      assert.equal(
        (await counters(muted))?.acted_count,
        1,
        'a manager who said "not doing this" was read as a manager who never looked',
      );
    });

    test('another hotel\'s finding cannot be engaged with through this route', async () => {
      const bId = await insertFinding({ propertyId: PID_B, dedupeKey: 'probe_demote:b' });
      const res = await POST(postReq({ propertyId: PID_A, findingId: bId, action: 'receipt_opened' }));
      assert.equal(res.status, 404, 'the hotel filter has to hold on the engagement path too');
      assert.equal((await counters(bId))?.acted_count, 0);
    });
  });

  // ── demotion ─────────────────────────────────────────────────────────────

  describe('a check this hotel ignores steps down, and only at this hotel', () => {
    test('the first run opens state with TODAY\'s totals as the baseline', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      await seedEngagement(PID_A, 40, 0);

      probeDrafts = [draft()];
      const summary = await runFindingsForProperty(PID_A, ONLY_PROBE);

      const s = await state(PID_A);
      assert.ok(s, 'a state row must exist after the first pass');
      assert.equal(s?.steps_down, 0, 'nothing is demoted on evidence gathered before we were watching');
      assert.equal(Number(s?.baseline_shown), 40);
      assert.equal(summary.demotions.length, 0);
    });

    test('below the threshold, nothing moves', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      await seedEngagement(PID_A, 9, 0);
      await ageBaseline(PID_A, 40);
      const summary = await runFindingsForProperty(PID_A, ONLY_PROBE);

      assert.equal(summary.demotions.length, 0, 'nine shows is not enough to judge a check on');
      assert.equal((await state(PID_A))?.steps_down, 0);
    });

    test('long enough is not enough if the manager ever engaged', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      await seedEngagement(PID_A, 30, 1);
      await ageBaseline(PID_A, 60);
      const summary = await runFindingsForProperty(PID_A, ONLY_PROBE);

      assert.equal(summary.demotions.length, 0, 'one engagement vetoes the whole case');
    });

    test('shown enough, ignored long enough: one rung, recorded, and the card goes quieter', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      await seedEngagement(PID_A, 10, 0);
      await ageBaseline(PID_A, 21);
      const summary = await runFindingsForProperty(PID_A, ONLY_PROBE);

      assert.equal(summary.demotions.length, 1);
      assert.equal(summary.demotions[0].from, 'propose');
      assert.equal(summary.demotions[0].to, 'recommend');
      assert.ok(summary.demotions[0].reason.length > 0, 'a demotion nobody can explain is a bug');

      const s = await state(PID_A);
      assert.equal(s?.steps_down, 1);
      assert.equal(Number(s?.baseline_shown), 10, 'the evidence that bought this rung is spent');
      assert.equal((s?.transitions as unknown[]).length, 1, 'and the transition is on the record');

      const row = await pg.query<{ disposition: string }>(
        `select disposition from public.findings where property_id = $1 and detector_id = 'probe_demote'`,
        [PID_A],
      );
      assert.equal(
        row.rows[0]?.disposition,
        'recommend',
        'tonight\'s card must already be quieter — not one more loud night first',
      );
    });

    test('a demotion cannot cascade on the same evidence', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      await seedEngagement(PID_A, 10, 0);
      await ageBaseline(PID_A, 21);
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      // Same counters, three more weeks: the ignoring stopped accumulating.
      await ageBaseline(PID_A, 21);
      const second = await runFindingsForProperty(PID_A, ONLY_PROBE);

      assert.equal(second.demotions.length, 0, 'one stretch of being ignored buys exactly one rung');
      assert.equal((await state(PID_A))?.steps_down, 1);
    });

    test('one hotel ignoring a check does not silence it at another', async () => {
      for (const pid of [PID_A, PID_B]) {
        await insertFinding({ propertyId: pid, dedupeKey: 'probe_demote:room_214:hvac' });
        probeDrafts = [draft()];
        await runFindingsForProperty(pid, ONLY_PROBE);
      }

      await seedEngagement(PID_A, 10, 0);
      await ageBaseline(PID_A, 21);
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      assert.equal((await state(PID_A))?.steps_down, 1, 'hotel A demoted it');
      assert.equal((await state(PID_B))?.steps_down, 0, 'hotel B must be untouched');
      assert.equal((await state(PID_B))?.dormant, false);
    });

    test('out of rungs, the check rests — visibly, and apart from "no data"', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      // Three separate stretches of being ignored: propose → recommend → fyi →
      // resting. Each one needs its own ten shows over its own three weeks.
      for (let rung = 1; rung <= 3; rung += 1) {
        await seedEngagement(PID_A, 10 * rung, 0);
        await ageBaseline(PID_A, 21);
        probeDrafts = [draft()];
        await runFindingsForProperty(PID_A, ONLY_PROBE);
      }

      const s = await state(PID_A);
      assert.equal(s?.dormant, true);
      assert.equal(s?.steps_down, 3);

      probeDrafts = [draft(9)];
      const resting = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(resting.detectorsDormant, 1);
      assert.equal(resting.detectorsChecked, 0, 'a resting check does not run at all');
      assert.equal(resting.detectorsSkipped, 0, 'and it is NOT reported as starved of data');
      assert.deepEqual(resting.dormant.map((d) => d.detectorId), ['probe_demote']);
      assert.equal((await latestRunRow(PID_A))?.detectors_dormant, 1, 'and the run row says so');
    });

    test('re-arming puts it back on duty and does not immediately re-rest it', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      for (let rung = 1; rung <= 3; rung += 1) {
        await seedEngagement(PID_A, 10 * rung, 0);
        await ageBaseline(PID_A, 21);
        probeDrafts = [draft()];
        await runFindingsForProperty(PID_A, ONLY_PROBE);
      }
      assert.equal((await state(PID_A))?.dormant, true);

      const rearmed = await rearmDetector(PID_A, 'probe_demote');
      assert.equal(rearmed.changed, true);

      const s = await state(PID_A);
      assert.equal(s?.dormant, false);
      assert.equal(s?.steps_down, 0);
      assert.equal(
        Number(s?.baseline_shown),
        30,
        'the baseline moves to today — otherwise the same thirty ignored shows rest it again',
      );

      probeDrafts = [draft()];
      const summary = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(summary.detectorsDormant, 0);
      assert.equal(summary.detectorsChecked, 1, 'it runs again');
      assert.equal(summary.demotions.length, 0, 'and it is not demoted on the spot');
    });

    test('a hand-kicked run can be told not to touch demotion at all', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe_demote:room_214:hvac' });
      probeDrafts = [draft()];
      await runFindingsForProperty(PID_A, { ...ONLY_PROBE, skipDemotion: true });
      assert.equal(await state(PID_A), null, 'no state is opened, so nothing can be judged by accident');
    });
  });

  // ── ask → the one question surface ───────────────────────────────────────

  describe('a finding the judge turned into a question is asked exactly once', () => {
    async function askFinding(): Promise<string> {
      return insertFinding({
        propertyId: PID_A,
        dedupeKey: 'probe_demote:ask_me',
        summary: 'Supply spend is well above this hotel\'s own normal week.',
        judgedDisposition: 'ask',
        judgedEn: 'Supply spend is well above normal, but the last count is nine days old.',
        judgedEs: 'El gasto en suministros está muy por encima de lo normal.',
      });
    }

    test('it becomes the drip card, recorded against the finding', async () => {
      const id = await askFinding();
      const question = await getDripQuestion(PID_A);

      assert.ok(question, 'an ask finding must reach the one place Staxis asks questions');
      assert.equal(question?.category, 'finding');
      assert.equal(question?.topic, findingQuestionTopic('probe_demote', 'probe_demote:ask_me'));
      assert.ok(question!.en.trim().endsWith('?'), 'a card with Yes/No under a statement is a trap');
      assert.ok(question!.es.trim().endsWith('?'));
      assert.notEqual(question!.es, question!.en, 'the Spanish path must be Spanish');
      assert.ok(question!.topic.length <= 80, 'agent_knowledge_questions.topic CHECK is 80');

      const ledger = await pg.query<{ finding_id: string; ask_count: number; category: string }>(
        `select finding_id, ask_count, category from public.agent_knowledge_questions
          where property_id = $1`,
        [PID_A],
      );
      assert.equal(ledger.rows[0]?.finding_id, id, 'the answer has to know what to resolve');
      assert.equal(ledger.rows[0]?.ask_count, 1);
    });

    test('it does not come back the same day, however many times the screen loads', async () => {
      await askFinding();
      const first = await getDripQuestion(PID_A);
      assert.ok(first);

      assert.equal(await getDripQuestion(PID_A), null, 'ignoring is an answer, and it holds for the day');
      assert.equal(await getDripQuestion(PID_A), null);

      const ledger = await pg.query<{ ask_count: number }>(
        `select ask_count from public.agent_knowledge_questions where property_id = $1`, [PID_A],
      );
      assert.equal(ledger.rows[0]?.ask_count, 1, 'and the ask is not re-counted on every load');
    });

    test('answered "no": the question is never asked again and the finding is resolved', async () => {
      const id = await askFinding();
      const question = await getDripQuestion(PID_A);
      assert.ok(question);

      const answer = await answerDripQuestion({
        propertyId: PID_A,
        topic: question!.topic,
        answer: 'no',
        actor: { accountId: null, name: 'Maria', role: 'general_manager' },
      });
      assert.equal(answer.ok, true);
      assert.equal(answer.recorded, true);
      assert.equal(answer.storedFact ?? false, false, 'a "no" writes no fact');

      assert.equal((await counters(id))?.status, 'resolved', 'the card must not still be asking');

      const ledger = await pg.query<{ status: string }>(
        `select status from public.agent_knowledge_questions where property_id = $1`, [PID_A],
      );
      assert.equal(ledger.rows[0]?.status, 'declined', 'the decline is what makes it never come back');

      // A later day: still nothing, because a decline is permanent.
      await pg.query(
        `update public.agent_knowledge_questions set last_asked_on = current_date - 5
          where property_id = $1`, [PID_A],
      );
      assert.equal(await getDripQuestion(PID_A), null);
    });

    test('answered "yes": the finding becomes a known problem at the size they agreed to', async () => {
      const id = await askFinding();
      const question = await getDripQuestion(PID_A);
      assert.ok(question);

      const answer = await answerDripQuestion({
        propertyId: PID_A,
        topic: question!.topic,
        answer: 'yes',
        actor: { accountId: null, name: 'Maria', role: 'general_manager' },
      });
      assert.equal(answer.ok, true, answer.error ?? '');
      assert.equal(answer.recorded, true);

      const row = await pg.query<{ status: string; silenced_at_magnitude: string | null }>(
        `select status, silenced_at_magnitude from public.findings where id = $1`, [id],
      );
      assert.equal(row.rows[0]?.status, 'known_problem');
      assert.equal(
        Number(row.rows[0]?.silenced_at_magnitude),
        4,
        'consent is to the size they were shown — escalation is measured from there',
      );
    });

    test('a replayed tap changes nothing', async () => {
      const id = await askFinding();
      const question = await getDripQuestion(PID_A);
      assert.ok(question);

      const args = {
        propertyId: PID_A,
        topic: question!.topic,
        answer: 'no' as const,
        actor: { accountId: null, name: 'Maria', role: 'general_manager' },
      };
      await answerDripQuestion(args);
      const replay = await answerDripQuestion(args);

      assert.equal(replay.recorded, false, 'a second tap is not a second answer');
      assert.equal((await counters(id))?.status, 'resolved');
    });

    test('an ask finding at another hotel is never asked about here', async () => {
      await insertFinding({
        propertyId: PID_B,
        dedupeKey: 'probe_demote:ask_me',
        summary: 'ZZLEAKB supply spend is above normal.',
        judgedDisposition: 'ask',
        judgedEn: 'ZZLEAKB spend is above normal.',
        judgedEs: 'ZZLEAKB gasto por encima de lo normal.',
      });

      const question = await getDripQuestion(PID_A);
      if (question) {
        assert.ok(!question.en.includes('ZZLEAKB'), 'hotel B leaked into hotel A\'s question');
        assert.ok(!question.es.includes('ZZLEAKB'));
      }
    });

    test('the card surface still refuses to render ask findings itself', async () => {
      await askFinding();
      const res = await GET(getReq(PID_A));
      const body = (await res.json()) as { data?: { findings: unknown[] } };
      assert.equal(
        body.data?.findings.length,
        0,
        'two question surfaces with different rules is exactly what the adapter avoids',
      );
    });
  });
});
