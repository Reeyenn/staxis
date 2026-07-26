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
