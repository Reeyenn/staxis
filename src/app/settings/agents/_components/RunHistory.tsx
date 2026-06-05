'use client';

// Per-agent run history + receipt drawer. Reads through agentsApi (never the
// supabase client). nextCursor is null today; handled generically.

import React, { useCallback, useEffect, useState } from 'react';
import { T, fonts, Pill, Caps } from './_tokens';
import { Drawer } from './Drawer';
import { RunReceipt } from './RunReceipt';
import { Loading, ErrorBanner, EmptyState } from './states';
import { agentsApi, isSessionEnded } from '../_lib/api';
import { runStatusTone, runStatusLabel, formatDateTime, errorToMessage } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { AgentRun, AgentRunReceipt } from '@/lib/agents/types';

export function RunHistory({ agentId, lang }: { agentId: string; lang: Lang }) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AgentRunReceipt | null>(null);
  const [receiptErr, setReceiptErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null); setRuns(null);
    try {
      const r = await agentsApi.runs(agentId);
      if (r.ok) setRuns(r.data.items);
      else { setError(errorToMessage(r.error, lang)); setRuns([]); }
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); setRuns([]); }
  }, [agentId, lang]);

  useEffect(() => { void load(); }, [load]);

  const openReceipt = useCallback(async (runId: string) => {
    setOpenRunId(runId); setReceipt(null); setReceiptErr(null);
    try {
      const r = await agentsApi.receipt(runId);
      if (r.ok) setReceipt(r.data.receipt);
      else setReceiptErr(errorToMessage(r.error, lang));
    } catch (e) { if (isSessionEnded(e)) throw e; setReceiptErr(s(lang, 'somethingWrong')); }
  }, [lang]);

  if (runs === null && !error) return <Loading lang={lang} />;
  if (error && (!runs || runs.length === 0)) return <ErrorBanner message={error} onRetry={load} lang={lang} />;
  if (runs && runs.length === 0) return <EmptyState title={s(lang, 'noRuns')} />;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(runs ?? []).map((run) => (
          <button
            key={run.id}
            onClick={() => openReceipt(run.id)}
            style={{
              textAlign: 'left', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12,
              padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 10,
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pill tone={runStatusTone(run.status)}>{runStatusLabel(run.status, lang)}</Pill>
                <Caps>{run.mode === 'dry_run' ? (lang === 'es' ? 'SIM' : 'SIM') : (lang === 'es' ? 'REAL' : 'LIVE')}</Caps>
              </span>
              {run.summary && (
                <span style={{
                  display: 'block', fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginTop: 4,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360,
                }}>{run.summary}</span>
              )}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, flexShrink: 0 }}>{formatDateTime(run.startedAt, lang)}</span>
          </button>
        ))}
      </div>

      <Drawer open={openRunId !== null} onClose={() => setOpenRunId(null)} title={s(lang, 'runReceipt')} lang={lang}>
        {receiptErr
          ? <ErrorBanner message={receiptErr} lang={lang} />
          : receipt
            ? <RunReceipt receipt={receipt} lang={lang} />
            : <Loading lang={lang} />}
      </Drawer>
    </>
  );
}
