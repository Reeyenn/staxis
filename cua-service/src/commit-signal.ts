/**
 * Structural commit signal for the CUA mapper (fix/cua-mapper-commit).
 *
 * The mapper's per-feed agent loop commits a page as a feed by emitting a
 * {"rowSelector","columns"} JSON object. The observed failure mode (run
 * c9f0fd7f, 2026-06-13) is that the model WON'T emit it: it keeps navigating in
 * search of a "more canonical / report" version, refuses to accept a correct
 * page that happens to have zero rows right now, and dithers on a page that
 * already shows the data — until the loop detector or the per-target cost cap
 * kills the feed having captured nothing.
 *
 * This module is the PURE decision core for a deterministic backstop: when the
 * agent has lingered on the SAME page across turns (dithering, not navigating)
 * and that page shows a repeating, multi-column tabular structure — the
 * universal shape of a PMS feed — the mapper appends a one-time "commit
 * checkpoint" reminder to the next turn.
 *
 * UNIVERSAL by construction: every function here reasons about page SHAPE
 * (counts of tables / columns / data rows) and the TARGET's own required-field
 * contract. There is ZERO PMS vocabulary, page name, URL, or menu label. The
 * Playwright glue that produces a `TabularSummary` lives in mapper.ts; this
 * module never touches a Page, the DB, env, or the network, so it unit-tests in
 * isolation (mirrors loop-detector.ts).
 *
 * SAFETY: the reminder is model-mediated — the model still emits the actual
 * selectors and the column audit still verifies them, so the nudge can never by
 * itself commit a page. The mapper additionally gates firing to CORE feeds
 * (which carry value-level audits), excludes the dashboard, and requires the
 * page to be stable across the turn. See mapActionCore for those env gates.
 */

/** Purely-structural summary of the current page, produced by the Playwright
 *  glue in mapper.ts. No PMS-specific content — just shape counts. */
export interface TabularSummary {
  /** Number of repeating, >=2-column tabular structures detected (native
   *  <table> or ARIA role=grid/table). */
  tableCount: number;
  /** Most columns seen in any detected structure (header OR body row). */
  maxColumns: number;
  /** Most DATA rows seen in any detected structure. 0 = a structurally-valid
   *  but currently-empty table (e.g. no departures right now) — still a
   *  complete, valid capture. */
  maxDataRows: number;
}

/** Minimum columns for a structure to count as a data table rather than a
 *  navigation menu / single-column list (which are 1 column wide). */
export const COMMIT_MIN_COLUMNS = 2;

/** Fire the nudge once the agent has reasoned on the SAME page for this many
 *  turns beyond the first (>=2 => the 3rd consecutive same-page turn). Chosen
 *  to land BEFORE the action-loop detector's 4th-identical-tuple trip while
 *  still giving the model two unprompted turns to commit on its own. */
export const COMMIT_DITHER_TURNS = 2;

/**
 * Does the page show a committable feed shape? True iff at least one repeating,
 * multi-column tabular structure is present. ZERO data rows still qualifies — an
 * empty-but-structured table is a complete capture; the evidence floor is met by
 * STRUCTURE, not row count. The >=2-column rule excludes nav menus / single-
 * column lists, which are the common 1-column false positives.
 */
export function hasCommittableStructure(s: TabularSummary): boolean {
  return s.tableCount >= 1 && s.maxColumns >= COMMIT_MIN_COLUMNS;
}

/**
 * The PURE half of the nudge decision: dithering + a committable structure +
 * not-yet-nudged. The caller (mapActionCore) supplies the additional ENV gates
 * that keep this safe — CORE-target-only, off-dashboard, page-stable-this-turn —
 * because those need a live Page / the target catalogue and don't belong in a
 * pure module. Keeping the streak/structure logic here makes it directly
 * testable.
 */
export function shouldNudgeCommit(args: {
  /** Consecutive same-page turns so far (see COMMIT_DITHER_TURNS). */
  samePageStreak: number;
  structure: TabularSummary;
  /** Already nudged this exact page — fire at most once per page. */
  alreadyNudgedThisPage: boolean;
}): boolean {
  if (args.alreadyNudgedThisPage) return false;
  if (args.samePageStreak < COMMIT_DITHER_TURNS) return false;
  return hasCommittableStructure(args.structure);
}

/**
 * Build the commit-checkpoint reminder text. This is a TRUSTED supervisor
 * instruction (same channel as the recovery re-ask / supervisor-hint user turns
 * in mapActionCore) — it contains ONLY our own required-field names and generic
 * guidance, never any PMS-derived page text, so it carries no injection risk.
 *
 * The text:
 *   - tells the model an empty (0-row) table is a COMPLETE capture,
 *   - lists THIS feed's required fields so it verifies column presence before
 *     committing (false-capture guard),
 *   - forces a heading/identity check so a sibling page (arrivals vs
 *     departures) is REDIRECTED, not wrongly committed, and
 *   - rejects committing a dashboard summary tile of totals.
 */
export function buildCommitNudge(args: {
  actionName: string;
  requiredFields: string[];
  structure: TabularSummary;
}): string {
  const fields = args.requiredFields.length > 0
    ? args.requiredFields.join(', ')
    : "this feed's required fields";
  const emptyNote = args.structure.maxDataRows === 0
    ? `This table currently has ZERO data rows — that is normal and still a COMPLETE, valid ` +
      `capture (there may simply be no records right now). Read the column selectors from the ` +
      `header row and emit them; do NOT keep searching for a version that has rows. `
    : '';
  return (
    `Supervisor checkpoint: you have stayed on this page for several turns without finishing, ` +
    `and it already shows a repeating table/list (${args.structure.maxColumns} columns visible). ` +
    `If these columns include this feed's required fields (${fields}) AND this page really is the ` +
    `target — check the page heading/title; if it actually names a DIFFERENT feed (for example a ` +
    `sibling such as arrivals vs departures), do NOT commit it: return to the dashboard and open ` +
    `the adjacent menu item instead — then THIS is the target: emit the success JSON now with your ` +
    `best-guess CSS selectors. ${emptyNote}` +
    `Do not hold out for a cleaner or "report"-named version, and do not commit a dashboard ` +
    `summary tile of totals — only the page that lists the individual records.`
  );
}
