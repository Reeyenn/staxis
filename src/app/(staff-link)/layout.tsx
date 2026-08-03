import type { ReactNode } from 'react';

/**
 * Staff-link destinations are deliberately shell-free. Their bearer-token
 * identity and mobile surfaces must never inherit the authenticated app shell.
 */
export default function StaffLinkRouteLayout({ children }: { children: ReactNode }) {
  return children;
}
