'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

interface SyncContextValue {
  /** Whether the browser has network access. */
  isOnline: boolean;
  /** Number of room-status changes written while offline and not yet confirmed. */
  pendingCount: number;
  /** True for ~2.5 s after reconnecting with pending writes (Firestore is syncing). */
  isSyncing: boolean;
  /** Call this every time a Firestore write is made while offline. */
  recordOfflineAction: () => void;
}

const SyncContext = createContext<SyncContextValue>({
  isOnline: true,
  pendingCount: 0,
  isSyncing: false,
  recordOfflineAction: () => {},
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  // Keep a ref so the online handler can read the latest count synchronously
  // without stale-closure issues.
  const pendingRef = useRef(0);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPending = (n: number) => {
    pendingRef.current = n;
    setPendingCount(n);
  };

  useEffect(() => {
    // Hydrate with the real browser value (avoids SSR mismatch).
    setIsOnline(navigator.onLine);

    const handleOnline = () => {
      setIsOnline(true);
      if (pendingRef.current > 0) {
        // Show a brief "syncing" banner while Firestore flushes queued writes.
        setIsSyncing(true);
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => {
          setIsSyncing(false);
          setPending(0);
        }, 2500);
      }
    };

    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const recordOfflineAction = () => {
    if (!navigator.onLine) {
      setPending(pendingRef.current + 1);
    }
  };

  return (
    <SyncContext.Provider
      value={{ isOnline, pendingCount, isSyncing, recordOfflineAction }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export const useSyncContext = () => useContext(SyncContext);
