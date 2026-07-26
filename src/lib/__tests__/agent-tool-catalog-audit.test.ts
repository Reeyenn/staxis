/**
 * The standing audit on the tool catalog itself.
 *
 * The 2026-07-27 rebuild tore the catalog down and rewrote every description
 * because it had accumulated: overlapping tools, one-line descriptions that
 * said what a tool was called rather than when to reach for it, and dead stubs
 * that answered "not yet integrated" to a manager's real question. A catalog in
 * that state makes every model that reads it worse, and it got there one
 * harmless-looking addition at a time.
 *
 * So the bar is a TEST, not a convention. Everything below is a rule the
 * rebuild established, asserted so that the next addition either meets it or
 * turns the suite red:
 *
 *   1. no two tools claim the same wire-name (the registry is a Map — a
 *      collision is SILENT, and the loser simply stops existing)
 *   2. every retired name still resolves, resolves to a real tool, and grants
 *      nothing its target does not already carry
 *   3. `listAllTools()` returns live tools only, so the tenant-isolation sweep
 *      walks the true catalog rather than a doubled one
 *   4. every description carries the four things a model needs to route
 *      correctly: what it does, WHEN to use it, its arguments, what it returns,
 *      and what it refuses
 *   5. every argument the schema declares is described, and every REQUIRED one
 *      is named in the prose
 *   6. every tool a description points the model at actually exists
 *
 * (4)-(6) read `description`, which is normally the sort of source-string
 * assertion this repo forbids. It is justified here for the reason the ban
 * exists: the ban is on tests that grep source for prose to prove BEHAVIOUR.
 * Here the description IS the behaviour — it is the entire interface the model
 * routes on, and there is no other observable to assert against. The checks are
 * also structural (does a section exist, does a named tool resolve), never a
 * copy of any particular sentence, so a rewrite that keeps the contract passes.
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

import {
  listAllTools,
  getTool,
  resolveToolName,
  isMutationTool,
  approvalTierFor,
  TOOL_ALIASES,
  type ToolDefinition,
} from '@/lib/agent/tools';
import '@/lib/agent/tools/index'; // register everything

const TOOLS_DIR = join(process.cwd(), 'src/lib/agent/tools');

/** Every tool answering for ONE hotel — the catalog this audit governs. */
function perHotelTools(): ToolDefinition[] {
  return listAllTools().filter((t) => !(t.surfaces ?? ['chat']).includes('portfolio'));
}

function portfolioTools(): ToolDefinition[] {
  return listAllTools().filter((t) => (t.surfaces ?? ['chat']).includes('portfolio'));
}

function argNames(tool: ToolDefinition): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {});
}

function requiredArgNames(tool: ToolDefinition): string[] {
  const schema = tool.inputSchema as { required?: string[] } | undefined;
  return schema?.required ?? [];
}

// ─── 1. Wire-name uniqueness ────────────────────────────────────────────────

describe('tool catalog — wire-names are unique', () => {
  /**
   * `registry` is a Map keyed by name, so registering two tools under one name
   * does not throw — the second silently REPLACES the first, and a tool the
   * model was told about stops existing with no error anywhere. The only place
   * the collision is visible is the source, so that is where it is counted.
   */
  it('no two registerTool calls claim the same name', () => {
    const seen = new Map<string, string[]>();
    for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      for (const chunk of src.split(/registerTool</).slice(1)) {
        const name = /\bname: '([a-z_]+)'/.exec(chunk)?.[1];
        if (!name) continue;
        seen.set(name, [...(seen.get(name) ?? []), file]);
      }
    }
    const duplicated = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} registered in ${files.join(' and ')}`);
    assert.deepEqual(duplicated, []);

    // And the source and the registry agree — a name declared in source that
    // never reaches the registry means a module is not imported by index.ts.
    const registered = new Set(listAllTools().map((t) => t.name));
    const declaredButUnregistered = [...seen.keys()].filter((n) => !registered.has(n));
    assert.deepEqual(
      declaredButUnregistered,
      [],
      'declared in a tool file but absent from the registry — is the module imported by tools/index.ts?',
    );
    assert.equal(seen.size, registered.size);
  });
});

// ─── 2. Retired names ───────────────────────────────────────────────────────

describe('tool catalog — retired names', () => {
  it('every alias points at a tool that exists', () => {
    const broken = [...TOOL_ALIASES.entries()]
      .filter(([, target]) => !listAllTools().some((t) => t.name === target))
      .map(([from, to]) => `${from} → ${to} (target is not registered)`);
    assert.deepEqual(broken, []);
  });

  it('no alias shadows a live tool', () => {
    // An alias whose KEY is also a registered name would be dead code that
    // reads as if it redirected — `getTool` resolves the alias first, so the
    // live tool of that name would become unreachable.
    const live = new Set(listAllTools().map((t) => t.name));
    const shadowing = [...TOOL_ALIASES.keys()].filter((k) => live.has(k));
    assert.deepEqual(shadowing, []);
  });

  it('aliases never chain', () => {
    // A → B → C would resolve to B and stop, so C never runs. One hop, always.
    const chained = [...TOOL_ALIASES.entries()]
      .filter(([, target]) => TOOL_ALIASES.has(target))
      .map(([from, to]) => `${from} → ${to}, which is itself an alias`);
    assert.deepEqual(chained, []);
    for (const from of TOOL_ALIASES.keys()) {
      assert.equal(resolveToolName(resolveToolName(from)), resolveToolName(from));
    }
  });

  it('an alias grants nothing its target does not already carry', () => {
    // The whole safety argument for keeping retired names callable is that they
    // are a NAME redirect and nothing else: role, surface, section, capability
    // and approval all come from the surviving tool's own declarations.
    for (const [from, to] of TOOL_ALIASES) {
      const target = listAllTools().find((t) => t.name === to);
      assert.ok(target, `${to} missing`);
      assert.equal(getTool(from)?.name, to);
      assert.equal(isMutationTool(from), target!.mutates === true);
      assert.equal(approvalTierFor(from), target!.approval ?? null);
    }
  });

  it('listAllTools() returns live tools only, never an alias', () => {
    // The tenant-isolation sweep walks this. An alias in here would be walked
    // twice under two names and would inflate every catalog count.
    const names = listAllTools().map((t) => t.name);
    const leaked = names.filter((n) => TOOL_ALIASES.has(n));
    assert.deepEqual(leaked, []);
    assert.equal(new Set(names).size, names.length, 'listAllTools() returned a duplicate');
  });
});

// ─── 3. Description quality ─────────────────────────────────────────────────

/**
 * The portfolio catalog is exempt, and the exemption is asserted to be EXACTLY
 * the portfolio-surface set below — so a per-hotel tool cannot escape the bar
 * by being listed here. Those tools are owned by the cross-hotel workstream and
 * were written to a different (older) shape; folding them in is that
 * workstream's call, not a silent edit from this one.
 */
const DESCRIPTION_AUDIT_EXEMPT = new Set([
  'list_my_hotels',
  'portfolio_open_items',
  'portfolio_work_orders',
  'portfolio_supply_spend',
  'portfolio_inventory_health',
  'portfolio_compare',
  'company_rulebook',
]);

describe('tool catalog — description quality', () => {
  it('the exemption list is exactly the portfolio catalog', () => {
    assert.deepEqual(
      [...DESCRIPTION_AUDIT_EXEMPT].sort(),
      portfolioTools().map((t) => t.name).sort(),
    );
  });

  it('the audit governs a real catalog (it is not vacuously passing)', () => {
    assert.ok(perHotelTools().length >= 40, `walked only ${perHotelTools().length} tools`);
  });

  it('every description says WHEN to use the tool, not just what it is called', () => {
    // The single highest-value line for routing. A description that only names
    // the tool leaves the model to guess from the name, which is how two tools
    // that read the same table end up called for the same question.
    const offenders = perHotelTools()
      .filter((t) => !DESCRIPTION_AUDIT_EXEMPT.has(t.name))
      .filter((t) => !/use when:/i.test(t.description))
      .map((t) => t.name);
    assert.deepEqual(offenders, [], 'each of these needs a "Use when:" clause');
  });

  it('every description covers its arguments, its return, and its refusals', () => {
    const offenders: string[] = [];
    for (const tool of perHotelTools()) {
      if (DESCRIPTION_AUDIT_EXEMPT.has(tool.name)) continue;
      const d = tool.description;
      const takesArgs = argNames(tool).length > 0;
      if (takesArgs && !/args:/i.test(d)) offenders.push(`${tool.name} — no "Args:" section`);
      if (!takesArgs && !/takes no arguments/i.test(d)) {
        offenders.push(`${tool.name} — takes no arguments but does not say so`);
      }
      if (!/returns:/i.test(d)) offenders.push(`${tool.name} — no "Returns:" section`);
      // "Refuses:" is where a tool states its limits and the honesty rules the
      // model has to carry into prose (an empty list is not an all-clear; a
      // range is not a quote). It is the section that stops a confident wrong
      // answer, so it is required even when the answer is "Refuses: nothing".
      if (!/refuses:/i.test(d)) offenders.push(`${tool.name} — no "Refuses:" section`);
    }
    assert.deepEqual(offenders, []);
  });

  it('no description is a one-liner', () => {
    const short = perHotelTools()
      .filter((t) => !DESCRIPTION_AUDIT_EXEMPT.has(t.name))
      .filter((t) => t.description.trim().length < 300)
      .map((t) => `${t.name} (${t.description.trim().length} chars)`);
    assert.deepEqual(short, []);
  });

  it('every declared argument is described, and every required one is named in the prose', () => {
    const offenders: string[] = [];
    for (const tool of perHotelTools()) {
      if (DESCRIPTION_AUDIT_EXEMPT.has(tool.name)) continue;
      const schema = tool.inputSchema as
        { properties?: Record<string, { description?: string }> } | undefined;
      for (const [arg, spec] of Object.entries(schema?.properties ?? {})) {
        if (!spec?.description || spec.description.trim().length < 10) {
          offenders.push(`${tool.name}.${arg} — argument has no usable description`);
        }
      }
      // A REQUIRED argument the description never mentions is one the model has
      // to infer exists from the schema alone.
      for (const arg of requiredArgNames(tool)) {
        if (!tool.description.includes(arg)) {
          offenders.push(`${tool.name}.${arg} — required, but never named in the description`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the system prompt does not route the model at a tool it will not be offered', () => {
    // The catalog is only half of what the model routes on; the other half is
    // the role prompt, which names tools directly ("Occupancy? → get_occupancy").
    // A merge that renames a tool and forgets the prompt hands the model a map
    // to a place that no longer exists — it then either invents the call or
    // picks something worse, and nothing anywhere goes red.
    //
    // This reads prompts.ts as source because these are the FAIL-SOFT constants:
    // they are what a fresh seed installs and what runs whenever the prompt
    // table cannot be read, so they are the thing that must never rot. (Rows
    // already sitting in `agent_prompts` are data, not code, and are corrected
    // by re-seeding — see the note in the 2026-07-27 rebuild commit.)
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/prompts.ts'), 'utf8');
    const live = new Set(listAllTools().map((t) => t.name));
    const offenders: string[] = [];
    for (const retired of TOOL_ALIASES.keys()) {
      // Word-boundary match, and skip the survivor's own name where a retired
      // name is a prefix of nothing here — the alias keys are all full names.
      if (new RegExp(`\\b${retired}\\b`).test(src)) {
        offenders.push(`prompts.ts still routes to ${retired} — point it at ${resolveToolName(retired)}`);
      }
    }
    // And the inverse: a prompt naming something that was never a tool at all.
    // Only snake_case tokens are considered — a routing line may legitimately
    // point at prose ("→ use snapshot", "→ check myRooms snapshot") rather than
    // at a tool, and every real wire-name carries an underscore.
    for (const name of new Set(src.match(/→ ([a-z]+(?:_[a-z]+)+)\b/g)?.map((m) => m.slice(2)) ?? [])) {
      if (!live.has(name) && !TOOL_ALIASES.has(name)) {
        offenders.push(`prompts.ts routes to ${name}, which is not a tool`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('every tool a description points at actually exists', () => {
    // Descriptions route the model to siblings ("for one room use
    // query_room_status"). A cross-reference to a tool that has been merged
    // away sends the model at a name it was never offered — and this is the
    // check that makes the catalog un-rottable, because a merge that forgets to
    // update its neighbours' prose fails here.
    const live = new Set(listAllTools().map((t) => t.name));
    const offenders: string[] = [];
    for (const tool of listAllTools()) {
      // Only names that look like OUR tools: snake_case with a known prefix.
      const mentioned = tool.description.match(
        /\b(?:get|list|search|create|log|mark|reset|toggle|flag|request|assign|remove|adjust|send|post|add|stop|cancel|decide|walk|fetch|query|remember|forget|portfolio|staxis|company)_[a-z_]+\b/g,
      ) ?? [];
      for (const name of new Set(mentioned)) {
        if (live.has(name)) continue;
        offenders.push(
          TOOL_ALIASES.has(name)
            ? `${tool.name} points at ${name}, which was retired — point it at ${resolveToolName(name)}`
            : `${tool.name} points at ${name}, which is not a tool`,
        );
      }
    }
    assert.deepEqual(offenders, []);
  });
});
