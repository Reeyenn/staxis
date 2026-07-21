import { createHash } from 'node:crypto';

/** Stable id for the caller-bound staff row Communications creates on first use. */
export function commsStaffIdentityId(propertyId: string, accountId: string): string {
  const digest = Buffer.from(
    createHash('sha256')
      .update(`staxis:comms-staff:v1:${propertyId}:${accountId}`)
      .digest()
      .subarray(0, 16),
  );
  // RFC-4122 variant + a v5-shaped version nibble. The input is namespaced
  // and SHA-256-derived; this is an internal deterministic database id.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
