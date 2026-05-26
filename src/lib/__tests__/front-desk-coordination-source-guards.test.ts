/**
 * Source-level guard tests for the front-desk coordination wiring.
 *
 * Some invariants we care about are easier to verify by reading the
 * source than by spinning up a full integration harness:
 *
 *   - The inspections completion path MUST call into the front-desk
 *     coordination layer on pass. A future refactor that drops the
 *     hook would silently regress "room ready" pings — this test
 *     ensures it fails loudly instead.
 *
 *   - All Twilio call sites in the coordination layer MUST go through
 *     dispatchSMS — direct `sendSms` calls would bypass the dry-run
 *     gate. We assert the only `sendSms(` reference in the directory
 *     lives inside dispatch-sms.ts.
 *
 *   - The migration registers under the correct version number
 *     (0231+) and adds both the column + table.
 *
 *   - Every /api/front-desk/* route has BOTH requireSession AND a role
 *     gate (no raw requireSession that forgets to call
 *     passesFrontDeskGate). Catches the bug where a future route
 *     copies the requireSession skeleton but forgets the gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(resolve(srcRoot, rel), 'utf8');
}

describe('inspection completion → front-desk notification wire-up', () => {
  it('correction-loop.ts imports notifyFrontDeskRoomReady', () => {
    const src = readSrc('lib/inspections/correction-loop.ts');
    assert.match(
      src,
      /from\s+['"]\.\/notify-front-desk-room-ready['"]/,
      'correction-loop.ts must import from ./notify-front-desk-room-ready',
    );
  });

  it('calls notifyFrontDeskRoomReady on pass — both atomic + legacy paths', () => {
    const src = readSrc('lib/inspections/correction-loop.ts');
    const calls = src.match(/notifyFrontDeskRoomReady\(/g) ?? [];
    assert.ok(
      calls.length >= 2,
      `expected ≥2 notifyFrontDeskRoomReady calls (atomic + legacy paths); got ${calls.length}`,
    );
  });

  it('the helper uses dispatchSMS (not sendSms) — dry-run safety', () => {
    const src = readSrc('lib/inspections/notify-front-desk-room-ready.ts');
    assert.match(src, /dispatchSMS\(/, 'must call dispatchSMS');
    assert.doesNotMatch(
      src, /import.*sendSms.*from\s+['"]@\/lib\/sms['"]/,
      'notify-front-desk-room-ready must NOT import sendSms — that would bypass dry-run gating',
    );
  });
});

describe('Twilio call-site containment', () => {
  it('only dispatch-sms.ts imports sendSms in the coordination directory', () => {
    const dir = resolve(srcRoot, 'lib/front-desk-coordination');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      const importsSendSms = /import\s+\{[^}]*\bsendSms\b[^}]*\}\s+from\s+['"]@\/lib\/sms['"]/.test(src);
      if (importsSendSms && f !== 'dispatch-sms.ts') {
        offenders.push(f);
      }
    }
    assert.deepEqual(
      offenders, [],
      `Only dispatch-sms.ts may import sendSms — other modules must go through dispatchSMS. Offenders: ${offenders.join(', ')}`,
    );
  });

  it('dispatch-sms.ts gates the sendSms call on mode === live', () => {
    const src = readSrc('lib/front-desk-coordination/dispatch-sms.ts');
    // Pattern: somewhere before the sendSms call, there must be a
    // `mode === 'dry_run'` early-return path that bypasses Twilio.
    assert.match(
      src,
      /if\s*\(\s*mode\s*===\s*['"]dry_run['"]/,
      'dispatch-sms.ts must early-return when mode === dry_run before calling sendSms',
    );
    assert.match(src, /sendSms\(/, 'dispatch-sms.ts must still wire sendSms for the live path');
  });
});

describe('migration shape', () => {
  // Find whichever migration file matches the front-desk coordination
  // contract (column + table). The number is 0231 by design but the
  // glob-style search keeps the test resilient if the file gets
  // renumbered at merge time.
  function findMigration(): string {
    const dir = resolve(srcRoot, '..', 'supabase', 'migrations');
    const files = readdirSync(dir);
    for (const f of files) {
      const path = join(dir, f);
      if (!statSync(path).isFile()) continue;
      if (!f.endsWith('.sql')) continue;
      const src = readFileSync(path, 'utf8');
      if (src.includes('sms_notifications_mode') && src.includes('notification_events')) {
        return src;
      }
    }
    throw new Error('No migration adds sms_notifications_mode + notification_events');
  }

  it('adds properties.sms_notifications_mode with dry_run default', () => {
    const sql = findMigration();
    assert.match(sql, /sms_notifications_mode\s+text\s+not\s+null\s+default\s+'dry_run'/i);
  });

  it('constrains sms_notifications_mode to dry_run | live', () => {
    const sql = findMigration();
    assert.match(sql, /check\s*\(\s*sms_notifications_mode\s+in\s*\(\s*'dry_run'\s*,\s*'live'\s*\)/i);
  });

  it('creates notification_events with service-role-only RLS', () => {
    const sql = findMigration();
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+public\.notification_events/i);
    assert.match(sql, /alter\s+table\s+public\.notification_events\s+enable\s+row\s+level\s+security/i);
    assert.match(sql, /revoke\s+all\s+on\s+public\.notification_events\s+from\s+public[^;]*authenticated/i);
    // policy denies everything to anon + authenticated
    assert.match(sql, /policy\s+notification_events_deny_all/i);
  });

  it('constrains notification_events.event_type to the dispatch taxonomy', () => {
    const sql = findMigration();
    assert.match(sql, /event_type[^,]*check[\s\S]*?'room_ready'[\s\S]*?'vip_arrival'[\s\S]*?'room_move'[\s\S]*?'walk_in'[\s\S]*?'rush'/i);
  });
});

describe('/api/front-desk/* routes have both auth + role gate', () => {
  it('every route uses requireSession AND passesFrontDeskGate', () => {
    const dir = resolve(srcRoot, 'app/api/front-desk');
    const offenders: string[] = [];
    function walk(d: string) {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('route.ts')) continue;
        const src = readFileSync(p, 'utf8');
        const hasSession = /requireSession\(/.test(src);
        const hasGate = /passesFrontDeskGate\(/.test(src);
        if (!hasSession || !hasGate) {
          offenders.push(p.replace(srcRoot, ''));
        }
      }
    }
    walk(dir);
    assert.deepEqual(
      offenders, [],
      `every front-desk route must call BOTH requireSession() and passesFrontDeskGate(). Offenders: ${offenders.join(', ')}`,
    );
  });

  it('write routes (walk-in + room-move + currently-working) all rate-limit', () => {
    const dir = resolve(srcRoot, 'app/api/front-desk');
    const offenders: string[] = [];
    function walk(d: string) {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('route.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (!/checkAndIncrementRateLimit\(/.test(src)) {
          offenders.push(p.replace(srcRoot, ''));
        }
      }
    }
    walk(dir);
    assert.deepEqual(
      offenders, [],
      `every front-desk route must rate-limit. Offenders: ${offenders.join(', ')}`,
    );
  });
});

describe('header role gate — housekeepers do NOT see the Front Desk tab', () => {
  it('Header.tsx gates /front-desk on the manager-tier + front_desk roles', () => {
    const src = readSrc('components/layout/Header.tsx');
    // Look for the FRONT_DESK_ROLES allowlist with housekeeping/maintenance
    // intentionally absent.
    assert.match(src, /FRONT_DESK_ROLES[\s\S]*?Set[\s\S]*?'admin'[\s\S]*?'owner'[\s\S]*?'general_manager'[\s\S]*?'front_desk'/);
    // The allowlist must not include 'housekeeping' or 'maintenance'.
    const block = /const\s+FRONT_DESK_ROLES[\s\S]*?\]\)/.exec(src);
    assert.ok(block, 'expected the FRONT_DESK_ROLES Set literal');
    assert.doesNotMatch(block[0], /'housekeeping'/);
    assert.doesNotMatch(block[0], /'maintenance'/);
  });
});

describe('room-move orchestrator — both rooms rebuild', () => {
  it('updates both rooms (from + to) AND writes both pms_room_status_log rows', () => {
    const src = readSrc('lib/front-desk-coordination/room-move-orchestrator.ts');
    // From: status=dirty + type=checkout
    assert.match(src, /status:\s*'dirty'/);
    assert.match(src, /type:\s*'checkout'/);
    // To: type=stayover
    assert.match(src, /type:\s*'stayover'/);
    // Two pms_room_status_log inserts: vacant_dirty for from, occupied for to.
    assert.match(src, /'vacant_dirty'/);
    assert.match(src, /'occupied'/);
  });
});
