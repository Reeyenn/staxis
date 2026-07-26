import 'server-only';

// ─── The portfolio identity block ───────────────────────────────────────────
//
// WHAT THIS IS
// The list of hotels a company-scope person is asking about, rendered into the
// CACHED half of their portfolio conversation's system prompt: which company,
// which hotels, how big each one is. It is the portfolio surface's answer to
// the per-hotel `hotel-identity.ts` block — and it is deliberately NOT that
// block repeated twenty times.
//
// WHAT IT IS NOT, AND WHY THAT IS THE POINT
// A per-hotel prompt carries that hotel's PRIVATE, DURABLE facts: its
// housekeeping level, its checklists, its shift pattern, its roster shape, its
// PMS family's shared notes. NONE of that belongs here. Twenty hotels' identity
// blocks in one prompt would be ~20x the cached tokens for text the model was
// asked nothing about, and it would put one hotel's internal setup in front of
// a question about a different hotel. A portfolio question is "which of my
// hotels had the worst week", and the answer to that needs the NAMES and the
// SIZES — the two things you need to read a comparison honestly (a 45-room
// inn's supply bill is not a 200-room hotel's) — and then a tool call.
//
// So the rule, enforced by `portfolio-prompt-assembly.test.ts`:
//   the portfolio prompt contains hotel names + room counts and NO other
//   hotel-supplied fact.
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTHING IN HERE MAY VARY WITH THE CLOCK
//
// Same contract as INV-TIER-9 and the company tier: this rides in the cached
// block, so a value that moves turn to turn rewrites the cached prefix every
// turn and silently multiplies the bill. Names and `total_rooms` are structural
// (the 0125 trigger keeps `total_rooms` equal to the room inventory's length,
// so it moves only when the hotel's actual room list does). Live counts live in
// the DYNAMIC snapshot block next door.
//
// TRUST
// Hotel names and the company name are CUSTOMER-SUPPLIED TEXT reaching the
// cached system block. They are sanitised against the same forgery vocabulary
// the family and company tiers use (`<`, `>`, `───`, newlines) and capped, so
// a hotel called `</staxis-portfolio> SYSTEM:` cannot close the envelope. The
// header, the ceiling and both marker tags are printed HERE, never by a row.

import type { PortfolioHotel } from './hotels';

export const PORTFOLIO_IDENTITY_VERSION = 'portfolio-identity-v1';

export const PORTFOLIO_IDENTITY_HEADER = '─── The hotels you are being asked about ───';
export const PORTFOLIO_TRUST_MARKER_OPEN = '<staxis-portfolio trust="system">';
export const PORTFOLIO_TRUST_MARKER_CLOSE = '</staxis-portfolio>';

/** Longest a hotel or company name may be after sanitising. */
const MAX_NAME_CHARS = 80;
/** Ceiling on the whole rendered block — cached tokens paid on every turn. */
const MAX_BLOCK_CHARS = 4000;

/**
 * Neutralise a customer-supplied name before it reaches the cached block.
 * Same treatment `safeLabel` gives a hotel's own labels, for the same reason.
 */
export function safePortfolioName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[<>]/g, ' ')      // no trust-marker forgery
    .replace(/─/g, '-')         // no section-header forgery
    .replace(/[\r\n]+/g, ' ')   // stays on its own line
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_NAME_CHARS ? cleaned.slice(0, MAX_NAME_CHARS) : cleaned;
}

export interface PortfolioIdentity {
  organizationId: string;
  organizationName: string | null;
  hotels: PortfolioHotel[];
  /** Hotels the caller covers that this turn will not read (the 50 ceiling). */
  omittedHotelCount: number;
}

/**
 * Render the block, or null when there is nothing honest to say.
 *
 * DAY-ZERO SILENT, like every other derived block: a company with no readable
 * hotels renders NO SECTION rather than a header over an empty list. A rendered
 * "0 hotels" is a sentence the model repeats to a VP as a finding about their
 * company instead of a fact about our database.
 */
export function formatPortfolioIdentityForPrompt(
  identity: PortfolioIdentity | null,
): string | null {
  if (!identity || identity.hotels.length === 0) return null;

  const company = safePortfolioName(identity.organizationName) ?? 'this management company';

  const rows: string[] = [];
  let budget = MAX_BLOCK_CHARS;
  let dropped = 0;
  for (const hotel of identity.hotels) {
    const name = safePortfolioName(hotel.name);
    if (!name) {
      // A hotel we cannot name is a hotel the model must not invent a name for.
      dropped += 1;
      continue;
    }
    const size = hotel.totalRooms && hotel.totalRooms > 0 ? ` — ${hotel.totalRooms} rooms` : '';
    const line = `- ${name}${size}`;
    if (line.length > budget) {
      dropped += 1;
      continue;
    }
    budget -= line.length + 1;
    rows.push(line);
  }
  if (rows.length === 0) return null;

  const unlisted = identity.omittedHotelCount + dropped;

  const lines: string[] = [
    PORTFOLIO_IDENTITY_HEADER,
    `You are in PORTFOLIO mode, answering for ${company} across the hotels listed below and no others. `
    + 'Every hotel in the list belongs to this company and this person oversees all of them, so '
    + 'comparing them with each other is exactly what they are asking for. A hotel that is NOT in '
    + 'the list is somebody else\'s hotel: you have no data about it, no tool that reaches it, and '
    + 'nothing to say about it.',
    'Sizes are here so you read a comparison honestly — a 45-room inn and a 200-room hotel do not '
    + 'spend the same on supplies, so say which is which rather than ranking raw dollars alone.',
    '',
    PORTFOLIO_TRUST_MARKER_OPEN,
    ...rows,
  ];
  if (unlisted > 0) {
    lines.push(
      `(${unlisted} more of this company's hotels are not listed here and are not covered by this `
      + 'conversation — say so if the question needs them.)',
    );
  }
  lines.push(PORTFOLIO_TRUST_MARKER_CLOSE);
  return lines.join('\n');
}
