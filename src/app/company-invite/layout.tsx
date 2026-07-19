import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Defense in depth with middleware's response header: keep the capability URL
// out of Referer even if this segment is rendered through a client transition.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function CompanyInviteLayout({ children }: { children: ReactNode }) {
  return children;
}
