/**
 * Voice approval gate — deterministic spoken copy (feature/voice-approval).
 *
 * Item (d): the voice-brain stages a card action and speaks a DETERMINISTIC
 * read-back built from buildActionSummary (never model free-text). This pins the
 * copy the route emits for a staged card, plus the cross-turn prompt note that
 * re-derives the awaiting-confirmation state each turn. Both are bilingual with
 * real accented characters.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickVoiceLang,
  buildSpokenReadback,
  buildPendingConfirmationPromptBlock,
} from '@/lib/agent/voice-confirm-copy';

const COMPLAINT_ARGS = { description: 'no hot water', roomNumber: '305' };

describe('pickVoiceLang', () => {
  test("'es' → es; everything else (incl ht/tl/vi) → en", () => {
    assert.equal(pickVoiceLang('es'), 'es');
    assert.equal(pickVoiceLang('en'), 'en');
    assert.equal(pickVoiceLang('ht'), 'en');
    assert.equal(pickVoiceLang(undefined), 'en');
    assert.equal(pickVoiceLang(null), 'en');
  });
});

describe('buildSpokenReadback — the staged-card confirmation the route speaks', () => {
  test('EN read-back embeds the deterministic action summary + a yes prompt', () => {
    const out = buildSpokenReadback('log_complaint', COMPLAINT_ARGS, 'en');
    assert.match(out, /^Just to confirm — /);
    // Uses the real summary builder, not model text.
    assert.match(out, /Log a guest complaint for room 305/);
    assert.match(out, /Say yes to go ahead/);
    assert.doesNotMatch(out, /one more after this/); // single card
  });

  test('ES read-back is Spanish with real accents (no \\uXXXX escapes)', () => {
    const out = buildSpokenReadback('log_complaint', COMPLAINT_ARGS, 'es');
    assert.match(out, /^Para confirmar — /);
    assert.match(out, /Di sí para continuar/); // accented í
    assert.ok(out.includes('í'), 'must contain a real accented character');
  });

  test('more=true appends the one-at-a-time note (EN + ES), without promising a queue', () => {
    const en = buildSpokenReadback('log_complaint', COMPLAINT_ARGS, 'en', true);
    const es = buildSpokenReadback('log_complaint', COMPLAINT_ARGS, 'es', true);
    assert.match(en, /one at a time/);
    assert.match(en, /tell me the rest after this one/);
    assert.match(es, /una en una/);
  });
});

describe('buildPendingConfirmationPromptBlock — cross-turn note', () => {
  test('EN note names the awaiting action + confirm/cancel tools', () => {
    const out = buildPendingConfirmationPromptBlock('createMaintenanceWorkOrder', { action: 'REPAIR', item: 'sink', room_number: '305' }, 'en');
    assert.match(out, /AWAITING THE USER'S SPOKEN CONFIRMATION/);
    assert.match(out, /confirm_pending_action/);
    assert.match(out, /cancel_pending_action/);
    // Deterministic summary of the held action is embedded.
    assert.match(out, /maintenance ticket/i);
  });

  test('ES note is Spanish with real accents', () => {
    const out = buildPendingConfirmationPromptBlock('log_complaint', COMPLAINT_ARGS, 'es');
    assert.match(out, /ESPERANDO LA CONFIRMACIÓN HABLADA/); // accented Ó
    assert.match(out, /confirm_pending_action/);
    assert.match(out, /cancel_pending_action/);
  });
});
