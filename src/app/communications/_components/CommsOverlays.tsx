'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — overlays & modes:
//   SearchPalette · CatchUp popover · NewMessageModal · TodoMode (+ composer).
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Search, X, Megaphone, ArrowRight, ArrowUpRight, AlertTriangle, Sparkles, Plus, Check, Clock, ChevronDown, Loader2,
} from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '@/lib/comms/client';
import type { ConversationDTO, StaffLite, SearchHitDTO, CommsDept } from '@/lib/comms/types';
import type { WorklistItem, WorklistSourceType } from '@/lib/worklist/types';
import type { L } from './comms-types-fe';
import {
  T, SANS, SERIF, MONO, deptColor, deptColorDark, deptLabel, tint, Avatar, DeptDot, MonoLabel,
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,.22)', zIndex: 70, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 84 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92%', maxHeight: '70%', background: T.bg, borderRadius: 14, border: `1px solid ${T.hair}`, boxShadow: '0 24px 64px rgba(31,35,28,.22)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,.2)', zIndex: 70, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 76 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 424, maxWidth: '92%', background: T.bg, border: `1px solid ${T.hair}`, borderRadius: 14, boxShadow: '0 18px 50px rgba(31,35,28,.16)', overflow: 'hidden' }}>
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,.3)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.bg, borderRadius: 16, width: 400, maxWidth: '92%', maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(31,35,28,.2)' }}>
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

type DateBucket = 'all' | 'overdue' | 'today' | 'week';

/** Source tag label + colour per worklist source type. */
function sourceMeta(L: L): Record<WorklistSourceType, { label: string; color: string }> {
  return {
    task:       { label: L('To-do', 'Tarea'),           color: T.ink },
    complaint:  { label: L('Complaint', 'Queja'),       color: T.terracotta },
    workorder:  { label: L('Work order', 'Orden'),      color: T.gold },
    inspection: { label: L('Inspection', 'Inspección'), color: T.forest },
    pm:         { label: L('Preventive', 'Preventivo'), color: T.teal },
  };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function inDateBucket(it: WorklistItem, bucket: DateBucket): boolean {
  if (bucket === 'all') return true;
  if (bucket === 'overdue') return it.overdue;
  if (it.overdue) return true;   // overdue items always count as "needs attention now"
  const due = it.dueDate ? new Date(it.dueDate) : null;
  if (!due || Number.isNaN(due.getTime())) return false;
  if (bucket === 'today') return sameLocalDay(due, new Date());
  const end = new Date(); end.setDate(end.getDate() + 7);   // 'week'
  return due.getTime() <= end.getTime();
}

export function TodoMode({ pid, items, staff, L, reload }: { pid: string; items: WorklistItem[]; staff: StaffLite[]; L: L; reload: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [assignTarget, setAssignTarget] = React.useState<WorklistItem | null>(null);
  const [typeFilter, setTypeFilter] = React.useState<WorklistSourceType | 'all'>('all');
  const [bucket, setBucket] = React.useState<DateBucket>('all');
  const meta = sourceMeta(L);

  const filtered = items.filter((it) => (typeFilter === 'all' || it.sourceType === typeFilter) && inDateBucket(it, bucket));
  const overdueCount = items.filter((it) => it.overdue).length;
  const presentTypes = (['task', 'complaint', 'workorder', 'inspection', 'pm'] as WorklistSourceType[])
    .map((t) => ({ t, n: items.filter((it) => it.sourceType === t).length }))
    .filter((x) => x.n > 0);

  // Complete-from-here: every completable source routes through the worklist
  // dispatcher, which writes back to the item's real module. Inspections aren't
  // completable inline (canComplete=false) — their row deep-links to the inspect
  // flow instead. Manual to-dos can also be deleted from here.
  const complete = async (it: WorklistItem) => {
    await apiPost('/api/worklist/complete', { pid, sourceType: it.sourceType, sourceId: it.sourceId });
    reload();
  };
  const deleteTask = async (it: WorklistItem) => {
    await apiDelete(`/api/comms/tasks?pid=${encodeURIComponent(pid)}&taskId=${encodeURIComponent(it.sourceId)}`);
    reload();
  };

  const chipStyle = (active: boolean, color: string): React.CSSProperties => ({
    fontFamily: SANS, fontSize: 12.5, fontWeight: 600, padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${active ? tint(color, .5) : T.hair}`, background: active ? tint(color, .14) : T.bg,
    color: active ? deptColorDark(color) : T.dim, whiteSpace: 'nowrap',
  });

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ marginBottom: 7 }}><MonoLabel>{L(`${items.length} open · ${overdueCount} overdue`, `${items.length} abiertas · ${overdueCount} vencidas`)}</MonoLabel></div>
            <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Worklist', 'Lista')}</div>
          </div>
          <button onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: `1px solid ${tint(T.forest, .4)}`, background: tint(T.forest, .12), color: deptColorDark(T.forest), fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>
            <Plus size={16} /> {L('Add to-do', 'Agregar tarea')}
          </button>
        </div>

        {/* Filters — Type then date bucket (mirrors QUORE) */}
        <div style={{ marginTop: 18, display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
          <button onClick={() => setTypeFilter('all')} style={chipStyle(typeFilter === 'all', T.ink)}>{L('All', 'Todo')} {items.length}</button>
          {presentTypes.map(({ t, n }) => (
            <button key={t} onClick={() => setTypeFilter(t)} style={chipStyle(typeFilter === t, meta[t].color)}>{meta[t].label} {n}</button>
          ))}
          <span style={{ width: 1, height: 18, background: T.hair, margin: '0 3px' }} />
          {(['all', 'overdue', 'today', 'week'] as DateBucket[]).map((b) => (
            <button key={b} onClick={() => setBucket(b)} style={chipStyle(bucket === b, b === 'overdue' ? T.terracotta : T.ink)}>
              {b === 'all' ? L('Any time', 'Cualquier') : b === 'overdue' ? L('Overdue', 'Vencidas') : b === 'today' ? L('Today', 'Hoy') : L('This week', 'Esta semana')}
            </button>
          ))}
        </div>

        {/* List */}
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.length === 0 && (
            <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '26px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}>
              {items.length === 0
                ? L('Nothing open across the property. Add a to-do to get started.', 'Nada pendiente en la propiedad. Agrega una tarea para empezar.')
                : L('No items match these filters.', 'Ningún elemento coincide con estos filtros.')}
            </div>
          )}
          {filtered.map((it) => (
            <WorklistRow key={it.id} it={it} meta={meta[it.sourceType]} L={L} onComplete={() => complete(it)} onAssign={() => setAssignTarget(it)} onDelete={() => deleteTask(it)} />
          ))}
        </div>
      </div>

      {adding && <TodoComposer pid={pid} staff={staff} L={L} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload(); }} />}
      {assignTarget && <AssignModal item={assignTarget} pid={pid} staff={staff} L={L} onClose={() => setAssignTarget(null)} onDone={() => { setAssignTarget(null); reload(); }} />}
    </div>
  );
}

// ── Assign / reassign popup (staff for task & complaint; priority lane for work order) ──
function AssignModal({ item, pid, staff, L, onClose, onDone }: { item: WorklistItem; pid: string; staff: StaffLite[]; L: L; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const isPriority = item.sourceType === 'workorder';
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const post = async (payload: Record<string, unknown>) => {
    if (busy) return; setBusy(true);
    try { await apiPost('/api/worklist/assign', { pid, sourceType: item.sourceType, sourceId: item.sourceId, ...payload }); onDone(); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,.3)', zIndex: 71, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.bg, borderRadius: 16, width: 400, maxWidth: '94%', maxHeight: '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(31,35,28,.22)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.hairSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15 }}>{isPriority ? L('Set priority', 'Definir prioridad') : L('Assign to', 'Asignar a')}</span>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>

        {isPriority ? (
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([['urgent', L('Urgent', 'Urgente'), T.terracotta], ['normal', L('Normal', 'Normal'), T.dim], ['low', L('Low', 'Baja'), T.teal]] as [string, string, string][]).map(([id, lbl, col]) => {
              const on = item.priority === id;
              return (
                <button key={id} disabled={busy} onClick={() => post({ priority: id })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${on ? tint(col, .5) : T.hair}`, background: on ? tint(col, .12) : T.bg, fontFamily: SANS, fontSize: 14, fontWeight: 600, color: on ? deptColorDark(col) : T.ink, textAlign: 'left' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: col }} />
                  <span style={{ flex: 1 }}>{lbl}</span>
                  {on && <Check size={15} color={deptColorDark(col)} />}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ overflowY: 'auto', padding: '6px 0' }}>
            <button disabled={busy} onClick={() => post({ assigneeStaffId: null })} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 18px', background: 'transparent', border: 'none', borderBottom: `1px solid ${T.hairSoft}`, cursor: 'pointer', fontFamily: SANS, fontSize: 13.5, color: T.dim }}>
              <span style={{ width: 28, height: 28, borderRadius: '50%', border: `1.5px dashed ${T.hairer}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></span>
              {L('Unassigned', 'Sin asignar')}
            </button>
            {staff.map((s) => {
              const on = item.assigneeStaffId === s.id;
              return (
                <button key={s.id} disabled={busy} onClick={() => post({ assigneeStaffId: s.id })} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 18px', background: on ? T.paper : 'transparent', border: 'none', borderBottom: `1px solid ${T.hairSoft}`, cursor: 'pointer', fontFamily: SANS, fontSize: 14 }}>
                  <Avatar name={s.name} dept={(s.channel === 'all_staff' ? 'management' : s.channel) as CommsDept} size={28} />
                  <span style={{ flex: 1 }}>{s.name} <span style={{ fontSize: 12, color: T.dim }}>· {s.department ?? L('staff', 'personal')}</span></span>
                  {on && <Check size={15} color={T.forest} />}
                </button>
              );
            })}
            {staff.length === 0 && <div style={{ padding: 18, color: T.dim, fontSize: 13, fontFamily: SANS }}>{L('No staff found', 'Sin personal')}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function prioLabel(p: WorklistItem['priority'], L: L): string {
  return p === 'urgent' ? L('Urgent', 'Urgente') : p === 'high' ? L('High', 'Alta') : p === 'low' ? L('Low', 'Baja') : L('Normal', 'Normal');
}

function WorklistRow({ it, meta, L, onComplete, onAssign, onDelete }: { it: WorklistItem; meta: { label: string; color: string }; L: L; onComplete: () => void; onAssign: () => void; onDelete: () => void }) {
  const [hover, setHover] = React.useState(false);
  const isTask = it.sourceType === 'task';
  const prColor = it.priority === 'urgent' ? T.terracotta : it.priority === 'high' ? T.gold : T.dim;
  const dueLabel = it.dueDate ? new Date(it.dueDate).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${it.overdue ? tint(T.terracotta, .35) : T.hair}`, borderRadius: 12, background: T.bg }}>
      {/* Complete control — completable items get a check that routes back to
          their module; inspections (canComplete=false) show a source dot and are
          actioned via the deep-link instead. */}
      {it.canComplete ? (
        <button onClick={onComplete} aria-label={L('Mark done', 'Marcar hecho')} style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${hover ? T.forest : T.hairer}`, background: T.bg }}>
          {hover && <Check size={14} strokeWidth={2.6} color={T.forest} />}
        </button>
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: meta.color }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase', color: deptColorDark(meta.color), background: tint(meta.color, .12), border: `1px solid ${tint(meta.color, .3)}`, borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap' }}>{meta.label}</span>
          {it.location && <MonoLabel style={{ fontSize: 10 }}>{it.location}</MonoLabel>}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 14, color: T.ink, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 5, flexWrap: 'wrap' }}>
          {it.canAssign ? (
            <button onClick={onAssign} title={it.sourceType === 'workorder' ? L('Set priority', 'Definir prioridad') : L('Assign', 'Asignar')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${T.hair}`, borderRadius: 999, padding: '2px 9px 2px 6px', background: T.bg, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = T.hairer)} onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.hair)}>
              {it.sourceType === 'workorder'
                ? <MonoLabel style={{ fontSize: 10, color: prColor }}>{prioLabel(it.priority, L)}</MonoLabel>
                : it.assigneeName
                  ? <><Avatar name={it.assigneeName} size={15} /><MonoLabel style={{ fontSize: 10 }}>{it.assigneeName}</MonoLabel></>
                  : <MonoLabel style={{ fontSize: 10 }}>{L('Assign', 'Asignar')}</MonoLabel>}
            </button>
          ) : (
            it.assigneeName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar name={it.assigneeName} size={16} /><MonoLabel style={{ fontSize: 10 }}>{it.assigneeName}</MonoLabel></span>
          )}
          {it.overdue && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} color={T.terracotta} /><MonoLabel style={{ fontSize: 10, color: T.terracotta }}>{L('Overdue', 'Vencida')}</MonoLabel></span>}
          {dueLabel && !it.overdue && <MonoLabel style={{ fontSize: 10, color: prColor }}>{dueLabel}</MonoLabel>}
        </div>
      </div>

      {it.priority === 'urgent' && <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.1em', color: T.terracotta, border: `1px solid ${tint(T.terracotta, .3)}`, borderRadius: 5, padding: '2px 6px' }}>{L('URGENT', 'URGENTE')}</span>}

      {!isTask && (
        <a href={it.deepLink} title={L('Open', 'Abrir')} style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${T.hair}`, color: T.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, textDecoration: 'none' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; e.currentTarget.style.borderColor = T.hairer; }} onMouseLeave={(e) => { e.currentTarget.style.color = T.dim; e.currentTarget.style.borderColor = T.hair; }}>
          <ArrowUpRight size={15} />
        </a>
      )}
      {isTask && hover && <button onClick={onDelete} title={L('Delete', 'Eliminar')} style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><X size={15} /></button>}
    </div>
  );
}

// ── Add-to-do composer (centered popup) + scrollable wheel date picker ───────
function TodoComposer({ pid, staff, L, onClose, onAdded }: { pid: string; staff: StaffLite[]; L: L; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = React.useState('');
  const [dept, setDept] = React.useState('all_staff');
  const [assignee, setAssignee] = React.useState('');
  const [priority, setPriority] = React.useState<'normal' | 'high' | 'urgent'>('normal');
  const [dueIso, setDueIso] = React.useState('');   // '' = no due date
  const [busy, setBusy] = React.useState(false);
  const inp = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { inp.current?.focus(); }, []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true);
    try {
      await apiPost('/api/comms/tasks', { pid, title: t, assignedDepartment: dept, assignedStaffId: assignee || undefined, priority, dueAt: dueIso || undefined });
      onAdded();
    } finally { setBusy(false); }
  };
  const prios: [typeof priority, string, string][] = [['normal', L('Normal', 'Normal'), T.dim], ['high', L('High', 'Alta'), T.gold], ['urgent', L('Urgent', 'Urgente'), T.terracotta]];
  const curDept = (DEPT_OPTIONS.find((d) => d.key === dept)?.dept ?? 'management');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,.3)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.bg, borderRadius: 16, width: 460, maxWidth: '94%', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(31,35,28,.22)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '15px 18px 12px', borderBottom: `1px solid ${T.hairSoft}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 20, color: T.ink }}>{L('New to-do', 'Nueva tarea')}</span>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>

        <div style={{ padding: '14px 18px' }}>
          <input ref={inp} value={text} onChange={(e) => setText(e.target.value)} placeholder={L('What needs doing?', '¿Qué hay que hacer?')}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            style={{ width: '100%', border: `1px solid ${T.hair}`, borderRadius: 10, outline: 'none', background: T.paper, fontFamily: SANS, fontSize: 15, color: T.ink, padding: '11px 12px' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <MonoLabel style={{ fontSize: 9.5 }}>{L('For', 'Para')}</MonoLabel>
              <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <DeptDot dept={curDept} />
                <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ appearance: 'none', border: `1px solid ${T.hair}`, borderRadius: 8, background: T.paper, fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: T.ink, padding: '6px 26px 6px 9px', marginLeft: 7, cursor: 'pointer' }}>
                  {DEPT_OPTIONS.map((d) => <option key={d.key} value={d.key}>{d.key === 'all_staff' ? L('All Staff', 'Todos') : deptLabel(d.dept)}</option>)}
                </select>
                <span style={{ position: 'absolute', right: 8, color: T.dim, pointerEvents: 'none', display: 'flex' }}><ChevronDown size={12} /></span>
              </span>
            </label>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ border: `1px solid ${T.hair}`, borderRadius: 8, background: T.paper, fontFamily: SANS, fontSize: 12.5, color: T.ink, padding: '7px 9px', cursor: 'pointer', maxWidth: 180 }}>
              <option value="">{L('Anyone', 'Cualquiera')}</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 5, marginTop: 12 }}>
            {prios.map(([id, lbl, col]) => {
              const on = priority === id;
              return <button key={id} onClick={() => setPriority(id)} style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? tint(col, .5) : T.hair}`, background: on ? tint(col, .14) : T.bg, color: on ? col : T.dim }}>{lbl}</button>;
            })}
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}><Clock size={13} color={T.dim} /><MonoLabel style={{ fontSize: 9.5 }}>{L('Due', 'Vence')}</MonoLabel></div>
            <WheelDatePicker value={dueIso} onChange={setDueIso} L={L} />
          </div>
        </div>

        <div style={{ padding: '12px 18px 16px', borderTop: `1px solid ${T.hairSoft}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '9px 16px', borderRadius: 9, border: `1px solid ${T.hair}`, background: T.bg, color: T.dim, cursor: 'pointer' }}>{L('Cancel', 'Cancelar')}</button>
          <button onClick={submit} disabled={!text.trim() || busy} style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 9, border: 'none', cursor: text.trim() ? 'pointer' : 'default', background: text.trim() ? T.ink : T.hairSoft, color: text.trim() ? '#fff' : T.dim, display: 'flex', alignItems: 'center', gap: 6 }}>
            {busy && <Loader2 size={13} className="comms-spin" />} {L('Add to-do', 'Agregar')}
          </button>
        </div>
      </div>
    </div>
  );
}

const WHEEL_ROW_H = 34;
const WHEEL_VISIBLE = 5;

interface WheelOption { value: string; label: string }

function WheelColumn({ options, value, onChange, flex = 1 }: { options: WheelOption[]; value: string; onChange: (v: string) => void; flex?: number }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const pad = WHEEL_ROW_H * Math.floor(WHEEL_VISIBLE / 2);

  // Sync scroll position to the selected value (mount + external changes). When
  // the change came FROM scrolling, the position already matches → no jump.
  React.useEffect(() => {
    const el = ref.current; if (!el) return;
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const target = i * WHEEL_ROW_H;
    if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  const onScroll = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = ref.current; if (!el) return;
      const i = Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / WHEEL_ROW_H)));
      const o = options[i];
      if (o && o.value !== value) onChange(o.value);
    }, 110);
  };

  return (
    <div style={{ position: 'relative', flex, minWidth: 0 }}>
      <div ref={ref} onScroll={onScroll} className="wheel-scroll" style={{ height: WHEEL_ROW_H * WHEEL_VISIBLE, overflowY: 'auto', scrollSnapType: 'y mandatory' }}>
        <div style={{ height: pad }} />
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <div key={o.value || `i${i}`} onClick={() => { onChange(o.value); ref.current?.scrollTo({ top: i * WHEEL_ROW_H, behavior: 'smooth' }); }}
              style={{ height: WHEEL_ROW_H, scrollSnapAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: SANS, fontSize: 14.5, padding: '0 6px', textAlign: 'center', color: on ? T.ink : T.dim, fontWeight: on ? 700 : 500, opacity: on ? 1 : 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {o.label}
            </div>
          );
        })}
        <div style={{ height: pad }} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: pad, height: WHEEL_ROW_H, pointerEvents: 'none', borderTop: `1px solid ${tint(T.forest, .4)}`, borderBottom: `1px solid ${tint(T.forest, .4)}`, background: tint(T.forest, .05) }} />
    </div>
  );
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function WheelDatePicker({ value, onChange, L }: { value: string; onChange: (iso: string) => void; L: L }) {
  // Day column: No date + Today + next 30 days. Value = YYYY-MM-DD ('' = none).
  const dayOptions = React.useMemo<WheelOption[]>(() => {
    const opts: WheelOption[] = [{ value: '', label: L('No date', 'Sin fecha') }];
    const base = new Date(); base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 31; i++) {
      const d = new Date(base); d.setDate(base.getDate() + i);
      const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const label = i === 0 ? L('Today', 'Hoy') : i === 1 ? L('Tomorrow', 'Mañana') : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      opts.push({ value: ymd, label });
    }
    return opts;
  }, [L]);

  // Time column: every 30 min. Value = minutes-from-midnight (as string).
  const timeOptions = React.useMemo<WheelOption[]>(() => {
    const opts: WheelOption[] = [];
    for (let m = 0; m < 24 * 60; m += 30) {
      const h = Math.floor(m / 60); const mm = m % 60;
      const ap = h < 12 ? 'AM' : 'PM'; let h12 = h % 12; if (h12 === 0) h12 = 12;
      opts.push({ value: String(m), label: `${h12}:${pad2(mm)} ${ap}` });
    }
    return opts;
  }, []);

  const cur = value ? new Date(value) : null;
  const valid = cur && !Number.isNaN(cur.getTime());
  const curDay = valid ? `${cur!.getFullYear()}-${pad2(cur!.getMonth() + 1)}-${pad2(cur!.getDate())}` : '';
  const curMin = valid ? String(cur!.getHours() * 60 + Math.round(cur!.getMinutes() / 30) * 30) : '540'; // default 9:00 AM

  const compose = (day: string, minStr: string) => {
    if (!day) { onChange(''); return; }
    const [y, mo, d] = day.split('-').map(Number);
    const min = Number(minStr || '540');
    onChange(new Date(y, mo - 1, d, Math.floor(min / 60), min % 60, 0, 0).toISOString());
  };

  return (
    <div style={{ border: `1px solid ${T.hair}`, borderRadius: 12, overflow: 'hidden', background: T.paper, display: 'flex' }}>
      <WheelColumn options={dayOptions} value={curDay} onChange={(d) => compose(d, curMin)} flex={1.4} />
      <div style={{ width: 1, background: T.hairSoft }} />
      <WheelColumn options={timeOptions} value={curMin} onChange={(m) => compose(curDay, m)} flex={1} />
      <style>{`.wheel-scroll{scrollbar-width:none;-ms-overflow-style:none}.wheel-scroll::-webkit-scrollbar{display:none}`}</style>
    </div>
  );
}
