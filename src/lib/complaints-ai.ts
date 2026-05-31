// ═══════════════════════════════════════════════════════════════════════════
// Complaints AI — the part that beats a manual glitch list.
//
//   1. classifyComplaint()      → category + severity from free text
//   2. draftServiceRecovery()   → a suggested guest apology + make-good
//
// Everything here is BEST-EFFORT. A Claude hiccup must never block a complaint
// from being logged, so every export falls back to a safe default and never
// throws to the caller. Server-only (uses the secret API key).
// ═══════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import {
  COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES,
  type ComplaintCategory, type ComplaintSeverity,
} from '@/lib/complaints-shared';

// Haiku is fast + cheap; classification/short drafts don't need a bigger model.
const MODEL = 'claude-haiku-4-5';

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (cachedClient) return cachedClient;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null; // no key (e.g. local/test) → callers use fallbacks
  cachedClient = new Anthropic({ apiKey: key, timeout: 20_000, maxRetries: 1 });
  return cachedClient;
}

/** Pull the first text block out of an Anthropic response. */
function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Parse a JSON object out of a model reply, tolerating ```json fences / prose. */
function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceCategory(v: unknown): ComplaintCategory {
  return (COMPLAINT_CATEGORIES as readonly string[]).includes(v as string)
    ? (v as ComplaintCategory)
    : 'other';
}
function coerceSeverity(v: unknown): ComplaintSeverity {
  return (COMPLAINT_SEVERITIES as readonly string[]).includes(v as string)
    ? (v as ComplaintSeverity)
    : 'medium';
}

export interface ComplaintClassification {
  category: ComplaintCategory;
  severity: ComplaintSeverity;
  /** One-line normalized summary, handy for list rows. May be empty. */
  summary: string;
  /** True when the values came from Claude (vs a fallback). */
  aiClassified: boolean;
}

const CLASSIFY_SYSTEM =
  'You triage hotel guest complaints for a limited-service hotel. ' +
  'Classify the complaint into exactly one category and a severity, and give a short neutral summary. ' +
  'Categories: maintenance (broken/not working — AC, plumbing, TV, lights, locks), ' +
  'cleanliness (dirty room, bad linens, smell, pests), noise, service (staff behavior, slow/no response, check-in issues), ' +
  'billing (charges, refunds, rates), amenities (wifi, pool, breakfast, parking), other. ' +
  'Severity: high (safety, health, no-hot-water, security, very angry guest, repeated issue), ' +
  'medium (real problem, guest inconvenienced), low (minor/cosmetic). ' +
  'Reply with ONLY a JSON object: {"category": "...", "severity": "...", "summary": "..."}.';

/**
 * Classify a complaint's category + severity. Never throws — on any error or
 * missing key returns a safe default ({ other, medium }) with aiClassified=false.
 */
export async function classifyComplaint(
  description: string,
  roomNumber?: string | null,
): Promise<ComplaintClassification> {
  const fallback: ComplaintClassification = {
    category: 'other', severity: 'medium', summary: '', aiClassified: false,
  };
  const client = getClient();
  if (!client || !description?.trim()) return fallback;

  try {
    const userMsg =
      (roomNumber ? `Room ${roomNumber}. ` : '') + `Complaint: ${description.trim()}`;
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const parsed = extractJson(textOf(res));
    if (!parsed) return fallback;
    return {
      category: coerceCategory(parsed.category),
      severity: coerceSeverity(parsed.severity),
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
      aiClassified: true,
    };
  } catch (err) {
    log.warn('[complaints-ai] classify failed', { err: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

export interface ServiceRecoveryDraft {
  /** Suggested message to the guest (staff edits before sending). */
  guestMessage: string;
  /** Recommended make-good (e.g. "comp one night's parking"). */
  makeGood: string;
  aiDrafted: boolean;
}

const DRAFT_SYSTEM =
  'You are a hotel guest-relations manager writing a brief, warm, sincere service-recovery message. ' +
  'Acknowledge the specific issue, apologize without excuses, state the concrete fix, and (if warranted by severity) ' +
  'offer a proportionate make-good. Keep the guest message under 90 words, professional, no emojis, no placeholders ' +
  'like [Name] unless a real value is given. Reply with ONLY JSON: {"guestMessage":"...","makeGood":"..."}.';

/**
 * Draft a service-recovery message + recommended make-good. Never throws — on
 * any failure returns a sensible template with aiDrafted=false.
 */
export async function draftServiceRecovery(input: {
  description: string;
  category: ComplaintCategory;
  severity: ComplaintSeverity;
  guestName?: string | null;
  roomNumber?: string | null;
}): Promise<ServiceRecoveryDraft> {
  const greeting = input.guestName ? `Dear ${input.guestName},` : 'Dear Guest,';
  const fallback: ServiceRecoveryDraft = {
    guestMessage:
      `${greeting} thank you for letting us know about the issue with your stay` +
      `${input.roomNumber ? ` in room ${input.roomNumber}` : ''}. ` +
      `I'm sorry for the inconvenience — we're addressing it right away and will follow up to make sure it's fully resolved.`,
    makeGood: input.severity === 'high' ? 'Offer a sincere apology and a meaningful gesture (e.g. comp a night or loyalty points).'
      : input.severity === 'medium' ? 'Offer a small gesture (e.g. comp breakfast or late checkout).'
      : 'A sincere apology is likely sufficient.',
    aiDrafted: false,
  };
  const client = getClient();
  if (!client) return fallback;

  try {
    const userMsg =
      `Category: ${input.category}. Severity: ${input.severity}. ` +
      (input.guestName ? `Guest: ${input.guestName}. ` : '') +
      (input.roomNumber ? `Room: ${input.roomNumber}. ` : '') +
      `Complaint: ${input.description.trim()}`;
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const parsed = extractJson(textOf(res));
    if (!parsed || typeof parsed.guestMessage !== 'string') return fallback;
    return {
      guestMessage: parsed.guestMessage.slice(0, 1000),
      makeGood: typeof parsed.makeGood === 'string' ? parsed.makeGood.slice(0, 500) : fallback.makeGood,
      aiDrafted: true,
    };
  } catch (err) {
    log.warn('[complaints-ai] draft failed', { err: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}
