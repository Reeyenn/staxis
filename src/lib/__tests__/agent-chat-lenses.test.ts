/**
 * WHO LENSES — the mount, enumerated.
 *
 * One chat, one route, one registry. What changes between a GM, a front-desk
 * agent and a maintenance tech is WHICH TOOLS MOUNT and WHAT THE MODEL IS TOLD
 * ITS JOB IS. This suite is the machine-readable version of that table, and it
 * exists because the interesting failure here is silent: a lens that quietly
 * widens, or a prompt that promises a tool the mount does not carry, produces a
 * chat that looks fine and hallucinates on the tenth turn.
 *
 * WHAT EACH BLOCK WOULD CATCH — every mutation below was applied and the suite
 * watched go red, with the failure count in brackets:
 *
 *   MOUNT TABLE      `get_payments_summary` added to the front-desk lens — a
 *                    real widening, since that tool's allowedRoles DO admit the
 *                    desk and only the lens was keeping it out            [5]
 *   DECLARATION      `staxis_findings` added to the front-desk lens. The
 *                    intersection would drop it anyway, so no mount changes —
 *                    which is exactly why the declaration is checked too   [1]
 *   NEVER WIDENS     `get_staff_performance` added to the maintenance lens [1]
 *   EXECUTOR         deleting the lensAllowsTool() gate in executeTool, which
 *                    is what a stale tool list or a replayed old conversation
 *                    walks through                                        [2]
 *   NO CHAT          giving housekeeping `mounted: true` — the standing founder
 *                    rule that Staxis never adds a step to a housekeeper's job
 *                                                                         [1]
 *   PROMPT           reverting buildSystemPrompt to the DB role row, which
 *                    hands a front-desk agent the MANAGER's prompt (what
 *                    prompts-store actually did before this)               [2]
 *   PROMPT/MOUNT     naming `get_payments_summary` in the front-desk prompt —
 *                    the drift that makes a model promise and fail         [1]
 *
 * Cache purity is asserted here but is additionally compiler-enforced: the
 * StableTier / DynamicTier unions in prompts.ts make "put the lens in the
 * per-turn block" a type error, not a runtime one.
 *
 * The money strip and every row-level guarantee are proved in the integration
 * twin, which has a real database to prove them against.
 *
 * On asserting against prompt text: the lens prompt IS the interface — it is
 * the entire job description the model routes on, and there is no other
 * observable. The checks here are structural (does a section exist, does a
 * named tool resolve), never a copy of any particular sentence, so a rewrite
 * that keeps the contract passes. Same justification the catalog audit makes.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import '@/lib/agent/tools/index';
import {
  executeTool,
  getTool,
  getToolsForRole,
  listAllTools,
  type ToolContext,
} from '@/lib/agent/tools';
import {
  CHAT_LENSES,
  chatIsMountedForRole,
  lensAllowsTool,
  lensFor,
  moneyVisibleToRole,
} from '@/lib/agent/lenses';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { seedPromptsCache, invalidatePromptsCache } from '@/lib/agent/prompts-store';
import type { HotelSnapshot } from '@/lib/agent/context';
import { ALL_ROLES, type AppRole } from '@/lib/roles';

const PID = '11111111-1111-4111-8111-111111111111';

function names(role: AppRole): string[] {
  return getToolsForRole(role, 'chat').map((t) => t.name).sort();
}

function ctx(role: AppRole): ToolContext {
  return {
    user: {
      uid: 'u', accountId: '00000000-0000-0000-0000-000000000001',
      username: 'u', displayName: 'U', role, propertyAccess: [PID],
    },
    propertyId: PID,
    staffId: null,
    requestId: 'r',
    surface: 'chat',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE MOUNT TABLE — what each hat can ask, written out
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The front desk's whole chat, by name. Written out rather than derived,
 * because the point of this assertion is that a human decided each line: a
 * derived list would agree with whatever the code happens to do.
 */
const FRONT_DESK_MOUNT = [
  'add_logbook_entry', 'adjust_stock', 'cancel_reminder', 'create_reminder', 'create_todo',
  'fetch_document_section', 'flag_issue', 'forget', 'get_future_bookings', 'get_hotel_state',
  'get_low_stock', 'get_outstanding_balances', 'get_today_summary', 'list_scheduled_items',
  'log_complaint', 'log_found_item', 'mark_room_clean', 'query_room_status', 'remember',
  'request_help', 'reset_room', 'search_knowledge', 'search_lost_found', 'send_message',
  'toggle_dnd',
].sort();

const MAINTENANCE_MOUNT = [
  'add_logbook_entry', 'create_todo', 'fetch_document_section', 'flag_issue', 'forget',
  'get_hotel_state', 'get_my_rooms', 'get_work_order_history', 'log_complaint', 'log_found_item',
  'query_room_status', 'remember', 'request_help', 'search_knowledge', 'search_lost_found',
  'send_message', 'staxis_checked_last_night', 'staxis_equipment', 'staxis_explain_finding',
  'staxis_findings', 'staxis_preventive',
].sort();

describe('the mount table', () => {
  it('the front desk gets exactly this list', () => {
    assert.deepEqual(names('front_desk'), FRONT_DESK_MOUNT);
  });

  it('the maintenance hat gets exactly this list', () => {
    assert.deepEqual(names('maintenance'), MAINTENANCE_MOUNT);
  });

  it('housekeeping mounts nothing — not an empty answer, an empty mount', () => {
    assert.equal(chatIsMountedForRole('housekeeping'), false);
    assert.deepEqual(names('housekeeping'), []);
  });

  it('the manager tier is untouched — a lens can only ever have narrowed', () => {
    // No lens for these hats, so `lensFor` returns null and getToolsForRole
    // behaves exactly as it did before lenses existed. If someone adds a lens
    // for a manager role, this is the test that makes them argue for it.
    for (const role of ['admin', 'owner', 'general_manager', 'staff'] as AppRole[]) {
      assert.equal(lensFor(role, 'chat'), null, `${role} must have no lens`);
      assert.ok(names(role).length > 0, `${role} must keep a catalog`);
    }
  });

  it('every role in the product is either lensed or deliberately not', () => {
    // A new role added to ALL_ROLES silently inherits "no lens" — which is the
    // right default, but it should be a decision someone reads this list to
    // make rather than a thing that happens.
    const lensed = Object.keys(CHAT_LENSES).sort();
    assert.deepEqual(lensed, ['front_desk', 'housekeeping', 'maintenance']);
    for (const role of ALL_ROLES) {
      assert.ok(typeof chatIsMountedForRole(role) === 'boolean', role);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE FOUNDER'S MUST-NOTS, named
// ═══════════════════════════════════════════════════════════════════════════

/** Manager surfaces the front desk must never reach through the chat. */
const MANAGER_SURFACES_FOR_DESK = [
  // findings + what Staxis noticed + anything waiting on a decision
  'staxis_findings', 'staxis_explain_finding', 'staxis_pending_decisions',
  'staxis_preventive', 'staxis_equipment', 'staxis_checked_last_night',
  // money
  'get_finance_summary', 'get_inventory_monthly_accounting', 'get_payments_summary',
  'get_lost_reservations',
  // staffing analytics + the schedule
  'get_staff_performance', 'get_room_assignments', 'get_schedule', 'assign_shift',
  'remove_from_shift', 'get_time_off_requests', 'decide_time_off', 'assign_room',
  // housekeeping planning + hotel-wide broadcast
  'get_deep_clean_queue', 'post_announcement',
  // the company
  'portfolio_open_items', 'portfolio_compare', 'company_rulebook', 'list_my_hotels',
];

/** What the wrench must never reach: money, staffing, company, sign-offs. */
const MANAGER_SURFACES_FOR_WRENCH = [
  'staxis_pending_decisions',
  'get_finance_summary', 'get_inventory_monthly_accounting', 'get_payments_summary',
  'get_outstanding_balances', 'get_future_bookings', 'get_lost_reservations',
  'get_staff_performance', 'get_room_assignments', 'get_schedule', 'assign_shift',
  'remove_from_shift', 'get_time_off_requests', 'decide_time_off', 'assign_room',
  'portfolio_open_items', 'portfolio_compare', 'company_rulebook', 'list_my_hotels',
];

describe('what a lens keeps out', () => {
  it('no manager surface is on the front-desk mount', () => {
    const mounted = new Set(names('front_desk'));
    for (const name of MANAGER_SURFACES_FOR_DESK) {
      assert.equal(mounted.has(name), false, `${name} must not mount for the front desk`);
    }
  });

  it('no money, staffing, company or sign-off surface is on the maintenance mount', () => {
    const mounted = new Set(names('maintenance'));
    for (const name of MANAGER_SURFACES_FOR_WRENCH) {
      assert.equal(mounted.has(name), false, `${name} must not mount for maintenance`);
    }
  });

  it('no lens DECLARES a manager surface, even one it could not grant anyway', () => {
    // The mount assertions above pass whether or not a lens NAMES
    // `staxis_findings` for the front desk, because that tool's own
    // allowedRoles would drop it at the intersection. The wall holds — but the
    // declaration would still be someone's stated intent to hand the desk the
    // findings queue, sitting in the file that reads as the product decision,
    // one `allowedRoles` edit away from being true. So the list itself is
    // checked, not only what survives it.
    const forbidden: Record<string, string[]> = {
      front_desk: MANAGER_SURFACES_FOR_DESK,
      maintenance: MANAGER_SURFACES_FOR_WRENCH,
    };
    for (const [role, names_] of Object.entries(forbidden)) {
      const declared = new Set(CHAT_LENSES[role as AppRole]!.tools);
      for (const name of names_) {
        assert.equal(declared.has(name), false, `the ${role} lens declares ${name}`);
      }
    }
  });

  it('every name on those lists is a real tool — a typo would silently prove nothing', () => {
    for (const name of [...MANAGER_SURFACES_FOR_DESK, ...MANAGER_SURFACES_FOR_WRENCH]) {
      assert.ok(getTool(name), `${name} is not a registered tool (renamed? then fix this list)`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A LENS CAN ONLY EVER NARROW
// ═══════════════════════════════════════════════════════════════════════════

describe('a lens is a keyhole, never a grant', () => {
  it('every tool a lens mounts also passes that tool\'s own allowedRoles', () => {
    for (const [role, lens] of Object.entries(CHAT_LENSES)) {
      if (!lens.mounted) continue;
      for (const name of names(role as AppRole)) {
        const tool = getTool(name);
        assert.ok(tool, `${name} vanished from the registry`);
        assert.ok(
          tool!.allowedRoles.includes(role as AppRole),
          `${role}/${name}: the lens mounted a tool the tool itself refuses`,
        );
      }
    }
  });

  it('a lens naming a tool the role cannot use does NOT mount it', () => {
    // The intersection, proved from the other side. `staxis_pending_decisions`
    // is not on the maintenance lens list AND its allowedRoles exclude
    // maintenance; `get_finance_summary` is excluded by both. Neither may
    // appear no matter which of the two walls is examined.
    for (const name of ['staxis_pending_decisions', 'get_finance_summary']) {
      assert.equal(lensAllowsTool('maintenance', 'chat', name), false);
      assert.equal(getTool(name)!.allowedRoles.includes('maintenance'), false);
      assert.equal(names('maintenance').includes(name), false);
    }
  });

  it('every name in every lens resolves to a registered tool', () => {
    const registered = new Set(listAllTools().map((t) => t.name));
    for (const [role, lens] of Object.entries(CHAT_LENSES)) {
      for (const name of lens.tools) {
        assert.ok(registered.has(name), `${role} lens names "${name}", which is not registered`);
      }
    }
  });

  it('lenses do not touch the voice, walkthrough or portfolio surfaces', () => {
    // The lens narrows the CHAT mount. A lens reaching the portfolio surface
    // would be a category error — that surface answers for a company, not for
    // a hat at one hotel — and the housekeeping voice catalog must survive.
    for (const surface of ['voice', 'walkthrough', 'portfolio'] as const) {
      for (const role of ALL_ROLES) {
        assert.equal(lensFor(role, surface), null, `${role}/${surface}`);
        assert.equal(lensAllowsTool(role, surface, 'anything_at_all'), true);
      }
    }
    assert.ok(getToolsForRole('housekeeping', 'voice', 'general').length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE EXECUTOR'S HALF — the stale-list / replayed-conversation case
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool enforces the lens too', () => {
  it('refuses a tool the lens leaves out, even when allowedRoles permits it', async () => {
    // get_payments_summary lists front_desk in allowedRoles — it did before the
    // lens and still does. The ONLY thing keeping it away from the desk is the
    // lens, on both sides: absent from the catalog, refused by the executor.
    assert.equal(getTool('get_payments_summary')!.allowedRoles.includes('front_desk'), true);
    const res = await executeTool('get_payments_summary', {}, ctx('front_desk'));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /not part of what you can do/i);
  });

  it('refuses everything for a hat with no chat', async () => {
    for (const name of ['search_knowledge', 'get_my_rooms', 'mark_room_clean', 'remember']) {
      const res = await executeTool(name, {}, ctx('housekeeping'));
      assert.equal(res.ok, false, `${name} answered a housekeeper`);
    }
  });

  it('the refusal tells the model to stop, not to find another route', async () => {
    // A refusal that only says "no" invites the model to try the next tool that
    // might get the same number. This one has to close the topic.
    const res = await executeTool('get_payments_summary', {}, ctx('front_desk'));
    assert.match(res.error ?? '', /manager question/i);
    assert.match(res.error ?? '', /do not try to get the same information another way/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE PROMPT — the hat's job description, and its agreement with the mount
// ═══════════════════════════════════════════════════════════════════════════

function snapshot(): HotelSnapshot {
  return {
    today: '2026-07-27',
    property: { id: PID, name: 'Test Hotel', timezone: 'America/Chicago' },
    rooms: {
      total: 80, dirty: 10, in_progress: 0, clean: 70, dnd: 0, issuesFlagged: 0,
      helpRequested: 0, checkouts: 12, stayovers: 30, inHouse: 42, outOfOrder: 0, seedingGap: 0,
    },
    staff: { activeToday: 5, assignedHousekeepers: 3 },
  } as HotelSnapshot;
}

/** Fixture prompt rows, so an assertion can never accidentally read the DB. */
function seedPrompts(): void {
  seedPromptsCache([
    { role: 'base', version: 'test-base-v1', content: 'BASE PROMPT BODY' },
    { role: 'general_manager', version: 'test-gm-v1', content: 'MANAGER PROMPT BODY' },
    { role: 'housekeeping', version: 'test-hk-v1', content: 'HOUSEKEEPER PROMPT BODY' },
    { role: 'owner', version: 'test-owner-v1', content: 'OWNER PROMPT BODY' },
    { role: 'admin', version: 'test-admin-v1', content: 'ADMIN PROMPT BODY' },
  ]);
}

describe('the lens prompt', () => {
  it('replaces the role prompt for a lensed hat, and stamps its own version', async () => {
    seedPrompts();
    const built = await buildSystemPrompt('front_desk', snapshot(), 'conv-1');
    // Before lenses, prompts-store mapped front_desk → the GENERAL_MANAGER row.
    // A front-desk agent was reading the manager's job description, listing
    // tools they could not call. That is the bug this line pins shut.
    assert.equal(built.stable.includes('MANAGER PROMPT BODY'), false);
    assert.ok(built.stable.includes(CHAT_LENSES.front_desk!.prompt));
    assert.match(built.stableStamp, /role:lens-front-desk-v1/);
    assert.match(built.versionLabel, /role:lens-front-desk-v1/);
    invalidatePromptsCache();
  });

  it('maintenance gets the wrench prompt, not the housekeeper one', async () => {
    seedPrompts();
    const built = await buildSystemPrompt('maintenance', snapshot(), 'conv-2');
    assert.equal(built.stable.includes('HOUSEKEEPER PROMPT BODY'), false);
    assert.ok(built.stable.includes(CHAT_LENSES.maintenance!.prompt));
    assert.match(built.stableStamp, /role:lens-maintenance-v1/);
    invalidatePromptsCache();
  });

  it('an unlensed hat still reads its operator-editable DB row', async () => {
    seedPrompts();
    const built = await buildSystemPrompt('general_manager', snapshot(), 'conv-3');
    assert.ok(built.stable.includes('MANAGER PROMPT BODY'));
    assert.match(built.stableStamp, /test-gm-v1/);
    invalidatePromptsCache();
  });

  it('lives in the CACHED half and is byte-identical turn to turn', async () => {
    // A per-turn value in the stable block rewrites the cached prefix on every
    // single turn. Nothing breaks; the input-token bill silently multiplies.
    seedPrompts();
    const a = await buildSystemPrompt('front_desk', snapshot(), 'conv-4');
    const b = await buildSystemPrompt('front_desk', snapshot(), 'conv-4');
    assert.equal(a.stable, b.stable);
    assert.equal(a.stableStamp, b.stableStamp);
    assert.equal(a.dynamic.includes(CHAT_LENSES.front_desk!.prompt), false);
    invalidatePromptsCache();
  });

  it('every tool a lens prompt names is a tool that lens mounts', () => {
    // The drift that makes a model promise and fail. A prompt line saying
    // "→ get_payments_summary" on a mount that does not carry it produces a
    // confident tool call, a refusal, and an apology to a guest at a counter.
    const registered = listAllTools().map((t) => t.name);
    for (const [role, lens] of Object.entries(CHAT_LENSES)) {
      if (!lens.mounted) continue;
      const mounted = new Set(names(role as AppRole));
      for (const name of registered) {
        // Word-boundary match so `get_low_stock` does not also match a longer
        // name that contains it.
        if (!new RegExp(`\\b${name}\\b`).test(lens.prompt)) continue;
        assert.ok(mounted.has(name), `the ${role} prompt names ${name}, which that lens does not mount`);
      }
    }
  });

  it('the front-desk prompt carries a Spanish section written as Spanish', () => {
    // The most Spanish-first surface in the product: a guest at the counter,
    // and an agent who works in Spanish. The rule being pinned is structural —
    // there is a section of the prompt IN Spanish, not an English instruction
    // about Spanish — because a translation pass is what produces the stilted
    // "El desayuno es servido de..." nobody says out loud.
    const p = CHAT_LENSES.front_desk!.prompt;
    assert.match(p, /─── En español ───/);
    const spanishHalf = p.slice(p.indexOf('─── En español ───'));
    assert.ok(spanishHalf.length > 400, 'the Spanish section must be substantive, not a token line');
    // Written in Spanish, not rendered into it: inverted punctuation, Spanish
    // orthography, and the counter's own vocabulary for the escalation path.
    assert.match(spanishHalf, /[¿¡]/);
    assert.match(spanishHalf, /[ñáéíóú]/);
    assert.match(spanishHalf, /gerente/);
    // The honesty rule has to survive the language switch — this is the one
    // sentence a Spanish-speaking agent needs and the one an English-first
    // prompt quietly drops.
    assert.match(spanishHalf, /no lo tengo/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MONEY — the boundary both floor lenses draw
// ═══════════════════════════════════════════════════════════════════════════

describe('money visibility', () => {
  it('is off for both floor hats and on for everyone else', () => {
    assert.equal(moneyVisibleToRole('front_desk'), false);
    assert.equal(moneyVisibleToRole('maintenance'), false);
    for (const role of ['admin', 'owner', 'general_manager', 'staff'] as AppRole[]) {
      assert.equal(moneyVisibleToRole(role), true, role);
    }
  });
});
