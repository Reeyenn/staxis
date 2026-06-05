'use client';

export const dynamic = 'force-dynamic';

// Edit-agent wizard page. Manager-gated. Template is fixed at create, so the
// wizard starts at Basics.

import React from 'react';
import { useParams } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { PageShell, AccessDenied, NoProperty } from '../../_components/PageShell';
import { AgentWizard } from '../../_components/AgentWizard';
import { s } from '../../_lib/strings';

export default function EditAgentPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : '';

  if (!user || !canManageTeam(user.role)) {
    return <AppLayout><AccessDenied lang={lang} /></AppLayout>;
  }

  const pid = activePropertyId ?? '';

  return (
    <AppLayout>
      <PageShell eyebrow={`${s(lang, 'agents')}`} title={s(lang, 'editAgent')} lang={lang} backHref="/settings/agents" backLabel={s(lang, 'agents')}>
        {!pid ? <NoProperty lang={lang} /> : <AgentWizard mode="edit" pid={pid} agentId={id} lang={lang} />}
      </PageShell>
    </AppLayout>
  );
}
