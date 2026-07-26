// ─── Answering Staxis in the conversation ────────────────────────────────────
//
// Two tools, and between them the chat becomes another finger for the buttons
// the Staxis tab already has:
//
//   staxis_decide_pending_action   approve the fix Staxis is offering, undo one,
//                                  record a verdict on a card, or close out an
//                                  upkeep schedule — "yes, raise the work order",
//                                  "we're not doing that one", "the flush is done"
//   staxis_todays_question         surface the one question Staxis has for this
//                                  hotel today, and take the answer
//
// ═══ NOTHING HERE IS A SECOND EXECUTION PATH ═══
// Approving runs `staxis_execute_finding_action` — the same plpgsql function
// the card's button calls, in one transaction, against the params FROZEN the
// night the offer was written. That function re-derives the finding's receipt
// inside the transaction and DECLINES if the facts have moved; it makes a
// double tap one action by itself. This file does not verify, does not compute a
// plan, and does not decide anything the card would not: it names an action id
// and reads back the answer. If a fix ever needs changing, it changes in the
// catalog and in SQL, and both surfaces change with it.
//
// The company's signature is enforced the same way too, by resolving it FRESH at
// the moment of the write (`resolveSignOffStrict`) rather than reading a locked
// flag off the proposal — so a rule the company wrote this morning governs an
// offer frozen last night, and "we could not read the rulebook" refuses instead
// of guessing. A rule-gated action is refused in chat in exactly the words the
// card would use: it is in somebody else's queue, and saying so is the answer.
//
// AND THE HUMAN STILL SAYS YES.
// Both tools are two calls (src/lib/agent/chat-confirm.ts): the first reads the
// offer back in the hotel's own words and writes nothing; the second acts, and
// only once the route has recorded a message FROM THE PERSON since that
// read-back. "What needs my decision?" can never end with something having been
// decided.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  proposeConfirmation,
  takeConfirmation,
  confirmedMarker,
} from '../chat-confirm';
import { loadFinding, setFindingStatus, recordFindingActed } from '@/lib/findings/store';
import {
  loadAction,
  loadActionsForFindings,
  executeAction,
  undoAction,
} from '@/lib/findings/actions/store';
import { getAction } from '@/lib/findings/actions/registry';
import { logPreventiveOutcome, PREVENTIVE_DETECTOR_ID } from '@/lib/findings/preventive-log';
import { formatMoneyRange } from '@/lib/findings/pricing';
import { resolveCompanyForProperty } from '@/lib/company/access';
import { resolveSignOffStrict } from '@/lib/company/signoff';
import { effectiveDisposition } from '@/components/concourse/finding-cards';
import { getDripQuestion, answerDripQuestion } from '../drip-questions';
import type { Finding } from '@/lib/findings/types';

const MANAGER_ROLES = ['admin', 'owner', 'general_manager'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// staxis_decide_pending_action
// ═══════════════════════════════════════════════════════════════════════════

const DECISIONS = ['approve', 'undo', 'not_doing_it', 'seen', 'handled', 'pm_done', 'pm_called'] as const;
type Decision = typeof DECISIONS[number];

interface DecisionParams {
  findingId: string;
  decision: Decision;
  /** The action row the approval/undo will run. Null for the verdicts. */
  actionId: string | null;
  /** What the person was told they were agreeing to, frozen. */
  offer: string | null;
}

/** The sign-off gate, in the same three states and with the same refusals the
 *  execute route uses. A gate that guesses is not a gate. */
type Gate =
  | { state: 'allowed' }
  | { state: 'blocked'; why: string }
  | { state: 'unavailable'; why: string };

async function signOffGate(
  ctx: ToolHandlerContext,
  finding: Finding,
  actionKind: string,
): Promise<Gate> {
  const company = await resolveCompanyForProperty(ctx.propertyId);
  if (company.status === 'unavailable') {
    return { state: 'unavailable', why: 'I could not tell which company runs this hotel, so I have not done it. Say that plainly and try again in a moment — do not describe it as blocked.' };
  }
  if (company.status === 'ambiguous') {
    return { state: 'unavailable', why: 'Two companies both claim this hotel, so I cannot tell whose approval rules apply. Nothing has been done; somebody has to sort that out first.' };
  }
  if (company.status === 'independent') return { state: 'allowed' };

  let resolution;
  try {
    resolution = await resolveSignOffStrict({
      organizationId: company.organizationId,
      propertyId: ctx.propertyId,
      actionKind,
      price: finding.price,
      callerAccountId: ctx.user.accountId,
    });
  } catch {
    return { state: 'unavailable', why: 'I could not read this company\'s approval rules just now, so I have not done it. Try again in a moment — do NOT tell them it is approved.' };
  }
  if (resolution.kind === 'unreadable') {
    return { state: 'unavailable', why: 'I could not read this company\'s approval rules just now, so I have not done it. Try again in a moment — do NOT tell them it is approved.' };
  }
  if (resolution.kind === 'none' || resolution.requirement.callerMayApprove) return { state: 'allowed' };

  const named = resolution.requirement.approvers
    .map((a) => a.name)
    .filter((n): n is string => !!n && n.trim().length > 0);
  return {
    state: 'blocked',
    why: named.length > 0
      ? `That one needs ${named.join(', ')} to sign it off — it is in their queue. Tell them that; do not try another way to get it done.`
      : 'Your company\'s rules send that one to somebody else to sign off, and nobody there currently holds that job. Tell them exactly that.',
  };
}

registerTool<{ findingId?: string; decision?: string; confirmToken?: string }>({
  name: 'staxis_decide_pending_action',
  section: 'staxis',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description:
    'Act on something Staxis has raised — approve the one-tap fix it is offering, undo one it already ran, record what the manager decided about a card, or close out an upkeep schedule. This is the same button the Staxis tab shows, reached by talking. ' +
    'Use when: the person answers a card — "yes, raise that work order", "go ahead", "we\'re not doing that one", "I already fixed it", "the water heater flush is done", "somebody\'s coming out Tuesday", "undo that", "sí, hazlo". Find what is waiting first with staxis_pending_decisions or staxis_findings, and use the id from there rather than guessing one. ' +
    'Args: findingId — the id of the thing being decided, from staxis_pending_decisions or staxis_findings. decision — approve (run the fix Staxis offered), undo (reverse one it ran), not_doing_it (they have decided against it; Staxis goes quiet), seen (they know about it and want it quiet unless it grows), handled (they have already dealt with it), pm_done (the upkeep job has been done, which restarts its clock), pm_called (somebody has been called out, so it rests for a week). confirmToken — ONLY on the second call, after they have said yes. ' +
    'Returns: on the first call { awaitingConfirmation, readBack, confirm } carrying the OFFER IN STAXIS\'S OWN WORDS and its dollar range — read that back and wait. On the second call, what the database actually did, including its receipt. ' +
    'Refuses: an approval the company\'s rules send to somebody else — you are told who, by name, and telling the person that IS the answer; never look for another route to the same outcome. It refuses when the rulebook cannot be read at all, rather than guessing that nothing governs it. It refuses to act on the first call and refuses a confirmToken when the person has not answered you since the read-back. Approving twice is ONE action: if it comes back already done, say it was already done rather than reporting a second one. And the database re-checks the facts inside the write — if it declines because they moved, report exactly that and do not retry.',
  inputSchema: {
    type: 'object',
    properties: {
      findingId: { type: 'string', description: 'The finding being decided, from staxis_pending_decisions or staxis_findings.' },
      decision: { type: 'string', enum: [...DECISIONS], description: 'What they decided: approve, undo, not_doing_it, seen, handled, pm_done or pm_called.' },
      confirmToken: { type: 'string', description: 'The token from your earlier proposal. Send ONLY after the person has said yes in a new message.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the confirm half ──
    if (args.confirmToken) {
      const taken = await takeConfirmation<DecisionParams>(ctx, 'finding_decision', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;
      if (!p || typeof p.findingId !== 'string' || !(DECISIONS as readonly string[]).includes(p.decision)) {
        return { ok: false, error: 'What you agreed to did not survive intact, so I have done nothing. Ask again from the top.' };
      }

      const finding = await loadFinding(ctx.propertyId, p.findingId).catch(() => null);
      if (!finding) {
        return { ok: false, error: 'That is not a finding at this hotel any more. Nothing was done.' };
      }

      if (p.decision === 'approve' || p.decision === 'undo') {
        if (!p.actionId) {
          return { ok: false, error: 'There is no one-tap fix attached to that one, so there is nothing to run. Nothing was done.' };
        }
        // The company's signature, resolved FRESH — a rule written this morning
        // governs an offer frozen last night, and the answer that matters is the
        // one that is true at the write. Undo is deliberately NOT gated: a
        // manager left holding a fix they can no longer reverse is worse off
        // than one who was never allowed to run it.
        if (p.decision === 'approve') {
          // The EXACT row that will run, by id — not "whatever is attached to
          // this finding now". A re-find between the read-back and the yes can
          // have superseded the offer, and gating the row we will not execute
          // would be checking the wrong plan's price.
          const action = await loadAction(ctx.propertyId, p.actionId).catch(() => null);
          if (!action) {
            return { ok: false, error: 'That offer is not there any more, so nothing was done. Ask them to look again in the Staxis tab.' };
          }
          const gate = await signOffGate(ctx, finding, action.kind);
          if (gate.state !== 'allowed') return { ok: false, error: gate.why };
        }

        if (ctx.dryRun) {
          return { ok: true, data: { ...confirmedMarker(args.confirmToken), code: 'dry_run', dryRun: true } };
        }

        let result;
        try {
          result = p.decision === 'approve'
            ? await executeAction(ctx.propertyId, p.actionId, ctx.user.accountId)
            : await undoAction(ctx.propertyId, p.actionId, ctx.user.accountId);
        } catch {
          // Deliberately NOT "it worked": an error here means we do not know
          // what the database did, and a confident sentence on an unknown
          // outcome is the exact failure the whole re-verification layer exists
          // to prevent.
          return { ok: false, error: 'Something went wrong and I cannot tell whether it went through. Say exactly that, and that they should check the Staxis tab.' };
        }
        await recordFindingActed(ctx.propertyId, p.findingId);

        return {
          ok: true,
          data: {
            ...confirmedMarker(args.confirmToken),
            // The database's own verdict, not ours: 'executed', 'already_executed'
            // (a second yes on the same offer — ONE action), 'declined_changed'
            // (the facts moved, so it refused), 'undone', 'undo_refused_touched'.
            code: result.code,
            done: result.ok,
            receipt: result.receipt ?? null,
            whatChanged: result.changed ?? null,
            why: result.why ?? null,
            howToSayIt: result.code === 'already_executed'
              ? 'This was already done earlier — say so. Do not report it as a second action.'
              : result.code === 'declined_changed'
                ? 'Staxis refused because the situation had moved since the offer was made. Say what changed and that nothing was done.'
                : null,
          },
        };
      }

      if (p.decision === 'pm_done' || p.decision === 'pm_called') {
        if (ctx.dryRun) {
          return { ok: true, data: { ...confirmedMarker(args.confirmToken), dryRun: true } };
        }
        // The schedule write happens FIRST, exactly as the card's route does it:
        // closing the card and then failing to move the date would leave them
        // believing a flush is on record that Staxis has no trace of.
        const logged = await logPreventiveOutcome(
          ctx.propertyId,
          p.findingId,
          p.decision === 'pm_done' ? 'done' : 'called',
          ctx.user.displayName || null,
        );
        if (!logged.ok) {
          return {
            ok: false,
            error: logged.because === 'not_a_preventive_finding'
              ? 'That card is not about an upkeep schedule, so there is no date to move. Nothing was recorded.'
              : 'I could not find that schedule any more, so nothing was recorded.',
          };
        }
        await recordFindingActed(ctx.propertyId, p.findingId);
        await setFindingStatus(ctx.propertyId, p.findingId, 'resolved', ctx.user.accountId);
        return {
          ok: true,
          data: { ...confirmedMarker(args.confirmToken), recorded: logged.result, status: 'resolved' },
        };
      }

      // The three verdicts. Same statuses the card's own buttons write.
      const status = p.decision === 'not_doing_it' ? 'muted'
        : p.decision === 'seen' ? 'known_problem'
        : 'resolved';
      if (ctx.dryRun) {
        return { ok: true, data: { ...confirmedMarker(args.confirmToken), status, dryRun: true } };
      }
      await recordFindingActed(ctx.propertyId, p.findingId);
      const updated = await setFindingStatus(ctx.propertyId, p.findingId, status, ctx.user.accountId);
      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          status: updated?.status ?? status,
          note: status === 'known_problem'
            ? 'Recorded as known. Staxis will stay quiet about it unless it gets bigger — that is NOT the same as it being fixed, so do not say it is handled.'
            : status === 'muted'
              ? 'Muted. Staxis will not raise it again.'
              : 'Marked as handled. If it comes back it will be raised as a new one.',
        },
      };
    }

    // ── the propose half — writes nothing ──
    const findingId = String(args.findingId ?? '').trim();
    if (!findingId) {
      return { ok: false, error: 'Which one? Get the id from staxis_pending_decisions or staxis_findings — do not guess it.' };
    }
    const decision = String(args.decision ?? '').trim() as Decision;
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      return { ok: false, error: `What did they decide? One of: ${DECISIONS.join(', ')}.` };
    }

    let finding: Finding | null;
    try {
      finding = await loadFinding(ctx.propertyId, findingId);
    } catch {
      return { ok: false, error: 'I could not read that finding, so I have proposed nothing. Try again in a moment.' };
    }
    if (!finding) {
      return { ok: false, error: 'No finding with that id at this hotel. Get the id from staxis_findings rather than guessing it.' };
    }

    const summary = finding.judgedSummaryEn ?? finding.summary;
    const price = finding.price
      ? formatMoneyRange(finding.price.lowCents, finding.price.highCents, finding.price.currency)
      : null;

    let actionId: string | null = null;
    let offer: string | null = null;
    if (decision === 'approve' || decision === 'undo') {
      const action = (await loadActionsForFindings(ctx.propertyId, [findingId])).get(findingId);
      if (!action) {
        return { ok: false, error: 'Staxis has no one-tap fix attached to that one — it has to be handled by hand. Say so rather than offering to run something.' };
      }
      if (decision === 'approve' && action.state !== 'proposed') {
        return {
          ok: false,
          error: action.state === 'executed'
            ? 'That fix has already been run. Tell them it is done — do not offer to run it again.'
            : `That offer is no longer live (it is "${action.state}"), so there is nothing to approve. Say that.`,
        };
      }
      if (decision === 'undo' && action.state !== 'executed') {
        return { ok: false, error: 'Nothing has been run on that one, so there is nothing to undo.' };
      }
      actionId = action.id;
      const definition = getAction(action.kind);
      // The offer sentence is built server-side from the FROZEN params, never
      // from the model's reading of the finding. A plan the catalog refuses has
      // no sentence, and therefore no offer to agree to.
      if (!definition || definition.validate(action.params)) {
        return { ok: false, error: 'I cannot describe that fix accurately, so I will not offer to run it. Tell them to open it in the Staxis tab.' };
      }
      offer = definition.offer(action.params).en;

      if (decision === 'approve') {
        const gate = await signOffGate(ctx, finding, action.kind);
        if (gate.state !== 'allowed') return { ok: false, error: gate.why };
      }
    }

    if ((decision === 'pm_done' || decision === 'pm_called') && finding.detectorId !== PREVENTIVE_DETECTOR_ID) {
      return { ok: false, error: 'That card is not about an upkeep schedule, so "done" and "somebody\'s been called" do not apply to it. Pick handled, seen or not_doing_it instead.' };
    }

    const params: DecisionParams = { findingId, decision, actionId, offer };

    const sentence: Record<Decision, { en: string; es: string }> = {
      approve: {
        en: `Go ahead with: ${offer}${price ? ` (Staxis puts it at roughly ${price})` : ''}. Right?`,
        es: `Adelante con: ${offer}${price ? ` (Staxis lo estima en unos ${price})` : ''}. ¿Correcto?`,
      },
      undo: {
        en: `Undo what Staxis did for "${summary}" — ${offer}. Right?`,
        es: `Deshacer lo que Staxis hizo por "${summary}" — ${offer}. ¿Correcto?`,
      },
      not_doing_it: {
        en: `Not doing anything about "${summary}" — Staxis will stop raising it. Right?`,
        es: `No haremos nada con "${summary}" — Staxis dejará de mencionarlo. ¿Correcto?`,
      },
      seen: {
        en: `Mark "${summary}" as a known problem — quiet unless it gets bigger, and NOT recorded as fixed. Right?`,
        es: `Marcar "${summary}" como un problema conocido — en silencio salvo que crezca, y NO como arreglado. ¿Correcto?`,
      },
      handled: {
        en: `Mark "${summary}" as already handled. Right?`,
        es: `Marcar "${summary}" como ya resuelto. ¿Correcto?`,
      },
      pm_done: {
        en: `Record that job as done today, which restarts its schedule from now. Right?`,
        es: `Registrar ese trabajo como hecho hoy, lo que reinicia su ciclo desde ahora. ¿Correcto?`,
      },
      pm_called: {
        en: `Record that somebody has been called out for it — Staxis rests it for a week and then asks again. Right?`,
        es: `Registrar que ya llamaron a alguien — Staxis lo deja en pausa una semana y luego vuelve a preguntar. ¿Correcto?`,
      },
    };

    return {
      ok: true,
      data: {
        ...await proposeConfirmation(ctx, 'finding_decision', params, sentence[decision]),
        about: {
          summary,
          price,
          disposition: effectiveDisposition(finding),
          offer,
        },
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// staxis_todays_question
// ═══════════════════════════════════════════════════════════════════════════

interface QuestionParams {
  topic: string;
  /** The exact sentence the person was asked. Frozen so the answer is recorded
   *  against the question they actually heard, not a later rephrasing of it. */
  question: string;
}

registerTool<{ answer?: string; confirmToken?: string }>({
  name: 'staxis_todays_question',
  section: 'staxis',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description:
    'The ONE question Staxis has for this hotel today — a pattern it has noticed and cannot settle on its own — and the manager\'s yes or no to it. ' +
    'Use when: the person asks what Staxis wants to know, "anything you need from me", "what are you asking", "¿tienes alguna pregunta?" — or when they answer one you have already put to them. Do NOT go looking for it in the middle of another task: it is a one-a-day interruption by design, and asking it while they are doing something else is exactly what it exists not to be. ' +
    'Args: answer — yes or no, ONLY when they are answering a question you already read out. confirmToken — the token from that question, sent with their answer. Call it with neither to see whether there is a question at all. ' +
    'Returns: with no arguments, either the question in both languages plus a token, or a plain "nothing today". With an answer and a token, what their answer did — a yes becomes a permanent, human-authored fact this hotel is credited with, or a piece of equipment on the register. ' +
    'Refuses: answering without the token from the question you actually asked, and answering before the person has replied to you. Asking for a question twice in one day gets nothing the second time — that is the point, so say there is nothing rather than hunting for something to ask. A "no" is a real answer and is recorded as one: it is never asked again, so never soften it into "maybe later".',
  inputSchema: {
    type: 'object',
    properties: {
      answer: { type: 'string', enum: ['yes', 'no'], description: 'The manager\'s answer to the question you already read out. Omit to fetch the question.' },
      confirmToken: { type: 'string', description: 'The token that came with the question. Send it with their answer, never before.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the answer half ──
    if (args.answer !== undefined || args.confirmToken !== undefined) {
      const answer = String(args.answer ?? '').trim();
      if (answer !== 'yes' && answer !== 'no') {
        return { ok: false, error: 'Was that a yes or a no? Ask them plainly rather than deciding for them.' };
      }
      const taken = await takeConfirmation<QuestionParams>(ctx, 'hotel_question', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;
      if (!p || typeof p.topic !== 'string') {
        return { ok: false, error: 'I lost track of which question that answers, so I have recorded nothing. Ask for the question again.' };
      }
      if (ctx.dryRun) {
        return { ok: true, data: { ...confirmedMarker(String(args.confirmToken)), recorded: true, dryRun: true } };
      }

      // Straight through the drip module, which owns "one a day", "never
      // twice", and what a yes is worth. This tool is a second way IN, not a
      // second set of rules.
      const result = await answerDripQuestion({
        propertyId: ctx.propertyId,
        topic: p.topic,
        answer,
        actor: {
          accountId: ctx.user.accountId,
          name: ctx.user.displayName || null,
          role: ctx.user.role,
        },
      });
      if (!result.ok) {
        return { ok: false, error: 'I could not record that answer, so nothing has been saved. Try again in a moment.' };
      }
      if (!result.recorded) {
        return {
          ok: true,
          data: {
            ...confirmedMarker(String(args.confirmToken)),
            recorded: false,
            note: 'That question had already been answered — probably on the card. Nothing changed; say so rather than thanking them for an answer that did not land.',
          },
        };
      }
      return {
        ok: true,
        data: {
          ...confirmedMarker(String(args.confirmToken)),
          recorded: true,
          answer,
          storedFact: result.storedFact === true,
          createdEquipmentId: result.createdEquipmentId ?? null,
          note: answer === 'yes'
            ? 'Recorded as something this hotel now knows, credited to them. It will not be asked again.'
            : 'Recorded as a no. It will not be asked again.',
        },
      };
    }

    // ── the ask half ──
    // Serving RECORDS the ask, which is what makes "ignored means gone for the
    // day" true — so this half does write, to the question ledger and nothing
    // else. It changes nothing about the hotel, which is why the answer below
    // still says nothing has happened yet.
    if (ctx.dryRun) {
      return { ok: true, data: { question: null, dryRun: true } };
    }
    let question;
    try {
      question = await getDripQuestion(ctx.propertyId);
    } catch {
      return { ok: false, error: 'I could not check whether there is a question for this hotel. Try again in a moment.' };
    }
    if (!question) {
      return {
        ok: true,
        data: {
          question: null,
          note: 'Nothing to ask today. That is the normal answer most days — do not invent a question to fill the space.',
        },
      };
    }

    const params: QuestionParams = { topic: question.topic, question: question.en };
    return {
      ok: true,
      data: {
        ...await proposeConfirmation(ctx, 'hotel_question', params, { en: question.en, es: question.es }),
        category: question.category,
        howToAsk: 'Put this question to them in their own language, exactly as written, and stop. When they answer, call this tool again with their answer and the token.',
      },
    };
  },
});
