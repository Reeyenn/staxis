'use client';

// SyncContext — "is this browser online?", nothing more.
//
// This used to also count writes made while offline (`pendingCount`) and show
// a "Syncing changes…" banner for ~2.5s after reconnecting (`isSyncing`).
// The only surface that ever produced those events was the manager Rooms
// board, which was removed on 2026-07-24 when the PMS became the sole source
// of truth for room cleanliness. With no producer left, the counter would
// have read 0 forever and the syncing banner could never appear — a status
// indicator that is structurally incapable of reporting anything is worse
// than none, so both were removed rather than left dormant.
//
// The housekeeper phone view queues and replays its own offline actions; it
// has never used this context and is unaffected.
//
// If a manager-side offline write ever comes back, re-add the counter TOGETHER
// with its producer — not ahead of it.

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';

interface SyncContextValue {
  /** Whether the browser has network access. */
  isOnline: boolean;
}

const SyncContext = createContext<SyncContextValue>({
  isOnline: true,
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    // Hydrate with the real browser value (avoids SSR mismatch).
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <SyncContext.Provider value={{ isOnline }}>
      {children}
    </SyncContext.Provider>
  );
}

export const useSyncContext = () => useContext(SyncContext);
