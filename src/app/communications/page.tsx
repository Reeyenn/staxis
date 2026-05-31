import { AppLayout } from '@/components/layout/AppLayout';
import { CommsApp } from './_components/CommsApp';

export const dynamic = 'force-dynamic';

export default function CommunicationsPage() {
  return (
    <AppLayout>
      <CommsApp />
    </AppLayout>
  );
}
