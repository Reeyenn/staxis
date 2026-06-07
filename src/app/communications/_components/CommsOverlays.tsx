'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — overlays & modes:
//   SearchPalette · CatchUp popover · NewMessageModal · TodoMode (+ composer).
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Search, X, Megaphone, ArrowRight, Sparkles, Plus, Check, Clock, ChevronDown, Loader2,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/comms/client';
import type { ConversationDTO, StaffLite, TaskDTO, SearchHitDTO, CommsDept } from '@/lib/comms/types';
import type { L } from './comms-types-fe';
import {
  T, SANS, SERIF, MONO, deptColor, deptColorDark, deptLabel, tint, Avatar, DeptDot, MonoLabel, useFlip,
} from './comms-ui';

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH PALETTE
// ─────────────────────────────────────────────────────────────────────────────
export function SearchPalette({ pid, L, onClose, onJump, onOpenDm }: {
  pid: string; L: L; onClose: () => void; onJump: (conversationId: string) => void; onOpenDm: (staffId: string) => void;
}) {
  const [q, setQ] = React.useState('');
  const [hits, setHits] = React.useState<SearchHitDTO[]>([]);
  const inp = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => { inp.current?.focus(); }, []);
  React.useEffect(() => {
    const id = setTimeout(async () => {
      const r = await apiGet<{ hits: SearchHitDTO[] }>(`/api/comms/search?pid=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      if (r.ok && r.data) setHits(r.data.hits);
    }, 220);
    return () => clearTimeout(id);
  }, [pid, q]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const channels = hits.filter((h) => h.kind === 'channel');
  const people = hits.filter((h) => h.kind === 'person');
  const messages = hits.filter((h) => h.kind === 'message');
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'transparent', cursor: 'pointer' };
  const hov = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = T.paper);
  const out = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'transparent');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(24,22,17,.22)', zIndex: 70, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 84 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92%', maxHeight: '70%', background: T.bg, borderRadius: 14, border: `1px solid ${T.hair}`, boxShadow: '0 24px 64px rgba(24,22,17,.22)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <span style={{ color: T.dim, display: 'flex' }}><Search size={18} /></span>
          <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('Search messages, channels and people…', 'Buscar mensajes, canales y personas…')}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 15, color: T.ink }} />
          <button onClick={onClose} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: T.dim, border: `1px solid ${T.hair}`, borderRadius: 6, padding: '3px 7px', background: 'transparent', cursor: 'pointer' }}>ESC</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0 12px' }}>
          {channels.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{L('Channels', 'Canales')}</MonoLabel></div>
            {channels.map((h) => (
              <button key={'c' + h.conversationId} onClick={() => h.conversationId && onJump(h.conversationId)} style={rowStyle} onMouseEnter={hov} onMouseLeave={out}>
                <span style={{ color: deptColor(h.dept), display: 'flex' }}>{h.title === 'Announcements' ? <Megaphone size={16} /> : <span style={{ fontFamily: SANS, fontSize: 16, fontWeight: 600 }}>#</span>}</span>
                <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: T.ink, flex: 1 }}>{h.title}</span>
                {h.subtitle && <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim }}>{h.subtitle}</span>}
              </button>
            ))}
          </div>}
          {people.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{L('People', 'Personas')}</MonoLabel></div>
            {people.map((h) => (
              <button key={'p' + h.staffId} onClick={() => h.staffId && onOpenDm(h.staffId)} style={rowStyle} onMouseEnter={hov} onMouseLeave={out}>
                <Avatar name={h.title} dept={h.dept} size={26} />
                <span style={{ fontFamily: SANS, fontSize: 14, color: T.ink, flex: 1 }}><span style={{ fontWeight: 600 }}>{h.title}</span>{h.subtitle && <span style={{ color: T.dim, fontSize: 12 }}> · {h.subtitle}</span>}</span>
              </button>
            ))}
          </div>}
          {messages.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{L(`Messages (${messages.length})`, `Mensajes (${messages.length})`)}</MonoLabel></div>
            {messages.map((h, i) => (
              <button key={'m' + i} onClick={() => h.conversationId && onJump(h.conversationId)} style={{ ...rowStyle, alignItems: 'flex-start' }} onMouseEnter={hov} onMouseLeave={out}>
                <Avatar name={h.title} dept={h.dept} size={26} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim }}><span style={{ fontWeight: 600, color: T.ink }}>{h.title}</span> · {h.subtitle}</span>
                  <span style={{ display: 'block', fontFamily: SANS, fontSize: 13.5, color: T.ink, lineHeight: 1.4 }}>{h.snippet}</span>
                </span>
              </button>
            ))}
          </div>}
          {hits.length === 0 && <div style={{ padding: '24px 16px', textAlign: 'center', fontFamily: SANS, fontSize: 13.5, color: T.dim }}>{q ? L(`No results for “${q}”.`, `Sin resultados para “${q}”.`) : L('Type to search.', 'Escribe para buscar.')}</div>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CATCH UP popover (ranked unread, with optional AI summary)
// ─────────────────────────────────────────────────────────────────────────────
export function CatchUp({ pid, conversations, L, onJump, onClose }: {
  pid: string; conversations: ConversationDTO[]; L: L; onJump: (conversationId: string) => void; onClose: () => void;
}) {
  const items = conversations
    .filter((c) => c.unread > 0 || (c.pendingAck ?? 0) > 0)
    .map((c) => ({
      conversationId: c.id,
      dept: (c.dept ?? 'management') as CommsDept,
      urgent: (c.pendingAck ?? 0) > 0,
      title: c.title,
      text: c.lastMessagePreview ?? L('New activity', 'Actividad nueva'),
    }))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  const channelCount = new Set(items.map((i) => i.conversationId)).size;
  const needsYou = items.filter((i) => i.urgent).length;

  const [summary, setSummary] = React.useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = React.useState(false);
  const summarize = async () => {
    setLoadingSummary(true);
    try { const r = await apiPost<{ summary: string }>('/api/comms/summary', { pid }); setSummary(r.data?.summary ?? L('You are all caught up.', 'Estás al día.')); }
    finally { setLoadingSummary(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(24,22,17,.2)', zIndex: 70, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 76 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 424, maxWidth: '92%', background: T.bg, border: `1px solid ${T.hair}`, borderRadius: 14, boxShadow: '0 18px 50px rgba(24,22,17,.16)', overflow: 'hidden' }}>
        <div style={{ padding: '15px 18px 12px', borderBottom: `1px solid ${T.hairSoft}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: T.forest, marginBottom: 5 }}><Sparkles size={15} /><MonoLabel color={T.forest}>{L('Catch up', 'Ponerme al día')}</MonoLabel></div>
            <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 20, lineHeight: 1.16, color: T.ink }}>
              {items.length === 0 ? L('You are all caught up', 'Estás al día') : L(`${items.length} things across ${channelCount} conversations`, `${items.length} cosas en ${channelCount} conversaciones`)}
            </div>
            {needsYou > 0 && <div style={{ fontFamily: SANS, fontSize: 12, color: T.dim, marginTop: 5 }}>{L(`${needsYou} need you`, `${needsYou} te necesitan`)}</div>}
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>
        <div style={{ padding: '6px 10px 6px', maxHeight: 320, overflowY: 'auto' }}>
          {items.map((it) => (
            <button key={it.conversationId} onClick={() => onJump(it.conversationId)} style={{ display: 'flex', gap: 11, width: '100%', textAlign: 'left', padding: '11px 10px', background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', alignItems: 'flex-start' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.paper)} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ marginTop: 3, width: 8, height: 8, borderRadius: '50%', background: deptColor(it.dept), flexShrink: 0, boxShadow: it.urgent ? `0 0 0 4px ${tint(deptColor(it.dept), .16)}` : 'none' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.45, color: T.ink }}><strong style={{ fontWeight: 700 }}>{it.title}</strong> — {it.text}</span>
                {it.urgent && <span style={{ marginLeft: 7, fontFamily: MONO, fontSize: 9, letterSpacing: '.1em', color: T.terracotta }}>{L('NEEDS YOU', 'TE NECESITA')}</span>}
              </span>
              <span style={{ color: T.dim, marginTop: 2 }}><ArrowRight size={14} /></span>
            </button>
          ))}
          {items.length > 0 && (
            summary
              ? <div style={{ margin: '6px 10px 10px', padding: 12, background: T.forestTint, borderRadius: 10, fontSize: 12.5, color: T.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap', fontFamily: SANS }}>{summary}</div>
              : <button onClick={summarize} disabled={loadingSummary} style={{ margin: '4px 10px 8px', display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: deptColorDark(T.forest), fontFamily: SANS, fontSize: 12.5, fontWeight: 600 }}>
                  {loadingSummary ? <Loader2 size={13} className="comms-spin" /> : <Sparkles size={13} />} {L('Summarize with AI', 'Resumir con IA')}
                </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW MESSAGE (DM picker)
// ─────────────────────────────────────────────────────────────────────────────
export function NewMessageModal({ staff, L, onPick, onClose }: { staff: StaffLite[]; L: L; onPick: (staffId: string) => void; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const filtered = staff.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(24,22,17,.3)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.bg, borderRadius: 16, width: 400, maxWidth: '92%', maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(24,22,17,.2)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.hair}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontFamily: SANS, fontSize: 15 }}>{L('New message', 'Nuevo mensaje')}</span>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('Search staff…', 'Buscar personal…')} style={{ margin: 14, padding: '10px 12px', border: `1px solid ${T.hair}`, borderRadius: 10, fontFamily: SANS, fontSize: 14, outline: 'none' }} />
        <div style={{ overflowY: 'auto' }}>
          {filtered.map((s) => (
            <button key={s.id} onClick={() => onPick(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 18px', background: 'transparent', border: 'none', borderBottom: `1px solid ${T.hairSoft}`, cursor: 'pointer', fontFamily: SANS, fontSize: 14 }}>
              <Avatar name={s.name} dept={(s.channel === 'all_staff' ? 'management' : s.channel) as CommsDept} size={28} />
              <span>{s.name} <span style={{ fontSize: 12, color: T.dim }}>· {s.department ?? L('staff', 'personal')}</span></span>
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: 18, color: T.dim, fontSize: 13, fontFamily: SANS }}>{L('No staff found', 'Sin resultados')}</div>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TO-DO mode
// ─────────────────────────────────────────────────────────────────────────────
const DEPT_OPTIONS: { key: string; dept: CommsDept }[] = [
  { key: 'all_staff', dept: 'management' },
  { key: 'front_desk', dept: 'front_desk' },
  { key: 'housekeeping', dept: 'housekeeping' },
  { key: 'maintenance', dept: 'maintenance' },
];

export function TodoMode({ pid, tasks, staff, L, reload }: { pid: string; tasks: TaskDTO[]; staff: StaffLite[]; L: L; reload: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const toggle = async (t: TaskDTO) => { await apiPatch('/api/comms/tasks', { pid, taskId: t.id, status: t.status === 'done' ? 'open' : 'done' }); reload(); };
  const del = async (t: TaskDTO) => { await apiDelete(`/api/comms/tasks?pid=${encodeURIComponent(pid)}&taskId=${encodeURIComponent(t.id)}`); reload(); };

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ marginBottom: 7 }}><MonoLabel>{L(`${open.length} open · ${done.length} done`, `${open.length} abiertas · ${done.length} hechas`)}</MonoLabel></div>
            <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('To-do', 'Tareas')}</div>
          </div>
          <button onClick={() => setAdding((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: `1px solid ${adding ? T.hair : tint(T.forest, .4)}`, background: adding ? T.bg : tint(T.forest, .12), color: adding ? T.dim : deptColorDark(T.forest), fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>
            {adding ? <><X size={15} /> {L('Cancel', 'Cancelar')}</> : <><Plus size={16} /> {L('Add to-do', 'Agregar tarea')}</>}
          </button>
        </div>
        {adding && <TodoComposer pid={pid} staff={staff} L={L} onAdded={() => { setAdding(false); reload(); }} />}
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {open.length === 0 && !adding && <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}>{L('Nothing open. Add a to-do to get started.', 'Nada pendiente. Agrega una tarea para empezar.')}</div>}
          {open.map((t) => <TodoRow key={t.id} t={t} L={L} onToggle={() => toggle(t)} onDelete={() => del(t)} />)}
        </div>
        {done.length > 0 && <div style={{ marginTop: 26 }}><MonoLabel>{L('Done', 'Hechas')}</MonoLabel></div>}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {done.map((t) => <TodoRow key={t.id} t={t} L={L} onToggle={() => toggle(t)} onDelete={() => del(t)} />)}
        </div>
      </div>
    </div>
  );
}

function TodoComposer({ pid, staff, L, onAdded }: { pid: string; staff: StaffLite[]; L: L; onAdded: () => void }) {
  const [text, setText] = React.useState('');
  const [dept, setDept] = React.useState('all_staff');
  const [assignee, setAssignee] = React.useState('');
  const [priority, setPriority] = React.useState<'normal' | 'high' | 'urgent'>('normal');
  const [due, setDue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const inp = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { inp.current?.focus(); }, []);

  const submit = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true);
    try {
      await apiPost('/api/comms/tasks', { pid, title: t, assignedDepartment: dept, assignedStaffId: assignee || undefined, priority, dueAt: due ? new Date(due).toISOString() : undefined });
      onAdded();
    } finally { setBusy(false); }
  };
  const prios: [typeof priority, string, string][] = [['normal', L('Normal', 'Normal'), T.dim], ['high', L('High', 'Alta'), T.gold], ['urgent', L('Urgent', 'Urgente'), T.terracotta]];
  const curDept = (DEPT_OPTIONS.find((d) => d.key === dept)?.dept ?? 'management');

  return (
    <div style={{ marginTop: 16, border: `1px solid ${tint(T.forest, .35)}`, borderRadius: 13, background: T.bg, padding: '14px 16px', boxShadow: '0 8px 28px rgba(24,22,17,.07)' }}>
      <input ref={inp} value={text} onChange={(e) => setText(e.target.value)} placeholder={L('What needs doing?', '¿Qué hay que hacer?')}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 15, color: T.ink, padding: '2px 0 10px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', borderTop: `1px solid ${T.hairSoft}`, paddingTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <MonoLabel style={{ fontSize: 9.5 }}>{L('For', 'Para')}</MonoLabel>
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <DeptDot dept={curDept} />
            <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ appearance: 'none', border: `1px solid ${T.hair}`, borderRadius: 8, background: T.paper, fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: T.ink, padding: '5px 26px 5px 9px', marginLeft: 7, cursor: 'pointer' }}>
              {DEPT_OPTIONS.map((d) => <option key={d.key} value={d.key}>{d.key === 'all_staff' ? L('All Staff', 'Todos') : deptLabel(d.dept)}</option>)}
            </select>
            <span style={{ position: 'absolute', right: 8, color: T.dim, pointerEvents: 'none', display: 'flex' }}><ChevronDown size={12} /></span>
          </span>
        </label>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ border: `1px solid ${T.hair}`, borderRadius: 8, background: T.paper, fontFamily: SANS, fontSize: 12.5, color: T.ink, padding: '6px 9px', cursor: 'pointer', maxWidth: 160 }}>
          <option value="">{L('Anyone', 'Cualquiera')}</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4 }}>
          {prios.map(([id, lbl, col]) => {
            const on = priority === id;
            return <button key={id} onClick={() => setPriority(id)} style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? tint(col, .5) : T.hair}`, background: on ? tint(col, .14) : T.bg, color: on ? col : T.dim }}>{lbl}</button>;
          })}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '4px 8px' }}>
          <Clock size={13} color={T.dim} />
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 12, color: T.ink }} />
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={submit} disabled={!text.trim() || busy} style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 9, border: 'none', cursor: text.trim() ? 'pointer' : 'default', background: text.trim() ? T.ink : T.hairSoft, color: text.trim() ? '#fff' : T.dim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {busy && <Loader2 size={13} className="comms-spin" />} {L('Add', 'Agregar')}
        </button>
      </div>
    </div>
  );
}

function TodoRow({ t, L, onToggle, onDelete }: { t: TaskDTO; L: L; onToggle: () => void; onDelete: () => void }) {
  const [ref, flip] = useFlip('x');
  const [hover, setHover] = React.useState(false);
  const pr = t.priority === 'urgent' ? T.terracotta : t.priority === 'high' ? T.gold : T.dim;
  const deptDot = (t.assignedDepartment === 'all_staff' || !t.assignedDepartment ? 'management' : t.assignedDepartment) as CommsDept;
  return (
    <div ref={ref} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 16px', border: `1px solid ${T.hair}`, borderRadius: 12, background: t.status === 'done' ? T.paper : T.bg, transformStyle: 'preserve-3d' }}>
      <button onClick={() => flip(onToggle)} aria-label={L('toggle', 'alternar')} style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${t.status === 'done' ? T.forest : T.hairer}`, background: t.status === 'done' ? T.forest : T.bg, color: '#fff' }}>
        {t.status === 'done' && <Check size={14} strokeWidth={2.6} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: SANS, fontSize: 14, color: t.status === 'done' ? T.dim : T.ink, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 5, flexWrap: 'wrap' }}>
          {(t.assignedStaffName || t.assignedDepartment) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><DeptDot dept={deptDot} size={6} /><MonoLabel style={{ fontSize: 10 }}>{t.assignedStaffName ?? t.assignedDepartment ?? ''}</MonoLabel></span>}
          {t.dueAt && <MonoLabel style={{ fontSize: 10, color: pr }}>{new Date(t.dueAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</MonoLabel>}
        </div>
      </div>
      {t.priority === 'urgent' && t.status !== 'done' && <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.1em', color: T.terracotta, border: `1px solid ${tint(T.terracotta, .3)}`, borderRadius: 5, padding: '2px 6px' }}>{L('URGENT', 'URGENTE')}</span>}
      {hover && <button onClick={onDelete} title={L('Delete', 'Eliminar')} style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><X size={15} /></button>}
    </div>
  );
}
