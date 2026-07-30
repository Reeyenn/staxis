/**
 * ONE price table, and everything bills off it.
 *
 * Until 2026-07-25 there were two authoritative price tables that disagreed:
 * `PRICING` in src/lib/agent/llm.ts priced Opus at $15/$75 per million tokens
 * (the retired Opus 3 rate) while ANTHROPIC_TIER_PRICING in
 * src/lib/ai/feature-registry.ts had the correct $5/$25. Nothing was visibly
 * broken only because the single price-sensitive consumer — the cost-cap
 * reservation — reads the Sonnet row, which the two tables happened to agree
 * on. Luck, not design: routing one background job to Opus would have sized
 * every hold 3x too high and started rejecting requests under the daily cap.
 *
 * These tests fail if a second price list reappears anywhere in the billing
 * path, or if the surviving one drifts internally.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANTHROPIC_TIER_PRICING,
  CONSERVATIVE_ANTHROPIC_PRICING,
  anthropicTierTokenRates,
  type AnthropicPricingTier,
} from '@/lib/ai/feature-registry';
import {
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ITERATIONS,
  defaultModelRef,
  estimateCost,
} from '@/lib/agent/llm';
import {
  COST_LIMITS,
  RESERVATION_INPUT_HEADROOM_USD,
  deriveReservationUsd,
} from '@/lib/agent/cost-controls';

const TIERS: AnthropicPricingTier[] = ['haiku', 'sonnet', 'opus'];

/** Anthropic's published list price on the registry's asOf date. Anchored as
 * literals because the correct number is external knowledge the code cannot
 * derive — this is the assertion that would have caught the stale $15/$75. */
const PUBLISHED_LIST_PRICE: Record<AnthropicPricingTier, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },    // Claude Haiku 4.5
  sonnet: { input: 3, output: 15 },  // Claude Sonnet 4.6
  opus: { input: 5, output: 25 },    // Claude Opus 4.7
};

describe('the surviving price table is internally consistent', () => {
  for (const tier of TIERS) {
    test(`${tier} carries Anthropic's published input/output list price`, () => {
      const rates = anthropicTierTokenRates(tier);
      assert.equal(rates.inputUsdPerMillionTokens, PUBLISHED_LIST_PRICE[tier].input);
      assert.equal(rates.outputUsdPerMillionTokens, PUBLISHED_LIST_PRICE[tier].output);
    });

    test(`${tier} cache rates are the published multiples of its input rate`, () => {
      // Anthropic prices cache read at 0.1x input, a 5-minute cache write at
      // 1.25x, and a 1-hour cache write at 2x. A typo'd or half-updated row
      // breaks these ratios even when the headline rate looks plausible.
      // Rounded because 3 * 0.1 is 0.30000000000000004 in binary floating
      // point — the expectation, not the stored rate, is what needs cleaning.
      const cents = (n: number | undefined) => Math.round((n ?? NaN) * 10_000) / 10_000;
      const p = ANTHROPIC_TIER_PRICING[tier];
      const input = PUBLISHED_LIST_PRICE[tier].input;
      assert.equal(cents(p.cachedInputUsdPerMillionTokens), cents(input * 0.1));
      assert.equal(cents(p.cacheCreation5mInputUsdPerMillionTokens), cents(input * 1.25));
      assert.equal(cents(p.cacheCreation1hInputUsdPerMillionTokens), cents(input * 2));
    });

    test(`${tier} is labelled as a verified list price`, () => {
      assert.equal(ANTHROPIC_TIER_PRICING[tier].source, 'official-list-price');
    });
  }

  test('the conservative estimate is derived from Opus, not typed out', () => {
    // It exists to over-charge unpriced models. If Opus's list price moves and
    // this stays put, it quietly stops being a safety margin at all.
    const opus = ANTHROPIC_TIER_PRICING.opus;
    assert.equal(CONSERVATIVE_ANTHROPIC_PRICING.source, 'conservative-unverified');
    assert.equal(
      CONSERVATIVE_ANTHROPIC_PRICING.inputUsdPerMillionTokens,
      (opus.inputUsdPerMillionTokens ?? 0) * 3,
    );
    assert.equal(
      CONSERVATIVE_ANTHROPIC_PRICING.outputUsdPerMillionTokens,
      (opus.outputUsdPerMillionTokens ?? 0) * 3,
    );
    assert.ok(
      (CONSERVATIVE_ANTHROPIC_PRICING.outputUsdPerMillionTokens ?? 0)
        > (opus.outputUsdPerMillionTokens ?? 0),
      'the unverified estimate must never undercut the priciest verified tier',
    );
  });
});

describe('the agent bills at the registry rate, not a local copy', () => {
  // Exercising the estimator at exactly one million tokens of a single class
  // makes the dollar figure equal the per-million rate, so any divergence
  // between what the agent charges and what the registry says is a direct
  // numeric mismatch rather than something hidden behind arithmetic.
  const ONE_MILLION = 1_000_000;

  for (const tier of TIERS) {
    test(`estimateCost('${tier}') charges every token class at the registry rate`, () => {
      const p = ANTHROPIC_TIER_PRICING[tier];
      assert.equal(
        estimateCost(tier, ONE_MILLION, 0),
        p.inputUsdPerMillionTokens,
        'fresh input',
      );
      assert.equal(
        estimateCost(tier, 0, ONE_MILLION),
        p.outputUsdPerMillionTokens,
        'output',
      );
      assert.equal(
        estimateCost(tier, 0, 0, ONE_MILLION),
        p.cachedInputUsdPerMillionTokens,
        'cache read',
      );
      assert.equal(
        estimateCost(tier, 0, 0, 0, ONE_MILLION, ONE_MILLION, 0),
        p.cacheCreation5mInputUsdPerMillionTokens,
        '5-minute cache write',
      );
      assert.equal(
        estimateCost(tier, 0, 0, 0, ONE_MILLION, 0, ONE_MILLION),
        p.cacheCreation1hInputUsdPerMillionTokens,
        '1-hour cache write',
      );
    });

    test(`the tier-default model ref for '${tier}' carries the registry price`, () => {
      // This is the price the live agent loop bills against whenever no
      // admin-configured feature plan applies.
      assert.deepEqual(defaultModelRef(tier).pricing, ANTHROPIC_TIER_PRICING[tier]);
    });
  }

  test('Opus is priced at the current rate, not the retired Opus 3 rate', () => {
    // The exact regression this whole file exists for. $75/M output was the
    // Opus 3 price; charging it today overstates Opus spend 3x.
    assert.equal(estimateCost('opus', 0, 1_000_000), 25);
    assert.notEqual(estimateCost('opus', 0, 1_000_000), 75);
  });
});

describe('the cost-cap hold stays coupled to its inputs', () => {
  // Deliberate Codex review fix H1: the reservation is DERIVED from the output
  // cap, the iteration limit, and the Sonnet output price. A hard-coded dollar
  // figure here would let a future cap increase bypass the daily spend gate.
  test('the configured hold equals the derived worst case', () => {
    assert.equal(
      COST_LIMITS.estimatedRequestUsd,
      deriveReservationUsd({
        outputUsdPerMillionTokens: anthropicTierTokenRates('sonnet').outputUsdPerMillionTokens,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxToolIterations: MAX_TOOL_ITERATIONS,
        inputHeadroomUsd: RESERVATION_INPUT_HEADROOM_USD,
      }),
    );
  });

  test('the hold covers the worst-case output spend with headroom to spare', () => {
    const worstCaseOutputUsd =
      (MAX_OUTPUT_TOKENS / 1_000_000)
      * anthropicTierTokenRates('sonnet').outputUsdPerMillionTokens
      * MAX_TOOL_ITERATIONS;
    assert.ok(
      COST_LIMITS.estimatedRequestUsd > worstCaseOutputUsd,
      `hold ${COST_LIMITS.estimatedRequestUsd} must exceed worst-case output ${worstCaseOutputUsd}`,
    );
  });

  test('raising the output cap raises the hold', () => {
    const base = { outputUsdPerMillionTokens: 15, maxToolIterations: 8, inputHeadroomUsd: 1 };
    assert.ok(
      deriveReservationUsd({ ...base, maxOutputTokens: 16_384 })
        > deriveReservationUsd({ ...base, maxOutputTokens: 8_192 }),
    );
  });

  test('raising the iteration limit raises the hold', () => {
    const base = { outputUsdPerMillionTokens: 15, maxOutputTokens: 8_192, inputHeadroomUsd: 1 };
    assert.ok(
      deriveReservationUsd({ ...base, maxToolIterations: 16 })
        > deriveReservationUsd({ ...base, maxToolIterations: 8 }),
    );
  });

  test('a price rise raises the hold', () => {
    const base = { maxOutputTokens: 8_192, maxToolIterations: 8, inputHeadroomUsd: 1 };
    assert.ok(
      deriveReservationUsd({ ...base, outputUsdPerMillionTokens: 30 })
        > deriveReservationUsd({ ...base, outputUsdPerMillionTokens: 15 }),
    );
  });
});

describe('no second price list', () => {
  // A no-runtime invariant: a rate written into some other module is invisible
  // to every behavioural test above until something routes through it, which
  // is exactly how the llm.ts table drifted unnoticed for months. The only way
  // to catch a NEW duplicate is to look for one.
  const PRICE_FIELD = /(?:input|output|cachedInput|cacheCreation5mInput|cacheCreation1hInput)UsdPerMillionTokens\s*:\s*-?\d/;

  /** The one file allowed to write a price down, plus tests, which need
   * synthetic rates to exercise the estimator against known values. */
  const ALLOWED = /(?:^|[/\\])(?:feature-registry\.ts|__tests__[/\\].*|.*\.test\.[tj]sx?)$/;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(full) ? [full] : [];
    });
  }

  test('only feature-registry.ts writes a per-million-token rate', () => {
    const srcRoot = path.resolve(import.meta.dirname, '..', '..');
    const offenders = walk(srcRoot)
      .filter((file) => !ALLOWED.test(file))
      .filter((file) => PRICE_FIELD.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file));

    assert.deepEqual(
      offenders,
      [],
      'Model prices belong in ANTHROPIC_TIER_PRICING (src/lib/ai/feature-registry.ts) '
      + `and nowhere else. Hardcoded rate(s) found in: ${offenders.join(', ')}`,
    );
  });

  test('the scan can actually see a price literal', () => {
    // Guard the guard: if the pattern ever stops matching the shape it hunts,
    // the test above passes vacuously forever.
    assert.ok(PRICE_FIELD.test('  outputUsdPerMillionTokens: 75,'));
    assert.ok(PRICE_FIELD.test('cachedInputUsdPerMillionTokens:0.5'));
    // …and does not fire on a legitimate pass-through of a computed value.
    assert.equal(PRICE_FIELD.test('outputUsdPerMillionTokens: rates.output,'), false);
  });
});
