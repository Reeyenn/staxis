// ─── AI activity — pure view model (client-safe) ────────────────────────────
//
// The shared, import-safe half of the AI-activity feed: the view types, the
// status→outcome badge mapping, the row→view mapper, and day grouping. NO server
// imports live here (no supabaseAdmin), so both the client pop-up
// (AiActivityButton.tsx) and the server read (activity.ts) can import it without
// dragging the service-role client into the browser bundle.
//
// Only buildActionSummary is pulled in — it's a pure copy table (approval.ts)
// with no server deps, already used client-side by the approval cards.

import { buildActionSummary } from '@/lib/agent/approval';
import type { PendingStatus } from '@/lib/agent/pending-actions';

/** The four terminal outcomes a manager reviews, plus a catch-all for the rare
 *  still-in-flight row. Bilingual labels + a color role live in the client. */
export type ActivityOutcome = 'done' | 'denied' | 'expired' | 'failed' | 'pending';

export function outcomeForStatus(status: PendingStatus | string): ActivityOutcome {
  switch (status) {
    case 'executed': return 'done';
    case 'denied':   return 'denied';
    case 'expired':  return 'expired';
    case 'failed':   return 'failed';
    default:         return 'pending'; // 'pending' | 'approved' | anything unknown
  }
}

/** One row as the client renders it. Summaries are pre-built EN + ES so the
 *  browser needs no tool registry; the error text (failures only) is verbatim
 *  from the row. `who` is the display name of the account that asked the AI. */
export interface ActivityItem {
  id: string;
  createdAt: string;          // ISO — when the AI proposed the action
  who: string;                // account display name (or a neutral fallback)
  toolName: string;
  outcome: ActivityOutcome;
  summary: { en: string; es: string };
  error: string | null;       // present for failed rows only
}

export interface ActivityPage {
  items: ActivityItem[];
  hasMore: boolean;
}

/** Default + hard cap on page size. The client asks for 50 at a time. */
export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_PAGE_MAX = 100;

/** The raw agent_pending_actions columns the feed reads. */
export interface ActivityRawRow {
  id: string;
  account_id: string;
  tool_name: string;
  tool_args: unknown;
  status: string;
  error: string | null;
  created_at: string;
}

/**
 * Pure mapper: raw agent_pending_actions rows + an account→display-name lookup
 * → the client view model. Separated from the DB read so it can be unit-tested
 * directly. `nameFor` returns the display name for an account id, or a fallback.
 */
export function mapActivityRows(
  rows: ActivityRawRow[],
  nameFor: (accountId: string) => string,
): ActivityItem[] {
  return rows.map((r) => {
    const args = (r.tool_args && typeof r.tool_args === 'object' ? r.tool_args : {}) as Record<string, unknown>;
    return {
      id: r.id,
      createdAt: r.created_at,
      who: nameFor(r.account_id),
      toolName: r.tool_name,
      outcome: outcomeForStatus(r.status),
      summary: {
        en: buildActionSummary(r.tool_name, args, 'en'),
        es: buildActionSummary(r.tool_name, args, 'es'),
      },
      // Only surface the error string for genuinely-failed rows — a denied or
      // expired row carries a housekeeping "declined by user" note that isn't
      // an error the manager needs to see.
      error: r.status === 'failed' ? (r.error ?? null) : null,
    };
  });
}

// ─── Day grouping (presentation-adjacent, pure + testable) ──────────────────

export interface ActivityDayGroup {
  key: string;
  label: string;
  items: ActivityItem[];
}

/**
 * Group items (already newest-first) into per-day buckets with a friendly header
 * (Today / Yesterday / a localized date). Insertion order is preserved so the
 * feed still reads newest→oldest. `lang` picks EN vs ES for the header copy.
 */
export function groupByDay(items: ActivityItem[], lang: string): ActivityDayGroup[] {
  const es = lang === 'es';
  const groups: ActivityDayGroup[] = [];
  const byKey = new Map<string, ActivityDayGroup>();
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));

  for (const it of items) {
    const d = new Date(it.createdAt);
    const key = dayKey(d);
    let g = byKey.get(key);
    if (!g) {
      let label: string;
      if (key === today) label = es ? 'Hoy' : 'Today';
      else if (key === yesterday) label = es ? 'Ayer' : 'Yesterday';
      else label = d.toLocaleDateString(es ? 'es' : 'en', { weekday: 'long', month: 'short', day: 'numeric' });
      g = { key, label, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
