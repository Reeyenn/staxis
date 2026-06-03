import { AppLayout } from '@/components/layout/AppLayout';
import { CommsApp } from './_components/CommsApp';
import { commsFontVars } from './_components/comms-fonts';

export const dynamic = 'force-dynamic';

export default function CommunicationsPage() {
  return (
    <AppLayout>
      <div className={commsFontVars} style={{ height: '100%' }}>
        <CommsApp />
      </div>
    </AppLayout>
  );
}
