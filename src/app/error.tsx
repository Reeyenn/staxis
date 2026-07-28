'use client';

import { useEffect } from 'react';
import { RouteErrorState } from '@/components/layout/RouteResourceState';
import {
  isStaleDeploymentChunkError,
  markStaleChunkFailureThisBoot,
  reloadOnceWithSessionGuard,
  STALE_CHUNK_RECOVERY_GUARD_KEY,
  STALE_CHUNK_RECOVERY_PARAM,
  staleChunkRecoveryKey,
} from '@/lib/stale-chunk-recovery';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const staleChunk = isStaleDeploymentChunkError(error);

  useEffect(() => {
    if (!staleChunk) return;
    markStaleChunkFailureThisBoot();
    const key = staleChunkRecoveryKey(window.location.pathname, error);
    reloadOnceWithSessionGuard({
      key,
      guardKey: STALE_CHUNK_RECOVERY_GUARD_KEY,
      fallbackParam: STALE_CHUNK_RECOVERY_PARAM,
      getSessionStorage: () => window.sessionStorage,
      location: window.location,
    });
  }, [error, staleChunk]);

  return (
    <RouteErrorState
      title={staleChunk ? 'Staxis was updated' : 'This page ran into a problem'}
      message={staleChunk
        ? 'Reload the latest version to continue. Your hotel data was not changed.'
        : 'Your hotel data was not changed. Try this page again.'}
      retryLabel={staleChunk ? 'Reload latest version' : 'Try again'}
      onRetry={staleChunk ? () => window.location.reload() : reset}
    />
  );
}
