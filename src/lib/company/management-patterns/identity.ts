const SHA256_RX = /^[0-9a-f]{64}$/;

/**
 * Encode a SHA-256 identity as an RFC 4122 variant/version-5 UUID. The digest
 * remains the authoritative identity; the UUID is only the relational key.
 */
export function deterministicUuidFromFingerprint(fingerprint: string): string {
  if (!SHA256_RX.test(fingerprint)) {
    throw new TypeError('fingerprint must be a lowercase SHA-256 digest');
  }
  const bytes = fingerprint.slice(0, 32).split('');
  bytes[12] = '5';
  const variant = Number.parseInt(bytes[16], 16);
  bytes[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
