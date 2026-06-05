'use client';

// The property's agents with status, last run, and row actions (run now,
// activate/pause, edit, archive/restore). Reads/writes through agentsApi only.
// Run-now that yields awaiting_approval nudges the parent to refresh the inbox.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Play, ChevronRight } from 'lucide-react';
import { T, fonts, Card, Btn, Caps } from './_tokens';
import { AgentStatusPill } from './AgentStatusPill';
import { Loading, ErrorBanner, EmptyState } from './states';
import { agentsApi, isSessionEnded } from '../_lib/api';
import { formatDateTime, errorToMessage } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { Agent, AgentStatus } from '@/lib/agents/types';

export function AgentList({ pid, lang, onApprovalsChanged }: { pid: string; lang: Lang; onApprovalsChanged?: () => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await agentsApi.list(pid);
      if (r.ok) setAgents(r.data.agents);
      else { setError(errorToMessage(r.error, lang)); setAgents([]); }
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); setAgents([]); }
  }, [pid, lang]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = async (id: string, status: AgentStatus) => {
    setBusyId(id); setError(null);
    try {
      const r = await agentsApi.update(id, { status });
      if (!r.ok) setError(errorToMessage(r.error, lang));
      await load();
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); }
    setBusyId(null);
  };

  const runNow = async (id: string) => {
    setBusyId(id); setError(null); setToast(null);
    try {
      const r = await agentsApi.run(id, { mode: 'live' });
      if (!r.ok) { setError(errorToMessage(r.error, lang)); setBusyId(null); return; }
      const o = r.data.outcome;
      if (!o.runId) setToast(o.summary || s(lang, 'runStarted'));            // disabled / already handled
      else if (o.status === 'awaiting_approval') { setToast(s(lang, 'runNeedsApproval')); onApprovalsChanged?.(); }
      else setToast(s(lang, 'runStarted'));
      await load();
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); }
    setBusyId(null);
  };

  if (agents === null && !error) return <Loading lang={lang} />;
  if (error && (!agents || agents.length === 0)) return <ErrorBanner message={error} onRetry={load} lang={lang} />;
  if (agents && agents.length === 0) {
    return (
      <EmptyState
        title={s(lang, 'noAgentsTitle')}
        body={s(lang, 'noAgentsBody')}
        action={<Link href="/settings/agents/new"><Btn variant="primary">{s(lang, 'createAgent')}</Btn></Link>}
      />
    );
  }

  const live = (agents ?? []).filter((a) => a.status !== 'archived');
  const archived = (agents ?? []).filter((a) => a.status === 'archived');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <ErrorBanner message={error} onRetry={load} lang={lang} />}
      {toast && (
        <div role="status" style={{ padding: '10px 14px', background: T.sageDim, border: `1px solid ${T.sageDeep}30`, borderRadius: 12, color: T.sageDeep, fontFamily: fonts.sans, fontSize: 13 }}>{toast}</div>
      )}

      {live.map((a) => (
        <Card key={a.id} style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Link href={`/settings/agents/${a.id}`} style={{ textDecoration: 'none', minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink }}>{a.name}</span>
                <AgentStatusPill status={a.status} lang={lang} />
              </div>
              <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, marginTop: 4 }}>
                {a.lastRunAt ? `${s(lang, 'lastRun')}: ${formatDateTime(a.lastRunAt, lang)}` : s(lang, 'neverRun')}
              </div>
            </Link>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Btn variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => runNow(a.id)} title={`${s(lang, 'runNow')} — ${a.name}`}>
                <Play size={13} /> {s(lang, 'runNow')}
              </Btn>
              {a.status === 'active'
                ? <Btn variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => setStatus(a.id, 'paused')}>{s(lang, 'pause')}</Btn>
                : <Btn variant="sage" size="sm" disabled={busyId === a.id} onClick={() => setStatus(a.id, 'active')}>{s(lang, 'activate')}</Btn>}
              <Link href={`/settings/agents/${a.id}/edit`}><Btn variant="ghost" size="sm">{s(lang, 'edit')}</Btn></Link>
              <Btn variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => setStatus(a.id, 'archived')}>{s(lang, 'archive')}</Btn>
              <Link href={`/settings/agents/${a.id}`} aria-label={a.name} style={{ display: 'inline-flex', color: T.ink3 }}><ChevronRight size={18} /></Link>
            </div>
          </div>
        </Card>
      ))}

      {archived.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Caps style={{ display: 'block', marginBottom: 8 }}>{s(lang, 'archivedSection')}</Caps>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {archived.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', border: `1px solid ${T.ruleSoft}`, borderRadius: 12 }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2 }}>{a.name}</span>
                <Btn variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => setStatus(a.id, 'draft')}>{s(lang, 'restore')}</Btn>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
