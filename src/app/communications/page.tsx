import { AppLayout } from '@/components/layout/AppLayout';
import { CommsApp } from './_components/CommsApp';
import { commsFontVars } from './_components/comms-fonts';

export const dynamic = 'force-dynamic';

export default function CommunicationsPage() {
  return (
    <AppLayout>
      {/* Concourse shell: fill the remaining viewport under the floating bar
          (AppLayout's <main> is a flex column) and float the workspace as a
          rounded card on the page wash — no hard white-on-gradient seam. */}
      <div
        className={commsFontVars}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '12px clamp(12px, 2vw, 20px) 16px',
        }}
      >
        <CommsApp />
      </div>
    </AppLayout>
  );
}
