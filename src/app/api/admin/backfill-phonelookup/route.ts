/**
 * POST /api/admin/backfill-phonelookup
 *
 * One-time migration tool. Walks every staff row and rewrites
 * `phone_lookup` to E.164 if it doesn't already match. Used after the
 * `toStaffRow` format change to bring legacy last-10-digit values up to
 * the new canonical format.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Was previously
 * ungated. The GET-alias was removed — mutating endpoints should not be
 * triggerable by an `<img>` or link prefetch.
 *
 * Safe to call repeatedly. Returns counts + examples so you can verify.
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
    const { data: staff, error } = await supabaseAdmin
      .from('staff')
      .select('id, phone, phone_lookup');
    if (error) throw error;

    // PromiseLike (not Promise) because Supabase's query-builder chain is a
    // thenable — .then() on it returns a PromiseLike, which Promise.all
    // accepts without a full Promise cast.
    const updates: PromiseLike<unknown>[] = [];
    const examples: Array<{ staffId: string; phone: string; phoneLookup: string }> = [];
    let updated = 0;
    let skippedNoPhone = 0;
    let alreadyCurrent = 0;

    for (const row of (staff ?? [])) {
      const phone = (row.phone as string | null) ?? '';
      if (!phone) { skippedNoPhone++; continue; }
      const normalized = toE164(phone);
      if (!normalized) { skippedNoPhone++; continue; }
      if ((row.phone_lookup as string | null) === normalized) { alreadyCurrent++; continue; }

      updates.push(
        supabaseAdmin
          .from('staff')
          .update({ phone_lookup: normalized })
          .eq('id', row.id)
          .then(({ error: upErr }) => { if (upErr) throw upErr; }),
      );
      if (examples.length < 10) {
        examples.push({ staffId: row.id as string, phone, phoneLookup: normalized });
      }
      updated++;
    }

    if (updates.length > 0) await Promise.all(updates);

    return NextResponse.json({
      scanned: (staff ?? []).length,
      updated,
      alreadyCurrent,
      skippedNoPhone,
      examples,
    });
  } catch (err) {
    const msg = errToString(err);
    console.error('backfill-phonelookup error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

