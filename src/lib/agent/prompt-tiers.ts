// ─── Prompt tier policy ────────────────────────────────────────────────────
// The rules about the three instruction tiers (global → PMS family → hotel)
// that are pure decisions: what a family addendum is allowed to contain, and
// what a healthy set of tier rows looks like.
//
// Deliberately a LEAF module — no imports at all. Two callers need these rules
// and they live on opposite sides of the app: the prompt assembler (hot path)
// and /api/admin/doctor. Putting them here keeps the doctor route from
// importing the entire agent runtime (prompts → context → tools → db) just to
// count rows, and keeps the prompts ⇄ prompts-store cycle from growing a new
// value dependency.
//
// Migration 0338 enforces the same rules in the database with CHECK
// constraints; this file is the code-side half of INV-TIER-7 and the whole of
// the doctor's `agent_prompt_tiers` check.

/** Hard ceiling on a family addendum, mirroring CHECK
 *  agent_prompts_family_len_ck (0338). ~1000 tokens of cached prompt, paid on
 *  every conversation of every hotel on that PMS. */
export const FAMILY_CONTENT_MAX_CHARS = 4000;

/** The two structural vocabularies a family row must not be able to forge:
 *  llm.ts's trust markers and the assembler's section headers. */
const FAMILY_FORBIDDEN_MARKER = /<\s*\/?\s*(staxis-|tool-result)/i;
const SECTION_RULE = '───';

/**
 * EVERY character a reader would see as a horizontal rule, not just the one
 * this codebase types.
 *
 * The old check was `content.includes('───')` — three U+2500 BOX DRAWINGS LIGHT
 * HORIZONTAL, the exact glyph the assembler prints. A row that opened its fake
 * section with `═══` (double), `━━━` (heavy), `———` (em dashes) or `▬▬▬` passed
 * it and rendered as something a model reads as a section boundary anyway. The
 * denylist has to be about what the text LOOKS like, because that is the only
 * thing the model can act on.
 *
 * Three or more in a row, because one em dash is ordinary prose ("all our
 * hotels — every one — use Ecolab") and forbidding it would reject real
 * rulebook lines.
 */
const DIVIDER_RUN = new RegExp(
  '['
  + '\\u2010-\\u2015'   // hyphen … horizontal bar (em/en dash live in here)
  + '\\u2212'           // minus sign
  + '\\u2500-\\u257F'   // box drawing, including the ─ the assembler prints
  + '\\u2E3A\\u2E3B'    // two-em / three-em dash
  + '\\u23AF\\u23E4'    // horizontal line extension, straightness symbol
  + '\\u25AC\\u25AD'    // black / white rectangle
  + '\\uFE58\\uFE63\\uFF0D' // small + fullwidth hyphen forms
  + '\\u02D7\\u058A\\u1806\\u2043' // modifier, Armenian, Mongolian, hyphen bullet
  + ']{3,}',
);

/**
 * Fold a string down to the shape the denylists are written against.
 *
 * THE HOLE THIS CLOSES. `FAMILY_FORBIDDEN_MARKER` above is an ASCII pattern:
 * it looks for the literal hyphen in "staxis-". A U+2011 NON-BREAKING HYPHEN is
 * not that character, so a fact reading `</staxis‑company‑rulebook>` sailed
 * past the check while rendering, to the model, as a perfect closing tag —
 * manager-typed prose would have landed in the cached system prompt of every
 * hotel the company operates, wearing Staxis's own standing. The same trick
 * works with U+2010, U+2212 MINUS SIGN, U+FF0D FULLWIDTH HYPHEN-MINUS, and
 * with U+00AD SOFT HYPHEN, which is invisible.
 *
 * So: NFKC first (which collapses fullwidth and compatibility forms), then map
 * every dash-like code point to ASCII `-`, and drop the zero-width characters
 * that can be sprinkled INSIDE a marker word to break the match without
 * changing a single rendered glyph.
 *
 * NOTE this is used for the CHECK ONLY — never for what gets rendered. The
 * rendered bytes stay exactly what the author wrote (escaped, see below), so a
 * normalization quirk can never silently rewrite a company's own policy text.
 */
/** Zero-width, soft hyphen, joiners, bidi controls, BOM. Invisible to a reader,
 *  and each one splits a denylisted word in two (`sta<ZWSP>xis-`) without
 *  changing a single rendered glyph. */
const INVISIBLES = new RegExp(
  '[\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E'
  + '\\u2060-\\u2064\\u206A-\\u206F\\uFEFF]',
  'g',
);

/** Every dash-like code point a reader sees as an ASCII `-`. */
const DASHES = new RegExp(
  '[\\u2010-\\u2015\\u2212\\u2E3A\\u2E3B\\uFE58\\uFE63\\uFF0D'
  + '\\u02D7\\u058A\\u1806\\u2043]',
  'g',
);

/**
 * NFKC + strip invisibles. Preserves dash IDENTITY, so a run of em dashes is
 * still recognisable as a drawn divider. This is what `DIVIDER_RUN` is tested
 * against.
 */
function foldInvisibles(content: string): string {
  return content.normalize('NFKC').replace(INVISIBLES, '');
}

/**
 * `foldInvisibles`, plus every dash flattened to ASCII `-`. This is what the
 * `<staxis-…>` marker denylist is tested against, and it is the whole point of
 * the exercise: `staxis‑` (U+2011) now matches `staxis-`.
 *
 * Deliberately NOT the input to `DIVIDER_RUN` — flattening `———` to `---` would
 * hide the divider from the check that exists to catch it.
 */
export function normalizeForMarkerCheck(content: string): string {
  return foldInvisibles(content).replace(DASHES, '-');
}

/**
 * Is this family addendum safe to splice into the cached prompt?
 *
 * The DB already rejects violating rows. Re-checking here means a relaxed
 * constraint, a hand-edited row, or a future non-DB source of family content
 * still cannot fabricate a `<staxis-snapshot trust="system">` block or open a
 * fake `─── … ───` section — the assembler drops the section instead.
 *
 * This predicate is a FILTER, not the guarantee. The guarantee is that the
 * assembler escapes `< > &` in whatever it does render
 * (`escapeTrustMarkerContent`), so even a marker this check failed to
 * recognise cannot close an envelope. A denylist is a list of attacks somebody
 * thought of; escaping is arithmetic.
 */
export function familyContentIsSafe(content: string): boolean {
  if (content.length > FAMILY_CONTENT_MAX_CHARS) return false;
  if (FAMILY_FORBIDDEN_MARKER.test(normalizeForMarkerCheck(content))) return false;
  const visible = foldInvisibles(content);
  if (visible.includes(SECTION_RULE) || DIVIDER_RUN.test(visible)) return false;
  return true;
}

/**
 * Hard ceiling on the whole COMPANY rulebook block (0365). Same order as the
 * family cap and for the same reason: this is cached prompt paid on every
 * conversation of every hotel the company operates, so a company that pastes a
 * 200-page brand manual into its rulebook must not be able to bill itself for
 * that on every turn. Facts past the budget are dropped, never truncated
 * mid-sentence — half a policy is worse than no policy.
 */
export const COMPANY_BLOCK_MAX_CHARS = 4000;

/**
 * Is this rulebook line safe to splice into the cached prompt?
 *
 * The DB already rejects violating rows (company_knowledge_no_markers_ck). This
 * re-check means a relaxed constraint, a hand-edited row, or a future non-DB
 * source still cannot fabricate a `<staxis-snapshot trust="system">` block or
 * open a fake `─── … ───` section from inside the company tier — which sits
 * ABOVE the family tier and is therefore the highest-authority text a customer
 * can put in front of the model.
 *
 * Deliberately the same predicate as `familyContentIsSafe`, applied per fact
 * rather than per row: the block-level budget is enforced by the renderer.
 *
 * As there, this is the FILTER. The guarantee is `company-tier.ts` escaping
 * `< > &` in every fact it renders — the homoglyph probe that motivated the
 * normalization above (`</staxis‑company‑rulebook>` with a U+2011 hyphen)
 * defeats any denylist eventually, and only escaping is total.
 */
export function companyFactIsSafe(content: string): boolean {
  if (content.length > COMPANY_BLOCK_MAX_CHARS) return false;
  if (FAMILY_FORBIDDEN_MARKER.test(normalizeForMarkerCheck(content))) return false;
  const visible = foldInvisibles(content);
  if (visible.includes(SECTION_RULE) || DIVIDER_RUN.test(visible)) return false;
  return true;
}

/**
 * Hard ceiling on the whole HOTEL standing-rules block (0417).
 *
 * A quarter of the company cap, and that is not a rounding choice. A company
 * rulebook is a written policy document that a VP maintains; a hotel's standing
 * rules are sentences a manager said out loud to the companion, one at a time.
 * Fifty of them is a hotel that has started using the companion as a filing
 * cabinet, and past that point the block is crowding out the hotel's own live
 * numbers in the same prompt. Rules past the budget are dropped whole, never
 * truncated: half a rule is worse than no rule.
 */
export const HOTEL_RULES_BLOCK_MAX_CHARS = 1000;

/**
 * Is this standing rule safe to splice into the cached prompt?
 *
 * Deliberately the same predicate as `companyFactIsSafe`, because the two land
 * in the same prompt inside the same kind of untrusted envelope and a divergence
 * between them would be a hole in whichever one drifted. Named separately so
 * that a future change to one is a decision about that one, and so the hotel
 * tier's call site does not read as though it is checking company content.
 */
export function hotelRuleIsSafe(content: string): boolean {
  return companyFactIsSafe(content);
}

// ─── The envelope discipline ───────────────────────────────────────────────

/**
 * Render text that SOMEBODY ELSE WROTE into the cached system block.
 *
 * Three tiers do this today (PMS family, company rulebook, hotel standing
 * rules) and each one had assembled the same five-part shape by hand. The shape
 * is not decoration; every part of it is load-bearing:
 *
 *   header      a section rule the CONTENT cannot forge, because the predicates
 *               above reject drawn dividers in every alphabet.
 *   trustNote   the code-owned CEILING: what this channel is allowed to do.
 *               Printed by code, so an operator with psql cannot edit it.
 *   markerOpen  an attribute-bearing tag naming the channel and its trust level.
 *   body        the other party's text, ALREADY escaped by the caller.
 *   markerClose unforgeable, because escaping `< > &` is arithmetic rather than
 *               recognition — no byte sequence in the body can close it.
 *
 * The caller still owns escaping and dropping, because the caller is the only
 * one that knows which predicate above applies and what to do with a row it
 * rejects (every current caller reports the drop to Sentry with the row's
 * identity and never its content). This function owns the SHAPE, so a fourth
 * fenced tier cannot ship without a ceiling above it or a closing tag under it.
 *
 * Lives in this leaf module rather than with the rule registry so that the
 * tiers which use it do not have to import the registry that imports them.
 */
export function renderTrustEnvelope(input: {
  header: string;
  trustNote: string;
  markerOpen: string;
  markerClose: string;
  /** Already escaped. This function never escapes: it cannot know the predicate. */
  bodyLines: readonly string[];
}): string {
  return [
    input.header,
    input.trustNote,
    '',
    input.markerOpen,
    ...input.bodyLines,
    input.markerClose,
  ].join('\n');
}

/** One agent_prompts row, as the tier-health evaluator needs it. */
export interface PromptTierRow {
  role: string;
  pmsFamily: string | null;
  isActive: boolean;
  contentLength: number;
}

export interface PromptTierHealth {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * Decide whether the prompt tiers are in a healthy state.
 *
 * Rules (the FAIL/WARN split matters):
 *  - FAIL  >1 active row in any (role, family) group. The partial unique index
 *          makes this unreachable, so seeing it means the index is gone.
 *  - FAIL  a GLOBAL group that has rows but none active — the copilot silently
 *          fell back to the fail-soft code constants.
 *  - FAIL  an active family row over the length cap — defence in depth if a
 *          future migration relaxes the CHECK.
 *  - WARN  a FAMILY group that has rows but none active. That is the state a
 *          botched activation leaves behind (see the 0338 RPC fix); it is not
 *          a global outage, so it must not fail the deploy gate.
 *  - OK    zero family rows. An empty slot is the correct steady state until
 *          the first PMS report format is understood — this check must not nag
 *          the founder for weeks about a slot that is meant to be empty.
 */
export function evaluatePromptTierHealth(rows: PromptTierRow[]): PromptTierHealth {
  const groups = new Map<string, PromptTierRow[]>();
  for (const r of rows) {
    const key = `${r.role}::${r.pmsFamily ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const multiActive: string[] = [];
  const darkGlobal: string[] = [];
  const darkFamily: string[] = [];
  const oversized: string[] = [];
  let activeGlobal = 0;
  let activeFamily = 0;

  for (const [key, bucket] of groups) {
    const actives = bucket.filter(r => r.isActive);
    const isFamily = bucket[0].role === 'family';
    if (actives.length > 1) multiActive.push(key);
    else if (actives.length === 0) (isFamily ? darkFamily : darkGlobal).push(key);
    if (isFamily) {
      activeFamily += actives.length;
      for (const a of actives) {
        if (a.contentLength > FAMILY_CONTENT_MAX_CHARS) oversized.push(key);
      }
    } else {
      activeGlobal += actives.length;
    }
  }

  const census = `${activeGlobal} global tier(s) active, ${activeFamily} family tier(s) active`
    + (activeFamily === 0 ? ' (slot empty)' : '');

  if (multiActive.length > 0) {
    return {
      status: 'fail',
      detail: `more than one active prompt row in: ${multiActive.join(', ')}. `
        + 'The partial unique index agent_prompts_active_per_role_family_uq should make this impossible — verify it still exists.',
    };
  }
  if (darkGlobal.length > 0) {
    return {
      status: 'fail',
      detail: `global prompt tier(s) with rows but none active: ${darkGlobal.join(', ')}. `
        + 'The copilot is running on the fail-soft code constants for these.',
    };
  }
  if (oversized.length > 0) {
    return {
      status: 'fail',
      detail: `active family prompt row(s) over ${FAMILY_CONTENT_MAX_CHARS} chars: ${oversized.join(', ')}. `
        + 'This is cached prompt paid on every conversation.',
    };
  }
  if (darkFamily.length > 0) {
    return {
      status: 'warn',
      detail: `${census}. PMS family tier(s) with rows but none active: ${darkFamily.join(', ')}. `
        + 'Hotels on those PMS families are getting no PMS guidance.',
    };
  }
  return { status: 'ok', detail: census };
}

// ─── Prompt routing vs the tool catalog ────────────────────────────────────
//
// `agent-tool-catalog-audit` already asserts that prompts.ts — the FAIL-SOFT
// constants — never routes the model at a tool it will not be offered. That
// test can only see code, and code is not what production reads: the live
// prompt for every role is a ROW in `agent_prompts`, and a row is data. The
// 2026-07-27 catalog rebuild renamed and merged tools, updated the constants
// (forced by that test), and left three live rows pointing at
// `list_my_rooms`, `generate_schedule`, `get_revenue`, `get_occupancy`,
// `get_inventory`, `compare_properties` and `get_financial_report` — names the
// model was no longer offered. Nothing anywhere went red, because nothing
// anywhere looks at the rows.
//
// This is that missing half, expressed as pure rules so the doctor route can
// apply them to the live table (see `agent_prompt_tool_names`). The catalog
// itself is passed IN rather than imported: this module is a deliberate leaf
// (see the file header) and importing the agent tool registry here would drag
// the whole agent runtime into every caller.

/** What the model is actually offered, and what a retired name now means. */
export interface PromptToolCatalog {
  /** Wire-names of registered tools — `listAllTools()`. */
  live: ReadonlySet<string>;
  /** Retired wire-name → surviving tool. `TOOL_ALIASES`. */
  retired: ReadonlyMap<string, string>;
}

/** One active prompt row, as the routing check needs it. */
export interface PromptRoutingRow {
  role: string;
  version: string;
  pmsFamily: string | null;
  content: string;
}

/** A wire-name shaped token: lower snake_case, at least one underscore. */
const TOOL_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * The tools a prompt sends the model to.
 *
 * Prompt rows route with an arrow — `"Occupancy?" → get_today_summary` — so the
 * tokens that matter are the ones AFTER the first arrow on a line. Everything
 * before it is the user's phrasing, and prose elsewhere in a prompt legitimately
 * contains snake_case that is not a tool (`pms_family`, `original_language`).
 *
 * Deliberately the same shape as the constants-side check in
 * `agent-tool-catalog-audit`, so the two halves cannot disagree about what
 * counts as routing. A line may chain (`→ a_tool + another_tool`), so every
 * token after the arrow is taken, not just the first.
 */
export function extractRoutedToolNames(content: string): string[] {
  const found = new Set<string>();
  for (const line of content.split('\n')) {
    const arrow = line.indexOf('→');
    if (arrow === -1) continue;
    for (const match of line.slice(arrow + 1).matchAll(TOOL_TOKEN)) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/**
 * Do the live prompt rows still point at tools that exist?
 *
 * Two failures, deliberately graded differently:
 *
 *   FAIL  a routed name that is neither a live tool NOR a retired alias. The
 *         model calls it and gets "Tool not found" — the answer is already
 *         broken, and only a query against the rows can see it.
 *
 *   WARN  a retired name. The alias layer keeps it working, so nothing is
 *         broken today; the row is simply stale, and every turn it costs the
 *         model a routing hop it should not have to take. Warn, not fail,
 *         because a deploy gate that goes red over text that still works is a
 *         gate that gets waved through.
 *
 * Rows are named by role + version in the detail so the fix is a copy-paste:
 * write the new revision and activate it.
 */
export function evaluatePromptToolRouting(
  rows: PromptRoutingRow[],
  catalog: PromptToolCatalog,
): PromptTierHealth {
  const dangling: string[] = [];
  const stale: string[] = [];

  for (const row of rows) {
    const label = `${row.role}${row.pmsFamily ? `/${row.pmsFamily}` : ''} v${row.version}`;
    // A retired name ANYWHERE in the row, arrow or not: "Send everyone the
    // schedule → generate_schedule + send_help_sms" is routing, and so is a
    // sentence that merely mentions the old name as the thing to call.
    for (const [retired, survivor] of catalog.retired) {
      if (new RegExp(`\\b${retired}\\b`).test(row.content)) {
        stale.push(`${label} names ${retired} (now ${survivor})`);
      }
    }
    for (const name of extractRoutedToolNames(row.content)) {
      if (catalog.live.has(name) || catalog.retired.has(name)) continue;
      dangling.push(`${label} routes to ${name}, which is not a tool`);
    }
  }

  if (dangling.length > 0) {
    return {
      status: 'fail',
      detail: `active prompt row(s) route the copilot at names that do not exist: ${dangling.join('; ')}. `
        + 'The model calls them and gets "Tool not found".'
        // Reported alongside rather than on the next run: a row that has gone
        // this stale is usually stale in both ways, and fixing it means writing
        // one new revision. Two visits for one edit is how the second half gets
        // forgotten.
        + (stale.length > 0 ? ` Also still naming retired tools: ${stale.join('; ')}.` : ''),
    };
  }
  if (stale.length > 0) {
    return {
      status: 'warn',
      detail: `active prompt row(s) still name retired tools: ${stale.join('; ')}. `
        + 'The aliases keep them working, but the rows are behind the catalog.',
    };
  }
  return {
    status: 'ok',
    detail: `${rows.length} active prompt row(s) route only to live tools`,
  };
}
