import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const runner = readFileSync(
  'src/app/api/agent/command/_stream-runner.ts',
  'utf8',
);
const commandRoute = readFileSync(
  'src/app/api/agent/command/route.ts',
  'utf8',
);
const resolveRoute = readFileSync(
  'src/app/api/agent/command/resolve-action/route.ts',
  'utf8',
);

function sourceWindow(source: string, marker: string, length = 500): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

describe('finance-hat hotel chat wiring', () => {
  test('the route-built user context carries exact-hotel financial and mutation standing', () => {
    assert.match(runner, /seesFinancials: boolean/);
    assert.match(runner, /seesFinancials: standing\.seesFinancials/);
    assert.match(runner, /hotelMutationAllowed: standing\.hotelMutationAllowed/);
  });

  test('the initial turn passes current standing to both prompt and catalog', () => {
    const promptCall = sourceWindow(commandRoute, 'const systemPrompt = await buildSystemPrompt');
    const catalogCall = sourceWindow(commandRoute, 'const tools = getToolsForRole');
    assert.match(promptCall, /memoryBlock,[\s\S]*?undefined,[\s\S]*?userCtx,/);
    assert.match(catalogCall, /'chat',[\s\S]*?enabledSections,[\s\S]*?userCtx,/);
  });

  test('approval resume rebuilds prompt and catalog from newly resolved standing', () => {
    const promptCall = sourceWindow(resolveRoute, 'const systemPrompt = await buildSystemPrompt');
    const catalogCall = sourceWindow(resolveRoute, 'const tools = getToolsForRole');
    assert.match(promptCall, /memoryBlock,[\s\S]*?undefined,[\s\S]*?userCtx,/);
    assert.match(catalogCall, /'chat',[\s\S]*?enabledSections,[\s\S]*?userCtx,/);
  });
});
