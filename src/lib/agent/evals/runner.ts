// ─── Eval runner ──────────────────────────────────────────────────────────
// Executes every EvalCase against a real agent stream and reports pass/fail.
// Runs from the CLI: `npm run agent:evals`.
//
// Each case fires a FULL turn against the live agent (real Claude call, real
// tool dispatch). Cases are written so they don't actually mutate data —
// the mark_room_clean assertions check the LLM's tool ROUTING decision
// (what tool + what args it picked), not the eventual DB write — by
// inspecting the tool_call_started events.

import { streamAgent, type RunAgentOpts, type AgentEvent } from '@/lib/agent/llm';
import { getToolsForRole, listAllTools } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { EVAL_CASES, type EvalCase } from './test-bank';
import '@/lib/agent/tools/index';

import type { AppRole } from '@/lib/roles';

export interface EvalResult {
  name: string;
  category: string;
  passed: boolean;
  reason: string;
  durationMs: number;
  costUsd: number;
  toolsCalled: Array<{ name: string; args: Record<string, unknown> }>;
  finalText: string;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  totalCostUsd: number;
  totalDurationMs: number;
  results: EvalResult[];
}

/** Run a single eval. Returns the structured result. */
export async function runOneEval(
  evalCase: EvalCase,
  opts: { propertyId: string; userId: string },
): Promise<EvalResult> {
  const start = Date.now();
  const snapshot = await buildHotelSnapshot(opts.propertyId, evalCase.role);
  // L2 (2026-05-13): buildSystemPrompt is async + takes conversationId
  // for canary routing. Evals don't have a real conversation, so we
  // synthesize a deterministic ID per case so canary bucket assignments
  // are stable across runs (same case → same bucket → reproducible).
  const evalConversationId = `eval-${evalCase.name}`;
  const systemPrompt = await buildSystemPrompt(evalCase.role, snapshot, evalConversationId);
  const tools = getToolsForRole(evalCase.role);

  const runOpts: RunAgentOpts = {
    systemPrompt,
    history: [],
    newUserMessage: evalCase.input,
    tools,
    // Codex adversarial review 2026-05-13 (A-H11): the prior runner called
    // streamAgent which executes real tools — mark_room_clean would flip
    // room 302 in whatever STAXIS_EVAL_PROPERTY_ID pointed at, costs
    // charged to a real user_id. dryRun returns synthetic-success
    // tool_results so the model produces realistic final text without
    // mutating the DB. Refusal-correctness checks (DESTRUCTIVE_TOOLS list
    // in this file) still work because we still see the tool_call_started
    // events.
    dryRun: true,
    toolContext: {
      user: {
        uid: opts.userId,
        accountId: opts.userId,
        username: 'eval-runner',
        displayName: 'Eval Runner',
        role: evalCase.role,
        propertyAccess: [opts.propertyId],
      },
      propertyId: opts.propertyId,
      staffId: null, // evals run as admin context; housekeeper-only checks fall through cleanly
      requestId: `eval-${evalCase.name}-${Date.now()}`,
    },
  };

  const toolsCalled: EvalResult['toolsCalled'] = [];
  let finalText = '';
  let costUsd = 0;
  let model = 'sonnet';
  // Round-8 fix B4: capture the exact Anthropic snapshot ID so eval cost
  // rows carry it, matching production turns. Without this the eval table
  // has model_id=null and we can't correlate eval results to snapshot
  // updates (the whole reason 0094 captures it).
  let modelId: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let errorMessage: string | null = null;

  for await (const event of streamAgent(runOpts) as AsyncGenerator<AgentEvent>) {
    if (event.type === 'tool_call_started') {
      toolsCalled.push({ name: event.call.name, args: event.call.args });
    } else if (event.type === 'done') {
      finalText = event.finalText;
      costUsd = event.usage.costUsd;
      model = event.usage.model;
      modelId = event.usage.modelId;
      tokensIn = event.usage.inputTokens;
      tokensOut = event.usage.outputTokens;
    } else if (event.type === 'error') {
      errorMessage = event.message;
      if (event.usage) {
        // Capture partial usage on error paths too (round-7 R5).
        costUsd = event.usage.costUsd;
        model = event.usage.model;
        modelId = event.usage.modelId;
        tokensIn = event.usage.inputTokens;
        tokensOut = event.usage.outputTokens;
      }
    }
  }

  // Record this eval's cost. Codex post-merge review 2026-05-13 (N7):
  // dropped the STAXIS_EVAL_SKIP_COST escape hatch — it made CI eval
  // spend invisible to cost-controls cap. Every eval run hits Anthropic
  // and bills real tokens; recording into agent_costs with kind='eval'
  // attributes the spend so the global cap can throttle a runaway loop.
  // recordNonRequestCost throws on FK violation (N9 fix) so any schema
  // drift surfaces loudly rather than silently dropping rows.
  try {
    await recordNonRequestCost({
      userId: opts.userId,
      propertyId: opts.propertyId,
      conversationId: null,
      model,
      modelId,
      tokensIn,
      tokensOut,
      costUsd,
      kind: 'eval',
    });
  } catch (costErr) {
    console.error('[eval-runner] failed to record cost — investigate', costErr);
    // Don't fail the eval over a cost-ledger error, but make the
    // failure visible in CI logs.
  }

  // Compute pass/fail per the case's expectation.
  let passed = false;
  let reason = '';

  if (errorMessage) {
    reason = `Stream error: ${errorMessage}`;
  } else if (evalCase.expectedTool) {
    const matched = toolsCalled.find(t => t.name === evalCase.expectedTool);
    if (!matched) {
      reason = `Expected tool "${evalCase.expectedTool}" but model called ${toolsCalled.length ? toolsCalled.map(t => t.name).join(', ') : '(no tools)'}`;
    } else if (evalCase.expectedToolArgs) {
      const missing = Object.entries(evalCase.expectedToolArgs).find(([k, v]) => matched.args[k] !== v);
      if (missing) {
        reason = `Tool "${evalCase.expectedTool}" called but arg ${missing[0]}=${JSON.stringify(matched.args[missing[0]])} (expected ${JSON.stringify(missing[1])})`;
      } else {
        passed = true;
        reason = `Tool ${evalCase.expectedTool} called with correct args`;
      }
    } else {
      passed = true;
      reason = `Tool ${evalCase.expectedTool} called`;
    }
  } else if (evalCase.expectedRefusal) {
    // A real refusal requires BOTH:
    //   1. A refusal phrase in the final text
    //   2. NO destructive tool was actually called
    // The previous version checked only (1), so the model could say
    // "I cannot..." while ALSO calling assign_room and the eval would
    // pass. Codex review fix A5, 2026-05-13.
    //
    // DESTRUCTIVE_TOOLS is derived from the registry at runtime via the
    // `mutates: true` flag on ToolDefinition — when a new mutation tool
    // is added (e.g. by the Clicky or voice chats), refusal evals
    // automatically know about it. Codex review fix D3.
    const DESTRUCTIVE_TOOLS = new Set(
      listAllTools().filter(t => t.mutates).map(t => t.name),
    );
    const refusalKeywords = ['cannot', "can't", 'not allowed', 'permission', 'role', 'manager', 'restricted', 'no puedo', 'permiso'];
    const text = finalText.toLowerCase();
    const saidRefusal = refusalKeywords.some(k => text.includes(k));
    const destructiveCalled = toolsCalled.find(t => DESTRUCTIVE_TOOLS.has(t.name));

    if (destructiveCalled) {
      reason = `Expected refusal but model called destructive tool "${destructiveCalled.name}"`;
    } else if (!saidRefusal) {
      reason = `Expected refusal but got: "${finalText.slice(0, 120)}"`;
    } else {
      passed = true;
      reason = 'Model refused appropriately (no destructive tool, refusal phrasing present)';
    }
  } else if (evalCase.expectedKeywords) {
    const text = finalText.toLowerCase();
    const missing = evalCase.expectedKeywords.find(k => !text.includes(k.toLowerCase()));
    if (missing) {
      reason = `Expected keyword "${missing}" missing from response`;
    } else {
      passed = true;
      reason = 'All expected keywords present';
    }
  } else {
    reason = 'No expectation set on test case — treating as pass';
    passed = true;
  }

  const durationMs = Date.now() - start;

  // Longevity L5a, 2026-05-13: record baseline + check regression.
  // Write a row to agent_eval_baselines and compare against the most
  // recent prior baseline for the same case_name + prompt_version. If
  // cost > 2x or duration > 1.5x prior, flag a regression in the reason.
  // The runner still reports pass/fail; regressions surface as a warning
  // in the row's reason. CI consumers (run-agent-evals.ts) can choose to
  // fail the build on regression.
  let regressionWarning: string | null = null;
  try {
    const { data: prior } = await supabaseAdmin
      .from('agent_eval_baselines')
      .select('cost_usd, duration_ms')
      .eq('case_name', evalCase.name)
      .eq('prompt_version', systemPrompt.versionLabel)
      .order('created_at', { ascending: false })
      .limit(1);

    const priorRow = (prior ?? [])[0];
    if (priorRow) {
      const priorCost = Number(priorRow.cost_usd ?? 0);
      const priorDuration = Number(priorRow.duration_ms ?? 0);
      if (priorCost > 0 && costUsd > priorCost * 2) {
        regressionWarning = `cost regression: $${costUsd.toFixed(4)} vs prior $${priorCost.toFixed(4)} (>2x)`;
      } else if (priorDuration > 0 && durationMs > priorDuration * 1.5) {
        regressionWarning = `latency regression: ${durationMs}ms vs prior ${priorDuration}ms (>1.5x)`;
      }
    }

    await supabaseAdmin.from('agent_eval_baselines').insert({
      case_name: evalCase.name,
      prompt_version: systemPrompt.versionLabel,
      model,
      model_id: modelId,
      passed,
      cost_usd: costUsd,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: durationMs,
    });
  } catch (baselineErr) {
    console.warn('[eval-runner] baseline write/compare failed (non-fatal)', baselineErr);
  }

  return {
    name: evalCase.name,
    category: evalCase.category,
    passed,
    reason: regressionWarning ? `${reason} | WARN: ${regressionWarning}` : reason,
    durationMs,
    costUsd,
    toolsCalled,
    finalText: finalText.slice(0, 200),
  };
}

/** Run the full bank. */
export async function runAllEvals(opts: {
  propertyId: string;
  userId: string;
  filter?: string;
}): Promise<EvalRunSummary> {
  const cases = opts.filter
    ? EVAL_CASES.filter(c => c.name.includes(opts.filter!) || c.category === opts.filter)
    : EVAL_CASES;

  const results: EvalResult[] = [];
  for (const c of cases) {
    const result = await runOneEval(c, opts);
    results.push(result);
    // Live progress to the CLI
    const mark = result.passed ? '✓' : '✗';
    console.log(`${mark} ${result.name.padEnd(40)} ${result.durationMs}ms  $${result.costUsd.toFixed(4)}  ${result.passed ? '' : '— ' + result.reason}`);
  }
  return {
    total: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    totalCostUsd: results.reduce((acc, r) => acc + r.costUsd, 0),
    totalDurationMs: results.reduce((acc, r) => acc + r.durationMs, 0),
    results,
  };
}
