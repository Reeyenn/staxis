import 'server-only';

// ─── The org-scope marker on a conversation ─────────────────────────────────
//
// A portfolio conversation is stored in `agent_conversations` like every other
// one. Two things about that table decide the shape of this file, and both are
// worth stating plainly rather than discovering later:
//
//   • `property_id` is `uuid NOT NULL references properties(id)` (0079). A
//     conversation with no single hotel is not representable, and this change
//     ships NO migration. So a portfolio conversation is ANCHORED to one hotel
//     the caller genuinely covers — the lowest-sorted hotel in the company at
//     the moment it was created. The anchor is bookkeeping (it satisfies the FK,
//     it gives `agent_messages`' 0336 trigger a property to derive, and it keeps
//     `staxis_lock_load_and_record_user_turn`'s property check meaningful). It
//     is NOT the scope of the answer: the answer's scope is re-resolved from the
//     spine on every turn and on every tool call.
//
//     The anchor is READ BACK from the row on later turns, never recomputed —
//     a company that buys a hotel sorting before the old anchor would otherwise
//     fail the RPC's property check on its VP's next message.
//
//   • `role` is a CHECK'd enum and `title` is user-visible, so neither can carry
//     a company id. `prompt_version` is free-form text whose documented meaning
//     is "which prompt configuration this conversation started under" — and a
//     portfolio conversation genuinely started under a different prompt
//     assembly. The marker rides there, as a trailing `+org:<uuid>` segment, in
//     the same `+`-separated shape `parsePromptStamp` already tolerates
//     (unknown segments fall through to `codeRules`, and the leading bare
//     segment still parses as the base/role version).
//
// THE DAY A COLUMN EXISTS, THIS FILE IS THE ONLY THING TO MOVE. Encoding and
// decoding both live here; nothing else in the codebase reads or writes the
// marker's format.

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORG_SEGMENT_PREFIX = 'org:';

/**
 * Stamp a conversation as belonging to a company.
 *
 * The org segment goes LAST so `parsePromptStamp` still reads the leading bare
 * segment as the prompt version it always was — a pre-existing reader of an
 * org-scoped row degrades to "an extra code rule I don't recognise", never to a
 * mis-parsed version.
 */
export function stampOrgScope(promptVersion: string, organizationId: string): string {
  if (!UUID_RX.test(organizationId ?? '')) return promptVersion;
  return `${promptVersion}+${ORG_SEGMENT_PREFIX}${organizationId}`;
}

/** The company a conversation belongs to, or null for every hotel conversation. */
export function orgScopeFromStamp(promptVersion: string | null | undefined): string | null {
  if (typeof promptVersion !== 'string' || promptVersion.length === 0) return null;
  for (const raw of promptVersion.split('+')) {
    const seg = raw.trim();
    if (!seg.startsWith(ORG_SEGMENT_PREFIX)) continue;
    const value = seg.slice(ORG_SEGMENT_PREFIX.length);
    if (UUID_RX.test(value)) return value;
  }
  return null;
}

/**
 * The hotel a portfolio conversation is anchored to.
 *
 * Lowest-sorted covered hotel, so the choice is deterministic and reproducible
 * from the company's own hotel list rather than from whichever read finished
 * first. Returns null for an empty portfolio, which the route refuses earlier.
 */
export function anchorHotelFor(propertyIds: readonly string[]): string | null {
  const sorted = [...propertyIds].filter((id) => UUID_RX.test(id)).sort();
  return sorted[0] ?? null;
}
