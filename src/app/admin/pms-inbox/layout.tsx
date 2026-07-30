import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

export default function RetiredPmsAuthInboxLayout({ children }: { children: ReactNode }) {
  if (!PMS_ROBOT_ENABLED) notFound();
  return children;
}
