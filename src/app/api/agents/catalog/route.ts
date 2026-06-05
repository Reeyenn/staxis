// GET /api/agents/catalog?pid=…
// The wizard's catalog: registered templates + actions + scopes + the selectable
// event list the Agent Builder UI renders. Server-only — the registries are
// NEVER imported into client components; the UI gets this shape over fetch.
// requireSession + property-access, like the other GET agent routes. Read-only,
// no rate limit.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
// Side-effect imports populate the registries (exactly as engine.ts does). These
// MUST run before the list*Meta() calls below, or the lists come back empty.
import '@/lib/agents/actions';
import '@/lib/agents/scopes';
import '@/lib/agents/templates';
import { listActionMeta } from '@/lib/agents/actions/registry';
import { listScopeMeta } from '@/lib/agents/scopes/registry';
import { listTemplateMeta } from '@/lib/agents/templates/registry';
import { AGENT_EVENT_CATALOG } from '@/lib/agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const pidV = validateUuid(req.nextUrl.searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    return ok(
      {
        templates: listTemplateMeta(),
        actions: listActionMeta(),
        scopes: listScopeMeta(),
        events: AGENT_EVENT_CATALOG,
      },
      { requestId },
    );
  } catch (e) {
    log.error('[agents/catalog] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
