'use client';

import { useCallback, useEffect, useState } from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';

interface ActiveStaffIdentity {
  staffId: string | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/** Resolve the current account's canonical staff row for one property. */
export function useActiveStaffIdentity(
  propertyId: string | null,
  enabled = true,
): ActiveStaffIdentity {
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const requestedKey = enabled && propertyId ? propertyId : null;
  const retry = useCallback(() => setRetryNonce(value => value + 1), []);

  useEffect(() => {
    if (!requestedKey) {
      setLoadedKey(null);
      setStaffId(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoadedKey(null);
    setStaffId(null);
    setError(false);
    void (async () => {
      try {
        const response = await fetchWithAuth(
          `/api/staff-schedule/me?hotelId=${encodeURIComponent(requestedKey)}`,
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error || 'Failed to load staff profile');
        if (cancelled) return;
        const resolved = body?.data?.staffId;
        setStaffId(typeof resolved === 'string' ? resolved : null);
        setLoadedKey(requestedKey);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [requestedKey, retryNonce]);

  return {
    staffId,
    loading: requestedKey !== null && loadedKey !== requestedKey && !error,
    error,
    retry,
  };
}
