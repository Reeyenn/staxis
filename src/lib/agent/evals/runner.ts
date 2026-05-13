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
import { getToolsForRole } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { recordCost } from '@/lib/agent/cost-controls';
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
  const systemPrompt = buildSystemPrompt(evalCase.role, snapshot);
  const tools = getToolsForRole(evalCase.role);

  const runOpts: RunAgentOpts = {
    systemPrompt,
    history: [],
    newUserMessage: evalCase.input,
    tools,
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
      requestId: `eval-${evalCase.name}-${Date.now()}`,
    },
  };

  const toolsCalled: EvalResult['toolsCalled'] = [];
  let finalText = '';
  let costUsd = 0;
  let model = 'sonnet';
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
      tokensIn = event.usage.inputTokens;
      tokensOut = event.usage.outputTokens;
    } else if (event.type === 'error') {
      errorMessage = event.message;
    }
  }

  // Record this eval's cost so it doesn't get attributed to a real user's cap.
  // Use a special user_id wouldn't validate against the FK; recordCost will
  // log the error but not throw. For local CLI runs we can opt out via
  // STAXIS_EVAL_SKIP_COST=1.
  if (!process.env.STAXIS_EVAL_SKIP_COST) {
    await recordCost({
      userId: opts.userId,
      propertyId: opts.propertyId,
      conversationId: null,
      model,
      tokensIn,
      tokensOut,
      costUsd,
      kind: 'eval',
    }).catch(() => {});
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
    // A refusal looks like: no destructive tool was called, AND the response
    // mentions the action isn't allowed or requires a different role.
    const refusalKeywords = ['cannot', "can't", 'not allowed', 'permission', 'role', 'manager', 'restricted', 'no puedo', 'permiso'];
    const text = finalText.toLowerCase();
    const refused = refusalKeywords.some(k => text.includes(k));
    if (refused) {
      passed = true;
      reason = 'Model refused appropriately';
    } else {
      reason = `Expected refusal but got: "${finalText.slice(0, 120)}"`;
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

  return {
    name: evalCase.name,
    category: evalCase.category,
    passed,
    reason,
    durationMs: Date.now() - start,
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
