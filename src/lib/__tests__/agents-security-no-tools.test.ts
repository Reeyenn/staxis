// SECURITY INVARIANT: the agent engine reaches the model through exactly ONE
// chokepoint (reasoner.ts), and that call ALWAYS passes `tools: []`. With no
// tools the model can't trigger any action — the approval gate can't be
// bypassed by prompt injection. This is a structural, grep-enforced guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = join(process.cwd(), 'src/lib/agents');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('only reasoner.ts imports the LLM client', () => {
  const importers = walk(AGENTS_DIR).filter((f) => readFileSync(f, 'utf8').includes("@/lib/agent/llm"));
  const names = importers.map((f) => f.split('/').pop());
  assert.deepEqual(names.sort(), ['reasoner.ts'], `unexpected LLM importers: ${names.join(', ')}`);
});

test('the reasoner passes an EMPTY tools array and never a populated one', () => {
  const src = readFileSync(join(AGENTS_DIR, 'reasoner.ts'), 'utf8');
  assert.ok(src.includes('tools: []'), 'reasoner must pass tools: []');
  // No `tools: [<something>` — i.e. never a non-empty tools array literal.
  assert.ok(!/tools:\s*\[[^\]\s]/.test(src), 'reasoner must never pass a populated tools array');
});
