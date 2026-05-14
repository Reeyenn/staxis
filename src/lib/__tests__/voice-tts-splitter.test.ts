/**
 * Unit tests for the sentence-splitter that feeds TTS chunks.
 *
 * The TtsPlayer hook splits streamed assistant text into sentences and
 * fires one /api/agent/speak request per sentence. Wrong boundaries =
 * choppy playback or merged sentences that exceed OpenAI's 4096-char cap.
 *
 * This is a pure function test — runs in tsx, no browser needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitSentences } from '@/components/agent/useTtsPlayer';

test('returns empty + buffer unchanged for text with no terminator', () => {
  const { sentences, rest } = splitSentences('I am still typing');
  assert.deepStrictEqual(sentences, []);
  assert.strictEqual(rest, 'I am still typing');
});

test('splits on period followed by whitespace', () => {
  const { sentences, rest } = splitSentences('Hello world. How are you');
  assert.deepStrictEqual(sentences, ['Hello world.']);
  assert.strictEqual(rest, ' How are you');
});

test('keeps trailing punctuation attached to its sentence', () => {
  const { sentences } = splitSentences('Room 302 is clean. Room 304 too. ');
  assert.deepStrictEqual(sentences, ['Room 302 is clean.', 'Room 304 too.']);
});

test('handles question marks and exclamation points', () => {
  const { sentences } = splitSentences('Are you sure? Yes! Definitely.');
  assert.deepStrictEqual(sentences, [
    'Are you sure?',
    'Yes!',
    'Definitely.',
  ]);
});

test('keeps the leftover (no terminator yet) in `rest`', () => {
  const { sentences, rest } = splitSentences('First sentence. Second sentence still streaming');
  assert.deepStrictEqual(sentences, ['First sentence.']);
  assert.strictEqual(rest, ' Second sentence still streaming');
});

test('handles multiple consecutive punctuation marks', () => {
  // The agent might emit "Wait!!" — the splitter should treat the run
  // as a single boundary rather than three.
  const { sentences } = splitSentences('Wait!! What did you say?');
  assert.deepStrictEqual(sentences, ['Wait!!', 'What did you say?']);
});

test('returns no sentences for whitespace-only buffer', () => {
  const { sentences, rest } = splitSentences('   ');
  assert.deepStrictEqual(sentences, []);
  assert.strictEqual(rest, '   ');
});

test('handles decimal numbers without splitting on the dot', () => {
  // "$0.99" shouldn't become two pseudo-sentences. The boundary requires
  // whitespace after the punctuation; ".99" doesn't qualify because there's
  // no whitespace between "." and "9".
  const { sentences, rest } = splitSentences('The price is $0.99 plus tax');
  assert.deepStrictEqual(sentences, []);
  assert.strictEqual(rest, 'The price is $0.99 plus tax');
});

test('does not emit empty strings between back-to-back terminators', () => {
  const { sentences } = splitSentences('Yes. No. Maybe.');
  assert.deepStrictEqual(sentences, ['Yes.', 'No.', 'Maybe.']);
});
