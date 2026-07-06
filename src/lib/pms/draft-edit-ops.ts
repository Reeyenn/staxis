/**
 * draft-edit-ops — the PURE payload builders for a DRAFT recipe edit.
 *
 * fix/cua-draft-resign — the bug this closes: the Coverage Editor's parked-draft
 * paths used to mutate a draft's `knowledge` jsonb IN PLACE via supabaseAdmin,
 * WITHOUT re-signing. Every draft is signed at learn time (HMAC over `knowledge`,
 * keyed by the Fly-only RECIPE_SIGNING_KEY — the web can NEVER sign), and the
 * worker verifies that seal before it will honour a draft. An in-place jsonb
 * write silently broke the seal, so promoting the edited draft made the worker
 * REFUSE it and auto-trigger a fresh ~$25 re-learn.
 *
 * The fix: a draft edit now enqueues the SAME worker re-sign job that a LIVE-map
 * edit already uses — the 'mapper.edit_recipe' job kind. The worker edits the
 * draft row IN PLACE (same id, same version, re-signed) via four draft-targeted
 * ops and stamps result.knowledge_file_id = the draft id, so the existing
 * GET /api/admin/mapper/live/[jobId] polling works unchanged.
 *
 * This module owns ONLY the shape of the four op payloads — it is a pure,
 * dependency-free function so it can be unit-tested to the exact worker contract
 * without a DB. The route does the fast-fail validation (contract-column guards,
 * can't-empty-feed, uuid checks) BEFORE calling these; the worker re-validates
 * authoritatively against the draft it re-signs.
 *
 * The EXACT worker contract (cua-service/src/ recipe-edit draft ops):
 *   - draft_delete_feeds      { pms_family, draft_id, feed_keys: string[] }
 *   - draft_delete_column     { pms_family, draft_id, feed_key, column_name }
 *   - draft_add_custom_column { pms_family, draft_id, feed_key, column_key,
 *                               selector, scope ('row'|'page') }
 *   - draft_set_column        { pms_family, draft_id, feed_key, column_name,
 *                               selector, is_custom: boolean }
 */

/** The four draft-targeted edit ops the worker's 'mapper.edit_recipe' job kind
 *  understands. Kept as a string-literal union so a typo can't reach the worker. */
export type DraftEditOp =
  | 'draft_delete_feeds'
  | 'draft_delete_column'
  | 'draft_add_custom_column'
  | 'draft_set_column';

/** The `edit_op`-tagged payload fragment for one draft op. This is the object
 *  spread into workflow_jobs.payload alongside { pms_family, property_id, ... };
 *  every op carries `draft_id` so the worker targets the exact parked row. */
export type DraftEditPayload =
  | { edit_op: 'draft_delete_feeds'; draft_id: string; feed_keys: string[] }
  | { edit_op: 'draft_delete_column'; draft_id: string; feed_key: string; column_name: string }
  | {
      edit_op: 'draft_add_custom_column';
      draft_id: string;
      feed_key: string;
      column_key: string;
      selector: string;
      scope: 'row' | 'page';
    }
  | {
      edit_op: 'draft_set_column';
      draft_id: string;
      feed_key: string;
      column_name: string;
      selector: string;
      is_custom: boolean;
    };

/** Delete one column (built-in or custom) from ONE draft feed. */
export function draftDeleteColumnPayload(args: {
  draftId: string;
  feedKey: string;
  columnName: string;
}): Extract<DraftEditPayload, { edit_op: 'draft_delete_column' }> {
  return {
    edit_op: 'draft_delete_column',
    draft_id: args.draftId,
    feed_key: args.feedKey,
    column_name: args.columnName,
  };
}

/** Delete one whole feed from a draft. The worker op is PLURAL (feed_keys[]) so
 *  the same job kind can drop several at once; the Coverage Editor removes one
 *  feed per click, so we send a single-element array. */
export function draftDeleteFeedsPayload(args: {
  draftId: string;
  feedKeys: string[];
}): Extract<DraftEditPayload, { edit_op: 'draft_delete_feeds' }> {
  return {
    edit_op: 'draft_delete_feeds',
    draft_id: args.draftId,
    feed_keys: args.feedKeys,
  };
}

/** Add an EXTRA (custom) column to a draft feed. `scope` is always sent
 *  explicitly ('row' for a per-row column, 'page' for a one-off page value) so
 *  the worker never has to infer it. */
export function draftAddCustomColumnPayload(args: {
  draftId: string;
  feedKey: string;
  columnKey: string;
  selector: string;
  scope: 'row' | 'page';
}): Extract<DraftEditPayload, { edit_op: 'draft_add_custom_column' }> {
  return {
    edit_op: 'draft_add_custom_column',
    draft_id: args.draftId,
    feed_key: args.feedKey,
    column_key: args.columnKey,
    selector: args.selector,
    scope: args.scope,
  };
}

/** RE-POINT an existing column (built-in/contract or custom) at a new selector
 *  on a draft feed. `is_custom` tells the worker WHICH hint bucket to touch
 *  (customColumns vs columns) — the route already knows this from the source row. */
export function draftSetColumnPayload(args: {
  draftId: string;
  feedKey: string;
  columnName: string;
  selector: string;
  isCustom: boolean;
}): Extract<DraftEditPayload, { edit_op: 'draft_set_column' }> {
  return {
    edit_op: 'draft_set_column',
    draft_id: args.draftId,
    feed_key: args.feedKey,
    column_name: args.columnName,
    selector: args.selector,
    is_custom: args.isCustom,
  };
}
