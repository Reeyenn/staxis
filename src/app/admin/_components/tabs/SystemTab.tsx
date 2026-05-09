'use client';

/**
 * System tab — Phase 7.
 *
 * Sections:
 *   1. Marvel/Loki-style visual timeline (build status — main branch
 *      commits, deploy markers, active local worktrees)
 *   2. Scheduled jobs status — per-hotel pull_jobs health
 *   3. Personal product TODO / roadmap (CRUD)
 *   4. Admin audit log (read-only)
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  Plus, Save, Trash2, ExternalLink, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';
import { MarvelTimeline } from '@/app/admin/_components/MarvelTimeline';

type RoadmapStatus = 'idea' | 'planned' | 'in_progress' | 'done' | 'dropped';

interface Commit {
  sha: string; shortSha: string; message: string; authorName: string; authorEmail: string; ts: string; url: string;
}
interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null; shortSha: string | null; deployedAt: string | null; url: string;
}
interface Worktree {
  name: string; branch: string | null; lastActivity: string | null;
}
interface Branch {
  name: string; shortSha: string; latestMessage: string;
  latestTs: string | null; aheadOfMain: number; behindMain: number; url: string;
}
interface MergedBranch {
  branchName: string; mergeCommitSha: string; mergedAt: string;
  title: string; url: string; commitCount: number;
}

// Two-tier polling:
//   - CURSOR_MS (2s): hits the tiny /api/admin/last-github-event endpoint
//     that just returns the newest webhook ts. When it ticks, we refetch
//     the full timeline immediately. This is what gives the "feels live"
//     reaction time when commits land.
//   - REFRESH_MS (60s): background safety net so even if a webhook is
//     missed (GitHub down, secret rotated, etc.) the timeline still
//     refreshes on its own.
const CURSOR_MS = 2_000;
const REFRESH_MS = 60_000;
interface ScheduledRow {
  propertyId: string; propertyName: string | null;
  lastSuccessAt: string | null; lastFailedAt: string | null;
  stuckCount: number; latestStatus: string | null; latestError: string | null;
}
interface RoadmapItem {
  id: string; title: string; description: string | null;
  status: RoadmapStatus; priority: number;
  created_at: string; updated_at: string; done_at: string | null;
}
interface AuditEntry {
  id: string; ts: string; actor_email: string | null; action: string;
  target_type: string | null; target_id: string | null;
  metadata: Record<string, unknown>;
}

export function SystemTab() {
  const [build, setBuild] = useState<{
    commits: Commit[]; deploys: Deploy[]; worktrees: Worktree[];
    branches?: Branch[]; merged?: MergedBranch[];
    mainLatestTs?: string | null;
  } | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledRow[] | null>(null);
  const [roadmap, setRoadmap] = useState<RoadmapItem[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [buildRes, schedRes, roadmapRes, auditRes] = await Promise.all([
        fetchWithAuth('/api/admin/build-status'),
        fetchWithAuth('/api/admin/scheduled-jobs'),
        fetchWithAuth('/api/admin/roadmap'),
        fetchWithAuth('/api/admin/audit-log?limit=30'),
      ]);
      const [buildJson, schedJson, roadmapJson, auditJson] = await Promise.all([
        buildRes.json(), schedRes.json(), roadmapRes.json(), auditRes.json(),
      ]);
      if (buildJson.ok) setBuild(buildJson.data);
      if (schedJson.ok) setScheduled(schedJson.data.rows);
      if (roadmapJson.ok) setRoadmap(roadmapJson.data.items);
      if (auditJson.ok) setAudit(auditJson.data.entries);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  // Two timers — cursor (fast, cheap) + background (slow, full refetch).
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenCursorTs = useRef<string | null>(null);

  useEffect(() => {
    void load();

    // Cursor poll: cheap query for the latest webhook event ts. When it
    // changes, refetch immediately. This is what gives sub-3s reaction
    // time to a fresh commit.
    const cursorTick = async () => {
      try {
        const res = await fetchWithAuth('/api/admin/last-github-event');
        const json = await res.json();
        if (json.ok) {
          const ts: string | null = json.data.latestTs ?? null;
          if (ts && ts !== lastSeenCursorTs.current) {
            const isFirstSeen = lastSeenCursorTs.current === null;
            lastSeenCursorTs.current = ts;
            // Don't refetch on the very first observation — that's just us
            // discovering the existing latest event, not a new one.
            if (!isFirstSeen) await load();
          }
        }
      } catch {
        /* swallow — background refresh will catch up */
      }
      cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);
    };
    cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);

    // Background refresh: in case the webhook misses an event, refetch
    // everything once a minute regardless.
    const refreshTick = () => {
      refreshTimer.current = setTimeout(async () => {
        await load();
        refreshTick();
      }, REFRESH_MS);
    };
    refreshTick();

    return () => {
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  if (error) {
    return (
      <div style={{
        padding: '12px 14px',
        background: 'var(--red-dim)',
        border: '1px solid rgba(239,68,68,0.25)',
        borderRadius: '10px',
        color: 'var(--red)', fontSize: '13px',
      }}>{error}</div>
    );
  }

  if (!build || !scheduled || !roadmap || !audit) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 1. Marvel timeline */}
      <section>
        <h2 style={sectionTitle}>The sacred timeline</h2>
        <p style={sectionHint}>Main flows left → right. Tendrils branching off are work-in-progress; arcs that loop back are branches that came home. Anything with activity in the last 5 minutes pulses live. Updates within ~3 seconds of any commit (GitHub webhook).</p>
        <MarvelTimeline
          commits={build.commits}
          deploys={build.deploys}
          worktrees={build.worktrees}
          branches={build.branches ?? []}
          merged={build.merged ?? []}
          mainLatestTs={build.mainLatestTs ?? null}
        />
      </section>

      {/* 2. Scheduled jobs */}
      <section>
        <h2 style={sectionTitle}>Scheduled jobs</h2>
        <p style={sectionHint}>Per-hotel pull_jobs status. Stuck jobs (queued/running &gt; 30 min) bubble to the top.</p>
        {scheduled.length === 0 ? (
          <EmptyState text="No scheduled job history yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {scheduled.map((s) => <ScheduledJobRow key={s.propertyId} row={s} />)}
          </div>
        )}
      </section>

      {/* 3. Roadmap */}
      <RoadmapSection items={roadmap} reload={load} />

      {/* 4. Audit log */}
      <section>
        <h2 style={sectionTitle}>Admin audit log</h2>
        <p style={sectionHint}>Last 30 admin actions. Useful when you have help on the team.</p>
        {audit.length === 0 ? (
          <EmptyState text="No admin actions logged yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
            {audit.map((a) => <AuditRow key={a.id} entry={a} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function ScheduledJobRow({ row }: { row: ScheduledRow }) {
  const isStuck = row.stuckCount > 0;
  const failedRecently = row.lastFailedAt && (!row.lastSuccessAt || row.lastFailedAt > row.lastSuccessAt);
  const StatusIcon = isStuck ? AlertTriangle : failedRecently ? AlertTriangle : CheckCircle2;
  const color = isStuck ? 'var(--red)' : failedRecently ? 'var(--amber)' : 'var(--green)';

  return (
    <Link href={`/admin/properties/${row.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{
        padding: '12px 14px',
        background: 'var(--surface-primary)',
        border: `1px solid ${isStuck ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`,
        borderRadius: '10px',
        display: 'flex', alignItems: 'center', gap: '12px',
      }}>
        <StatusIcon size={14} color={color} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>
            {row.propertyName ?? '(deleted property)'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {row.lastSuccessAt && <span style={{ color: 'var(--green)' }}>Last success {timeAgo(row.lastSuccessAt)}</span>}
            {row.lastFailedAt && <span style={{ color: 'var(--red)' }}>Last fail {timeAgo(row.lastFailedAt)}</span>}
            {row.stuckCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>{row.stuckCount} stuck</span>}
            {!row.lastSuccessAt && !row.lastFailedAt && <span>—</span>}
          </div>
          {row.latestError && (
            <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
              {row.latestError.slice(0, 120)}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

const STATUS_COLOR: Record<RoadmapStatus, string> = {
  idea: 'var(--text-muted)',
  planned: 'var(--text-secondary)',
  in_progress: 'var(--amber)',
  done: 'var(--green)',
  dropped: 'var(--red)',
};

function RoadmapSection({ items, reload }: { items: RoadmapItem[]; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const create = async () => {
    if (!newTitle.trim()) return;
    await fetchWithAuth('/api/admin/roadmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    setNewTitle('');
    setAdding(false);
    await reload();
  };

  const updateStatus = async (id: string, status: RoadmapStatus) => {
    await fetchWithAuth('/api/admin/roadmap', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    await reload();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this roadmap item?')) return;
    await fetchWithAuth('/api/admin/roadmap', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await reload();
  };

  const grouped = {
    in_progress: items.filter((i) => i.status === 'in_progress'),
    planned: items.filter((i) => i.status === 'planned'),
    idea: items.filter((i) => i.status === 'idea'),
    done: items.filter((i) => i.status === 'done').slice(0, 5),
    dropped: items.filter((i) => i.status === 'dropped').slice(0, 5),
  };

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div>
          <h2 style={sectionTitle}>Your roadmap</h2>
          <p style={sectionHint}>Personal product TODO. Lives here so admin doubles as your command center.</p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-secondary" style={{ fontSize: '12px' }}>
            <Plus size={12} /> Add
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') { setAdding(false); setNewTitle(''); } }}
            placeholder="What do you want to build next?"
            className="input"
            style={{ flex: 1, fontSize: '13px' }}
          />
          <button onClick={create} className="btn btn-primary" style={{ fontSize: '12px' }}>
            <Save size={12} /> Save
          </button>
          <button onClick={() => { setAdding(false); setNewTitle(''); }} className="btn btn-secondary" style={{ fontSize: '12px' }}>
            Cancel
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {(['in_progress', 'planned', 'idea', 'done', 'dropped'] as RoadmapStatus[]).map((s) => {
          const list = grouped[s];
          if (list.length === 0) return null;
          return (
            <div key={s}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: STATUS_COLOR[s], textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                {s.replace('_', ' ')} <span style={{ opacity: 0.6, fontWeight: 400 }}>· {list.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {list.map((item) => (
                  <RoadmapItemRow key={item.id} item={item} onStatusChange={updateStatus} onDelete={remove} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RoadmapItemRow({ item, onStatusChange, onDelete }: {
  item: RoadmapItem;
  onStatusChange: (id: string, status: RoadmapStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      display: 'flex', alignItems: 'center', gap: '10px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px' }}>{item.title}</div>
        {item.description && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{item.description}</div>
        )}
      </div>
      <select
        value={item.status}
        onChange={(e) => onStatusChange(item.id, e.target.value as RoadmapStatus)}
        className="input"
        style={{ fontSize: '11px', padding: '4px 8px' }}
      >
        <option value="idea">Idea</option>
        <option value="planned">Planned</option>
        <option value="in_progress">In progress</option>
        <option value="done">Done</option>
        <option value="dropped">Dropped</option>
      </select>
      <button
        onClick={() => onDelete(item.id)}
        aria-label="Delete"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex' }}
      >
        <Trash2 size={12} color="var(--text-muted)" />
      </button>
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <div style={{
      padding: '8px 12px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      fontSize: '12px',
      display: 'flex', alignItems: 'center', gap: '12px',
    }}>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0 }}>
        {timeAgo(entry.ts)}
      </span>
      <span style={{ color: 'var(--text-secondary)', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong style={{ color: 'var(--text-primary)' }}>{entry.actor_email ?? 'system'}</strong>
        {' · '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>{entry.action}</span>
        {entry.target_id && (
          <span style={{ color: 'var(--text-muted)' }}>{' on '}{entry.target_type}/{entry.target_id.slice(0, 8)}</span>
        )}
      </span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: '8px',
      padding: '20px',
      background: 'var(--surface-secondary)',
      border: '1px dashed var(--border)',
      borderRadius: '10px',
      textAlign: 'center',
      fontSize: '12px',
      color: 'var(--text-muted)',
    }}>{text}</div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const sectionTitle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const sectionHint: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  marginTop: '2px',
  marginBottom: '8px',
};
