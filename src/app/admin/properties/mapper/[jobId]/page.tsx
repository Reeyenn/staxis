'use client';

/**
 * Live Mapping admin console — Plan v8 Phase B chunk 2.
 *
 * Route: /admin/properties/mapper/[jobId]
 *
 * Reeyen opens this page from a "Watch Live" link on a running mapper
 * job in the Onboarding tab. The page shows:
 *
 *   - Header: hotel name, PMS family, mode (dom/vision), status, cost
 *   - Activity feed: lifecycle events streamed via Supabase realtime
 *     broadcast channel `mapping:{jobId}`. Updates live as cua-service
 *     emits events from mapping-driver.ts.
 *   - Help-request panel: when the mapper agent asks for help (the
 *     mapping_help_requests row hits status='pending'), this panel
 *     surfaces the question + lets Reeyen respond with:
 *        * "guidance" — type a text hint (e.g., "look under Reports → Audit")
 *        * "unavailable" — agent moves on; target marked unavailable
 *        * "abort" — fail the whole mapping job
 *     (Takeover mode is an admin button but the backend stub returns 501
 *     for now — that's chunk 2 follow-up work.)
 *
 * The page also heartbeats /api/admin/heartbeat every 30s while open so
 * cua-service's isAnyAdminOnline() check correctly reports "admin is
 * watching" — keeps the help-request flow active vs the no-admin
 * fallthrough.
 *
 * Realtime channels:
 *   - postgres_changes on mapping_help_requests filtered by job_id
 *     → drives the help-request panel + recent-requests history
 *   - broadcast channel `mapping:{jobId}`
 *     → drives the activity feed (lifecycle events from mapping-driver)
 */

import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Card, Btn, Pill, Caps,
} from '@/app/admin/_components/_snow';
import {
  ArrowLeft, AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Send,
} from 'lucide-react';
import Link from 'next/link';

interface WorkflowJobRow {
  id: string;
  property_id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  claude_cost_micros: number;
}

interface HelpRequestRow {
  id: string;
  target_key: string;
  question: string;
  what_ive_tried?: string[] | null;
  suggested_paths?: string[] | null;
  status: 'pending' | 'answered' | 'aborted' | 'expired';
  action_type?: 'guidance' | 'unavailable' | 'takeover' | 'abort' | null;
  response_text?: string | null;
  answered_at?: string | null;
  created_at: string;
}

interface MappingEvent {
  type: string;
  jobId: string;
  label?: string;
  pct?: number;
  detail?: Record<string, unknown>;
  at: string;
}

export default function LiveMappingPage() {
  const { user, loading: authLoading } = useAuth();
  const params = useParams();
  const jobId = (Array.isArray(params?.jobId) ? params?.jobId[0] : params?.jobId) ?? '';

  const [job, setJob] = useState<WorkflowJobRow | null>(null);
  const [pendingHelp, setPendingHelp] = useState<HelpRequestRow | null>(null);
  const [recentHelp, setRecentHelp] = useState<HelpRequestRow[]>([]);
  const [activity, setActivity] = useState<MappingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guidanceText, setGuidanceText] = useState('');

  const activityRef = useRef<HTMLDivElement>(null);

  // Initial fetch of state.
  const load = async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
      const json = await res.json();
      if (json.ok) {
        setJob(json.data.job);
        setPendingHelp(json.data.pendingHelpRequest);
        setRecentHelp(json.data.recentHelpRequests);
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load mapping job');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!jobId) return;
    void load();
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Heartbeat ping (P1-2 — keeps cua-service isAnyAdminOnline() true
  // while this tab is open).
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    const ping = () => { void fetchWithAuth('/api/admin/heartbeat', { method: 'POST' }); };
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, [user]);

  // Subscribe to mapping_help_requests postgres_changes for this job.
  useEffect(() => {
    if (!jobId) return;
    const ch = supabase
      .channel(`mapping-help:${jobId}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on('postgres_changes' as any, {
        event: '*',
        schema: 'public',
        table: 'mapping_help_requests',
        filter: `job_id=eq.${jobId}`,
      }, () => { void load(); })
      .subscribe();
    return () => { void ch.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Subscribe to the broadcast activity channel.
  useEffect(() => {
    if (!jobId) return;
    const ch = supabase
      .channel(`mapping:${jobId}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on('broadcast' as any, { event: '*' }, (msg: { event: string; payload: MappingEvent }) => {
        setActivity((prev) => [...prev, msg.payload].slice(-50));
      })
      .subscribe();
    return () => { void ch.unsubscribe(); };
  }, [jobId]);

  // Auto-scroll activity to bottom on new event.
  useEffect(() => {
    if (activityRef.current) {
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
    }
  }, [activity.length]);

  const submitAssist = async (
    actionType: 'guidance' | 'unavailable' | 'abort',
    responseText?: string,
  ) => {
    if (!pendingHelp) return;
    if (actionType === 'guidance' && !responseText?.trim()) {
      alert('Please type a hint before sending.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/assist', {
        method: 'POST',
        body: JSON.stringify({
          requestId: pendingHelp.id,
          actionType,
          responseText: responseText ?? `Marked ${actionType}`,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        alert(`Failed: ${json.error ?? 'unknown'}`);
      } else {
        setGuidanceText('');
        // The realtime subscription will refresh state.
      }
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || !user) {
    return (
      <AppLayout>
        <div style={{ padding: 60, textAlign: 'center' }}>
          <Loader2 size={24} className="spin" />
        </div>
      </AppLayout>
    );
  }
  if (user.role !== 'admin') {
    return (
      <AppLayout>
        <div style={{ padding: 80, textAlign: 'center' }}>
          <ShieldAlert size={32} color={T.warm} />
          <p style={{ fontFamily: FONT_SERIF, fontSize: 22, fontStyle: 'italic', marginTop: 12 }}>
            Admin access only.
          </p>
        </div>
      </AppLayout>
    );
  }

  const mode = (job?.payload as { mapper_mode?: string })?.mapper_mode ?? 'dom';
  const costDollars = job ? (job.claude_cost_micros / 1_000_000).toFixed(2) : '0.00';

  return (
    <AppLayout>
      <div style={{
        padding: '24px 48px 48px', maxWidth: 1200, margin: '0 auto',
        background: T.bg, minHeight: 'calc(100vh - 64px)',
        fontFamily: FONT_SANS,
      }}>
        {/* Back link */}
        <Link href="/admin/properties#onboarding" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
          textDecoration: 'none', letterSpacing: '0.16em',
          textTransform: 'uppercase', marginBottom: 16,
        }}>
          <ArrowLeft size={12} /> Back to Onboarding
        </Link>

        <h1 style={{
          fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, marginBottom: 8,
        }}>
          <span style={{ fontStyle: 'italic' }}>Live</span> Mapping
        </h1>

        {error && (
          <Card padding="16px 20px" style={{ borderColor: T.warm, marginBottom: 16 }}>
            <div style={{ color: T.warm, fontFamily: FONT_MONO, fontSize: 12 }}>
              <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {error}
            </div>
          </Card>
        )}

        {/* Status header */}
        {job && (
          <Card padding="20px 24px" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <div>
                <Caps>Job</Caps>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink }}>{job.id.slice(0, 8)}…</div>
              </div>
              <div>
                <Caps>Mode</Caps>
                <Pill tone={mode === 'vision' ? 'caramel' : 'sage'}>{mode}</Pill>
              </div>
              <div>
                <Caps>Status</Caps>
                <Pill tone={
                  job.status === 'completed' ? 'sage' :
                  job.status === 'failed' ? 'warm' :
                  job.status === 'running' ? 'caramel' : 'neutral'
                }>{job.status}</Pill>
              </div>
              <div>
                <Caps>Cost</Caps>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13 }}>${costDollars}</div>
              </div>
              <div>
                <Caps>Attempts</Caps>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13 }}>{job.attempts}/{job.max_attempts}</div>
              </div>
            </div>
            {job.error && (
              <div style={{
                marginTop: 12, padding: 12, background: 'rgba(160,74,44,0.08)',
                color: T.warm, fontFamily: FONT_MONO, fontSize: 11,
                borderRadius: 4,
              }}>
                {job.error}
              </div>
            )}
          </Card>
        )}

        {/* Pending help-request panel */}
        {pendingHelp && (
          <Card padding="20px 24px" style={{
            marginBottom: 16, borderColor: T.caramelDeep, borderWidth: 2,
          }}>
            <Caps style={{ color: T.caramelDeep }}>Agent needs help</Caps>
            <h2 style={{
              fontFamily: FONT_SERIF, fontSize: 20, fontWeight: 400,
              fontStyle: 'italic', margin: '4px 0 12px',
            }}>{pendingHelp.target_key}</h2>
            <p style={{ fontSize: 14, color: T.ink, marginBottom: 12 }}>
              {pendingHelp.question}
            </p>
            {Array.isArray(pendingHelp.what_ive_tried) && pendingHelp.what_ive_tried.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Caps>What it tried</Caps>
                <ul style={{ fontSize: 13, color: T.ink2, paddingLeft: 20, marginTop: 4 }}>
                  {pendingHelp.what_ive_tried.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {Array.isArray(pendingHelp.suggested_paths) && pendingHelp.suggested_paths.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Caps>Suggested paths</Caps>
                <ul style={{ fontSize: 13, color: T.ink2, paddingLeft: 20, marginTop: 4 }}>
                  {pendingHelp.suggested_paths.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}

            <textarea
              value={guidanceText}
              onChange={(e) => setGuidanceText(e.target.value)}
              placeholder="Type a hint (e.g., 'Reports → Audit → Revenue Detail')…"
              style={{
                width: '100%', minHeight: 80, padding: 10,
                fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                border: `1px solid ${T.ink3}`, borderRadius: 4,
                marginBottom: 12, background: T.paper,
              }}
            />

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn
                variant="primary"
                onClick={() => submitAssist('guidance', guidanceText)}
                disabled={submitting || !guidanceText.trim()}
              >
                <Send size={12} /> Send hint
              </Btn>
              <Btn
                variant="warm"
                onClick={() => submitAssist('unavailable', `Skipping — admin marked unavailable.`)}
                disabled={submitting}
              >
                Mark unavailable
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => submitAssist('abort', 'Aborted by admin.')}
                disabled={submitting}
              >
                Abort whole run
              </Btn>
            </div>
            <p style={{
              fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
              marginTop: 8, lineHeight: 1.5,
            }}>
              Tip: <strong>Send hint</strong> tells the agent what to try next (it keeps working).
              <strong>Mark unavailable</strong> skips this target only. <strong>Abort</strong> kills the whole job.
            </p>
          </Card>
        )}

        {!pendingHelp && job?.status === 'running' && (
          <Card padding="16px 20px" style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>
              <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: T.sage }} />
              Agent is working. No help requests right now — it'll appear here if it gets stuck.
            </div>
          </Card>
        )}

        {/* Activity feed */}
        <Card padding="16px 20px">
          <Caps>Activity</Caps>
          <div
            ref={activityRef}
            style={{
              fontFamily: FONT_MONO, fontSize: 11, color: T.ink2,
              lineHeight: 1.7, marginTop: 8, maxHeight: 400,
              overflowY: 'auto', background: T.bg,
              padding: 12, borderRadius: 4,
            }}
          >
            {activity.length === 0
              ? <div style={{ color: T.ink3 }}>Waiting for events…</div>
              : activity.map((evt, i) => (
                  <div key={i}>
                    <span style={{ color: T.ink3 }}>{new Date(evt.at).toLocaleTimeString()}</span>
                    {' '}
                    <span style={{ color: T.caramelDeep }}>[{evt.type}]</span>
                    {' '}
                    {evt.label ?? ''}
                    {typeof evt.pct === 'number' ? ` (${evt.pct}%)` : ''}
                  </div>
                ))}
          </div>
        </Card>

        {/* Recent help-request history */}
        {recentHelp.length > 0 && (
          <Card padding="16px 20px" style={{ marginTop: 16 }}>
            <Caps>Recent help requests</Caps>
            <div style={{ marginTop: 8 }}>
              {recentHelp.map((h) => (
                <div key={h.id} style={{
                  display: 'flex', gap: 12, alignItems: 'baseline',
                  padding: '6px 0', borderTop: `1px solid ${T.rule}`,
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, width: 80 }}>
                    {new Date(h.created_at).toLocaleTimeString()}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, flex: 1 }}>
                    {h.target_key}
                  </span>
                  <Pill tone={
                    h.status === 'answered' && h.action_type === 'guidance' ? 'sage' :
                    h.status === 'answered' ? 'caramel' :
                    h.status === 'pending' ? 'caramel' :
                    'neutral'
                  }>{h.action_type ?? h.status}</Pill>
                </div>
              ))}
            </div>
          </Card>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg) } } .spin { animation: spin 1s linear infinite }`}</style>
      </div>
    </AppLayout>
  );
}
