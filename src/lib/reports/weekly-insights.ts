/**
 * Generate a 1-paragraph plain-English insight for the weekly report
 * using Claude. Renders at the top of the weekly email.
 *
 * Design constraints:
 *   - Conservative tokens: ~120 tokens output max. The insight needs to
 *     read in 15 seconds. Anything longer and the GM stops reading the
 *     report.
 *   - Plain English: no jargon. Sentence-level summary of "what mattered
 *     this week" — not a metric recital (the email has those below).
 *   - Soft-fail: if the API key is missing, the call errors, or the
 *     response is malformed, returns null and the email goes out
 *     without the insight block. Never throws upward.
 *   - Cheap model: Haiku is plenty for "summarize these 8 numbers into
 *     a sentence." Cost is ~$0.0001 per weekly report — irrelevant.
 *
 * Returns null on any failure path. The cron treats null as "no insight"
 * rather than "weekly send failed."
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { ANTHROPIC_MAX_RETRIES } from '@/lib/external-service-config';
import { captureException } from '@/lib/sentry';
import type { WeeklyReportPayload } from './types';

// Pin the cheap, fast model — the prompt is short and the output is
// short. Haiku 4.5 is more than capable of summarizing 8 numbers.
const MODEL = 'claude-haiku-4-5-20251001';

const REQUEST_TIMEOUT_MS = 20_000;
const ABORT_MS = 25_000;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({
    apiKey: key,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
  return _client;
}

/**
 * Build the user-prompt content from the weekly payload. Strips PII
 * (staff names) — Claude doesn't need to know who specifically did what
 * to summarize the week.
 */
function buildPromptContent(payload: WeeklyReportPayload): string {
  const { operations, quality, labor, issues, trends, nextWeek } = payload;
  const trendLine = (m: string) => {
    const t = trends.find(x => x.metric === m);
    if (!t) return null;
    const sign = t.deltaPct > 0 ? '+' : '';
    return `${m}: ${sign}${Math.round(t.deltaPct)}% vs prior week`;
  };

  const lines = [
    `Rooms cleaned this week: ${operations.roomsCleanedToday}`,
    `Occupancy: ${operations.occupancyPct}%`,
    `Inspection pass rate: ${quality.passRatePct}% (${quality.inspectionsCompleted} inspections, ${quality.reclearRequestedCount} re-cleans)`,
    quality.topFailureReasons.length > 0
      ? `Top inspection failures: ${quality.topFailureReasons.map(r => `${r.reason} (${r.count})`).join(', ')}`
      : 'No inspection failures recorded.',
    `Labor cost: $${(labor.laborCostCents / 100).toFixed(2)}${labor.laborBudgetCents !== null ? ` (budget $${((labor.laborBudgetCents * 7) / 100).toFixed(2)} for the week)` : ''}`,
    `Overtime hours: ${labor.totalOvertimeHours}`,
    `Sick callouts: ${labor.sickCalloutsToday}`,
    `Maintenance tickets created: ${issues.workOrdersCreatedToday}, urgent pending: ${issues.urgentItemsStillPending}`,
    trendLine('rooms_cleaned'),
    trendLine('labor_cost_cents'),
    trendLine('inspection_pass_rate_pct'),
    `Next week projected: ${nextWeek.projectedArrivals} arrivals, ${nextWeek.projectedDepartures} departures, ${nextWeek.projectedRoomsToClean} rooms to clean`,
  ].filter(Boolean);

  return lines.join('\n');
}

export async function generateWeeklyInsight(
  payload: WeeklyReportPayload,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const promptContent = buildPromptContent(payload);

  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), ABORT_MS);
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 200,           // ~120 words of output, generous slack
        system:
          'You are an operations analyst writing a one-paragraph weekly summary for a hotel general manager. ' +
          'Write 3-5 sentences in plain English. Focus on what changed, what to celebrate, and what to watch. ' +
          'Do not list every metric — pick the 2 or 3 that matter most. ' +
          'No jargon. No bullet points. No headings. No "executive summary" preamble. Just the paragraph.',
        messages: [
          { role: 'user', content: `Weekly housekeeping numbers:\n${promptContent}\n\nWrite the one-paragraph summary.` },
        ],
      }, { signal: ac.signal });
    } finally {
      clearTimeout(abortTimer);
    }

    const block = response.content.find(c => c.type === 'text');
    if (!block || block.type !== 'text') return null;
    const text = block.text.trim();
    if (!text) return null;
    // Belt-and-suspenders: cap output length so a runaway response never
    // bloats the email beyond what reads as a paragraph.
    if (text.length > 1200) return text.slice(0, 1200).replace(/\s+\S*$/, '') + '…';
    return text;
  } catch (err) {
    // Soft-fail: the email still goes out with the metrics; the insight
    // block just disappears. Log to Sentry so we notice repeated failures.
    captureException(err, {
      subsystem: 'weekly-insights',
      failure_mode: 'claude_call_failed',
      propertyId: payload.propertyId,
    });
    return null;
  }
}
