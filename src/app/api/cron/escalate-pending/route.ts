/**
 * Escalation cron — runs every 15 minutes via GitHub Actions (see
 * .github/workflows/escalate-pending.yml). We moved off Vercel Cron because
 * the Hobby plan blocks sub-daily schedules.
 *
 * NOTE (2026-04-18): This cron was designed for the old yes/no confirmation
 * flow where HKs had to text YES/NO by a deadline. The new flow (Maria
 * confirms in person at 3pm, SMS is just a link to the assignment list)
 * creates docs with status='sent', NOT 'pending', so the `where('status',
 * '==', 'pending')` query below returns zero new results. This cron is
 * effectively a no-op under the new flow, and the workflow file can be
 * safely disabled. It's left in place for now so any legacy 'pending'
 * docs from the old flow can still surface, and so we can re-enable
 * escalations cleanly if we ever add a confirmation deadline back.
 *
 * Old behavior (pre-2026-04-18): for each pending shiftConfirmation
 *  - 45+ min after sentAt with no firstRemindedAt → resend YES/NO prompt
 *  - 75+ min after sentAt with no secondEscalatedAt → SMS scheduling manager
 *
 * Iterates users → properties → shiftConfirmations to avoid needing a
 * collectionGroup index (works out-of-the-box on a fresh Firestore).
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

const REMINDER_MINUTES = 45;
const ESCALATION_MINUTES = 75;

function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).startsWith('+')) return String(raw).trim();
  return null;
}

function formatShiftDate(date: string | undefined, lang: 'en' | 'es'): string {
  if (!date) return lang === 'es' ? 'mañana' : 'tomorrow';
  // YYYY-MM-DD → readable
  try {
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
    return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  } catch {
    return date;
  }
}

async function handler(req: NextRequest) {
  // Vercel Cron sets Authorization: Bearer <CRON_SECRET>. If CRON_SECRET is
  // configured, require it; otherwise allow unauthenticated calls (useful for
  // local testing — production should always set CRON_SECRET).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (!admin.apps.length) {
    console.error('[escalate-pending] Firebase Admin SDK not initialized');
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const db = admin.firestore();
  const now = Date.now();

  let scanned = 0;
  let reminders = 0;
  let escalations = 0;
  let errors = 0;

  try {
    const usersSnap = await db.collection('users').get();
    for (const userDoc of usersSnap.docs) {
      const propsSnap = await userDoc.ref.collection('properties').get();
      for (const propDoc of propsSnap.docs) {
        const uid = userDoc.id;
        const pid = propDoc.id;

        const confSnap = await propDoc.ref
          .collection('shiftConfirmations')
          .where('status', '==', 'pending')
          .get();

        // Cache managers per property so we don't re-query for every escalation.
        // Only the staff member(s) flagged isSchedulingManager = true receive
        // escalation texts. No department fallback — if no one is flagged,
        // nobody gets paged. This is intentional: front-desk staff should
        // never be looped in automatically.
        let cachedManagers: Array<{ name: string; phone: string }> | null = null;
        const getManagers = async () => {
          if (cachedManagers) return cachedManagers;
          const smSnap = await propDoc.ref
            .collection('staff')
            .where('isSchedulingManager', '==', true)
            .get();
          const list: Array<{ name: string; phone: string }> = [];
          for (const m of smSnap.docs) {
            const d = m.data() as { name?: string; phone?: string; isActive?: boolean };
            if (d.isActive === false) continue;
            const e164 = toE164(d.phone);
            if (!e164) continue;
            list.push({ name: d.name ?? 'Manager', phone: e164 });
          }
          cachedManagers = list;
          return list;
        };

        for (const doc of confSnap.docs) {
          scanned++;
          const data = doc.data() as Record<string, unknown>;

          // Skip if SMS never went out — nothing to reminder them about
          if (data.smsSent !== true) continue;

          const sentAtRaw = data.sentAt as admin.firestore.Timestamp | null | undefined;
          if (!sentAtRaw || typeof sentAtRaw.toMillis !== 'function') continue;
          const sentAtMs = sentAtRaw.toMillis();
          const minutesSince = (now - sentAtMs) / 1000 / 60;

          const lang: 'en' | 'es' = data.language === 'es' ? 'es' : 'en';
          const staffName = (data.staffName as string) ?? 'there';
          const firstName = staffName.split(' ')[0] || 'there';
          const hotelName = (data.hotelName as string) || 'the hotel';
          const phone = data.staffPhone as string | undefined;
          const shiftDate = data.shiftDate as string | undefined;

          try {
            // ── 45 min reminder to HK ─────────────────────────────────────
            if (
              minutesSince >= REMINDER_MINUTES &&
              !data.firstRemindedAt &&
              phone
            ) {
              const phoneE164 = toE164(phone);
              if (phoneE164) {
                const dateLabel = formatShiftDate(shiftDate, lang);
                const msg = lang === 'es'
                  ? `Hola ${firstName}, recordatorio: ¿puedes venir el ${dateLabel}? Responde SÍ o NO.\n– ${hotelName}`
                  : `Hi ${firstName}, just a reminder — can you come in on ${dateLabel}? Reply YES or NO.\n– ${hotelName}`;
                await sendSms(phoneE164, msg);
                await doc.ref.update({
                  firstRemindedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                reminders++;
              }
            }

            // ── 75 min escalation to managers ─────────────────────────────
            if (
              minutesSince >= ESCALATION_MINUTES &&
              !data.secondEscalatedAt
            ) {
              const managers = await getManagers();
              if (managers.length > 0) {
                const dateLabel = formatShiftDate(shiftDate, 'en');
                const managerMsg = `⚠️ ${staffName} hasn't confirmed for ${dateLabel} yet (75+ min, no reply). Please reach out directly.`;
                await Promise.allSettled(
                  managers.map(m => sendSms(m.phone, managerMsg)),
                );
              } else {
                console.warn(
                  `[escalate-pending] no managers to notify for uid=${uid} pid=${pid}`,
                );
              }
              await doc.ref.update({
                secondEscalatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              escalations++;
            }
          } catch (err) {
            errors++;
            console.error(
              `[escalate-pending] error processing doc ${doc.ref.path}:`,
              err,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('[escalate-pending] fatal error:', err);
    return NextResponse.json(
      { error: 'Internal error', scanned, reminders, escalations, errors },
      { status: 500 },
    );
  }

  return NextResponse.json({ scanned, reminders, escalations, errors });
}

export async function GET(req: NextRequest) {
  return handler(req);
}

export async function POST(req: NextRequest) {
  return handler(req);
}
