/**
 * Completeness of the `pmsFreshness` declaration.
 *
 * The dispatcher stamps the data age for every tool flagged `'stamped'`, so
 * the only way a PMS-backed answer can reach a manager with no as-of time is
 * for its tool to be missing the flag entirely. Two gates:
 *
 *   1. an explicit list of the tools known to read PMS data — every one must
 *      be registered and must carry a value;
 *   2. a source-scan backstop for the tools NOBODY remembered to add to that
 *      list: any tool file that reads a `pms_*` table — directly via
 *      `.from('pms_…')` or indirectly via mergePmsRoomsForDate /
 *      fetchTodayPropertyCounts, which is how 7 of them do it — must declare
 *      the flag on every read-only tool it registers.
 *
 * (2) is a source-string assertion, which this repo normally forbids. It is
 * justified here because which TABLE a tool touches is not observable at
 * runtime without a live database, and because the assertion is structural —
 * it looks for the presence of a field, not for a copy of any prose. It also
 * deliberately reads `mutates` from the live registry rather than the source,
 * so a mutation tool in the same file is skipped without a second regex.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listAllTools, getTool } from '@/lib/agent/tools';
import '@/lib/agent/tools/index'; // register everything

/**
 * Every tool whose answer describes PMS-sourced data. The four money/booking
 * feeds read their tables directly; the rest reach the same data through
 * mergePmsRoomsForDate or the today_property_counts_v1 RPC.
 */
const PMS_BACKED_TOOL_NAMES = [
  // pms-feeds.ts — direct reads
  'get_outstanding_balances',
  'get_payments_summary',
  'get_future_bookings',
  'get_lost_reservations',   // absorbed get_recent_no_shows + get_recent_cancellations
  // queries.ts — indirect readers (merge / counts RPC)
  'get_hotel_state',
  'get_today_summary',       // absorbed get_occupancy (reports.ts, deleted)
  'query_room_status',
  'get_my_rooms',            // absorbed list_my_rooms + get_my_next_room
  'get_deep_clean_queue',
  // management.ts — indirect readers
  'get_room_assignments',    // renamed from generate_schedule
  'get_pms_status',
] as const;

/**
 * The names the 2026-07-27 catalog rebuild retired. Every one described PMS
 * data, so every one must still resolve to a tool that declares the flag —
 * otherwise a replayed history row or a pinned eval case would run a PMS answer
 * with the as-of stamp silently stripped off, which is the exact failure this
 * whole file exists to prevent.
 */
const RETIRED_PMS_TOOL_NAMES = [
  'get_recent_no_shows',
  'get_recent_cancellations',
  'get_occupancy',
  'list_my_rooms',
  'get_my_next_room',
  'generate_schedule',
] as const;

const TOOLS_DIR = join(process.cwd(), 'src/lib/agent/tools');

/** A file reads PMS data if it queries a pms_ table or calls either of the
 *  two shared bridges that do. */
const PMS_READ_MARKERS = /\.from\('pms_|mergePmsRoomsForDate|fetchTodayPropertyCounts/;

describe('pmsFreshness completeness', () => {
  it('every known PMS-backed tool is registered and declares a scope', () => {
    const missing: string[] = [];
    for (const name of PMS_BACKED_TOOL_NAMES) {
      const tool = getTool(name);
      if (!tool) {
        missing.push(`${name} — not registered`);
        continue;
      }
      if (!tool.pmsFreshness) missing.push(`${name} — no pmsFreshness declared`);
    }
    assert.deepEqual(missing, []);
  });

  it('every retired PMS name still resolves to a tool that declares a scope', () => {
    const broken: string[] = [];
    for (const name of RETIRED_PMS_TOOL_NAMES) {
      const tool = getTool(name);
      if (!tool) {
        broken.push(`${name} — the alias no longer resolves`);
        continue;
      }
      if (!tool.pmsFreshness) broken.push(`${name} → ${tool.name} — no pmsFreshness declared`);
    }
    assert.deepEqual(broken, []);
  });

  it('the direct PMS feed readers are stamped, not declared independent', () => {
    // These ARE the money/booking/room feeds — declaring one 'independent'
    // would silently strip the as-of time off a balance or a booking answer.
    for (const name of [
      'get_outstanding_balances',
      'get_payments_summary',
      'get_future_bookings',
      'get_lost_reservations',
      'get_today_summary',
      'get_hotel_state',
      'query_room_status',
    ]) {
      assert.equal(getTool(name)?.pmsFreshness, 'stamped', `${name} must be stamped`);
    }
  });

  it('no mutation tool declares a data age', () => {
    // A proposal card has no "as of" — the action hasn't happened yet.
    const offenders = listAllTools()
      .filter((t) => t.mutates === true && t.pmsFreshness !== undefined)
      .map((t) => t.name);
    assert.deepEqual(offenders, []);
  });

  it('every read-only tool in a PMS-reading file declares the flag', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      if (!PMS_READ_MARKERS.test(src)) continue;

      // Split on registration boundaries: each chunk is one tool definition.
      const chunks = src.split(/registerTool</).slice(1);
      for (const chunk of chunks) {
        const name = /\bname: '([a-z_]+)'/.exec(chunk)?.[1];
        if (!name) {
          offenders.push(`${file} — a registerTool block has no parseable name`);
          continue;
        }
        // Mutation state comes from the registry, not the source text.
        if (getTool(name)?.mutates === true) continue;
        if (!/\bpmsFreshness:/.test(chunk)) {
          offenders.push(`${file}:${name} — reads PMS data but declares no pmsFreshness`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the backstop actually inspects files (it is not vacuously passing)', () => {
    // If the marker regex ever stops matching (a rename of the shared
    // bridges, say), the loop above would silently check nothing.
    const scanned = readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => PMS_READ_MARKERS.test(readFileSync(join(TOOLS_DIR, f), 'utf8')));
    assert.ok(
      scanned.length >= 4,
      `expected the PMS-reading tool files to be found, scanned: ${scanned.join(', ')}`,
    );
    // reports.ts was one of the four until the 2026-07-27 catalog rebuild
    // deleted it (get_occupancy folded into get_today_summary in queries.ts).
    // _helpers.ts takes its place in the list: it registers no tools, so it adds
    // nothing to the scan above, but it reaches the same PMS bridges — which
    // makes it the honest canary that the marker regex still matches at all.
    for (const expected of ['pms-feeds.ts', 'queries.ts', 'management.ts', '_helpers.ts']) {
      assert.ok(scanned.includes(expected), `${expected} must be scanned`);
    }
  });
});
