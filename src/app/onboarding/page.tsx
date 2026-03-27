'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Onboarding (property creation) is disabled for end users.
 * Properties are pre-provisioned by the admin.
 * Any navigation here is redirected to the property selector.
 */
export default function OnboardingPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/property-selector');
  }, [router]);

  return null;
}
