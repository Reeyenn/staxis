// ─── Teach it your way ───────────────────────────────────────────────────────
//
// One tool: `staxis_set_standing_rule`. A manager says something like "always
// tell me before any order over $200" and, from then on, the copilot at THIS
// hotel carries that sentence in its system prompt.
//
// TWO CALLS, AND THE SECOND ONE NEEDS A HUMAN. Exactly the shape of
// staxis_write_company_rule next door, and for the same reason: the model
// setting an argument called `confirmToken` is not a person agreeing to
// anything. The first call validates, writes NOTHING, and returns the rule read
// back VERBATIM. The second writes, using the text frozen by the first, and only
// once the route has recorded a message from the person since that read-back.
// The full argument lives in src/lib/agent/chat-confirm.ts.
//
// WHY THE READ-BACK IS VERBATIM AND NOT STRUCTURED
// This is the one place that differs from its neighbours, and the difference is
// the whole feature. A preventive task read back as "every 180 days, next due
// 11 September" is a service to the manager, because they said "every six
// months" and needed to find out what we heard. A standing rule read back as a
// tidied paraphrase is the opposite: it is the companion deciding what somebody
// meant, and then following its own paraphrase forever. So the rule is quoted
// back exactly, and what the manager approves is the string that gets stored.
//
// WHAT THIS TOOL CANNOT DO
// Grant anything. A rule is prose in an untrusted envelope inside the prompt
// (see hotel-rules-tier.ts), fenced against instructing the model to skip a
// tool, to claim something was done, or to reach data the reader could not
// already see. "Always let the front desk see wages" stores fine and changes
// nothing, because the wage gate is a capability check in a route, not a
// sentence in a prompt.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import { proposeConfirmation, takeConfirmation, confirmedMarker } from '../chat-confirm';
import { canManageTeam } from '@/lib/roles';
import {
  storeStandingRule,
  listStandingRules,
  STANDING_RULE_MAX_CHARS,
  STANDING_RULE_MIN_CHARS,
} from '@/lib/companion/rules';
import { ruleReadBack, ruleSavedLine, normalizeRule } from '@/lib/companion/copy';

const MANAGER_ROLES = ['admin', 'owner', 'general_manager'] as const;

interface StandingRuleParams {
  propertyId: string;
  ruleText: string;
}

/**
 * The hat that is asking, re-checked at the write.
 *
 * `ctx.user.role` is the account's global role; the per-hotel standing that the
 * route resolved rides on the context as `hotelMutationAllowed`. Both have to be
 * satisfied: a company user acting at a hotel they may only read must not be
 * able to legislate for it.
 */
function canSetRules(ctx: ToolHandlerContext): boolean {
  if (!canManageTeam(ctx.user.role)) return false;
  return ctx.user.hotelMutationAllowed !== false;
}

registerTool<{ rule?: string; confirmToken?: string }>({
  name: 'staxis_set_standing_rule',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description: [
    'Use when a manager tells you how they want things done from now on, in their own words:',
    '"always tell me before any order over $200", "never promise a late checkout without asking me",',
    '"check the pool chemicals before you close a maintenance ticket about the pool".',
    'Two calls. FIRST call with `rule` only: nothing is written, and you get the rule read back plus a token.',
    'Say the read-back to the person and wait. SECOND call with `confirmToken` ONLY after they have replied yes',
    'in a new message. Args: rule (their sentence, 8 to 400 characters, kept word for word),',
    'confirmToken (from the first call). Returns: the stored rule.',
    'Refuses: a rule that is too short or too long, a hotel that already has forty rules,',
    'and anyone who is not a manager at this hotel.',
    'Do NOT use for a one-off request ("order towels today"), for a fact about the hotel (use `remember`),',
    'or for a company-wide policy across several hotels (use staxis_write_company_rule).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      rule: {
        type: 'string',
        description:
          'The standing instruction, in the person\'s own words. Do not tidy it, shorten it or rephrase it. '
          + 'One rule per call.',
      },
      confirmToken: {
        type: 'string',
        description: 'Send ONLY after the person has said yes in a new message.',
      },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ══ the confirm half ══
    if (args.confirmToken) {
      const taken = await takeConfirmation<StandingRuleParams>(
        ctx,
        'hotel_standing_rule',
        args.confirmToken,
      );
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;

      // Never trust that the frozen params survived intact, and never trust the
      // property that came back with them: the rule is written to the hotel this
      // REQUEST is scoped to, so a token minted elsewhere cannot aim a write.
      if (!p || typeof p.ruleText !== 'string' || p.propertyId !== ctx.propertyId) {
        return {
          ok: false,
          error: 'What you agreed to did not survive intact, so I have not saved it. Tell me the rule again.',
        };
      }

      // Standing is re-checked at the WRITE, never read off the proposal.
      // Authority can change between the read-back and the yes, and the answer
      // that governs is the one that is true now.
      if (!canSetRules(ctx)) {
        return {
          ok: false,
          error: 'Standing rules are set by a manager at this hotel, and I have not saved this one. '
            + 'Ask your general manager or owner to tell me.',
        };
      }

      if (ctx.dryRun) {
        return {
          ok: true,
          data: { ...confirmedMarker(args.confirmToken), saved: p.ruleText, dryRun: true },
        };
      }

      const stored = await storeStandingRule({
        propertyId: ctx.propertyId,
        ruleText: p.ruleText,
        accountId: ctx.user.accountId,
        authorName: ctx.user.displayName || null,
        authorRole: ctx.user.role,
      });
      if (!stored.ok) return { ok: false, error: stored.error };

      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          saved: { id: stored.rule.id, rule: stored.rule.ruleText },
          say: ruleSavedLine(stored.rule.ruleText),
          note: 'Saved and confirmed. It is on the Knows tab under Standing rules, where anyone can '
            + 'read it and a manager can remove it.',
        },
      };
    }

    // ══ the propose half — writes NOTHING ══
    if (!canSetRules(ctx)) {
      return {
        ok: false,
        error: 'Standing rules are set by a manager at this hotel. Ask your general manager or owner to tell me.',
      };
    }

    const ruleText = normalizeRule(String(args.rule ?? ''));
    if (ruleText.length < STANDING_RULE_MIN_CHARS) {
      return {
        ok: false,
        error: 'What is the rule? Say it as a full sentence, the way you would tell a new manager.',
      };
    }
    if (ruleText.length > STANDING_RULE_MAX_CHARS) {
      return {
        ok: false,
        error: `Keep it under ${STANDING_RULE_MAX_CHARS} characters. If that is two rules, tell me the first one.`,
      };
    }

    const existing = await listStandingRules(ctx.propertyId);
    const duplicate = existing.find(
      (r) => r.ruleText.toLowerCase() === ruleText.toLowerCase(),
    );
    if (duplicate) {
      // Not an error. The person asked for something that is already true, and
      // telling them so is a better answer than storing it twice.
      return {
        ok: true,
        data: {
          alreadyKnown: true,
          rule: duplicate.ruleText,
          note: 'This is already a standing rule here, so nothing was written. Say so and move on.',
        },
      };
    }

    const params: StandingRuleParams = { propertyId: ctx.propertyId, ruleText };
    const readBackEn = ruleReadBack(ruleText);
    return {
      ok: true,
      data: {
        ...(await proposeConfirmation(ctx, 'hotel_standing_rule', params, {
          en: readBackEn,
          // The confirmation layer's ReadBack shape carries both languages. The
          // product is English only (founder ruling 2026-07-29), and this is
          // model-facing structured data rather than rendered copy, so the two
          // slots carry the same sentence rather than growing a translation.
          es: readBackEn,
        })),
        say: readBackEn,
        note: 'Nothing is written yet. Say the read-back word for word and wait for a plain yes.',
      },
    };
  },
});
