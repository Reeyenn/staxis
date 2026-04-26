/**
 * POST /api/admin/normalize-confirmation-phones
 *
 * One-off migration. Walks every open `shift_confirmations` row and rewrites
 * `staff_phone` to E.164 if it isn't already.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Was previously
 * ungated. The GET-alias was removed — mutating endpoints should not be
 * triggerable by a link prefetch.
 *
 * Safe to call repeatedly. Returns counts so you can see what it did.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { toE164 } from '@/lib/phone';
import { requireCronSecret } from '@/lib/admin-auth';

export async function POST(req: NextRequest) {
  const gate = requireCronSecret(req);
  if (gate) return gate;
  try {
    const { data: confs, error } = await supabaseAdmin
      .from('shift_confirmations')
      .select('token, status, staff_phone');
    if (error) throw error;

    let scanned = 0;
    let rewritten = 0;
    let skipped = 0;
    let nonPending = 0;
    const examples: Array<{ from: string; to: string; status: string }> = [];

    // PromiseLike — see backfill-phonelookup for the same-shaped comment.
    const updates: PromiseLike<unknown>[] = [];

    for (const row of (confs ?? [])) {
      scanned += 1;
      const status = (row.status as string) ?? 'sent';
      // Only normalise "open" rows — resolved ones are historical.
      if (status !== 'pending' && status !== 'sent') { nonPending += 1; continue; }

      const current = (row.staff_phone as string) ?? '';
      const normalized = toE164(current);
      if (!normalized) { skipped += 1; continue; }
      if (normalized === current) { skipped += 1; continue; }

      updates.push(
        supabaseAdmin
          .from('shift_confirmations')
          .update({ staff_phone: normalized })
          .eq('token', row.token as string)
          .then(({ error: upErr }) => { if (upErr) throw upErr; }),
      );
      rewritten += 1;
      if (examples.length < 10) examples.push({ from: current, to: normalized, status });
    }

    if (updates.length > 0) await Promise.all(updates);

    return NextResponse.json({ scanned, nonPending, rewritten, skipped, examples });
  } catch (err) {
    const msg = errToString(err);
    console.error('normalize-confirmation-phones error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

