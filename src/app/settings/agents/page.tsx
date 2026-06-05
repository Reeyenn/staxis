'use client';

export const dynamic = 'force-dynamic';

// Settings → Agents hub. Manager-gated. Approval inbox (the safety surface) on
// top, then the property's agents. All agent data flows through /api/agents/*
// (agentsApi) — never the supabase browser client.

import React, { useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { PageShell, AccessDenied, NoProperty } from './_components/PageShell';
import { ApprovalInbox } from './_components/ApprovalInbox';
import { AgentList } from './_components/AgentList';
import { Btn } from './_components/_tokens';
import { s } from './_lib/strings';

export default function AgentsHubPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [refreshKey, setRefreshKey] = useState(0);

  if (!user || !canManageTeam(user.role)) {
    return <AppLayout><AccessDenied lang={lang} /></AppLayout>;
  }

  const pid = activePropertyId ?? '';
  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <AppLayout>
      <PageShell
        eyebrow={`${s(lang, 'settings')} · ${s(lang, 'agents')}`}
        title={s(lang, 'agents')}
        lang={lang}
        backLabel={s(lang, 'settings')}
        headerRight={pid ? <Link href="/settings/agents/new"><Btn variant="primary">{s(lang, 'createAgent')}</Btn></Link> : null}
      >
        {!pid ? (
          <NoProperty lang={lang} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <ApprovalInbox key={`inbox-${refreshKey}`} pid={pid} lang={lang} onChange={bump} />
            <AgentList key={`list-${refreshKey}`} pid={pid} lang={lang} onApprovalsChanged={bump} />
          </div>
        )}
      </PageShell>
    </AppLayout>
  );
}
