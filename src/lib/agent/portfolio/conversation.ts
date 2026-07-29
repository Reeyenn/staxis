import 'server-only';

// ─── First-class conversation security scope ───────────────────────────────
//
// Migration 0379 made property/portfolio an explicit database distinction.
// `property_id` intentionally remains NOT NULL for both kinds because the 0336
// message trigger derives every agent_messages.property_id from it. On a
// portfolio row that hotel is only a relational/telemetry ANCHOR. It must never
// be interpreted as either the selected grain or the complete portfolio scope.
//
// The old `prompt_version + '+org:<uuid>'` marker remains readable solely so a
// rolling deployment and pre-0379 rows can be backfilled. Once explicit columns
// are present they always win, including an explicit property row whose prompt
// stamp happens to contain a conflicting legacy marker.

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORG_SEGMENT_PREFIX = 'org:';
const POLICY_SEGMENT_PREFIX = 'policy:';
const POLICY_FINGERPRINT_RX = /^[0-9a-f]{16,64}$/;

export const CONVERSATION_KINDS = ['property', 'portfolio'] as const;
export type ConversationKind = typeof CONVERSATION_KINDS[number];

export interface ConversationScopeRow {
  conversation_kind?: unknown;
  organization_id?: unknown;
  authorization_hash?: unknown;
  scope_receipt_id?: unknown;
  scope_verified_at?: unknown;
  prompt_version?: unknown;
}

export interface ConversationSecurityScope {
  conversationKind: ConversationKind;
  organizationId: string | null;
  /** Full, selector-independent authorization-universe hash. Never scopeHash. */
  authorizationHash: string | null;
  /** Provenance for the last DB-asserted scope; not authorization by itself. */
  scopeReceiptId: string | null;
  scopeVerifiedAt: string | null;
  legacyPromptStamp: boolean;
}

const AUTHORIZATION_HASH_RX = /^[0-9a-f]{64}$/;

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

export function stampPortfolioPolicy(
  promptVersion: string,
  policyFingerprint: string,
): string {
  if (!POLICY_FINGERPRINT_RX.test(policyFingerprint)) {
    throw new Error('portfolio policy fingerprint is invalid');
  }
  return `${promptVersion}+${POLICY_SEGMENT_PREFIX}${policyFingerprint}`;
}

export function portfolioPolicyFingerprintFromStamp(
  promptVersion: string | null | undefined,
): string | null {
  if (typeof promptVersion !== 'string') return null;
  for (const raw of promptVersion.split('+')) {
    const segment = raw.trim();
    if (!segment.startsWith(POLICY_SEGMENT_PREFIX)) continue;
    const fingerprint = segment.slice(POLICY_SEGMENT_PREFIX.length);
    return POLICY_FINGERPRINT_RX.test(fingerprint) ? fingerprint : null;
  }
  return null;
}

/**
 * Decode a DB row without letting the legacy prompt stamp override explicit
 * scope. Returns null on corrupt explicit metadata so callers fail closed.
 */
export function conversationSecurityScopeFromRow(
  row: ConversationScopeRow,
): ConversationSecurityScope | null {
  const explicitKind = row.conversation_kind;
  if (explicitKind === 'property') {
    if (row.organization_id != null
      || row.authorization_hash != null
      || row.scope_receipt_id != null
      || row.scope_verified_at != null
    ) {
      return null;
    }
    return {
      conversationKind: 'property',
      organizationId: null,
      authorizationHash: null,
      scopeReceiptId: null,
      scopeVerifiedAt: null,
      legacyPromptStamp: false,
    };
  }

  if (explicitKind === 'portfolio') {
    if (typeof row.organization_id !== 'string' || !UUID_RX.test(row.organization_id)) return null;
    if (row.authorization_hash != null
      && (typeof row.authorization_hash !== 'string'
        || !AUTHORIZATION_HASH_RX.test(row.authorization_hash))
    ) {
      return null;
    }
    if (row.scope_receipt_id != null
      && (typeof row.scope_receipt_id !== 'string' || !UUID_RX.test(row.scope_receipt_id))
    ) {
      return null;
    }
    if (row.scope_verified_at != null
      && (typeof row.scope_verified_at !== 'string'
        || !Number.isFinite(Date.parse(row.scope_verified_at)))
    ) {
      return null;
    }
    return {
      conversationKind: 'portfolio',
      organizationId: row.organization_id,
      authorizationHash: (row.authorization_hash as string | null | undefined) ?? null,
      scopeReceiptId: (row.scope_receipt_id as string | null | undefined) ?? null,
      scopeVerifiedAt: (row.scope_verified_at as string | null | undefined) ?? null,
      legacyPromptStamp: false,
    };
  }

  // Compatibility for a reader deployed just before/while 0379 backfills.
  // An explicit but unknown kind is corruption, not a reason to trust text.
  if (explicitKind != null) return null;
  const promptVersion = typeof row.prompt_version === 'string' ? row.prompt_version : null;
  const legacyOrganizationId = orgScopeFromStamp(promptVersion);
  if (legacyOrganizationId) {
    return {
      conversationKind: 'portfolio',
      organizationId: legacyOrganizationId,
      authorizationHash: null,
      scopeReceiptId: null,
      scopeVerifiedAt: null,
      legacyPromptStamp: true,
    };
  }
  return {
    conversationKind: 'property',
    organizationId: null,
    authorizationHash: null,
    scopeReceiptId: null,
    scopeVerifiedAt: null,
    legacyPromptStamp: true,
  };
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
