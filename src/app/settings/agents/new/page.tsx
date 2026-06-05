'use client';

export const dynamic = 'force-dynamic';

// Create-agent wizard page. Manager-gated.

import React from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { PageShell, AccessDenied, NoProperty } from '../_components/PageShell';
import { AgentWizard } from '../_components/AgentWizard';
import { s } from '../_lib/strings';

export default function NewAgentPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  if (!user || !canManageTeam(user.role)) {
    return <AppLayout><AccessDenied lang={lang} /></AppLayout>;
  }

  const pid = activePropertyId ?? '';

  return (
    <AppLayout>
      <PageShell eyebrow={`${s(lang, 'agents')}`} title={s(lang, 'newAgent')} lang={lang} backHref="/settings/agents" backLabel={s(lang, 'agents')}>
        {!pid ? <NoProperty lang={lang} /> : <AgentWizard mode="create" pid={pid} lang={lang} />}
      </PageShell>
    </AppLayout>
  );
}
