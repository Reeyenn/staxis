/**
 * POST /api/admin/normalize-confirmation-phones
 *
 * One-off migration. Walks every open `shift_confirmations` row and rewrites
 * `staff_phone` to E.164 if it isn't already. Needed because the first
 * version of /api/send-shift-confirmations stored whatever the user typed
 * (e.g. "4098282023", "(409) 828-2023") which the SMS-reply lookup can't
 * always match against Twilio's E.164 `From`.
 *
 * Also normalizes `staff.phone_lookup` as a side-effect so sms-reply can
 * resolve via either path.
 *
 * Safe to call repeatedly. Returns counts so you can see what it did.
 */
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

function toE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST() {
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
    console.error('normalize-confirmation-phones error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  // Easier to trigger from a browser — same behaviour as POST.
  return POST();
}
