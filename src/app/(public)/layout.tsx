import type { ReactNode } from 'react';

/**
 * Public route family. The root providers remain shared so auth and language
 * flows keep their existing behavior, but public destinations never inherit
 * the authenticated Concourse shell.
 */
export default function PublicRouteLayout({ children }: { children: ReactNode }) {
  return children;
}
