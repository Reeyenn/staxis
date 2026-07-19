import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

for (const route of [
  'src/app/api/agent/command/route.ts',
  'src/app/api/agent/command/resolve-action/route.ts',
]) {
  test(`${route} reserves and executes one resolved AI plan`, () => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    assert.equal(
      source.match(/resolveAskStaxisExecutionPlan\(\)/g)?.length,
      1,
      'the route must resolve exactly one model snapshot',
    );
    assert.match(source, /scaleAiReservationUsd\([\s\S]*executionPlan\.primary/);
    assert.match(source, /streamAgent\(\{[\s\S]*executionPlan,[\s\S]*deadlineAt: executionDeadlineAt/);
    assert.doesNotMatch(source, /estimateAiReservationUsd/);
  });
}

test('agent tool loops enforce the shared deadline only at safe boundaries', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/agent/llm.ts'), 'utf8');
  assert.ok(
    (source.match(/agentStopReason\(deadlineAt, opts\.abortSignal\)/g)?.length ?? 0) >= 3,
    'streaming provider and both tool execution loops must check the shared deadline',
  );
  assert.ok(
    (source.match(/assertAgentCanContinue\(deadlineAt, opts\.abortSignal\)/g)?.length ?? 0) >= 2,
    'sync provider and tool boundaries must check the shared deadline',
  );
  assert.ok(
    (source.match(/agentToolStopReason\(call\.name, deadlineAt, opts\.abortSignal\)/g)?.length ?? 0) >= 3,
    'sync and streaming tool boundaries must reserve enough time before starting a tool',
  );
  assert.doesNotMatch(
    source,
    /Promise\.race\([\s\S]{0,300}executeTool/,
    'already-started mutations must not continue after an abandoned timeout race',
  );
});

test('vision request routes forward caller cancellation into provider execution', () => {
  // financials/* vision routes delegate the actual Vision
  // call to a shared runner (scan-vision-route / vision-route), so the
  // cancellation forwarding is asserted on the runner, not the route file.
  for (const route of [
    'src/app/api/inventory/photo-count/route.ts',
    'src/app/api/inventory/scan-invoice/route.ts',
    'src/lib/financials/scan-vision-route.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    assert.match(source, /abortSignal:\s*req\.signal/, `${route} must forward request cancellation`);
    assert.match(source, /const visionDeadlineAt = Date\.now\(\) \+ 52_000/);
    assert.match(source, /deadlineAt:\s*visionDeadlineAt/);
  }
});

test('background output validation runs inside the billable model attempt', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/agent/llm.ts'), 'utf8');
  const requestStart = source.indexOf('const request = async (selected: AiModelRef');
  const validation = source.indexOf('opts.validateAssistantResponse({', requestStart);
  const executePlan = source.indexOf('const executed = await executeAiPlan(', requestStart);
  assert.ok(requestStart >= 0 && validation > requestStart && validation < executePlan);
  assert.ok(source.indexOf('normalizeAnthropicUsage(response.usage)', requestStart) < validation);
});

test('background agent calls reserve cleanup time beneath their cron ceilings', () => {
  const summary = readFileSync(join(process.cwd(), 'src/lib/agent/summarizer.ts'), 'utf8');
  assert.match(summary, /SUMMARY_AI_EXECUTION_BUDGET_MS = 40_000/);
  assert.match(summary, /deadlineAt:\s*summaryCallDeadlineAt\(opts\)/);
  assert.match(summary, /abortSignal:\s*opts\.abortSignal/);

  const memory = readFileSync(join(process.cwd(), 'src/lib/agent/memory-consolidate.ts'), 'utf8');
  assert.match(memory, /MEMORY_AI_EXECUTION_BUDGET_MS = 45_000/);
  assert.equal(
    memory.match(/deadlineAt:\s*memoryCallDeadlineAt\(opts\)/g)?.length,
    2,
    'both conversation and operational consolidation calls need a whole-call deadline',
  );
  assert.ok((memory.match(/abortSignal:\s*opts\.abortSignal/g)?.length ?? 0) >= 2);

  for (const route of [
    'src/app/api/cron/agent-summarize-long-conversations/route.ts',
    'src/app/api/cron/agent-consolidate-memory/route.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    assert.match(source, /const executionDeadlineAt = Date\.now\(\) \+ CRON_EXECUTION_BUDGET_MS/);
    assert.match(source, /deadlineAt:\s*executionDeadlineAt/);
    assert.match(source, /abortSignal:\s*req\.signal/);
  }
});

test('sync background usage is emitted from finally and error paths book it once', () => {
  const llm = readFileSync(join(process.cwd(), 'src/lib/agent/llm.ts'), 'utf8');
  const syncStart = llm.indexOf('export async function runAgent');
  const streamStart = llm.indexOf('export async function* streamAgent');
  const sync = llm.slice(syncStart, streamStart);
  assert.match(sync, /finally\s*\{[\s\S]*opts\.onUsage\?\.\(usage\)/);
  assert.equal(sync.match(/opts\.onUsage\?\.\(usage\)/g)?.length, 1);

  for (const file of [
    'src/lib/agent/summarizer.ts',
    'src/lib/agent/memory-consolidate.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /onUsage:\s*\([^)]*\)\s*=>/);
    assert.match(source, /failed_[a-z_]*attempt_cost_record_lost/);
  }
});

test('successful background usage is booked before downstream persistence', () => {
  const summary = readFileSync(join(process.cwd(), 'src/lib/agent/summarizer.ts'), 'utf8');
  const summaryRun = summary.indexOf('summaryRun = await runAgent');
  const summaryBook = summary.indexOf('await recordSummaryUsageBestEffort', summaryRun);
  const summaryRpc = summary.indexOf("supabaseAdmin.rpc(\n    'staxis_apply_conversation_summary'", summaryRun);
  assert.ok(summaryRun >= 0 && summaryBook > summaryRun && summaryBook < summaryRpc);

  const memory = readFileSync(join(process.cwd(), 'src/lib/agent/memory-consolidate.ts'), 'utf8');
  const conversationRun = memory.indexOf('run = await runAgent');
  const conversationBook = memory.indexOf('await recordConsolidationUsageBestEffort', conversationRun);
  const conversationParse = memory.indexOf('parseExtraction(run.text)', conversationRun);
  assert.ok(conversationRun >= 0 && conversationBook > conversationRun && conversationBook < conversationParse);

  const operationalRun = memory.indexOf('const run = await runAgent', conversationRun + 1);
  const operationalBook = memory.indexOf('await recordConsolidationUsageBestEffort', operationalRun);
  const operationalParse = memory.indexOf('parseExtraction(run.text, MAX_SIGNALS)', operationalRun);
  assert.ok(operationalRun >= 0 && operationalBook > operationalRun && operationalBook < operationalParse);
});
