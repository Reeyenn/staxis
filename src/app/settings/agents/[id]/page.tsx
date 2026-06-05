'use client';

export const dynamic = 'force-dynamic';

// Agent detail. Manager-gated. Config summary + status actions + run-now +
// test-on-a-date + run history. All through agentsApi.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Play } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { PageShell, AccessDenied, NoProperty } from '../_components/PageShell';
import { T, fonts, Card, Caps, Btn, Pill } from '../_components/_tokens';
import { AgentStatusPill } from '../_components/AgentStatusPill';
import { TestOnADate } from '../_components/TestOnADate';
import { RunHistory } from '../_components/RunHistory';
import { Loading, ErrorBanner } from '../_components/states';
import { agentsApi, isSessionEnded, type AgentCatalog } from '../_lib/api';
import { formatTrigger, pickBilingual, modeLabel, errorToMessage } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { Agent, AgentStatus } from '@/lib/agents/types';

const muted: React.CSSProperties = { color: T.ink3, fontFamily: fonts.sans, fontSize: 13 };

function DetailBody({ pid, id, lang }: { pid: string; id: string; lang: Lang }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, c] = await Promise.all([agentsApi.get(id), agentsApi.catalog(pid)]);
      if (!a.ok) { setErr(a.error.status === 404 ? s(lang, 'agentNotFound') : errorToMessage(a.error, lang)); return; }
      setAgent(a.data.agent);
      if (c.ok) setCatalog(c.data);
    } catch (e) { if (isSessionEnded(e)) throw e; setErr(s(lang, 'somethingWrong')); }
  }, [id, pid, lang]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = async (status: AgentStatus) => {
    setBusy(true); setErr(null);
    try {
      const r = await agentsApi.update(id, { status });
      if (r.ok) await load(); else setErr(errorToMessage(r.error, lang));
    } catch (e) { if (isSessionEnded(e)) throw e; setErr(s(lang, 'somethingWrong')); }
    setBusy(false);
  };

  const runNow = async () => {
    setBusy(true); setErr(null); setToast(null);
    try {
      const r = await agentsApi.run(id, { mode: 'live' });
      if (!r.ok) { setErr(errorToMessage(r.error, lang)); setBusy(false); return; }
      const o = r.data.outcome;
      setToast(!o.runId ? (o.summary || s(lang, 'runStarted')) : o.status === 'awaiting_approval' ? s(lang, 'runNeedsApproval') : s(lang, 'runStarted'));
      await load();
    } catch (e) { if (isSessionEnded(e)) throw e; setErr(s(lang, 'somethingWrong')); }
    setBusy(false);
  };

  if (err && !agent) return <ErrorBanner message={err} onRetry={load} lang={lang} />;
  if (!agent) return <Loading lang={lang} />;

  const actByKey = new Map((catalog?.actions ?? []).map((a) => [a.key, a]));
  const scopeByKey = new Map((catalog?.scopes ?? []).map((sc) => [sc.key, sc]));
  const cfg = agent.config;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, color: T.ink }}>{agent.name}</span>
          <AgentStatusPill status={agent.status} lang={lang} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {agent.status !== 'archived' && (
            <Btn variant="ghost" size="sm" disabled={busy} onClick={runNow} title={`${s(lang, 'runNow')} — ${agent.name}`}>
              <Play size={13} /> {s(lang, 'runNow')}
            </Btn>
          )}
          {agent.status === 'active'
            ? <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setStatus('paused')}>{s(lang, 'pause')}</Btn>
            : agent.status !== 'archived'
              ? <Btn variant="sage" size="sm" disabled={busy} onClick={() => setStatus('active')}>{s(lang, 'activate')}</Btn>
              : <Btn variant="sage" size="sm" disabled={busy} onClick={() => setStatus('draft')}>{s(lang, 'restore')}</Btn>}
          <Link href={`/settings/agents/${id}/edit`}><Btn variant="ghost" size="sm">{s(lang, 'edit')}</Btn></Link>
          {agent.status !== 'archived' && (
            <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setStatus('archived')}>{s(lang, 'archive')}</Btn>
          )}
        </div>
      </div>

      {agent.description && <p style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, margin: 0, lineHeight: 1.5 }}>{agent.description}</p>}
      {err && <ErrorBanner message={err} lang={lang} />}
      {toast && (
        <div role="status" style={{ padding: '10px 14px', background: T.sageDim, border: `1px solid ${T.sageDeep}30`, borderRadius: 12, color: T.sageDeep, fontFamily: fonts.sans, fontSize: 13 }}>{toast}</div>
      )}

      <Card>
        <Caps style={{ display: 'block', marginBottom: 8 }}>{s(lang, 'reviewTrigger')}</Caps>
        <div style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, marginBottom: 16 }}>{formatTrigger(cfg.trigger, lang)}</div>

        <Caps style={{ display: 'block', marginBottom: 6 }}>{s(lang, 'reviewSees')}</Caps>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {cfg.scopes.length === 0 ? <span style={muted}>{s(lang, 'nothing')}</span>
            : cfg.scopes.map((k) => <Pill key={k}>{pickBilingual(scopeByKey.get(k)?.label, lang) || k}</Pill>)}
        </div>

        <Caps style={{ display: 'block', marginBottom: 6 }}>{s(lang, 'reviewDoes')}</Caps>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cfg.actions.length === 0 ? <span style={muted}>{s(lang, 'nothing')}</span>
            : cfg.actions.map((k) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 12px' }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink }}>{pickBilingual(actByKey.get(k)?.label, lang) || k}</span>
                <Pill tone="neutral">{modeLabel(cfg.approvalRules.perAction[k] ?? cfg.approvalRules.defaultMode ?? 'suggest', lang)}</Pill>
              </div>
            ))}
        </div>
      </Card>

      <Card>
        <Caps style={{ display: 'block', marginBottom: 12 }}>{s(lang, 'testOnDate')}</Caps>
        <TestOnADate agentId={id} lang={lang} />
      </Card>

      <Card>
        <Caps style={{ display: 'block', marginBottom: 12 }}>{s(lang, 'runHistory')}</Caps>
        <RunHistory agentId={id} lang={lang} />
      </Card>
    </div>
  );
}

export default function AgentDetailPage() {
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
      <PageShell eyebrow={s(lang, 'agents')} title={s(lang, 'agents')} lang={lang} backHref="/settings/agents" backLabel={s(lang, 'agents')}>
        {!pid ? <NoProperty lang={lang} /> : <DetailBody pid={pid} id={id} lang={lang} />}
      </PageShell>
    </AppLayout>
  );
}
