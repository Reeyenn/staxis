/**
 * Live proof that the situational-awareness block reaches the model and is USED.
 *
 * WHY A SCRIPT AND NOT A TEST. A unit test can prove the block is assembled and
 * placed correctly; it cannot prove a real model reads it. That claim needs a
 * real call, and a real call costs money and cannot run in CI. So this is a
 * one-shot, on-demand proof — the same posture as the family-tier eval bank.
 *
 * WHAT MAKES IT HONEST. The eval harness had a vacuous-pass bug of exactly the
 * shape this script could have: recording that only happened inside the scripted
 * fake, so pointing it at a live model left the evidence arrays empty and every
 * assertion passed on nothing. So this script prints the EXACT system text it
 * sent, from the same variable it sent, and asserts the block is inside it
 * BEFORE looking at the answer. If the block is not in the recorded input, the
 * script fails loudly rather than reporting a pass on a prompt that never
 * carried it.
 *
 *   npx tsx --conditions=react-server scripts/prove-awareness-live.ts
 *
 * Cost: two Sonnet calls on a ~3k-token prompt. Well under $0.05.
 */

import Anthropic from '@anthropic-ai/sdk';

import { loadEnv } from './load-env';
import type { Awareness } from '../src/lib/agent/awareness';
import type { HotelSnapshot } from '../src/lib/agent/context';

// ENV FIRST, THEN THE APP. `src/lib/env.ts` validates at MODULE LOAD and throws
// on a missing key, and static imports are hoisted above every statement — so a
// top-level `import { buildSystemPrompt }` here would evaluate the env module
// before loadEnv() ever ran, and the script would die on its own .env.local.
// The two app modules are therefore pulled in dynamically, below, after this.
loadEnv(process.cwd());

const MODEL = 'claude-sonnet-4-6';
const PROPERTY_ID = '00000000-0000-0000-0000-0000000000a1';
const NOW = new Date('2026-07-27T19:47:00.000Z'); // 2:47 PM America/Chicago

const snapshot: HotelSnapshot = {
  today: '2026-07-27',
  property: { id: PROPERTY_ID, name: 'Comfort Suites', timezone: 'America/Chicago' },
  rooms: {
    total: 88, dirty: 12, in_progress: 0, clean: 14, dnd: 0, issuesFlagged: 0,
    helpRequested: 0, checkouts: 9, stayovers: 21, inHouse: 62, outOfOrder: 0,
    seedingGap: 0,
  },
  staff: { activeToday: 4, assignedHousekeepers: 3 },
  pmsDataSource: 'snapshot_capture',
  pmsDataCapturedAt: new Date(NOW.getTime() - 7 * 60_000).toISOString(),
};

// Hand-built rather than read from the DB: this script proves the PROMPT PATH
// (block → model → answer), and seeding a hotel to produce these exact lines
// would prove the same thing while writing rows to a real database.
const awareness: Awareness = {
  clock: '2:47 PM Mon at the hotel — afternoon turnover — rooms being readied for tonight',
  screen: 'Inventory',
  didToday: 'cleaning started ×6, inspection passed ×2, count saved',
  justChanged: '31 room-status changes recorded today',
  onYourPlate: '2 actions you left waiting on a Yes/No, 5 things Staxis is offering to do',
  staxisToday: 'checked 17 things at 4:02 AM',
  tonight: '23 arrivals booked for tonight, 19 not checked in yet',
};

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('sk-ant-placeholder')) {
    console.error('✗ ANTHROPIC_API_KEY missing or placeholder — this proof needs a real key.');
    process.exit(1);
  }

  const { formatAwarenessForPrompt } = await import('../src/lib/agent/awareness');
  const { buildSystemPrompt } = await import('../src/lib/agent/prompts');

  const block = formatAwarenessForPrompt(awareness);
  const systemPrompt = await buildSystemPrompt(
    'general_manager', snapshot, 'proof-conv', undefined, undefined, NOW, block,
  );

  // ── The recorded model input. This exact array is what gets sent. ──
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: systemPrompt.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemPrompt.dynamic },
  ];
  const recordedSystemText = systemBlocks.map(b => b.text).join('\n');

  // ── Prove the evidence before trusting any answer built on it. ──
  const mustContain = [
    '─── Right now ───',
    'On screen: Inventory.',
    'Time: 2:47 PM Mon at the hotel',
    '2 actions you left waiting on a Yes/No',
  ];
  for (const needle of mustContain) {
    if (!recordedSystemText.includes(needle)) {
      console.error(`✗ VACUOUS: the recorded model input does not contain ${JSON.stringify(needle)}.`);
      console.error('  Refusing to report a pass on a prompt that never carried the block.');
      process.exit(1);
    }
  }
  if (systemPrompt.stable.includes('─── Right now ───')) {
    console.error('✗ the block leaked into the CACHED half — this would miss the prompt cache every turn.');
    process.exit(1);
  }

  console.log('═'.repeat(78));
  console.log('RECORDED MODEL INPUT — the awareness block, verbatim from what was sent');
  console.log('═'.repeat(78));
  const start = systemPrompt.dynamic.indexOf('─── Right now ───');
  console.log(systemPrompt.dynamic.slice(start, systemPrompt.dynamic.indexOf('</staxis-awareness>') + 21));
  console.log();
  console.log(`(stable block: ${systemPrompt.stable.length} chars, CACHED, contains no awareness block)`);
  console.log(`(dynamic block: ${systemPrompt.dynamic.length} chars, uncached)`);
  console.log(`(awareness block itself: ${block.length} chars ≈ ${Math.round(block.length / 4)} tokens)`);

  const client = new Anthropic({ apiKey: key });

  const questions = [
    'what page am I on, and what have I done today?',
    'what should I be doing right now?',
  ];

  for (const question of questions) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemBlocks,
      messages: [{ role: 'user', content: question }],
    });
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    console.log();
    console.log('═'.repeat(78));
    console.log(`USER: ${question}`);
    console.log('─'.repeat(78));
    console.log(text.trim());
    console.log('─'.repeat(78));
    console.log(
      `tokens in=${res.usage.input_tokens} out=${res.usage.output_tokens} ` +
      `cache_write=${res.usage.cache_creation_input_tokens ?? 0} ` +
      `cache_read=${res.usage.cache_read_input_tokens ?? 0}`,
    );
  }
  console.log();
  console.log('✓ the block was in the recorded model input, and only in the uncached half.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
