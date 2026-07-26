/**
 * THE COMPANY RULEBOOK — company-scope people write it, their GMs read it.
 *
 * GET ?propertyId=<uuid>
 *   The hotel on screen tells us which company we are looking at (there is no
 *   company picker, and deliberately so: a GM only ever knows their own hotel).
 *   → { ok, data: {
 *        organizationId, canEdit, companyRole, viewOnlyBecauseHotelJob,
 *        settings: { gms_see_rulebook, cross_hotel_ai_chat, rulebook_editors,
 *                    setup_completed_at },
 *        facts: [{ id, topic, content, category, source, reviewState,
 *                  createdByName, updatedAt, reading }],
 *        rules: [{ actionKind, thresholdCents, thresholdInclusive, approverRole }],
 *        contradictions: [{ propertyName, key, companyValue, hotelValue, line }],
 *      } }
 *   `reading` is the STRUCTURED reading the fact would get if confirmed right
 *   now — the sentence the confirmer approves. It is computed, never stored,
 *   until somebody says yes.
 *
 * POST { propertyId, action, … }
 *   'confirm' | 'edit' | 'remove'  — the three rulebook actions. COMPANY-SCOPE
 *                                    ONLY; a GM is refused (403) on every one.
 *   'settings'                     — the setup choices.
 *
 * Auth: requireSession + loadSessionAccount + a HAT at the company that operates
 * `propertyId`. company_knowledge is deny-all RLS and every read/write goes
 * through supabaseAdmin, so the organization filter in
 * src/lib/company/rulebook.ts is the tenant boundary — not defence in depth,
 * THE boundary. Wall B holds because the only organization id this route ever
 * uses comes from `companyForProperty(propertyId)`.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { loadSessionAccount, managerManagesHotel, type ManagerCaller } from '@/lib/team-auth';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { companyForProperty } from '@/lib/company/access';
import { redactMemoryContent } from '@/lib/agent/memory-redact';
import {
  COMPANY_FACT_MAX_CONTENT,
  companyHotelSettings,
  confirmCompanyFact,
  editCompanyFact,
  listCompanyFacts,
  removeCompanyFact,
  structuredReadingFor,
  type CompanyFact,
} from '@/lib/company/rulebook';
import {
  companyAccessSettings,
  rulebookStandingFor,
  saveCompanyAccessSettings,
  type CompanyAccessKey,
  type RulebookStanding,
} from '@/lib/company/rulebook-access';
import { listAuthorityRules } from '@/lib/company/authority';
import { clearCompanyRulebookCache } from '@/lib/agent/company-tier';
import {
  describeAuthorityRule,
  describePolicyValue,
  findSettingContradictions,
  isCompanyCategory,
} from '@/lib/company/rulebook-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate {
  caller: ManagerCaller;
  propertyId: string;
  organizationId: string;
  standing: RulebookStanding;
}

/**
 * requireSession → the manager behind it → the company that runs the hotel on
 * screen → what that person's JOB at that company lets them do.
 *
 * `loadSessionAccount` is the shared, schema-pinned account loader; hand-rolling
 * another is how `accounts.name` (a column that does not exist) silently turned
 * a whole feature off for every user, three separate times.
 *
 * ─── WHY loadSessionAccount AND NOT loadManagerCaller ─────────────────────
 * The manager gate reads `accounts.role`, and the company vocabulary degrades
 * least-privilege into it: a `vp` hat becomes `general_manager`, a `finance`
 * hat becomes `front_desk` (src/lib/company/roles.ts). So the manager gate
 * refused a company's finance lead outright, and would refuse a VP whose
 * legacy role was never a manager word — the exact people
 * `rulebookStandingFor` and the company's own `rulebook_editors` choice are
 * written to answer about. The gate ran before the hats were ever consulted,
 * and the panel renders null on a refusal, so they got a silent blank where
 * their own company's book should be.
 *
 * Nothing widened: `rulebookStandingFor` below requires a hat AT THIS COMPANY,
 * and a legacy account with no hat still resolves to `denied` → 403. It is the
 * authority for view and for edit, which is what it was written to be.
 */
async function gate(
  req: NextRequest,
  requestId: string,
  propertyIdRaw: unknown,
): Promise<{ ok: false; response: Response } | ({ ok: true } & Gate)> {
  const session = await requireSession(req, { requestId });
  if (!session.ok) return { ok: false, response: session.response };

  const caller = await loadSessionAccount(session.userId);
  if (!caller) {
    return {
      ok: false,
      response: err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound }),
    };
  }

  const pidV = validateUuid(propertyIdRaw, 'propertyId');
  if (pidV.error) {
    return {
      ok: false,
      response: err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed }),
    };
  }
  const propertyId = pidV.value!;
  if (!managerManagesHotel(caller, propertyId)) {
    return {
      ok: false,
      response: err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  const organizationId = await companyForProperty(propertyId);
  if (!organizationId) {
    // An independent hotel has no company and therefore no rulebook. 404 rather
    // than an empty book: "there is nothing here" and "your company's book is
    // empty" are different answers and the screen renders them differently.
    return {
      ok: false,
      response: err('This hotel is not part of a management company', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      }),
    };
  }

  const standing = await rulebookStandingFor(caller.accountId, organizationId);
  if (!standing.canView) {
    return {
      ok: false,
      response: err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  return { ok: true, caller, propertyId, organizationId, standing };
}

function factPayload(fact: CompanyFact) {
  const reading = structuredReadingFor(fact.content);
  return {
    id: fact.id,
    topic: fact.topic,
    content: fact.content,
    category: fact.category,
    source: fact.source,
    reviewState: fact.reviewState,
    policyKey: fact.policyKey,
    policyValue: fact.policyValue,
    createdByName: fact.createdByName,
    updatedAt: fact.updatedAt,
    // What confirming this fact would freeze, in both languages, so the panel
    // shows the reading without a second round trip and the person approving
    // sees exactly what gets stored.
    reading: {
      authority: reading.authority
        ? {
          ...reading.authority,
          line: {
            en: describeAuthorityRule(reading.authority, 'en'),
            es: describeAuthorityRule(reading.authority, 'es'),
          },
        }
        : null,
      policy: reading.policy
        ? {
          ...reading.policy,
          line: {
            en: describePolicyValue(reading.policy, 'en'),
            es: describePolicyValue(reading.policy, 'es'),
          },
        }
        : null,
    },
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const g = await gate(req, requestId, new URL(req.url).searchParams.get('propertyId'));
  if (!g.ok) return g.response;

  const [facts, rules, settings, hotelSettings] = await Promise.all([
    listCompanyFacts(g.organizationId),
    listAuthorityRules(g.organizationId),
    companyAccessSettings(g.organizationId),
    companyHotelSettings(g.organizationId),
  ]);

  // Quiet FYI only, and only for the people who own the book. A GM reading the
  // policies they are governed by does not need a list of the ways their peers'
  // hotels differ from it.
  const contradictions = g.standing.companyRole === null
    ? []
    : findSettingContradictions(
      facts.filter((f) => f.reviewState === 'confirmed'),
      hotelSettings,
    );

  const confirmed = facts.filter((f) => f.reviewState === 'confirmed');
  // A read-only viewer sees the CONFIRMED book and nothing else. An unconfirmed
  // line is a draft nobody has approved — it is not yet a policy anyone is
  // governed by, it does not reach any copilot, and the GM cannot act on it. Put
  // it in front of them and the screen is claiming a rule exists when it does
  // not. Filtered on the SERVER so the honesty does not depend on the client.
  const visible = g.standing.canEdit ? facts : confirmed;

  return ok(
    {
      organizationId: g.organizationId,
      canEdit: g.standing.canEdit,
      companyRole: g.standing.companyRole,
      viewOnlyBecauseHotelJob: g.standing.viewOnlyBecauseHotelJob,
      settings,
      stats: {
        totalKnown: confirmed.length,
        pendingReview: g.standing.canEdit ? facts.length - confirmed.length : 0,
        hotelsCovered: hotelSettings.length,
      },
      // Unreviewed first: the whole point of the screen is that they need you.
      facts: [
        ...visible.filter((f) => f.reviewState === 'unreviewed').map(factPayload),
        ...visible.filter((f) => f.reviewState === 'confirmed').map(factPayload),
      ],
      rules: rules.map((r) => ({
        id: r.id,
        actionKind: r.actionKind,
        thresholdCents: r.thresholdCents,
        thresholdInclusive: r.thresholdInclusive,
        approverRole: r.approverRole,
        sourceFactId: r.sourceFactId,
      })),
      contradictions,
    },
    { requestId },
  );
}

interface PostBody {
  propertyId?: unknown;
  action?: unknown;
  id?: unknown;
  content?: unknown;
  category?: unknown;
  settings?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const g = await gate(req, requestId, body.propertyId);
  if (!g.ok) return g.response;

  // THE READ-ONLY WALL. A GM sees the book and cannot touch it; so does a
  // finance person at a company whose owner chose 'owner_and_vp'. This is one
  // check for every write action on purpose — a per-action gate is a per-action
  // opportunity to forget one.
  if (!g.standing.canEdit) {
    return err('Only company leadership can change the rulebook', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const action = body.action;
  if (action !== 'confirm' && action !== 'edit' && action !== 'remove' && action !== 'settings') {
    return err('Unknown action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rl = await checkAndIncrementRateLimit('company-rulebook-write', g.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const actor = {
    accountId: g.caller.accountId,
    name: g.caller.displayName,
    role: g.standing.companyRole ?? g.caller.role,
  };

  if (action === 'settings') {
    const raw = body.settings;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return err('settings is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const choices: Partial<Record<CompanyAccessKey, string>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      choices[key as CompanyAccessKey] = value;
    }
    const res = await saveCompanyAccessSettings(g.organizationId, choices, actor.accountId);
    if (!res.ok) {
      return err(res.error ?? 'Could not save those choices', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    return ok({ action, saved: res.saved }, { requestId });
  }

  const idV = validateUuid(body.id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  if (action === 'confirm') {
    const res = await confirmCompanyFact(g.organizationId, idV.value!, actor);
    if (!res.ok) {
      log.error('[company/rulebook:POST] confirm failed', { requestId, err: res.error });
      return err('Could not confirm that', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!res.confirmed) {
      return err('That line is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    // The company tier is cached per hotel for ten minutes. A VP who just
    // confirmed a policy should not have to wonder whether the copilot has it.
    clearCompanyRulebookCache();
    return ok({ action, id: idV.value }, { requestId });
  }

  if (action === 'remove') {
    const res = await removeCompanyFact(g.organizationId, idV.value!);
    if (!res.ok) {
      log.error('[company/rulebook:POST] remove failed', { requestId, err: res.error });
      return err('Could not remove that', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!res.removed) {
      return err('That line is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    clearCompanyRulebookCache();
    return ok({ action, id: idV.value }, { requestId });
  }

  // ── edit ──────────────────────────────────────────────────────────────────
  if (typeof body.content !== 'string') {
    return err('content is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  // Same PII masking every other durable-knowledge write path applies. A VP
  // typing a vendor rep's mobile number into a policy must not turn the company
  // rulebook into a place phone numbers accumulate.
  const content = redactMemoryContent(body.content.slice(0, COMPANY_FACT_MAX_CONTENT)).content.trim();
  if (!content) {
    return err('content is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.category !== undefined && !isCompanyCategory(body.category)) {
    return err('Unknown category', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const res = await editCompanyFact(
    g.organizationId,
    idV.value!,
    { content, ...(body.category !== undefined ? { category: body.category } : {}) },
    actor,
  );
  if (!res.ok) {
    log.error('[company/rulebook:POST] edit failed', { requestId, err: res.error });
    return err('Could not save that', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!res.updated) {
    return err('That line is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  clearCompanyRulebookCache();
  return ok({ action, id: idV.value, content }, { requestId });
}
