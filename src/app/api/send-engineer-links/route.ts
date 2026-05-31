// POST /api/send-engineer-links
// Body: { pid, baseUrl? }
//
// "Send compliance link" — texts the on-shift maintenance staff their
// /engineer/[id] magic-link so they can log readings + PM checks from their
// phone. Mirrors /api/send-shift-confirmations: requireSession + property
// access, rate-limited + billing (Twilio), cross-tenant safe via
// buildEngineerLink (which asserts each staff row belongs to pid). Targets
// staff with department='maintenance'.

import { NextRequest, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, safeBaseUrl } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { enqueueSms, processSmsJobs } from '@/lib/sms-jobs';
import { buildEngineerLink, CrossTenantStaffError } from '@/lib/staff-auth';
import { toE164 } from '@/lib/compliance/autoact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body { pid?: unknown; baseUrl?: unknown }

interface Outcome { staffId: string; name: string; status: 'sent' | 'skipped' | 'failed'; reason?: string }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;
  const baseUrl = safeBaseUrl(body.baseUrl);

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('send-engineer-links', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // On-shift maintenance staff for this property.
  const { data: staff, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, phone, language, is_active, department')
    .eq('property_id', pid)
    .eq('department', 'maintenance');
  if (staffErr) {
    log.error('[send-engineer-links] staff lookup failed', { requestId, pid, msg: staffErr.message });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const targets = (staff ?? []).filter((s) => s.is_active !== false);
  if (targets.length === 0) {
    return ok({ sent: 0, skipped: 0, failed: 0, perStaff: [], note: 'no_active_maintenance_staff' }, { requestId });
  }

  const { data: prop } = await supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle();
  const hotelName = (prop?.name as string) || 'Staxis';

  const perStaff: Outcome[] = await Promise.all(targets.map(async (s): Promise<Outcome> => {
    const name = String(s.name ?? 'Engineer');
    try {
      const phone = typeof s.phone === 'string' ? s.phone.trim() : '';
      if (!phone) return { staffId: String(s.id), name, status: 'skipped', reason: 'no_phone' };
      const phone164 = toE164(phone);
      if (!phone164) return { staffId: String(s.id), name, status: 'skipped', reason: 'invalid_phone' };

      const url = await buildEngineerLink(String(s.id), pid, baseUrl);
      const firstName = name.split(' ')[0] || name;
      const lang = s.language === 'es' ? 'es' : 'en';
      const message = lang === 'es'
        ? `Hola ${firstName}! Tus revisiones de cumplimiento de hoy:\n${url}\n\n– ${hotelName}`
        : `Hi ${firstName}! Your compliance checks for today:\n${url}\n\n– ${hotelName}`;

      await enqueueSms({
        propertyId: pid,
        toPhone: phone164,
        body: message,
        idempotencyKey: `engineer-link:${pid}:${s.id}:${new Date().toISOString().slice(0, 13)}`,
        metadata: { kind: 'engineer-compliance-link', staffId: s.id },
      });
      return { staffId: String(s.id), name, status: 'sent' };
    } catch (e) {
      if (e instanceof CrossTenantStaffError) {
        return { staffId: String(s.id), name, status: 'failed', reason: 'cross_tenant' };
      }
      return { staffId: String(s.id), name, status: 'failed', reason: errToString(e).slice(0, 80) };
    }
  }));

  const sent = perStaff.filter((p) => p.status === 'sent').length;
  const skipped = perStaff.filter((p) => p.status === 'skipped').length;
  const failed = perStaff.filter((p) => p.status === 'failed').length;

  after(async () => {
    try { await processSmsJobs(50); }
    catch (e) { log.error('[send-engineer-links] drain failed', { requestId, pid, msg: errToString(e) }); }
  });

  return ok({ sent, skipped, failed, perStaff }, { requestId });
}
