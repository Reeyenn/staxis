'use client';

// ─── /admin/agent/prompts — DB-backed prompt editor ─────────────────────
// Edit the AI's system prompts without a code deploy. List view shows
// every version, you click Edit to change content/notes, click Save,
// click Activate to promote a draft to production. Changes propagate
// within 30s across all Vercel function instances.
//
// Longevity L2, 2026-05-13. Round 11 T3 (2026-05-13): canary % slider
// removed — rollouts are always 100%, rollback via re-activating the
// prior version.

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ArrowLeft, CheckCircle2, AlertTriangle, Plus, Eye, Edit3 } from 'lucide-react';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sage:     'var(--snow-sage, #9EB7A6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
  caramel:  'var(--snow-caramel, #C99644)',
  warm:     'var(--snow-warm, #B85C3D)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

type PromptRole = 'base' | 'housekeeping' | 'general_manager' | 'owner' | 'admin' | 'summarizer';
const ROLE_LABELS: Record<PromptRole, string> = {
  base: 'Base (applies to every role)',
  housekeeping: 'Housekeeper',
  general_manager: 'Manager / Front desk',
  owner: 'Owner',
  admin: 'Admin (Staxis staff)',
  summarizer: 'Summarizer (background: writes conversation summaries)',
};

interface PromptRow {
  id: string;
  role: PromptRole;
  version: string;
  content: string;
  is_active: boolean;
  parent_version: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}

export default function AdminAgentPromptsPage() {
  const { user, loading: authLoading } = useAuth();
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Edit state — when set, we show the editor pane for this prompt id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editVersion, setEditVersion] = useState('');

  // New-version state — when set, show the create form for this role
  const [creatingRole, setCreatingRole] = useState<PromptRole | null>(null);
  const [newContent, setNewContent] = useState('');
  const [newVersion, setNewVersion] = useState('');
  const [newNotes, setNewNotes] = useState('');

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/agent/prompts');
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`);
        return;
      }
      const body = await res.json();
      setPrompts(body.data?.prompts ?? body.prompts ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    void load();
  }, [user]);

  const groupedByRole = useMemo(() => {
    const out = new Map<PromptRole, PromptRow[]>();
    for (const p of prompts) {
      if (!out.has(p.role)) out.set(p.role, []);
      out.get(p.role)!.push(p);
    }
    return out;
  }, [prompts]);

  const startEdit = (p: PromptRow) => {
    setEditingId(p.id);
    setEditContent(p.content);
    setEditNotes(p.notes ?? '');
    setEditVersion(p.version);
    setCreatingRole(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditNotes('');
    setEditVersion('');
  };

  const saveEdit = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetchWithAuth(`/api/admin/agent/prompts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          content: editContent,
          notes: editNotes,
          version: editVersion,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Save failed: ${res.status}`);
        return;
      }
      await load();
      cancelEdit();
    } finally {
      setBusy(null);
    }
  };

  const activate = async (id: string, version: string) => {
    if (!confirm(`Activate version "${version}"? This makes it live for all matching conversations within 30 seconds.`)) return;
    setBusy(id);
    try {
      const res = await fetchWithAuth(`/api/admin/agent/prompts/${id}/activate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Activate failed: ${res.status}`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const startCreate = (role: PromptRole) => {
    setCreatingRole(role);
    const active = groupedByRole.get(role)?.find(p => p.is_active);
    setNewContent(active?.content ?? '');
    setNewVersion('');
    setNewNotes('');
    setEditingId(null);
  };

  const saveCreate = async () => {
    if (!creatingRole) return;
    setBusy('new');
    try {
      const res = await fetchWithAuth('/api/admin/agent/prompts', {
        method: 'POST',
        body: JSON.stringify({
          role: creatingRole,
          version: newVersion,
          content: newContent,
          notes: newNotes,
          parent_version: groupedByRole.get(creatingRole)?.find(p => p.is_active)?.version ?? null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Create failed: ${res.status}`);
        return;
      }
      setCreatingRole(null);
      setNewContent('');
      setNewVersion('');
      setNewNotes('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (authLoading) return <AppLayout><Centered>Loading…</Centered></AppLayout>;
  if (!user || user.role !== 'admin') {
    return <AppLayout><Centered>This page is Staxis-only.</Centered></AppLayout>;
  }

  return (
    <AppLayout>
      <div style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '32px 24px 80px',
        fontFamily: FONT_SANS,
        color: C.ink,
        background: C.bg,
        minHeight: '100vh',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 36 }}>
          <div>
            <Link href="/admin/agent" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: FONT_MONO, fontSize: 11, textTransform: 'uppercase',
              letterSpacing: '0.08em', color: C.ink3, textDecoration: 'none',
              marginBottom: 8,
            }}>
              <ArrowLeft size={12} /> Back to Agent
            </Link>
            <div style={{
              fontFamily: FONT_SERIF,
              fontSize: 'clamp(48px, 6vw, 72px)',
              lineHeight: 1,
              letterSpacing: '-0.02em',
              color: C.ink,
            }}>
              Prompts
            </div>
            <div style={{
              marginTop: 8,
              fontFamily: FONT_MONO,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: C.ink3,
            }}>
              Edit system prompts without a code deploy · Live within 30s
            </div>
          </div>
          {error && (
            <div style={{
              padding: '6px 12px',
              background: 'rgba(184, 92, 61, 0.08)',
              border: `1px solid rgba(184, 92, 61, 0.20)`,
              borderRadius: 6,
              color: C.warm,
              fontFamily: FONT_MONO,
              fontSize: 11,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Per-role sections */}
        {(Object.keys(ROLE_LABELS) as PromptRole[]).map(role => {
          const rows = groupedByRole.get(role) ?? [];
          const active = rows.find(r => r.is_active);
          const drafts = rows.filter(r => !r.is_active);

          return (
            <div key={role} style={{
              marginBottom: 32,
              border: `1px solid ${C.rule}`,
              borderRadius: 14,
              overflow: 'hidden',
              background: C.bg,
            }}>
              {/* Section header */}
              <div style={{
                padding: '16px 20px',
                borderBottom: `1px solid ${C.rule}`,
                background: C.ruleSoft,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.ink3 }}>{role}</div>
                  <div style={{ fontFamily: FONT_SERIF, fontSize: 24, color: C.ink, marginTop: 2 }}>{ROLE_LABELS[role]}</div>
                </div>
                <button onClick={() => startCreate(role)} style={primaryButton}>
                  <Plus size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  New version
                </button>
              </div>

              {/* Create form (when creating for this role) */}
              {creatingRole === role && (
                <div style={editPanel}>
                  <div style={editPanelTitle}>New version of {ROLE_LABELS[role]}</div>
                  <label style={labelStyle}>Version label</label>
                  <input
                    type="text" value={newVersion} onChange={e => setNewVersion(e.target.value)}
                    placeholder="e.g. 2026.05.14-v1" style={inputStyle}
                  />
                  <label style={labelStyle}>Notes (what changed)</label>
                  <input
                    type="text" value={newNotes} onChange={e => setNewNotes(e.target.value)}
                    placeholder="Optional — describe the change" style={inputStyle}
                  />
                  <label style={labelStyle}>Content</label>
                  <textarea
                    value={newContent} onChange={e => setNewContent(e.target.value)}
                    rows={20} style={textareaStyle}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={saveCreate} disabled={busy === 'new' || !newVersion || !newContent} style={primaryButton}>
                      Save draft
                    </button>
                    <button onClick={() => setCreatingRole(null)} style={secondaryButton}>Cancel</button>
                  </div>
                  <div style={hintStyle}>
                    Draft starts inactive. Hit Activate on its row to make it live.
                  </div>
                </div>
              )}

              {/* Active version */}
              {active && (
                <PromptRowView
                  row={active}
                  isEditing={editingId === active.id}
                  editContent={editContent} setEditContent={setEditContent}
                  editNotes={editNotes} setEditNotes={setEditNotes}
                  editVersion={editVersion} setEditVersion={setEditVersion}
                  onStartEdit={() => startEdit(active)}
                  onCancelEdit={cancelEdit}
                  onSave={() => saveEdit(active.id)}
                  onActivate={() => {}}  // already active
                  busy={busy === active.id}
                />
              )}

              {/* Draft / historical versions */}
              {drafts.length > 0 && (
                <div style={{ padding: '16px 20px', borderTop: `1px solid ${C.rule}` }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.ink3, marginBottom: 8 }}>
                    {drafts.length} other version{drafts.length === 1 ? '' : 's'}
                  </div>
                  {drafts.map(d => (
                    <PromptRowView
                      key={d.id}
                      row={d}
                      isEditing={editingId === d.id}
                      editContent={editContent} setEditContent={setEditContent}
                      editNotes={editNotes} setEditNotes={setEditNotes}
                      editVersion={editVersion} setEditVersion={setEditVersion}
                      onStartEdit={() => startEdit(d)}
                      onCancelEdit={cancelEdit}
                      onSave={() => saveEdit(d.id)}
                      onActivate={() => activate(d.id, d.version)}
                      busy={busy === d.id}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AppLayout>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

interface RowViewProps {
  row: PromptRow;
  isEditing: boolean;
  editContent: string; setEditContent: (s: string) => void;
  editNotes: string; setEditNotes: (s: string) => void;
  editVersion: string; setEditVersion: (s: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onActivate: () => void;
  busy: boolean;
}

function PromptRowView(p: RowViewProps) {
  const [showFull, setShowFull] = useState(false);
  if (p.isEditing) {
    return (
      <div style={editPanel}>
        <div style={editPanelTitle}>Editing {p.row.version}</div>
        <label style={labelStyle}>Version label</label>
        <input
          type="text" value={p.editVersion} onChange={e => p.setEditVersion(e.target.value)}
          style={inputStyle}
        />
        <label style={labelStyle}>Notes</label>
        <input
          type="text" value={p.editNotes} onChange={e => p.setEditNotes(e.target.value)}
          placeholder="Optional" style={inputStyle}
        />
        <label style={labelStyle}>Content</label>
        <textarea
          value={p.editContent} onChange={e => p.setEditContent(e.target.value)}
          rows={20} style={textareaStyle}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={p.onSave} disabled={p.busy} style={primaryButton}>
            {p.busy ? 'Saving…' : 'Save'}
          </button>
          <button onClick={p.onCancelEdit} style={secondaryButton}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{
      padding: '16px 20px',
      borderTop: `1px solid ${C.rule}`,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          {p.row.is_active && <CheckCircle2 size={16} color={C.sageDeep} />}
          <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.ink, fontWeight: 500 }}>
            {p.row.version}
          </span>
          {p.row.is_active && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.sageDeep, padding: '2px 8px', background: 'rgba(94, 122, 96, 0.1)', borderRadius: 999 }}>
              ACTIVE
            </span>
          )}
          {p.row.notes && (
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: C.ink2, fontStyle: 'italic' }}>{p.row.notes}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setShowFull(!showFull)} style={secondaryButton}>
            <Eye size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {showFull ? 'Hide' : 'View'}
          </button>
          <button onClick={p.onStartEdit} style={secondaryButton}>
            <Edit3 size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            Edit
          </button>
          {!p.row.is_active && (
            <button onClick={p.onActivate} disabled={p.busy} style={primaryButton}>
              {p.busy ? '…' : 'Activate'}
            </button>
          )}
        </div>
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.ink3 }}>
        {new Date(p.row.created_at).toLocaleString()} {p.row.parent_version ? `· branched from ${p.row.parent_version}` : ''}
      </div>
      {showFull && (
        <pre style={{
          margin: '8px 0 0',
          padding: '12px',
          background: C.ruleSoft,
          border: `1px solid ${C.rule}`,
          borderRadius: 8,
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: C.ink2,
          whiteSpace: 'pre-wrap',
          maxHeight: 360,
          overflow: 'auto',
        }}>{p.row.content}</pre>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.ink, fontFamily: FONT_SANS, fontSize: 14,
    }}>
      {children}
    </div>
  );
}

const primaryButton: React.CSSProperties = {
  fontFamily: FONT_MONO, fontSize: 11,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  padding: '8px 14px',
  background: C.ink,
  color: C.bg,
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const secondaryButton: React.CSSProperties = {
  fontFamily: FONT_MONO, fontSize: 11,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  padding: '8px 12px',
  background: C.bg,
  color: C.ink2,
  border: `1px solid ${C.rule}`,
  borderRadius: 6,
  cursor: 'pointer',
};
const editPanel: React.CSSProperties = {
  padding: '20px',
  borderTop: `1px solid ${C.rule}`,
  background: C.ruleSoft,
};
const editPanelTitle: React.CSSProperties = {
  fontFamily: FONT_MONO, fontSize: 11,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  color: C.ink3,
  marginBottom: 12,
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: FONT_MONO, fontSize: 10,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  color: C.ink3,
  marginTop: 12,
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: FONT_SANS, fontSize: 13,
  color: C.ink,
  background: C.bg,
  border: `1px solid ${C.rule}`,
  borderRadius: 6,
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: FONT_MONO, fontSize: 12,
  lineHeight: 1.5,
  resize: 'vertical',
};
const hintStyle: React.CSSProperties = {
  marginTop: 8,
  fontFamily: FONT_SANS, fontSize: 11,
  color: C.ink3,
  fontStyle: 'italic',
};

// AlertTriangle is imported above to keep tree-shaking happy even
// though the current layout doesn't use it.
void AlertTriangle;
