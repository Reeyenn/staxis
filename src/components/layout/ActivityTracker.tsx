'use client';

/**
 * Mounts inside AppLayout and fires a `page_view` event whenever the
 * pathname changes. Scoped to the active property (admins fire with
 * propertyId=null and the server flags the role).
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fireEvent } from '@/lib/activity-tracker';

export function ActivityTracker() {
  const { user } = useAuth();
  const { activeProperty } = useProperty();
  const pathname = usePathname();

  useEffect(() => {
    if (!user) return;
    void fireEvent({
      eventType: 'page_view',
      propertyId: activeProperty?.id ?? null,
      metadata: { path: pathname },
    });
  }, [pathname, user, activeProperty?.id]);

  return null;
}
