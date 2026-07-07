/**
 * feed-sample-key — the ONE sanitizer that turns a feed's action key into the
 * filename segment used for its per-property preview artifact in the private
 * `mapping-screenshots` storage bucket:
 *
 *     live/{propertyId}/{sanitizeFeedKey(feedKey)}.sample.json
 *
 * feature/coverage-gated-feeds. This rule is SHARED (not duplicated) by every
 * place that has to agree on that path:
 *   - GET /api/admin/mapper/feed-sample — reads the artifact to show the founder
 *     the "Captured" preview panel.
 *   - promoteMap (gateByPropertyCaptures) — lists the same prefix at Make-live
 *     to decide which feeds have a proven preview and which get disabled.
 *
 * If these two ever computed the sanitized key differently, promote could
 * DISABLE a feed the panel shows as previewed (or vice-versa) — the founder's
 * prediction would drift from what actually collects. Keeping it a single
 * exported function makes that drift impossible.
 *
 * The rule is intentionally identical to feed-sample's original inline
 * `sanitizeKey`: any character that isn't [a-z0-9_-] (case-insensitive) → '_'.
 */
export const sanitizeFeedKey = (k: string): string => k.replace(/[^a-z0-9_-]/gi, '_');

/**
 * sampleIndicatesSuccess — does a parsed sample.json artifact PROVE its feed?
 *
 * Artifact EXISTENCE is not proof: the worker's on-demand capture writes the
 * sample even for a partially-failed read (it's a "see what went wrong"
 * preview) and stamps `ok: boolean` (extraction success) into the JSON. The
 * shared rule, used by BOTH the Make-live gate (promoteMap) and the
 * feed-sample route's response, is:
 *
 *   proven ⇔ parsed.ok !== false
 *
 * i.e. only an EXPLICIT ok:false marks a feed unproven. A legacy artifact
 * WITHOUT the field is grandfathered as proven — the feeds the founder
 * previewed successfully before the flag existed must stay on. Garbage /
 * non-object input also counts proven (fail open, consistent with the gate's
 * overall fail-open stance: collecting everything beats blocking go-live).
 */
export const sampleIndicatesSuccess = (parsed: unknown): boolean => {
  if (!parsed || typeof parsed !== 'object') return true; // garbage → fail open
  return (parsed as { ok?: unknown }).ok !== false;
};
