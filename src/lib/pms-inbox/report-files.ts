/**
 * Shared vocabulary for the raw report zone (migration 0340).
 *
 * Three surfaces need the same rules and must never drift apart:
 *   - /api/pms-inbox/inbound          (mints the signed upload URL)
 *   - /api/pms-inbox/attachment-commit (verifies the bytes landed)
 *   - /api/cron/pms-auth-codes-purge   (sweeps + purges raw objects)
 *
 * Pure functions only — no env, no Supabase, no server-only import — so the
 * rules can be unit-tested directly.
 *
 * FORMAT-AGNOSTIC ON PURPOSE: nothing here knows what a report looks like.
 * No PMS report scheduler has been observed yet, so any parsing, classifying
 * or column-mapping belongs to a later workstream. This file only decides
 * whether a file is *acceptable* and *where its bytes live*.
 */

export const PMS_RAW_BUCKET = 'pms-raw';

/**
 * 25 MiB — Cloudflare Email Routing's own message ceiling, mirrored in the
 * pms-raw bucket's file_size_limit (0340) and the Worker's MAX_BYTES. An
 * over-limit message is rejected at the Cloudflare edge before our Worker
 * runs, so it is invisible to every check we own; nothing downstream can
 * detect it, which is why the size ceiling is identical in all three places.
 */
export const MAX_ATTACHMENT_BYTES = 26_214_400;

/** Refuse a pathological multi-attachment message outright. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Accepted attachment types, keyed to the extension used in the object path.
 * Deliberately narrow: csv / plain / pdf / xls / xlsx. zip and message/rfc822
 * were considered and dropped — no PMS is known to send them, and each is a
 * container-parsing surface we would have to secure forever. Must stay in sync
 * with the bucket's allowed_mime_types in migration 0340.
 */
export const ALLOWED_REPORT_MIME: Readonly<Record<string, string>> = {
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}

/** Normalize a reported content type ("text/csv; charset=utf-8" → "text/csv"). */
export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase();
}

export function extensionForMime(mime: string | null | undefined): string | null {
  return ALLOWED_REPORT_MIME[normalizeMime(mime)] ?? null;
}

/**
 * Content-addressed object path: `<property_id>/<yyyy>/<mm>/<sha256>.<ext>`.
 *
 * The sha256 IS the filename, so the path is a claim about the bytes — one the
 * parse worker re-verifies on download. The yyyy/mm segments make a retention
 * sweep a prefix listing instead of a table scan, and the leading property_id
 * makes per-hotel deletion trivial. The ORIGINAL filename is never used in the
 * path: it is attacker-controlled and would open path traversal.
 */
export function buildRawObjectPath(args: {
  propertyId: string;
  sha256: string;
  mime: string | null | undefined;
  receivedAt: Date;
}): string | null {
  const ext = extensionForMime(args.mime);
  if (!ext) return null;
  if (!isSha256Hex(args.sha256)) return null;
  if (!/^[0-9a-f-]{36}$/.test(args.propertyId)) return null;
  const yyyy = String(args.receivedAt.getUTCFullYear());
  const mm = String(args.receivedAt.getUTCMonth() + 1).padStart(2, '0');
  return `${args.propertyId}/${yyyy}/${mm}/${args.sha256}.${ext}`;
}

/** Split a raw object path back into its Storage list() prefix + leaf name. */
export function splitObjectPath(path: string): { prefix: string; name: string } | null {
  const idx = path.lastIndexOf('/');
  if (idx <= 0 || idx === path.length - 1) return null;
  return { prefix: path.slice(0, idx), name: path.slice(idx + 1) };
}

export interface AttachmentClaim {
  filename: string | null;
  mimeType: string;
  size: number;
  sha256: string;
}

export type AttachmentRejection =
  | 'bad_sha256'
  | 'bad_size'
  | 'unsupported_type';

/**
 * Validate one attachment claim from the Worker. The Worker is a courier — it
 * reports what it saw; this is where the claim becomes a decision.
 */
export function validateAttachmentClaim(
  raw: unknown,
): { ok: true; claim: AttachmentClaim } | { ok: false; reason: AttachmentRejection; sha256: string | null } {
  const a = (raw ?? {}) as Record<string, unknown>;
  const sha256 = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
  if (!isSha256Hex(sha256)) return { ok: false, reason: 'bad_sha256', sha256: null };

  const size = typeof a.size === 'number' ? a.size : NaN;
  if (!Number.isInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: 'bad_size', sha256 };
  }

  const mimeType = normalizeMime(typeof a.mimeType === 'string' ? a.mimeType : '');
  if (!extensionForMime(mimeType)) return { ok: false, reason: 'unsupported_type', sha256 };

  // Filename is stored for the operator's benefit only — never used in a path.
  const rawName = typeof a.filename === 'string' ? a.filename : '';
  const filename = rawName ? rawName.replace(/[\r\n\t]/g, ' ').slice(0, 255) : null;

  return { ok: true, claim: { filename, mimeType, size, sha256 } };
}

/** Per-attachment instruction returned to the Worker. */
export interface AttachmentDecision {
  sha256: string;
  action: 'upload' | 'skip';
  /** Present only for action:'upload'. Supabase signed upload URL. */
  uploadUrl?: string;
  /** Why we skipped, for `wrangler tail` triage. Never surfaces to a user. */
  reason?: string;
}
