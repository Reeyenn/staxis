export interface OwnershipTransferAttempt {
  propertyId: string;
  newOwnerAccountId: string;
  operationId: string;
  reason: string | null;
}

interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = 'staxis:ownership-transfer-attempt:v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseAttempt(value: string | null): OwnershipTransferAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<OwnershipTransferAttempt>;
    return typeof parsed.propertyId === 'string'
      && typeof parsed.newOwnerAccountId === 'string'
      && typeof parsed.operationId === 'string'
      && (typeof parsed.reason === 'string' || parsed.reason === null)
      && UUID_PATTERN.test(parsed.operationId)
      ? {
          propertyId: parsed.propertyId,
          newOwnerAccountId: parsed.newOwnerAccountId,
          operationId: parsed.operationId,
          reason: parsed.reason,
        }
      : null;
  } catch {
    return null;
  }
}

function storageKey(propertyId: string, newOwnerAccountId: string): string {
  return `${STORAGE_PREFIX}:${propertyId}:${newOwnerAccountId}`;
}

export function getOrCreateOwnershipTransferAttempt(
  storage: AttemptStorage | null,
  propertyId: string,
  newOwnerAccountId: string,
  reason: string | null,
  createOperationId: () => string,
): OwnershipTransferAttempt {
  let existing: OwnershipTransferAttempt | null = null;
  const key = storageKey(propertyId, newOwnerAccountId);
  try {
    existing = parseAttempt(storage?.getItem(key) ?? null);
  } catch {
    // Browser storage can be unavailable; the caller still keeps this attempt
    // in memory for same-page retries.
  }
  if (existing?.propertyId === propertyId
      && existing.newOwnerAccountId === newOwnerAccountId) {
    return existing;
  }

  const operationId = createOperationId();
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error('ownership operation ID must be a UUID');
  }
  const attempt = { propertyId, newOwnerAccountId, operationId, reason };
  try {
    storage?.setItem(key, JSON.stringify(attempt));
  } catch {
    // Same-page retries remain protected by the caller's ref.
  }
  return attempt;
}

export function findOwnershipTransferAttempt(
  storage: AttemptStorage | null,
  propertyId: string,
  candidateAccountIds: string[],
): OwnershipTransferAttempt | null {
  for (const accountId of candidateAccountIds) {
    try {
      const attempt = parseAttempt(
        storage?.getItem(storageKey(propertyId, accountId)) ?? null,
      );
      if (attempt?.propertyId === propertyId
          && attempt.newOwnerAccountId === accountId) return attempt;
    } catch {
      return null;
    }
  }
  return null;
}

export function clearOwnershipTransferAttempt(
  storage: AttemptStorage | null,
  propertyId: string,
  newOwnerAccountId: string,
  operationId: string,
): void {
  const key = storageKey(propertyId, newOwnerAccountId);
  try {
    const existing = parseAttempt(storage?.getItem(key) ?? null);
    if (existing?.operationId === operationId) storage?.removeItem(key);
  } catch {
    // A failed cleanup is safe: a later different target replaces the record,
    // and an exact replay remains idempotent at the database boundary.
  }
}
