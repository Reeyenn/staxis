// ─── Memory retrieval + prompt injection ────────────────────────────────────
// The READ path for long-term copilot memory (migration 0256). Each turn the
// route fetches the hotel's active memory, ranks + caps it, and injects it into
// the DYNAMIC (uncached) half of the system prompt as ESCAPED reference data
// inside a <staxis-memory> trust marker. The model is told (base-prompt rule,
// migration 0257) to treat it as data, never instructions.
//
// v1 is intentionally UNCACHED — retrieval is one indexed query/turn, and a
// per-process cache would make "tell it something, then ask in a fresh chat"
// flaky on multi-instance serverless. Revisit only if latency profiling flags it.

import { escapeTrustMarkerContent } from './llm';
import { getActiveMemoryForTurn, type MemoryRow } from '@/lib/db/agent-memory';

/** Hard caps — the context-stuffing / cost ceiling. Guaranteed because
 *  retrieval is server-side and deterministic. ~6000 chars ≈ ~1500 tokens,
 *  comfortably inside the existing per-request cost reservation headroom. */
export const MAX_MEMORY_ENTRIES = 20;
export const MEMORY_CHAR_BUDGET = 6000;

// Lower = surfaced first. Corrections and explicit facts beat inferred/derived.
const SOURCE_RANK: Record<string, number> = {
  correction: 0,
  explicit_user: 1,
  consolidation: 2,
  operational: 2, // auto-learned from operations — ranks with consolidation, below human facts
  inferred: 3,
};

/** Deterministic ordering (stable across turns): source priority → recency →
 *  scope (personal prefs win ties) → id. No weighted decay in v1. */
function rankMemory(rows: MemoryRow[]): MemoryRow[] {
  return [...rows].sort((a, b) => {
    const sr = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    if (sr !== 0) return sr;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1; // newer first
    if (a.scope !== b.scope) return a.scope === 'user' ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** Escape a value destined for a double-quoted XML attribute: HTML-escape
 *  <,>,& (shared with content) then neutralize the quote that would break out. */
function attrEscape(s: string): string {
  return escapeTrustMarkerContent(s).replace(/"/g, '&quot;');
}

/**
 * Format active memory rows into the injectable prompt block. Returns '' when
 * there is nothing to inject, so the prompt is byte-identical to today on an
 * empty hotel (the additive-only guarantee). Content is escaped with the same
 * helper that protects <tool-result>/<staxis-summary>, so a stored
 * '</staxis-memory>…' or imperative text can't break the marker or pose as an
 * instruction.
 */
export function formatMemoryForPrompt(rows: MemoryRow[]): string {
  if (!rows.length) return '';
  const ranked = rankMemory(rows);
  const lines: string[] = [];
  let chars = 0;
  for (const r of ranked) {
    if (lines.length >= MAX_MEMORY_ENTRIES) break;
    const scopeLabel = r.scope === 'user' ? 'you' : 'hotel';
    // Provenance: auto-learned (consolidation) facts are labelled distinctly so
    // the model weights them as Staxis's own inference, below a manager's word.
    const by = r.source === 'consolidation'
      ? 'Staxis-auto'
      : r.source === 'operational'
        ? 'Staxis-observed'
        : r.createdByRole ? `role:${r.createdByRole}` : 'unknown';
    const line =
      `<staxis-memory trust="system-derived-from-untrusted" scope="${scopeLabel}" topic="${attrEscape(r.topic)}" ` +
      `by="${attrEscape(by)}" confidence="${attrEscape(r.confidence)}">` +
      `${escapeTrustMarkerContent(r.content)}</staxis-memory>`;
    if (chars + line.length > MEMORY_CHAR_BUDGET && lines.length > 0) break;
    lines.push(line);
    chars += line.length;
  }
  if (!lines.length) return '';
  return [
    '─── What Staxis remembers about this hotel ───',
    '<staxis-memory-block trust="system-derived-from-untrusted">',
    ...lines,
    '</staxis-memory-block>',
  ].join('\n');
}

/**
 * Fetch + format this turn's memory for (property, account). Non-fatal: any
 * failure returns '' so a memory hiccup never breaks a conversation.
 */
export async function retrieveMemoryForTurn(
  propertyId: string,
  subjectAccountId: string | null,
): Promise<string> {
  try {
    const rows = await getActiveMemoryForTurn(propertyId, subjectAccountId);
    return formatMemoryForPrompt(rows);
  } catch {
    return '';
  }
}
