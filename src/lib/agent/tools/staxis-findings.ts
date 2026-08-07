// ─── The SEE tools: what Staxis itself has noticed ─────────────────────────
//
// Six read-only tools that give the chat the same eyes the Staxis tab has.
// Before these, the assistant could read every operational table in the hotel
// and still answer "what has Staxis noticed?" with nothing — the findings
// engine, the one-tap offers, preventive schedules, the equipment registry and
// the nightly run record were all invisible to it. A manager asking the chat
// the single question the product exists to answer got a shrug.
//
// Design rules, all of them load-bearing:
//
//  1. READ-ONLY, every one. Approving a proposal from chat is a separate piece
//     of work with its own gate; nothing here writes, and no tool declares
//     `mutates`. `staxis_pending_decisions` deliberately reports sign-off state
//     WITHOUT offering to satisfy it.
//
//  2. Every number is computed HERE, in code, and handed to the model as a
//     finished value — totals, counts, day-spans, money ranges. The model
//     quotes; it never derives. This is the same rule the findings judge runs
//     under (prose-guard), for the same reason: a model that adds up a list in
//     prose gets it right until the day it matters.
//
//  3. Money is only ever a RANGE, formatted by `formatMoneyRange`. The findings
//     schema enforces range-or-nothing at the database level (low < high, both
//     or neither), and a point estimate is the one thing a GM will repeat to
//     an owner. Never surface `price_low_cents` on its own.
//
//  4. Everything routes through `ctx.db` (scoped-db) or a `src/lib/findings`
//     helper that does — the one-hotel wall (INV-25/INV-29). No tool here takes
//     a property id from its arguments.
//
//  5. Role-gated, and effectiveRole (not a global role) is what put the caller
//     in this conversation. Five of the six are open to the MAINTENANCE hat as
//     well as the manager tier (2026-07-27) — the wrench could not previously
//     ask what Staxis had noticed about the room it was standing in. That hat's
//     view carries no money and only findings attached to a room, a schedule or
//     a machine; see STAXIS_WRENCH_ROLES. `staxis_pending_decisions` stays
//     manager-only: an approval queue is not floor work. Preventive + equipment
//     additionally carry `section: 'maintenance'`, matching their own feed
//     loaders, which are section-gated the same way; the rest carry
//     `section: 'staxis'` so a hotel that has turned the Staxis tab off does not
//     get its findings through a side door.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  listFindings,
  loadFinding,
  latestRunFacts,
} from '@/lib/findings/store';
import { loadActionsForFindings } from '@/lib/findings/actions/store';
import { getAction } from '@/lib/findings/actions/registry';
import { resolveSignOffStrict } from '@/lib/company/signoff';
import { resolveCompanyForProperty } from '@/lib/company/access';
import {
  findingsForTarget,
  isFindingTargetKind,
  resolveFindingTarget,
} from '@/lib/findings/targeting';
import { formatMoneyRange, formatCents } from '@/lib/findings/pricing';
import { scheduleState } from '@/lib/findings/detectors/preventive-due';
import { daysBetweenDates, type PreventiveScheduleEntry } from '@/lib/findings/history';
import {
  effectiveDisposition,
  livenessLine,
  skippedNote,
  RUN_FRESH_HOURS,
} from '@/components/concourse/finding-cards';
import { moneyVisibleToRole } from '../lenses';
import { workOrderIsSettled } from '@/lib/db-mappers';
import type { AppRole } from '@/lib/roles';
import type { Finding, FindingTargetKind } from '@/lib/findings/types';

const STAXIS_ROLES = ['admin', 'owner', 'general_manager'] as const;

/**
 * The manager tier PLUS the maintenance hat (2026-07-27, WHO LENSES).
 *
 * Every piece of maintenance intelligence Staxis has — what it noticed about a
 * room, what is due, which units keep failing, whether the checks even ran —
 * was gated to managers, so the person actually holding the wrench could not
 * ask any of it. That was never a decision; it was `STAXIS_ROLES` being the
 * only constant in the file when these six were written.
 *
 * `staxis_pending_decisions` deliberately keeps the narrow list: an approval
 * queue is the manager's, and reading it is how a floor conversation turns into
 * "why hasn't anyone signed this off".
 *
 * The maintenance hat's version of these answers carries NO MONEY — see
 * `moneyVisibleToRole`. The price ranges are stripped from the payload rather
 * than hidden behind a prompt rule, because replacing a batch of PTACs is the
 * manager's decision and a number the model never receives is a number it
 * cannot quote.
 */
const STAXIS_WRENCH_ROLES = ['admin', 'owner', 'general_manager', 'maintenance'] as const;

const TARGET_KINDS = ['room', 'inventory_item', 'preventive_task', 'equipment'] as const;

/**
 * The kinds of thing a maintenance tech can walk up to and touch.
 *
 * A finding about supply spend or an inventory item is a manager's finding: it
 * is about the money and the ordering, and there is nothing the wrench can do
 * with it. Restricting the maintenance lens to findings ATTACHED to a room, a
 * schedule or a machine is the same "on the thing, not the tab" rule the
 * pattern chip encodes — a finding you can go and stand in front of.
 */
const WRENCH_TARGET_KINDS: readonly FindingTargetKind[] = ['room', 'preventive_task', 'equipment'];

/**
 * Findings this hat is allowed to be shown. Managers see everything; the
 * maintenance hat sees only what is attached to a room, a schedule or a machine,
 * and an untargeted finding (a hotel-wide spend baseline) is not shown at all.
 */
function findingsVisibleToRole(rows: Finding[], role: AppRole): Finding[] {
  if (moneyVisibleToRole(role)) return rows;
  return rows.filter((f) => {
    const target = resolveFindingTarget(f.evidence);
    return !!target && WRENCH_TARGET_KINDS.includes(target.kind);
  });
}

/** Range-or-nothing. A finding with no usable price says so in words. */
function priceOf(f: Finding): { range: string | null; basis: string | null } {
  if (!f.price) return { range: null, basis: null };
  return {
    range: formatMoneyRange(f.price.lowCents, f.price.highCents, f.price.currency),
    basis: f.price.basis,
  };
}

/**
 * A ticket's repair cost in DOLLARS, or null when nobody entered one.
 *
 * The null case is the whole point, and `Number()` gets it exactly backwards:
 * `Number(null)` is 0 and `Number('')` is 0, both of which are finite. A naive
 * `Number.isFinite(Number(x))` therefore counts every cost-less ticket as
 * costed and renders it as "$0.00" — telling a manager a repair was free when
 * the truth is that nobody wrote the number down. That inverts the one honesty
 * signal this tool carries: `ticketsWithRecordedCost` exists so "$180" is not
 * read as the machine's lifetime cost when only one of its tickets has a
 * figure on it at all.
 */
function repairCostOf(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The shared row shape for any list of findings we hand the model. */
function summarize(f: Finding, showMoney = true) {
  const price = showMoney ? priceOf(f) : { range: null, basis: null };
  const target = resolveFindingTarget(f.evidence);
  return {
    id: f.id,
    // The judge's phrasing when it has run, the detector's own sentence when it
    // has not. Never both, and never a blend.
    summary: f.judgedSummaryEn ?? f.summary,
    // Effective, not raw: the judge can move a finding down the ladder, and the
    // code clamps how far. This is the disposition the hotel actually sees.
    disposition: effectiveDisposition(f),
    severity: f.severity,
    status: f.status,
    detector: f.detectorId,
    price: price.range,
    priceBasis: price.basis,
    firstSeen: f.firstSeenAt,
    lastSeen: f.lastSeenAt,
    timesSeen: f.occurrenceCount,
    asOf: f.asOf,
    target: target ? { kind: target.kind, value: target.value } : null,
  };
}

// ─── staxis_findings ────────────────────────────────────────────────────────

registerTool<{ targetKind?: string; targetValue?: string; limit?: number }>({
  name: 'staxis_findings',
  section: 'staxis',
  pmsFreshness: 'independent',
  description:
    'What Staxis has NOTICED at this hotel on its own — the open findings its nightly checks have raised, with what each is estimated to be worth. ' +
    'Use when: the user asks what Staxis has found, spotted, noticed or flagged, "anything I should know", "what\'s wrong here", "qué ha encontrado Staxis", or asks what is going on with one specific room or piece of equipment. This is the tool behind the product\'s core promise — reach for it whenever the question is about problems the hotel has not already told you about. To understand WHY one of them was raised, follow up with staxis_explain_finding. ' +
    'Args: targetKind + targetValue — optional pair to narrow to one thing: kind is "room", "equipment", "preventive_task" or "inventory_item", and value is that thing\'s number or id (room "214", or an equipment id from staxis_equipment). Pass both or neither. limit — how many to return, default 20, newest activity first. ' +
    'Returns: { count, findings[] } — each with its summary, how serious it is, whether it needs a decision, its dollar RANGE and the basis for that range, when it was first and last seen, how many times, and what it is about. Counts and money are computed here; quote the range exactly and never reduce it to a single number. ' +
    'Refuses: an unknown target kind. Two honesty rules: an empty list means nothing is OPEN, not that the hotel is fine — a problem someone marked "known" or muted is still there but deliberately quiet, so do not report all-clear. And every price is an ESTIMATED RANGE, never a quote or a bill; say "roughly" and never present it as money already lost or saved. Some roles are not shown money at all: when a finding comes back with no `price`, that is either an unpriced finding or a figure outside your view, so say the dollar side is the manager\'s rather than that there is none.',
  inputSchema: {
    type: 'object',
    properties: {
      targetKind: {
        type: 'string',
        enum: [...TARGET_KINDS],
        description: 'Narrow to findings about one kind of thing. Requires targetValue.',
      },
      targetValue: {
        type: 'string',
        description: 'Which one — a room number like "214", or an equipment / task id. Requires targetKind.',
      },
      limit: { type: 'number', description: 'Max findings to return (default 20, max 100).' },
    },
  },
  allowedRoles: STAXIS_WRENCH_ROLES,
  handler: async ({ targetKind, targetValue, limit }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    if (targetKind && !isFindingTargetKind(targetKind)) {
      return { ok: false, error: `"${targetKind}" is not something Staxis tracks findings about. Use room, equipment, preventive_task or inventory_item.` };
    }
    const max = Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : 20), 100);
    const showMoney = moneyVisibleToRole(ctx.user.role, ctx.surface);

    let rows: Finding[];
    try {
      // 'open' + 'updated' only. known_problem and muted still hold the
      // one-active-row slot but the hotel has deliberately silenced them —
      // surfacing them here would re-raise something a manager already dismissed.
      rows = await listFindings(ctx.propertyId, { statuses: ['open', 'updated'], limit: 200 });
    } catch {
      return { ok: false, error: 'Could not read what Staxis has noticed at this hotel.' };
    }

    // Narrowing to a target reuses the SAME pure matcher the on-the-thing chips
    // use, so the chat and the chip on room 214's own record can never disagree
    // about what is attached to it.
    const visible = findingsVisibleToRole(rows, ctx.user.role);
    const scoped = targetKind && targetValue
      ? findingsForTarget(
          visible.map((f) => ({ ...f, judgedDisposition: f.judgedDisposition })),
          targetKind as FindingTargetKind,
          targetValue,
        )
      : visible;

    const findings = scoped.slice(0, max).map((f) => summarize(f, showMoney));

    return {
      ok: true,
      data: {
        count: findings.length,
        totalOpen: scoped.length,
        target: targetKind && targetValue ? { kind: targetKind, value: targetValue } : null,
        findings,
        note: findings.length === 0
          ? 'Nothing is open right now. That is not the same as "nothing is wrong" — findings someone marked as a known problem or muted are hidden here, and a hotel Staxis has not checked recently has nothing to show. Use staxis_checked_last_night before telling anyone things look fine.'
          : undefined,
      },
    };
  },
});

// ─── staxis_explain_finding ─────────────────────────────────────────────────

registerTool<{ findingId: string }>({
  name: 'staxis_explain_finding',
  section: 'staxis',
  pmsFreshness: 'independent',
  description:
    'The receipt behind ONE finding: the actual rows Staxis counted, the query that produced them, when the data was true, and how the dollar range was arrived at. ' +
    'Use when: the user challenges or wants to understand something Staxis raised — "why is it telling me this", "where did that number come from", "how do you know", "por qué dice eso", "is that right?". Answer from this rather than from the summary sentence: the summary is a claim, and this is the evidence for it. Get the id from staxis_findings or staxis_pending_decisions first. ' +
    'Args: findingId — the id of a finding from staxis_findings. ' +
    'Returns: { summary, evidence, price, timeline, dataAge }. evidence carries the query id Staxis ran, the parameters it ran with (the window, the room, the item), the raw values it got back, and a plain-English basis line. price carries the range and the basis for it. dataAge says how old the oldest input was. ' +
    'Refuses: an id that is not a finding at this hotel. Read the receipt honestly: if `values` does not contain a number, do NOT state that number, and if `priceBasis` says the finding is unpriced, say Staxis could not price it rather than estimating one yourself. When `dataAge` is several days old, say the finding may already be stale. The evidence is what Staxis counted — it is not proof the conclusion is right, and if the numbers do not support the summary, say so. When `price` carries a `withheldReason` instead of a range, the money is outside your view rather than missing — relay that reason and never say Staxis could not price it.',
  inputSchema: {
    type: 'object',
    properties: {
      findingId: { type: 'string', description: 'The finding id, from staxis_findings or staxis_pending_decisions.' },
    },
    required: ['findingId'],
  },
  allowedRoles: STAXIS_WRENCH_ROLES,
  handler: async ({ findingId }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const id = String(findingId ?? '').trim();
    if (!id) return { ok: false, error: 'Which finding? I need its id, from staxis_findings.' };

    const showMoney = moneyVisibleToRole(ctx.user.role, ctx.surface);

    let f: Finding | null;
    try {
      f = await loadFinding(ctx.propertyId, id);
    } catch {
      return { ok: false, error: 'Could not read that finding.' };
    }
    if (!f) {
      return { ok: false, error: 'No finding with that id at this hotel. Get the id from staxis_findings rather than guessing it.' };
    }
    // A hat that cannot list a finding must not be able to read its receipt by
    // pasting the id. Same wall, one layer down — the id is not the permission.
    if (findingsVisibleToRole([f], ctx.user.role).length === 0) {
      return { ok: false, error: 'No finding with that id at this hotel. Get the id from staxis_findings rather than guessing it.' };
    }

    const price = showMoney ? priceOf(f) : { range: null, basis: null };
    const target = resolveFindingTarget(f.evidence);

    return {
      ok: true,
      data: {
        id: f.id,
        summary: f.judgedSummaryEn ?? f.summary,
        disposition: effectiveDisposition(f),
        severity: f.severity,
        status: f.status,
        detector: f.detectorId,
        target: target ? { kind: target.kind, value: target.value } : null,
        evidence: {
          // The named query — the same identifier the detector declared, so a
          // curious manager (or an engineer) can find exactly what ran.
          query: f.evidence?.queryId ?? f.receiptQueryId,
          // What it ran WITH: the window, the room, the item. This is where
          // "last 30 days" lives, and quoting the wrong window is the most
          // common way an explanation goes wrong.
          params: f.evidence?.params ?? {},
          // What it got back. The model may quote these; it may not invent
          // siblings for them.
          values: f.evidence?.values ?? {},
          basis: f.evidence?.basis ?? null,
        },
        price: showMoney
          ? {
              range: price.range,
              basis: price.basis,
              unpricedReason: price.range === null
                ? 'Staxis could not put a range on this one. Say that plainly — do not estimate a figure of your own.'
                : null,
            }
          // NOT `unpricedReason: 'could not price it'` — that would be a lie in
          // the one field whose whole job is honesty about money. "You are not
          // shown this" and "there is no figure" are different sentences, and
          // the model must be able to tell the user which one is true.
          : {
              range: null,
              basis: null,
              withheldReason: 'The money on this finding is not part of what you can see. Say the dollar side is the manager\'s — do NOT say Staxis could not price it, and never estimate a figure yourself.',
            },
        timeline: {
          firstSeen: f.firstSeenAt,
          lastSeen: f.lastSeenAt,
          timesSeen: f.occurrenceCount,
          escalatedAt: f.escalatedAt,
          statusChangedAt: f.statusChangedAt,
        },
        dataAge: {
          asOf: f.asOf,
          weakestInputAgeDays: f.weakestInputAgeDays,
          note: (f.weakestInputAgeDays ?? 0) >= 3
            ? 'The oldest input behind this is several days old — say the finding may already be out of date.'
            : null,
        },
        // Whether a human has already been told, and whether they acted. Useful
        // when the user asks "did anyone look at this?".
        engagement: { timesShown: f.shownCount, timesActed: f.actedCount },
      },
    };
  },
});

// ─── staxis_pending_decisions ───────────────────────────────────────────────

registerTool<{ limit?: number }>({
  name: 'staxis_pending_decisions',
  section: 'staxis',
  pmsFreshness: 'independent',
  description:
    'What is waiting on a human decision: the findings Staxis is proposing to act on, the exact one-tap offer attached to each, and who has to sign it off. ' +
    'Use when: the user asks what needs their decision, "what\'s waiting on me", "anything to approve", "what does Staxis want to do", "qué está esperando". Also reach for it when someone asks why a proposal has not happened yet — the answer is usually a sign-off they did not know about. ' +
    'Args: limit — how many to return, default 20. ' +
    'Returns: { count, decisions[] } — each with the finding, its dollar range, the offer in the words the hotel will see, and signOff: who it is waiting on by name, what threshold triggered it, and whether the person asking can approve it themselves. ' +
    'Refuses: EVERYTHING that changes anything — this tool only reports. It never approves, declines or runs a proposal, so never say you have done one on the strength of having listed it. When the user then decides on one, pass its id to staxis_decide_pending_action, which reads the offer back and waits for their yes before doing anything. Do not read a sign-off requirement as disapproval: it means the rulebook routes a decision this size to someone else. Sign-off has THREE states and they are not interchangeable: `signOff: null` means nothing governs this one, a signOff object means somebody must sign it, and `signOffUnknown: true` means Staxis could not read the rules — say you cannot tell, never that it is clear to approve. When `approvers` is empty the card is still locked, and the honest answer is that nobody at this company currently holds that authority — not that it is approved.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max decisions to return (default 20, max 50).' },
    },
  },
  allowedRoles: STAXIS_ROLES,
  handler: async ({ limit }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const max = Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : 20), 50);

    let rows: Finding[];
    try {
      rows = await listFindings(ctx.propertyId, { statuses: ['open', 'updated'], limit: 200 });
    } catch {
      return { ok: false, error: 'Could not read what is waiting for a decision.' };
    }

    // A "decision" is a finding whose EFFECTIVE disposition is propose — the
    // judge's verdict as clamped by code, not the detector's raw intent.
    const proposals = rows.filter((f) => effectiveDisposition(f) === 'propose').slice(0, max);

    let actions = new Map<string, Awaited<ReturnType<typeof loadActionsForFindings>> extends Map<string, infer V> ? V : never>();
    try {
      actions = await loadActionsForFindings(ctx.propertyId, proposals.map((f) => f.id));
    } catch { /* non-fatal — a proposal with no offer is still a decision */ }

    // Which company governs this hotel decides whose rulebook applies. The
    // 4-state resolver refuses on ambiguity rather than picking a company, and
    // an unreadable answer here must not invent an approver.
    let organizationId: string | null = null;
    let companyNote: string | null = null;
    try {
      const company = await resolveCompanyForProperty(ctx.propertyId);
      if (company.status === 'company') organizationId = company.organizationId;
      else if (company.status === 'ambiguous') {
        companyNote = 'This hotel belongs to more than one company, so Staxis cannot say whose approval rules apply. Say that rather than naming an approver.';
      } else if (company.status === 'unavailable') {
        companyNote = 'Could not read which company governs this hotel, so any sign-off requirement below may be incomplete — do not tell the user a proposal is clear to approve on the strength of a missing requirement.';
      }
      // 'independent' is a real answer, not a gap: a hotel with no management
      // company has no sign-off rules, and the absence of an approver is correct.
    } catch {
      companyNote = 'Could not read which company governs this hotel, so sign-off requirements below may be incomplete.';
    }

    const decisions = [];
    for (const f of proposals) {
      const action = actions.get(f.id);
      // Only a live offer counts as pending. An executed / declined / failed
      // row is history, and describing it as waiting would be a lie.
      const pending = action && action.state === 'proposed' ? action : null;

      let offer: string | null = null;
      if (pending) {
        const def = getAction(pending.kind);
        // The offer sentence is built server-side from the FROZEN params, never
        // from the model's reading of the finding. If the catalog rejects the
        // params, there is no offer to show.
        if (def && !def.validate(pending.params)) {
          offer = def.offer(pending.params).en;
        }
      }

      // STRICT, deliberately. `resolveSignOff` folds "the rulebook could not be
      // read" into null, which a CARD may do (it degrades to an ordinary card
      // and the execute gate catches it later). A SENTENCE may not: the chat has
      // no second gate behind it, so "no sign-off needed" and "we could not
      // check whether a sign-off is needed" would come out of the model's mouth
      // as the same words, and only one of them is true. Unreadable is reported
      // as its own state.
      let signOff: {
        waitingOn: string;
        approvers: string[];
        thresholdCents: number;
        threshold: string;
        youCanApprove: boolean;
      } | null = null;
      let signOffUnknown = false;
      if (organizationId && pending) {
        try {
          const res = await resolveSignOffStrict({
            organizationId,
            propertyId: ctx.propertyId,
            actionKind: pending.kind,
            price: f.price,
            callerAccountId: ctx.user.accountId,
          });
          if (res.kind === 'requirement') {
            const req = res.requirement;
            signOff = {
              waitingOn: req.approverRole,
              approvers: req.approvers.map((a) => a.name).filter((n): n is string => !!n),
              thresholdCents: req.thresholdCents,
              threshold: formatCents(req.thresholdCents),
              youCanApprove: req.callerMayApprove,
            };
          } else if (res.kind === 'unreadable') {
            signOffUnknown = true;
          }
        } catch {
          signOffUnknown = true;
        }
      }

      const price = priceOf(f);
      decisions.push({
        findingId: f.id,
        summary: f.judgedSummaryEn ?? f.summary,
        severity: f.severity,
        price: price.range,
        priceBasis: price.basis,
        offer,
        offerState: pending ? 'waiting for a tap' : (action ? action.state : 'no one-tap offer — this one has to be handled by hand'),
        proposedAt: pending?.proposedAt ?? null,
        signOff,
        // Three states, not two. `null` = nothing governs this. An object =
        // somebody must sign. `signOffUnknown` = WE DO NOT KNOW, which must
        // never be spoken as "no approval needed".
        signOffUnknown: signOffUnknown || undefined,
        signOffUnknownNote: signOffUnknown
          ? 'Staxis could not read this company\'s approval rules for this one. Say that you cannot tell whether it needs someone else\'s sign-off — do NOT say it is clear to approve.'
          : undefined,
        locked: !!signOff && !signOff.youCanApprove,
      });
    }

    return {
      ok: true,
      data: {
        count: decisions.length,
        decisions,
        companyNote,
        howToAct: 'This tool only lists. When the user says what they want done with one, pass its findingId to staxis_decide_pending_action — it reads the offer back and does nothing until they answer. They can also still tap it in the Staxis tab.',
        note: decisions.length === 0
          ? 'Nothing is waiting on a decision right now.'
          : undefined,
      },
    };
  },
});

// ─── staxis_preventive ──────────────────────────────────────────────────────

registerTool<{ includeNotDue?: boolean }>({
  name: 'staxis_preventive',
  section: 'maintenance',
  pmsFreshness: 'independent',
  description:
    'The hotel\'s preventive maintenance schedules and where each one stands — due, overdue, resting after somebody called it in, or never done at all. ' +
    'Use when: the user asks about routine or scheduled maintenance — "what maintenance is due", "are we behind on anything", "when was the boiler last serviced", "qué mantenimiento toca", "what have we not done". For a broken thing right now use staxis_findings or log_complaint instead; this is the planned work. ' +
    'Args: includeNotDue — set true to list every schedule including the ones comfortably in date; leave it off to see only what needs attention. ' +
    'Returns: { counts, tasks[] } — each task with its name, area, how often it should happen, when it was last done, when it is next due, how many days overdue it is, and its state. Every day-count is computed here in the hotel\'s own calendar; quote them rather than working out dates yourself. ' +
    'Refuses: nothing, but read the states precisely because they are not interchangeable. "overdue" means it is past due. "resting" means somebody already called it in and Staxis is deliberately quiet for a week — that is handled, not ignored, so do not chase it. "never_done" means there is no record it has EVER been done, which may mean the schedule is new rather than neglected; say which you can tell. A task missing from this list is a task the hotel never set up — absence is not proof the work is not happening.',
  inputSchema: {
    type: 'object',
    properties: {
      includeNotDue: {
        type: 'boolean',
        description: 'True to include schedules that are not due yet. Default false — only what needs attention.',
      },
    },
  },
  allowedRoles: STAXIS_WRENCH_ROLES,
  handler: async ({ includeNotDue }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const { data, error } = await ctx.db
      .from('preventive_tasks')
      .select('id, name, area, frequency_days, last_completed_at, last_completed_by, called_at, called_by, skipped_at, skipped_by');
    if (error) return { ok: false, error: 'Could not read this hotel\'s preventive maintenance schedules.' };

    // The hotel's own calendar day — a schedule due "today" must not flip a day
    // early because the server runs in UTC.
    const { data: propRow } = await ctx.db.from('properties').select('timezone').maybeSingle();
    const tz = (propRow?.timezone as string | null) ?? null;
    let today: string;
    try {
      today = tz
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
        : new Date().toISOString().slice(0, 10);
    } catch {
      today = new Date().toISOString().slice(0, 10);
    }

    const addDays = (iso: string, n: number): string => {
      const [y, m, d] = iso.split('-').map(Number);
      const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
      dt.setUTCDate(dt.getUTCDate() + n);
      return dt.toISOString().slice(0, 10);
    };

    const tasks = [];
    for (const row of data ?? []) {
      const frequencyDays = Number(row.frequency_days ?? 0);
      if (!(frequencyDays >= 1)) continue; // a schedule with no interval is not a schedule

      const lastDoneAtIso = (row.last_completed_at as string | null) ?? null;
      const lastDoneDate = lastDoneAtIso ? lastDoneAtIso.slice(0, 10) : null;
      const calledAtIso = (row.called_at as string | null) ?? null;
      const skippedAtIso = (row.skipped_at as string | null) ?? null;

      const entry: PreventiveScheduleEntry = {
        id: String(row.id),
        name: String(row.name ?? ''),
        area: (row.area as string | null) ?? null,
        frequencyDays,
        lastDoneDate,
        lastDoneAtIso,
        nextDueDate: lastDoneDate ? addDays(lastDoneDate, frequencyDays) : null,
        calledDate: calledAtIso ? calledAtIso.slice(0, 10) : null,
        calledBy: (row.called_by as string | null) ?? null,
        skippedDate: skippedAtIso ? skippedAtIso.slice(0, 10) : null,
        skippedBy: (row.skipped_by as string | null) ?? null,
      };

      // The SAME state machine the nightly detector runs. Re-implementing
      // "is it due" here would give the chat and the cards two different
      // answers about the same boiler.
      const state = scheduleState(entry, today);
      if (!includeNotDue && state.kind === 'not_due') continue;

      tasks.push({
        id: entry.id,
        name: entry.name,
        area: entry.area,
        everyDays: frequencyDays,
        lastDone: entry.lastDoneDate,
        lastDoneBy: (row.last_completed_by as string | null) ?? null,
        nextDue: entry.nextDueDate,
        // 'not_due' | 'never_done' | 'due' | 'resting' | 'skipped' | 'follow_up'
        state: state.kind,
        daysOverdue: state.kind === 'due' || state.kind === 'follow_up' ? state.daysOverdue : 0,
        daysSinceCalled: state.kind === 'resting' || state.kind === 'follow_up' ? state.daysSinceCalled : null,
        calledBy: entry.calledBy,
        daysSinceLastDone: entry.lastDoneDate ? daysBetweenDates(entry.lastDoneDate, today) : null,
      });
    }

    // Heaviest lateness first — the order a manager would want to read them in.
    tasks.sort((a, b) => b.daysOverdue - a.daysOverdue || a.name.localeCompare(b.name));

    const counts = {
      total: tasks.length,
      overdue: tasks.filter((t) => t.state === 'due' || t.state === 'follow_up').length,
      resting: tasks.filter((t) => t.state === 'resting').length,
      neverDone: tasks.filter((t) => t.state === 'never_done').length,
    };

    return {
      ok: true,
      data: {
        today,
        counts,
        tasks,
        note: tasks.length === 0
          ? (includeNotDue
              ? 'This hotel has no preventive maintenance schedules set up at all.'
              : 'Nothing is due right now. Schedules that are in date are hidden — ask again with includeNotDue to see them all.')
          : undefined,
      },
    };
  },
});

// ─── staxis_equipment ───────────────────────────────────────────────────────

registerTool<{ equipmentId?: string; includeRetired?: boolean }>({
  name: 'staxis_equipment',
  section: 'maintenance',
  pmsFreshness: 'independent',
  description:
    'The hotel\'s equipment register — the physical assets it tracks — with how much trouble each one has been giving and anything Staxis has noticed about it. ' +
    'Use when: the user asks about a piece of kit — "how\'s the boiler been", "which units keep breaking", "what have we spent on that PTAC", "should we replace it", "cómo va el aire de la 214". For today\'s broken thing use staxis_findings; this is the history behind it. ' +
    'Args: equipmentId — one asset\'s id for its full ticket history; omit for the whole register. includeRetired — true to include assets marked replaced or decommissioned, which are excluded by default. ' +
    'Returns: without an id, { count, equipment[] } — each asset with its category, location, status, open and total work orders, and whether Staxis has an open finding about it. With an id, the same plus that asset\'s work-order history and its total recorded repair spend. Counts and totals are computed here — quote them, do not add up tickets yourself. ' +
    'Refuses: an id that is not an asset at this hotel. The register is only what staff have entered: a hotel with an empty register still has equipment, and repair spend is only what someone typed into a ticket, so a low total may mean poor record-keeping rather than a reliable machine. Never recommend replacing something on cost alone — say what the record shows and let the manager decide. Some roles get no cost fields at all; when spend is absent from the payload, say the money side is the manager\'s rather than reporting a machine as cheap to run.',
  inputSchema: {
    type: 'object',
    properties: {
      equipmentId: { type: 'string', description: 'One asset\'s id, for its full history. Omit for the whole register.' },
      includeRetired: { type: 'boolean', description: 'True to include replaced / decommissioned assets. Default false.' },
    },
  },
  allowedRoles: STAXIS_WRENCH_ROLES,
  handler: async ({ equipmentId, includeRetired }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const wanted = String(equipmentId ?? '').trim() || null;
    const showMoney = moneyVisibleToRole(ctx.user.role, ctx.surface);

    let q = ctx.db
      .from('equipment')
      .select('id, name, category, location, status, manufacturer, model_number, install_date, replacement_cost, last_pm_at, warranty_expires_at, created_from');
    if (wanted) q = q.eq('id', wanted);
    const { data: assets, error } = await q;
    if (error) return { ok: false, error: 'Could not read this hotel\'s equipment register.' };

    const rows = (assets ?? []).filter((a) => {
      if (includeRetired === true) return true;
      const s = String(a.status ?? 'operational');
      return s !== 'replaced' && s !== 'decommissioned';
    });

    if (wanted && rows.length === 0) {
      return { ok: false, error: 'No equipment with that id at this hotel. Call staxis_equipment without an id to see the register.' };
    }

    // Tickets for these assets, in one read rather than one per asset.
    const ids = rows.map((a) => String(a.id));
    const { data: orders } = ids.length
      ? await ctx.db
          .from('work_orders')
          .select('id, equipment_id, room_number, description, status, repair_cost, resolved_at, created_at')
          .in('equipment_id', ids)
      : { data: [] };

    // Anything Staxis has open about these assets, matched through the same
    // pure targeting helper the on-the-thing chips use.
    let findings: Finding[] = [];
    try {
      findings = await listFindings(ctx.propertyId, { statuses: ['open', 'updated'], limit: 200 });
    } catch { /* non-fatal — the register is still worth returning */ }

    const equipment = rows.map((a) => {
      const id = String(a.id);
      const mine = (orders ?? []).filter((o) => String(o.equipment_id) === id);
      // 'resolved' and 'closed' both take a ticket off the board. Asked as
      // `!== 'resolved'`, this counted every non issue against the asset as an
      // open work order on the asset register the companion reads from.
      const open = mine.filter((o) => !workOrderIsSettled(o.status ?? 'submitted'));
      // repair_cost is stored in dollars on work_orders (not cents) — summing
      // it as cents would inflate every figure a hundredfold.
      const spendDollars = mine.reduce((acc, o) => acc + (repairCostOf(o.repair_cost) ?? 0), 0);
      const withCost = mine.filter((o) => repairCostOf(o.repair_cost) !== null).length;

      const attached = findingsForTarget(
        findings.map((f) => ({ ...f, judgedDisposition: f.judgedDisposition })),
        'equipment',
        id,
      );

      return {
        id,
        name: a.name as string,
        category: a.category as string,
        location: (a.location as string | null) ?? null,
        status: a.status as string,
        manufacturer: (a.manufacturer as string | null) ?? null,
        model: (a.model_number as string | null) ?? null,
        installed: (a.install_date as string | null) ?? null,
        lastServiced: (a.last_pm_at as string | null) ?? null,
        warrantyExpires: (a.warranty_expires_at as string | null) ?? null,
        workOrders: mine.length,
        openWorkOrders: open.length,
        // Money is absent — not zeroed — for a hat that cannot see it. A `null`
        // here would read as "never cost anything", which is the exact
        // misreading `ticketsWithRecordedCost` exists to prevent.
        ...(showMoney
          ? {
              recordedRepairSpend: spendDollars > 0
                ? spendDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                : null,
              // How much of the history actually carries a cost. Without this the
              // model reads "$0" as "never cost anything".
              ticketsWithRecordedCost: withCost,
            }
          : {}),
        ticketsTotal: mine.length,
        staxisFindings: attached.map((f) => ({ id: f.id, summary: f.judgedSummaryEn ?? f.summary })),
        // History only when the caller asked about this one asset — the whole
        // register with every ticket inlined is a wall of text nobody reads.
        history: wanted
          ? mine
              .slice()
              .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
              .slice(0, 50)
              .map((o) => ({
                room: (o.room_number as string | null) ?? null,
                description: (o.description as string | null) ?? null,
                status: workOrderIsSettled(o.status ?? 'submitted') ? 'done' : 'open',
                ...(showMoney
                  ? { repairCost: repairCostOf(o.repair_cost)?.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) ?? null }
                  : {}),
                loggedAt: (o.created_at as string | null) ?? null,
                resolvedAt: (o.resolved_at as string | null) ?? null,
              }))
          : undefined,
      };
    });

    equipment.sort((a, b) => b.workOrders - a.workOrders || a.name.localeCompare(b.name));

    return {
      ok: true,
      data: {
        count: equipment.length,
        equipment,
        note: equipment.length === 0
          ? 'Nobody at this hotel has put any equipment on the register yet. That does not mean the hotel has none — Staxis simply cannot track what it has not been told about, so say that rather than reporting no equipment.'
          : (showMoney ? undefined : 'Repair costs and spend totals are not part of what you can see here. If asked what a machine has cost or whether to replace it, say the money side is the manager\'s — do not estimate.'),
      },
    };
  },
});

// ─── staxis_checked_last_night ──────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'staxis_checked_last_night',
  section: 'staxis',
  pmsFreshness: 'independent',
  description:
    'Whether Staxis actually looked at this hotel, and when — how many checks ran, how many came back normal, and what could not run. ' +
    'Use when: the user asks "did you check", "is this current", "how do you know things are fine", "when did you last look", "está actualizado". ALWAYS call this before telling anyone the hotel looks clear: an empty findings list from a watcher that has not run in a week means nothing, and saying "all good" on the back of it is the single most damaging thing you can get wrong here. Different from get_pms_status, which is about the hotel\'s PMS reports rather than about Staxis. ' +
    'Takes no arguments. ' +
    'Returns: { ranAt, checksRun, lookedNormal, couldNotRun, fresh, liveness } — the counts are computed here and `liveness` is the exact sentence the Staxis tab shows, so quoting it keeps the chat and the screen telling the same story. ' +
    'Refuses: nothing, but `neverChecked: true` means Staxis has NEVER run here, and the honest answer is then that it cannot tell them anything about this hotel yet — do not soften that into "nothing found". When `fresh` is false the run is more than two days old, so say when it last ran instead of implying the picture is current. "Could not run" checks are usually a hotel too new to have enough history, not a fault.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: STAXIS_WRENCH_ROLES,
  handler: async (_args, ctx: ToolHandlerContext): Promise<ToolResult> => {
    let run: Awaited<ReturnType<typeof latestRunFacts>>;
    try {
      run = await latestRunFacts(ctx.propertyId);
    } catch {
      return { ok: false, error: 'Could not read when Staxis last checked this hotel.' };
    }

    if (!run) {
      return {
        ok: true,
        data: {
          neverChecked: true,
          ranAt: null,
          liveness: null,
          note: 'Staxis has never run its checks at this hotel. It has nothing to report — say exactly that, and do not describe the hotel as clear or quiet.',
        },
      };
    }

    // How many of the checks that ran actually raised something, so
    // "N looked normal" is the real remainder rather than a guess. Counted as
    // DISTINCT detectors, matching the Staxis tab: five findings from one check
    // is one check that found something, not five.
    let withFindings = 0;
    try {
      const open = await listFindings(ctx.propertyId, { statuses: ['open', 'updated'], limit: 200 });
      withFindings = new Set(open.map((f) => f.detectorId)).size;
    } catch { /* non-fatal — the liveness line clamps at zero */ }

    const now = new Date();
    // The SAME sentence builder the cards use. Two phrasings of "we checked 34
    // things" that can drift is exactly how a screen and a chat start
    // contradicting each other in front of a customer.
    const line = livenessLine(run, withFindings, 'en', now);
    const skipped = skippedNote(run, 'en', now);

    const hoursAgo = (now.getTime() - new Date(run.runAt).getTime()) / 3_600_000;

    return {
      ok: true,
      data: {
        neverChecked: false,
        ranAt: run.runAt,
        hoursAgo: Math.max(0, Math.round(hoursAgo)),
        fresh: line.kind === 'fresh',
        freshWithinHours: RUN_FRESH_HOURS,
        checksRun: run.detectorsChecked,
        lookedNormal: Math.max(0, run.detectorsChecked - withFindings),
        checksThatRaisedSomething: withFindings,
        couldNotRun: run.detectorsSkipped,
        checksThatErrored: run.detectorsFailed,
        liveness: line.text,
        couldNotRunNote: skipped,
        note: line.kind === 'stale'
          ? 'This run is more than two days old. Say when Staxis last looked rather than answering as if the picture were current.'
          : undefined,
      },
    };
  },
});
