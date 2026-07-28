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

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
    <html lang="en">
      <body style={{ margin: 0 }}>
        <RouteErrorState
          title={staleChunk ? 'Staxis was updated' : 'Staxis could not finish opening'}
          message={staleChunk
            ? 'Reload the latest version to continue. Your hotel data was not changed.'
            : 'Your hotel data was not changed. Try opening Staxis again.'}
          retryLabel={staleChunk ? 'Reload latest version' : 'Try again'}
          onRetry={staleChunk ? () => window.location.reload() : reset}
        />
      </body>
    </html>
  );
}
