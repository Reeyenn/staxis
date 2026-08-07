/**
 * A SPEND HOLD SMALLER THAN THE CALL IT GUARDS IS NOT A GUARD.
 *
 * Every paid path in the product reserves money before it asks a provider
 * anything, and reconciles to the real figure afterwards. The reservation is the
 * only thing standing between a runaway and the daily cap, and it only works
 * while it is BIGGER than the worst the call can actually cost. If it is
 * smaller, the cap admits work it should have refused and the finalize quietly
 * corrects the books after the money has gone: the ceiling reads as enforced and
 * is not.
 *
 * ─── THE ONE THAT WAS WRONG ─────────────────────────────────────────────────
 *
 * The guided walkthrough held a flat $0.03 per step. The figure came from a
 * comment reasoning "worst case input ~4K tokens, output ~500 tokens", and
 * neither half was enforced anywhere: the request carries the same
 * MAX_OUTPUT_TOKENS ceiling as every other agent call, and the accessible name
 * of a page element went into the prompt with no length cap at all, sixty
 * elements at a time. A single step could cost several times its own hold.
 *
 * ─── WHY THE CHECK IS A DERIVATION AND NOT A NUMBER ─────────────────────────
 *
 * Asserting "the hold is $0.16" would pass on the day somebody raised the output
 * ceiling and left the hold alone, which is the mistake. So the arithmetic is
 * done here, from the same published rates and the same enforced bounds, and the
 * only claim is the relation: hold >= worst case. That is the property, and it
 * survives every future edit to either side.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { anthropicTierTokenRates, ANTHROPIC_TIER_PRICING } from '@/lib/ai/feature-registry';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_ITERATIONS } from '@/lib/agent/loop-core';
import {
  COST_LIMITS,
  deriveReservationUsd,
  RESERVATION_INPUT_HEADROOM_USD,
} from '@/lib/agent/cost-controls';
import { scaleAiReservationUsd } from '@/lib/ai/runtime';
import {
  deriveWalkthroughStepUsd,
  WALKTHROUGH_MAX_INPUT_TOKENS,
} from '@/lib/walkthrough-step';

const SONNET = anthropicTierTokenRates('sonnet');

/** The most a single provider attempt can be charged, given the bounds the
 *  caller actually enforces. */
function worstCaseCallUsd(maxInputTokens: number, maxOutputTokens: number, rates = SONNET): number {
  return (maxInputTokens / 1_000_000) * rates.inputUsdPerMillionTokens
    + (maxOutputTokens / 1_000_000) * rates.outputUsdPerMillionTokens;
}

describe('the guided walkthrough holds enough for the step it is about to run', () => {
  test('one step\'s hold covers one attempt at the output ceiling the request carries', () => {
    const hold = deriveWalkthroughStepUsd(SONNET, MAX_OUTPUT_TOKENS);
    const worst = worstCaseCallUsd(WALKTHROUGH_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
    assert.ok(
      hold >= worst,
      `a walkthrough step may cost up to $${worst.toFixed(4)} and only $${hold.toFixed(2)} is held for it`,
    );
  });

  test('a fallback attempt is held for too, not hoped away', () => {
    // The runtime retries a failed primary against the configured fallback and
    // books BOTH, so one step can be two charged calls. `scaleAiReservationUsd`
    // is what the route puts between the baseline and the reservation; this
    // pins that the pair is covered rather than the more expensive one.
    const pricing = ANTHROPIC_TIER_PRICING.sonnet;
    const hold = scaleAiReservationUsd(
      [
        { provider: 'anthropic', modelId: 'primary', pricing },
        { provider: 'anthropic', modelId: 'fallback', pricing },
      ],
      { usd: deriveWalkthroughStepUsd(SONNET, MAX_OUTPUT_TOKENS), ...SONNET },
    );
    const worstPair = 2 * worstCaseCallUsd(WALKTHROUGH_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
    assert.ok(hold >= worstPair, `two attempts may cost $${worstPair.toFixed(4)}, held $${hold.toFixed(2)}`);
  });

  test('raising the output ceiling raises the hold rather than widening the gap', () => {
    // The regression the flat number allowed: a bound moves, the hold does not.
    const doubled = deriveWalkthroughStepUsd(SONNET, MAX_OUTPUT_TOKENS * 2);
    assert.ok(doubled > deriveWalkthroughStepUsd(SONNET, MAX_OUTPUT_TOKENS));
  });
});

describe('the chat turn holds enough for the loop it is about to run', () => {
  test('the per-request hold still covers every iteration at the output ceiling', () => {
    // The control. This one was already derived from its own bounds, and it is
    // here so the suite states the rule rather than one exception to it: if this
    // ever stops holding, the same class of bug has reached the busiest path in
    // the product.
    const worstOutput = (MAX_OUTPUT_TOKENS / 1_000_000)
      * SONNET.outputUsdPerMillionTokens
      * MAX_TOOL_ITERATIONS;
    assert.ok(
      COST_LIMITS.estimatedRequestUsd >= worstOutput,
      `a chat turn may emit $${worstOutput.toFixed(4)} of output and only $${COST_LIMITS.estimatedRequestUsd} is held`,
    );
    // And the input headroom is on top of that, not inside it.
    assert.equal(
      COST_LIMITS.estimatedRequestUsd,
      deriveReservationUsd({
        outputUsdPerMillionTokens: SONNET.outputUsdPerMillionTokens,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxToolIterations: MAX_TOOL_ITERATIONS,
        inputHeadroomUsd: RESERVATION_INPUT_HEADROOM_USD,
      }),
    );
  });
});
