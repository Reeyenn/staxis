'use client';

/**
 * System tab — Snow design (May 2026).
 *
 * Top (full-width): Marvel timeline — commits, deploys, worktrees,
 * active Claude sessions.
 *
 * Below (2-column grid):
 *   Your roadmap (CRUD)  │  Admin audit log (read-only)
 */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Save, Trash2 } from 'lucide-react';
import { MarvelTimeline } from '@/app/admin/_components/MarvelTimeline';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Btn,
} from '@/app/admin/_components/_snow';

type RoadmapStatus = 'idea' | 'planned' | 'in_progress' | 'done' | 'dropped';

interface Commit {
  sha: string; shortSha: string; message: string; authorName: string; authorEmail: string; ts: string; url: string;
  checkStatus?: 'passed' | 'failed' | 'pending' | 'neutral' | null;
}
interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null; shortSha: string | null; deployedAt: string | null; url: string;
  status?: 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'QUEUED' | null;
  inProgress?: boolean;
  failed?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
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
interface Push {
  branch: string; ts: string; sha: string | null; commitMessage: string | null;
}
interface OpenPR {
  number: number; title: string; branch: string; url: string; draft: boolean;
  createdAt: string; updatedAt: string;
}

interface ActiveSession {
  session_id: string;
  branch: string | null;
  current_tool: string | null;
  started_at: string;
  last_heartbeat: string;
  cwd: string | null;
}

interface ActiveSessionsResp {
  sessions: ActiveSession[];
  grouped: { branch: string; sessionCount: number; sessions: ActiveSession[] }[];
  totalActive: number;
}

const CURSOR_MS = 2_000;
const REFRESH_MS = 60_000;

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
    pushes?: Push[]; openPRs?: OpenPR[];
    mainLatestTs?: string | null;
  } | null>(null);
  const [roadmap, setRoadmap] = useState<RoadmapItem[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionsResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [buildRes, roadmapRes, auditRes, sessionsRes] = await Promise.all([
        fetchWithAuth('/api/admin/build-status'),
        fetchWithAuth('/api/admin/roadmap'),
        fetchWithAuth('/api/admin/audit-log?limit=30'),
        fetchWithAuth('/api/admin/active-sessions'),
      ]);
      const [buildJson, roadmapJson, auditJson, sessionsJson] = await Promise.all([
        buildRes.json(), roadmapRes.json(), auditRes.json(), sessionsRes.json(),
      ]);
      if (buildJson.ok) setBuild(buildJson.data);
      if (roadmapJson.ok) setRoadmap(roadmapJson.data.items);
      if (auditJson.ok) setAudit(auditJson.data.entries);
      if (sessionsJson.ok) setActiveSessions(sessionsJson.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenCursorTs = useRef<string | null>(null);

  useEffect(() => {
    void load();

    const cursorTick = async () => {
      try {
        const [cursorRes, sessionsRes] = await Promise.all([
          fetchWithAuth('/api/admin/last-github-event'),
          fetchWithAuth('/api/admin/active-sessions'),
        ]);
        const cursorJson = await cursorRes.json();
        const sessionsJson = await sessionsRes.json();

        if (sessionsJson.ok) {
          setActiveSessions(sessionsJson.data);
        }

        if (cursorJson.ok) {
          const ts: string | null = cursorJson.data.latestTs ?? null;
          if (ts && ts !== lastSeenCursorTs.current) {
            const isFirstSeen = lastSeenCursorTs.current === null;
            lastSeenCursorTs.current = ts;
            if (!isFirstSeen) await load();
          }
        }
      } catch {
        /* swallow */
      }
      cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);
    };
    cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);

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
        padding: '14px 16px',
        background: T.warmDim,
        border: `1px solid rgba(184,92,61,0.25)`,
        borderRadius: 14,
        color: T.warm, fontSize: 13,
        fontFamily: FONT_SANS,
      }}>{error}</div>
    );
  }

  if (!build || !roadmap || !audit) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      <section>
        <MarvelTimeline
          commits={build.commits}
          deploys={build.deploys}
          worktrees={build.worktrees}
          branches={build.branches ?? []}
          merged={build.merged ?? []}
          pushes={build.pushes ?? []}
          openPRs={build.openPRs ?? []}
          mainLatestTs={build.mainLatestTs ?? null}
          activeSessions={activeSessions?.sessions ?? []}
        />
        {activeSessions && activeSessions.totalActive > 0 && (
          <ActiveSessionsPanel resp={activeSessions} />
        )}
      </section>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 18,
        alignItems: 'start',
      }}>
        <RoadmapSection items={roadmap} reload={load} />
        <section style={{ minWidth: 0 }}>
          <SectionTitle caps="Audit" title="Admin" italic="audit log" />
          {audit.length === 0 ? (
            <EmptyState text="No admin actions logged yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {audit.map((a) => <AuditRow key={a.id} entry={a} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ caps, title, italic, right }: {
  caps: string; title: string; italic?: string; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 12, marginBottom: 4,
    }}>
      <div>
        <Caps>{caps}</Caps>
        <h2 style={{
          fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
          lineHeight: 1.15,
        }}>
          {title}
          {italic && <> <span style={{ fontStyle: 'italic' }}>{italic}</span></>}
        </h2>
      </div>
      {right}
    </div>
  );
}

function ActiveSessionsPanel({ resp }: { resp: ActiveSessionsResp }) {
  return (
    <Card padding="14px 18px" style={{
      marginTop: 12,
      background: 'linear-gradient(180deg, rgba(215,176,126,0.10), rgba(215,176,126,0.02))',
      border: `1px solid rgba(140,106,51,0.20)`,
      borderRadius: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: T.sageDeep,
          animation: 'pulseDot 1.4s ease-in-out infinite',
        }} />
        <Caps c={T.ink}>
          {resp.totalActive} Claude {resp.totalActive === 1 ? 'session' : 'sessions'} active
        </Caps>
        <span style={{ color: T.ink3, fontSize: 11, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
          last heartbeat &lt; 2 min ago
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {resp.grouped.map((g) => (
          <div key={g.branch} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: T.sageDeep }}>
              {g.branch}
            </span>
            <span style={{ color: T.ink3 }}>·</span>
            <span style={{ color: T.ink2 }}>
              {g.sessionCount} {g.sessionCount === 1 ? 'session' : 'sessions'}
            </span>
            <span style={{ color: T.ink3 }}>·</span>
            <span style={{ color: T.ink2, fontFamily: FONT_MONO, fontSize: 11 }}>
              {g.sessions.map((s) => fmtToolName(s.current_tool ?? '?')).slice(0, 3).join(', ')}
            </span>
            <span style={{ color: T.ink3, marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 10.5, letterSpacing: '0.04em' }}>
              {timeAgo(g.sessions[0].last_heartbeat)}
            </span>
          </div>
        ))}
      </div>
      <style>{`@keyframes pulseDot { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.4; transform: scale(1.3) } }`}</style>
    </Card>
  );
}

const STATUS_COLOR: Record<RoadmapStatus, string> = {
  idea: T.ink3,
  planned: T.ink2,
  in_progress: T.caramelDeep,
  done: T.sageDeep,
  dropped: T.warm,
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
    <section style={{ minWidth: 0 }}>
      <SectionTitle
        caps="Roadmap"
        title="Your"
        italic="roadmap"
        right={!adding && (
          <Btn variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} /> Add
          </Btn>
        )}
      />

      {adding && (
        <Card padding="10px 12px" style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') { setAdding(false); setNewTitle(''); } }}
            placeholder="What do you want to build next?"
            style={{
              flex: 1, fontSize: 13, padding: '8px 12px',
              border: `1px solid ${T.rule}`, borderRadius: 999, outline: 'none',
              fontFamily: FONT_SANS, background: T.paper, color: T.ink,
            }}
          />
          <Btn variant="primary" size="sm" onClick={create}>
            <Save size={12} /> Save
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => { setAdding(false); setNewTitle(''); }}>
            Cancel
          </Btn>
        </Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
        {(['in_progress', 'planned', 'idea', 'done', 'dropped'] as RoadmapStatus[]).map((s) => {
          const list = grouped[s];
          if (list.length === 0) return null;
          return (
            <div key={s}>
              <div style={{
                fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600,
                color: STATUS_COLOR[s], textTransform: 'uppercase',
                letterSpacing: '0.16em', marginBottom: 6,
              }}>
                {s.replace('_', ' ')}
                <span style={{ marginLeft: 6, fontWeight: 400, color: T.ink3 }}>
                  · {list.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
      padding: '10px 14px',
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 12,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: T.ink, letterSpacing: '-0.005em' }}>{item.title}</div>
        {item.description && (
          <div style={{ fontSize: 11, color: T.ink2, marginTop: 2 }}>{item.description}</div>
        )}
      </div>
      <select
        value={item.status}
        onChange={(e) => onStatusChange(item.id, e.target.value as RoadmapStatus)}
        style={{
          fontSize: 11, padding: '4px 10px',
          border: `1px solid ${T.rule}`, borderRadius: 999,
          fontFamily: FONT_SANS, background: T.paper, color: T.ink2,
          outline: 'none', cursor: 'pointer',
        }}
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
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}
      >
        <Trash2 size={12} color={T.ink3} />
      </button>
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <div style={{
      padding: '10px 14px',
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 10,
      fontSize: 12,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, flexShrink: 0, letterSpacing: '0.04em' }}>
        {timeAgo(entry.ts)}
      </span>
      <span style={{ color: T.ink2, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong style={{ color: T.ink, letterSpacing: '-0.005em' }}>{entry.actor_email ?? 'system'}</strong>
        {' · '}
        <span style={{ fontFamily: FONT_MONO }}>{entry.action}</span>
        {entry.target_id && (
          <span style={{ color: T.ink3 }}> on {entry.target_type}/{entry.target_id.slice(0, 8)}</span>
        )}
      </span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '24px 20px',
      background: T.ruleSoft,
      border: `1px dashed ${T.rule}`,
      borderRadius: 14,
      textAlign: 'center',
      fontSize: 12.5,
      color: T.ink2,
      fontStyle: 'italic',
      fontFamily: FONT_SERIF,
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

function fmtToolName(tool: string): string {
  if (!tool) return tool;
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    return parts[parts.length - 1] || tool;
  }
  return tool;
}
