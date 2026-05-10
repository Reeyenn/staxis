'use client';

// /join — Legacy URL kept so existing share links still work. Redirects
// to /signup with the code prefilled. Owners and admins are now told to
// share /signup links instead.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function JoinRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const code = params.get('code');
    router.replace(code ? `/signup?code=${encodeURIComponent(code)}` : '/signup');
  }, [router, params]);
  return null;
}

export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinRedirect />
    </Suspense>
  );
}
