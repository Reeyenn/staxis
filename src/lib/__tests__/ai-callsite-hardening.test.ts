import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const source = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

test('scoped provider attempts forward the runtime signal and reject truncation', () => {
  const expected: Array<[string, number, number]> = [
    ['src/lib/comms/assistant.ts', 5, 4], // four Claude paths + Whisper
    ['src/lib/comms/translate.ts', 2, 2],
    ['src/lib/notice-translate.ts', 1, 1],
    ['src/lib/reports/catalog/ai-summary.ts', 1, 1],
    // (reports/weekly-insights.ts removed 2026-07-19 with the automatic
    // report emails.)
    ['src/lib/complaints-ai.ts', 2, 2],
    ['src/lib/compliance/nlp.ts', 1, 1],
  ];

  for (const [file, attemptCount, anthropicCount] of expected) {
    const text = source(file);
    assert.equal(count(text, /executeAi(?:Feature|Plan)\(/g), attemptCount, `${file}: execution count drifted`);
    assert.equal(count(text, /signal:\s*context\.signal/g), attemptCount, `${file}: an attempt ignores its signal`);
    assert.equal(count(text, /stop_reason\s*===\s*'max_tokens'/g), anthropicCount, `${file}: truncation is not rejected per Claude attempt`);
  }
});

test('communications Staxis pins one plan and checks every tool-loop boundary', () => {
  const text = source('src/lib/comms/assistant.ts');
  const start = text.indexOf('export async function runStaxisAssistant');
  const block = text.slice(start);
  assert.ok(block.indexOf('resolveAiExecutionPlan(') < block.indexOf('for (let iter'));
  assert.match(block, /executeAiPlan\(/);
  assert.match(block, /if \(configured\.usedFallback\)/);
  assert.equal(count(block, /assertAssistantCanContinue\(/g), 3);
  assert.match(block, /assertAssistantHasToolStartReserve\(tu\.name, deadlineAt\)/);
  assert.match(text, /ASSISTANT_KNOWLEDGE_SEARCH_START_RESERVE_MS = 31_000/);
});

test('malformed output is rejected before executeAiFeature can accept an attempt', () => {
  const requiredSignals: Array<[string, string[]]> = [
    ['src/lib/comms/assistant.ts', [
      'action detection returned an invalid schema',
      'unread summary returned empty output',
      'announcement polish returned empty output',
      'transcription returned malformed JSON',
      'Staxis assistant returned empty output',
    ]],
    ['src/lib/comms/translate.ts', [
      'translation model returned empty output',
      'translation batch returned an invalid JSON schema',
    ]],
    ['src/lib/notice-translate.ts', ['notice translation returned empty output']],
    // Overlong-but-valid outputs are truncated, not rejected (2026-07-17
    // adversarial review): only empty/truncated-generation outputs throw.
    ['src/lib/reports/catalog/ai-summary.ts', ['report summary returned empty output']],
    ['src/lib/complaints-ai.ts', [
      'complaint classifier returned an invalid category',
      'service-recovery model returned an invalid JSON schema',
    ]],
    ['src/lib/compliance/nlp.ts', ['model returned an invalid JSON schema']],
    // Missing optional keys are coerced to null (models omit null fields);
    // only a non-object top level is rejected.
    ['src/lib/compliance/vision.ts', ['expected an object at top level']],
  ];

  for (const [file, markers] of requiredSignals) {
    const text = source(file);
    for (const marker of markers) assert.ok(text.includes(marker), `${file}: missing ${marker}`);
  }
});

test('Whisper parses verbose JSON inside the fallback attempt and uses route cancellation', () => {
  const text = source('src/lib/comms/assistant.ts');
  const start = text.indexOf("'communications.voice_transcription'");
  const end = text.indexOf('// ── @Staxis', start);
  const block = text.slice(start, end);
  assert.match(block, /form\.append\('response_format', 'verbose_json'\)/);
  assert.match(block, /signal:\s*context\.signal/);
  assert.match(block, /await response\.json\(\)\.catch/);
  assert.match(block, /capturePricedUsage\(context\.attempts/);
  assert.ok(block.indexOf('response.json') < block.indexOf('return json.text.trim()'));

  const route = source('src/app/api/comms/transcribe/route.ts');
  assert.match(route, /assertAudioBudget\(\{ userId: ctx\.accountId, propertyId: ctx\.pid \}\)/);
  assert.ok(
    route.lastIndexOf('assertAudioBudget(') < route.lastIndexOf('transcribeAudioBuffer('),
    'authenticated Whisper spend must be budget-gated before the provider call',
  );
});

test('authenticated scoped routes attribute every provider attempt to agent_costs', () => {
  // Attribution is now runtime-owned: a route passes `ledger` through the AI
  // call options and the runtime records every billable attempt itself. A
  // route hand-rolling recordAiUsageBestEffort again would reintroduce the
  // forgettable-epilogue pattern this refactor removed.
  const routes = [
    'src/app/api/comms/detect-action/route.ts',
    'src/app/api/comms/summary/route.ts',
    'src/app/api/comms/polish/route.ts',
    'src/app/api/comms/translate/route.ts',
    'src/app/api/comms/transcribe/route.ts',
    'src/app/api/comms/assistant/route.ts',
    'src/app/api/comms/announce/route.ts',
    'src/app/api/comms/messages/route.ts',
    'src/app/api/comms/thread/route.ts',
    'src/app/api/comms/pin/route.ts',
    'src/app/api/comms/threads/route.ts',
    'src/app/api/housekeeping/notices/route.ts',
    'src/app/api/settings/reports/run/route.ts',
    'src/app/api/complaints/log/route.ts',
    'src/app/api/complaints/draft/route.ts',
    'src/app/api/compliance/setup/route.ts',
    'src/app/api/engineer/voice-log/route.ts',
    'src/app/api/cron/compliance-anomaly-sweep/route.ts',
  ];

  for (const file of routes) {
    const text = source(file);
    assert.match(text, /ledger:\s*(\{|accountId|costAccountId)/, `${file}: ledger attribution missing`);
    assert.doesNotMatch(text, /recordAiUsageBestEffort/, `${file}: hand-rolled ledger epilogue reintroduced`);
    assert.match(text, /deadlineAt/, `${file}: route deadline missing`);
  }

  // The runtime side of the contract: executeAiPlan settles usage in a
  // finally, emitting onUsage and recording the ledger even when the
  // primary threw before the fallback ran.
  const runtimeSource = source('src/lib/ai/runtime.ts');
  assert.match(runtimeSource, /finally\s*\{[\s\S]*?aggregateAiUsage\(attempts\)[\s\S]*?recordAiUsageBestEffort\(/);
});

test('usage ledger preserves per-attempt rows with bounded parallel writes', () => {
  const text = source('src/lib/ai/usage-ledger.ts');
  assert.match(text, /AI_USAGE_LEDGER_WRITE_CONCURRENCY = 8/);
  assert.match(text, /billable\.slice\(i, i \+ AI_USAGE_LEDGER_WRITE_CONCURRENCY\)/);
  assert.match(text, /Promise\.all\(chunk\.map/);
  assert.match(text, /model: attempt\.model/);
});
