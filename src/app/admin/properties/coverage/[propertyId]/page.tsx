'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/properties/coverage/[propertyId] — feature/cua-coverage-editor.
 *
 * Opens a SAVED PMS map (the active knowledge file for this hotel's PMS family)
 * and shows every data point (feed) it captures: learned columns, the live row
 * count + sample for THIS hotel, and trust state. From here the founder can:
 *   - Edit a feed  → re-point it via the same point-and-click takeover on the
 *                    live board (drive to the right page, press Finish).
 *   - Add a feed   → learn a feed the map doesn't have yet (same takeover).
 *   - Delete a feed→ remove where the robot grabs a piece entirely (re-signs a
 *                    new map version on the worker, never-zero-active safe).
 *
 * The map is PER-FAMILY (shared by every hotel on it) — edits change all of
 * them, surfaced prominently. Admin-only, English-only (matches the studio).
 *
 * All reads/writes go through /api/admin/mapper/coverage* (supabaseAdmin) — the
 * pms_* and pms_knowledge_files tables are deny-all-browser RLS.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  FONT_SANS, FONT_MONO, FONT_SERIF, Btn, Pill, Caps, type PillTone,
} from '@/app/admin/_components/studio/kit';
import {
  SurfaceShell, DarkCard, DarkEmpty, dimWhite, Backdrop, MODAL_CARD,
} from '@/app/admin/_components/studio/surface-kit';
import '@/app/admin/_components/studio/studio.css';
import {
  ChevronLeft, RefreshCw, Pencil, Trash2, Plus, AlertTriangle, Eye, Loader2, Layers, Lock,
} from 'lucide-react';

interface FeedDetail {
  key: string;
  actionKey: string | null;
  label: string;
  table: string | null;
  columns: Record<string, string>;
  required: boolean;
  canTakeover: boolean;
  source: 'actions' | 'legacy';
  state: 'live' | 'learning';
  rowCount: number | null;
  sample: Array<Record<string, unknown>>;
}

interface CoverageResponse {
  propertyId: string;
  propertyName: string;
  pmsFamily: string;
  familyLabel: string;
  hotelsOnFamily: number;
  connection: 'healthy' | 'pending' | 'paused';
  activeMap: {
    id: string; version: number; status: string; signed: boolean;
    shape: 'actions' | 'legacy' | 'empty'; editable: boolean;
  } | null;
  feeds: FeedDetail[];
  addableFeeds: Array<{ actionKey: string; label: string }>;
}

const STATE_PILL: Record<FeedDetail['state'], { tone: PillTone; label: string }> = {
  live: { tone: 'forest', label: 'Live' },
  learning: { tone: 'gold', label: 'Still learning' },
};

function DarkScope({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-studio" style={{
      background: 'var(--ink)', color: '#fff',
      marginLeft: 'calc(50% - 50vw)', marginRight: 'calc(50% - 50vw)',
      minHeight: 'calc(100vh - 64px)',
    }}>
      {children}
    </div>
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function CoveragePage() {
  const params = useParams<{ propertyId: string }>();
  const propertyId = params?.propertyId ?? '';
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);     // `${verb}:${key}`
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addKey, setAddKey] = useState<string>('');
  const [pendingDelete, setPendingDelete] = useState<FeedDetail | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/coverage?propertyId=${encodeURIComponent(propertyId)}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Failed to load coverage (${res.status})`);
        return;
      }
      setData(json.data as CoverageResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    if (!user || !propertyId) return;
    void load();
  }, [user, propertyId, load]);

  // Edit / Add → enqueue a single-target run + redirect to the live board where
  // the founder drives the robot to the right page and presses Finish.
  const startEditOrAdd = async (targetKey: string, mode: 'edit' | 'add') => {
    setBusy(`${mode}:${targetKey}`);
    setToast(null);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/edit-feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pmsFamily: data!.pmsFamily, propertyId, targetKey, mode }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setToast({ tone: 'bad', text: json.error ?? 'Could not start the edit run.' });
        return;
      }
      // Off to the board to drive the takeover.
      router.push(json.data.boardUrl as string);
    } catch (err) {
      setToast({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Delete → enqueue a worker recipe edit, then poll the job to completion.
  const confirmDelete = async () => {
    if (!pendingDelete?.actionKey || !data) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/delete-feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pmsFamily: data.pmsFamily, propertyId, targetKey: pendingDelete.actionKey }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setDeleteError(json.error ?? 'Could not remove the feed.');
        return;
      }
      const jobId = json.data.jobId as string;
      const outcome = await pollJob(jobId);
      setPendingDelete(null);
      if (outcome.ok) {
        const decision = (outcome.result?.promotion_decision as string | undefined) ?? '';
        if (decision === 'auto_promote') {
          setToast({ tone: 'good', text: `Removed “${pendingDelete.label}” — the map is live without it.` });
        } else {
          setToast({ tone: 'warn', text: (outcome.result?.promotion_reason as string | undefined) ?? 'Saved as a draft to review in Manage maps.' });
        }
      } else {
        setToast({ tone: 'bad', text: outcome.error });
      }
      await load();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  // Poll GET /live/[jobId] until the (headless) edit job finishes.
  const pollJob = async (jobId: string): Promise<{ ok: true; result: Record<string, unknown> | null } | { ok: false; error: string }> => {
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      try {
        const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
        const json = await res.json();
        const job = json?.data?.job as { status?: string; result?: Record<string, unknown> | null; error?: string } | undefined;
        if (job?.status === 'completed') return { ok: true, result: job.result ?? null };
        if (job?.status === 'failed' || job?.status === 'cancelled') return { ok: false, error: job.error ?? 'The edit run failed.' };
      } catch { /* keep polling */ }
    }
    return { ok: false, error: 'Timed out waiting for the edit to finish — check Manage maps.' };
  };

  const relearn = async () => {
    setBusy('relearn');
    try {
      const res = await fetchWithAuth('/api/admin/regenerate-recipe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, reason: 'coverage-editor: modernize legacy map' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setToast({ tone: 'bad', text: json.error ?? 'Could not start re-learning.' });
        return;
      }
      router.push(`/admin/properties/mapper/${json.data.jobId}`);
    } catch (err) {
      setToast({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (authLoading) return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Loading…</div></DarkScope></AppLayout>;
  if (!user) return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Not signed in</div></DarkScope></AppLayout>;
  if (user.role !== 'admin') return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Admin access only</div></DarkScope></AppLayout>;

  const map = data?.activeMap;
  const legacy = map && !map.editable;

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="tealTL" style={{ padding: '24px 48px 56px' }}>
          <div style={{ maxWidth: 1000, margin: '0 auto', fontFamily: FONT_SANS }}>
            <Link href="/admin/property-sessions" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.55),
              textDecoration: 'none', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 16,
            }}>
              <ChevronLeft size={12} /> CUA Sessions
            </Link>

            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
              <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', color: '#fff', margin: 0 }}>
                What the robot <span style={{ fontStyle: 'italic' }}>captures</span>
              </h1>
              <Btn variant="ghost" size="sm" onClick={() => void load()} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
                <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
              </Btn>
            </div>

            {data && (
              <p style={{ fontSize: 13, color: dimWhite(.66), margin: '0 0 18px' }}>
                {data.propertyName} · <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>{data.familyLabel}</span>
                {map && <> · map <span style={{ fontFamily: FONT_MONO }}>v{map.version}</span></>}
              </p>
            )}

            {error && (
              <DarkCard style={{ marginBottom: 16, background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)' }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--terracotta)' }}>{error}</span>
              </DarkCard>
            )}

            {toast && (
              <DarkCard style={{
                marginBottom: 16,
                background: toast.tone === 'good' ? 'var(--forest-dim)' : toast.tone === 'warn' ? 'var(--gold-dim)' : 'var(--terracotta-dim)',
                border: `1px solid ${toast.tone === 'good' ? 'rgba(60,156,104,.4)' : toast.tone === 'warn' ? 'rgba(201,154,46,.4)' : 'rgba(194,86,46,.4)'}`,
              }}>
                <span style={{ fontSize: 12.5, color: toast.tone === 'good' ? 'var(--forest)' : toast.tone === 'warn' ? 'var(--gold)' : 'var(--terracotta)' }}>{toast.text}</span>
              </DarkCard>
            )}

            {loading && !data && <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5) }}>Loading coverage…</div>}

            {data && !map && (
              <DarkEmpty text="No live map for this PMS yet. It appears here once the robot has learned this hotel's PMS." />
            )}

            {data && map && (
              <>
                {/* Family-scope warning + map meta */}
                <DarkCard style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <Layers size={18} color="var(--teal)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#fff' }}>
                      Editing changes the map for every {data.familyLabel} hotel
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.6), marginTop: 3 }}>
                      one map · {data.hotelsOnFamily} hotel{data.hotelsOnFamily === 1 ? '' : 's'} on this PMS · the counts below are for {data.propertyName}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Pill tone={map.signed ? 'forest' : 'gold'}>{map.signed ? 'Signed' : 'Unsigned'}</Pill>
                    {data.connection !== 'healthy' && <Pill tone="gold">{data.connection === 'pending' ? 'No reads yet' : 'Paused'}</Pill>}
                  </div>
                </DarkCard>

                {/* Legacy read-only banner */}
                {legacy && (
                  <DarkCard style={{ marginBottom: 16, background: 'var(--gold-dim)', border: '1px solid rgba(201,154,46,.4)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <Lock size={16} color="var(--gold)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--gold)' }}>This map predates per-feed editing</div>
                        <div style={{ fontSize: 12, color: dimWhite(.7), marginTop: 3 }}>
                          It’s shown read-only. Re-learn this PMS once to modernize it, then you can edit, add, and remove individual feeds.
                        </div>
                      </div>
                      <Btn variant="forest" size="sm" onClick={() => void relearn()} disabled={busy === 'relearn'}>
                        {busy === 'relearn' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />} Re-learn this PMS
                      </Btn>
                    </div>
                  </DarkCard>
                )}

                {/* Feed list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {data.feeds.length === 0 && <DarkEmpty text="This map captures no feeds." />}
                  {data.feeds.map((f) => {
                    const colNames = Object.keys(f.columns);
                    const isOpen = expanded === f.key;
                    return (
                      <DarkCard key={f.key} style={{ padding: '14px 18px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: FONT_SERIF, fontSize: 17, color: '#fff' }}>{f.label}</span>
                              <Pill tone={STATE_PILL[f.state].tone}>{STATE_PILL[f.state].label}</Pill>
                              {f.required && <Caps size={9} c="var(--teal)" style={{ letterSpacing: '.12em' }}>core</Caps>}
                            </div>
                            <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.45), marginTop: 4 }}>
                              {f.table ?? '—'} · {colNames.length} column{colNames.length === 1 ? '' : 's'}
                              {f.rowCount != null && <> · {f.rowCount} row{f.rowCount === 1 ? '' : 's'} seen here</>}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {f.source === 'actions' && f.canTakeover && (
                              <Btn variant="ghost" size="sm" onClick={() => void startEditOrAdd(f.actionKey!, 'edit')} disabled={!!busy} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
                                {busy === `edit:${f.actionKey}` ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Pencil size={12} />} Edit
                              </Btn>
                            )}
                            {f.source === 'actions' && !f.required && map.editable && (
                              <Btn variant="ghost" size="sm" onClick={() => { setDeleteError(null); setPendingDelete(f); }} disabled={!!busy} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>
                                <Trash2 size={12} /> Delete
                              </Btn>
                            )}
                          </div>
                        </div>

                        {colNames.length > 0 && (
                          <button
                            onClick={() => setExpanded(isOpen ? null : f.key)}
                            style={{ marginTop: 10, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                              fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5), letterSpacing: '.08em', textTransform: 'uppercase' }}
                          >
                            {isOpen ? '▾ hide columns' : '▸ show columns'}
                          </button>
                        )}
                        {isOpen && (
                          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {colNames.map((c) => (
                              <div key={c} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: '#fff', minWidth: 150 }}>{c}</span>
                                <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5), wordBreak: 'break-all' }}>{f.columns[c]}</span>
                              </div>
                            ))}
                            {f.sample.length > 0 && (
                              <div style={{ marginTop: 8, fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.4) }}>
                                sample: {JSON.stringify(f.sample[0]).slice(0, 240)}
                              </div>
                            )}
                          </div>
                        )}
                      </DarkCard>
                    );
                  })}
                </div>

                {/* Add a feed */}
                {map.editable && data.addableFeeds.length > 0 && (
                  <DarkCard style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Plus size={16} color="var(--forest)" />
                    <span style={{ fontSize: 13, color: '#fff' }}>Add a data point</span>
                    <select
                      value={addKey}
                      onChange={(e) => setAddKey(e.target.value)}
                      style={{ flex: 1, minWidth: 200, background: dimWhite(.06), color: '#fff', border: `1px solid ${dimWhite(.2)}`,
                        borderRadius: 8, padding: '7px 10px', fontFamily: FONT_SANS, fontSize: 12.5 }}
                    >
                      <option value="" style={{ color: '#000' }}>Choose a feed to add…</option>
                      {data.addableFeeds.map((a) => (
                        <option key={a.actionKey} value={a.actionKey} style={{ color: '#000' }}>{a.label}</option>
                      ))}
                    </select>
                    <Btn variant="forest" size="sm" disabled={!addKey || !!busy} onClick={() => void startEditOrAdd(addKey, 'add')}>
                      {busy === `add:${addKey}` ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={12} />} Add via takeover
                    </Btn>
                  </DarkCard>
                )}

                <div style={{ marginTop: 16, fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.4), display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Eye size={11} /> Edit / Add open the live board so you can drive the robot to the right page and press Finish.
                </div>
              </>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        </SurfaceShell>

        {/* Delete confirm */}
        {pendingDelete && (
          <Backdrop onClose={deleteBusy ? () => {} : () => { setPendingDelete(null); setDeleteError(null); }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
              <h3 style={{ fontFamily: FONT_SERIF, fontSize: 21, fontWeight: 500, margin: '0 0 10px', color: 'var(--ink)' }}>
                Remove “{pendingDelete.label}”?
              </h3>
              <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                The robot will stop capturing <b>{pendingDelete.label}</b> for every {data?.familyLabel} hotel. The map is re-published without it — you can re-add it later.
                <span style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 12, padding: '9px 11px', borderRadius: 10, background: 'rgba(194,86,46,.08)', border: '1px solid rgba(194,86,46,.3)', color: 'var(--terracotta-deep)', fontSize: 12.5 }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>This affects all {data?.hotelsOnFamily} hotel{data?.hotelsOnFamily === 1 ? '' : 's'} on this PMS.</span>
                </span>
              </div>
              {deleteError && (
                <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: 'var(--terracotta-deep)' }}>
                  {deleteError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
                <Btn size="md" variant="ghost" onClick={() => { setPendingDelete(null); setDeleteError(null); }} disabled={deleteBusy}>Cancel</Btn>
                <Btn size="md" variant="terracotta" onClick={() => void confirmDelete()} disabled={deleteBusy}>{deleteBusy ? 'Removing…' : 'Remove feed'}</Btn>
              </div>
            </div>
          </Backdrop>
        )}
      </DarkScope>
    </AppLayout>
  );
}
