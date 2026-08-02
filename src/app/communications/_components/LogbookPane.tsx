'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Shift Log Book — recaps + threaded replies.
// A shift handoff: any staffer posts a titled free-text recap scoped to their
// property; teammates reply in a thread. Newest-first, grouped by day. Mirrors
// the To-do stack (CommsOverlays · TodoMode). Reads/writes via /api/comms/
// logbook*; refresh by polling (gated on !document.hidden) like the rest of
// Communications — NOT subscribeTable. NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Plus, X, ArrowLeft, Loader2, MessageSquare, ChevronDown, Send, AlertCircle, RefreshCw } from 'lucide-react';
import { apiPost } from '@/lib/comms/client';
import type { LogEntryDTO, LogReplyDTO, CommsDept } from '@/lib/comms/types';
import type { L } from './comms-types-fe';
import { useCommsResource } from './comms-data';
import { reportCompanionFlow } from '@/components/companion/companion-events';
import {
  T, SANS, SERIF, MONO, deptColor, deptColorDark, tint, Avatar, MonoLabel, DeptDot,
  fmtClock, fmtDayLabel, dayKey,
} from './comms-ui';

const CATS: { key: string; dept: CommsDept; en: string }[] = [
  { key: 'general', dept: 'management', en: 'General', },
  { key: 'front_desk', dept: 'front_desk', en: 'Front Desk', },
  { key: 'housekeeping', dept: 'housekeeping', en: 'Housekeeping', },
  { key: 'maintenance', dept: 'maintenance', en: 'Maintenance', },
];
function catDept(category: string | null | undefined): CommsDept {
  switch (category) {
    case 'front_desk': return 'front_desk';
    case 'housekeeping': return 'housekeeping';
    case 'maintenance': return 'maintenance';
    default: return 'management';
  }
}
function catLabel(category: string | null | undefined, L: L): string {
  const c = CATS.find((x) => x.key === category);
  return c ? c.en : 'General';
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG BOOK mode (self-fetching: list ⇄ detail)
// ─────────────────────────────────────────────────────────────────────────────
export function LogbookMode({ pid, meName, L, embedded = false, onCount }: {
  pid: string;
  meName: string;
  L: L;
  /** Suppress this pane's own title block. The surface around it has a header
   *  already, and two titles in one box is one title too many. */
  embedded?: boolean;
  /** How many entries the read actually returned, so the surface around this
   *  pane can show a count without opening a second read of the same endpoint. */
  onCount?: (count: number) => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  // 30s, not 8s. This is a place you GO, not a feed you watch, and every tick
  // rebuilt the whole list. At 200 rows that was the lag on open: the tree was
  // re-rendered from scratch seven times a minute for a page nobody was
  // watching change. The rows below are memoised for the same reason.
  const { data, loading, error: loadError, reload: load } = useCommsResource<{ entries: LogEntryDTO[] }>(
    `/api/comms/logbook?pid=${encodeURIComponent(pid)}`,
    { pollMs: 30000, keepDataOnError: true },
  );
  const entries = React.useMemo(() => data?.entries ?? [], [data]);
  const loaded = data !== null;

  React.useEffect(() => { if (loaded) onCount?.(entries.length); }, [loaded, entries.length, onCount]);

  const selected = React.useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [selectedId, entries],
  );
  // Was rebuilt inline in the JSX, so every poll re-parsed a Date per entry and
  // re-grouped all of them before React had even begun diffing.
  const days = React.useMemo(() => groupByDay(entries), [entries]);
  const openEntry = React.useCallback((id: string) => setSelectedId(id), []);

  // If the open recap drops out of the polled list (deleted / fell past the
  // window), drop back to the list cleanly instead of snapping back into a stale
  // detail view if a later poll resurfaces it.
  React.useEffect(() => {
    if (loaded && selectedId && !entries.some((e) => e.id === selectedId)) setSelectedId(null);
  }, [loaded, entries, selectedId]);

  if (selectedId && selected) {
    return <LogEntryDetail pid={pid} entry={selected} meName={meName} L={L} onBack={() => setSelectedId(null)} onReplied={load} />;
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: embedded ? '16px 20px 28px' : '26px 28px 60px', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: embedded ? 'flex-end' : 'space-between', gap: 16 }}>
          {!embedded && (
            <div>
              <div style={{ marginBottom: 7 }}><MonoLabel>{data ? `${entries.length} recaps` : (loading ? 'Loading recaps' : 'Log unavailable')}</MonoLabel></div>
              <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{'Log book'}</div>
            </div>
          )}
          <button onClick={() => setAdding((v) => !v)} style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: `1px solid ${adding ? T.hair : tint(T.forest, .4)}`, background: adding ? T.bg : tint(T.forest, .12), color: adding ? T.dim : deptColorDark(T.forest), fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>
            {adding ? <><X size={15} /> {'Cancel'}</> : <><Plus size={16} /> {'New entry'}</>}
          </button>
        </div>

        {adding && <LogComposer pid={pid} L={L} onAdded={() => { setAdding(false); void load(); }} />}

        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading && !data && <div role="status" style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center' }}><Loader2 size={16} className="comms-spin" aria-hidden="true" /> {'Loading recaps…'}</div>}
          {loadError && <div role="alert" style={{ fontFamily: SANS, fontSize: 13, lineHeight: 1.45, color: T.terracotta, padding: '12px 14px', border: `1px solid ${tint(T.terracotta, .28)}`, background: tint(T.terracotta, .08), borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}><AlertCircle size={17} aria-hidden="true" /><span style={{ flex: 1 }}>{data ? 'The log book could not refresh. Showing the last results.' : 'The log book could not load. Check your connection and try again.'}</span><button onClick={() => void load()} aria-label={'Retry loading the log book'} style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: `1px solid ${tint(T.terracotta, .3)}`, background: T.bg, color: T.terracotta, cursor: 'pointer' }}><RefreshCw size={15} aria-hidden="true" /></button></div>}
          {loaded && !loadError && entries.length === 0 && !adding && (
            <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}>
              {'No recaps yet. Post a shift handoff to get started.'}
            </div>
          )}
          {days.map((grp) => (
            <React.Fragment key={grp.key}>
              <div style={{ padding: '12px 2px 4px' }}><MonoLabel>{fmtDayLabel(grp.entries[0].createdAt, 'Today', 'Yesterday')}</MonoLabel></div>
              {grp.entries.map((e) => <LogEntryRow key={e.id} e={e} L={L} onOpen={openEntry} />)}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function groupByDay(entries: LogEntryDTO[]): { key: string; entries: LogEntryDTO[] }[] {
  const out: { key: string; entries: LogEntryDTO[] }[] = [];
  for (const e of entries) {
    const k = dayKey(e.createdAt);
    const last = out[out.length - 1];
    if (last && last.key === k) last.entries.push(e);
    else out.push({ key: k, entries: [e] });
  }
  return out;
}

const LogEntryRow = React.memo(function LogEntryRow({ e, L, onOpen }: { e: LogEntryDTO; L: L; onOpen: (id: string) => void }) {
  const dept = catDept(e.category);
  return (
    <button onClick={() => onOpen(e.id)} style={{ textAlign: 'left', border: `1px solid ${T.hair}`, borderRadius: 12, background: T.bg, cursor: 'pointer', padding: '13px 16px', display: 'block', width: '100%' }}
      onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = tint(deptColor(dept), .45))} onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = T.hair)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <DeptDot dept={dept} size={7} />
        <MonoLabel style={{ fontSize: 10 }}>{catLabel(e.category, L)}</MonoLabel>
        <span style={{ flex: 1 }} />
        <MonoLabel style={{ fontSize: 10 }}>{fmtClock(e.createdAt)}</MonoLabel>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: T.ink, lineHeight: 1.3 }}>{e.title}</div>
      {e.body && <div style={{ fontFamily: SANS, fontSize: 13, color: T.dim, lineHeight: 1.45, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{e.body}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
        <Avatar name={e.authorName ?? 'Staff'} dept={dept} size={20} />
        <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: T.ink }}>{e.authorName ?? 'Staff'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: e.replyCount > 0 ? deptColorDark(T.teal) : T.dim }}>
          <MessageSquare size={13} />
          <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600 }}>{e.replyCount === 1 ? '1 reply' : `${e.replyCount} replies`}</span>
        </span>
      </div>
    </button>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW RECAP composer
// ─────────────────────────────────────────────────────────────────────────────
function LogComposer({ pid, L, onAdded }: { pid: string; L: L; onAdded: () => void }) {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [category, setCategory] = React.useState('general');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inp = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { inp.current?.focus(); }, []);

  const submit = async () => {
    const t = title.trim(); if (!t || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPost('/api/comms/logbook', { pid, title: t, body: body.trim() || undefined, category });
      if (!r.ok) { setError('The recap was not posted. Please try again.'); return; }
      // Written by hand, and add_logbook_entry is a real tool. Success only,
      // after the post landed. Shown at most once ever. See decideTeachMoment.
      reportCompanionFlow('log_book_entry');
      onAdded();
    } finally { setBusy(false); }
  };
  const curDept = catDept(category);

  return (
    <div style={{ marginTop: 16, border: `1px solid ${tint(T.forest, .35)}`, borderRadius: 13, background: T.bg, padding: '14px 16px', boxShadow: '0 8px 28px rgba(31,35,28,.07)' }}>
      <input ref={inp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={'Recap title, e.g. “Night shift handoff”'}
        style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 16, fontWeight: 700, color: T.ink, padding: '2px 0 8px' }} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={'What happened this shift? Anything the next team should know.'}
        rows={4}
        style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', resize: 'vertical', fontFamily: SANS, fontSize: 14, color: T.ink, lineHeight: 1.5, padding: '0 0 10px', minHeight: 72 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', borderTop: `1px solid ${T.hairSoft}`, paddingTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <MonoLabel style={{ fontSize: 9.5 }}>{'Area'}</MonoLabel>
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <DeptDot dept={curDept} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ minHeight: 44, appearance: 'none', border: `1px solid ${T.hair}`, borderRadius: 8, background: T.paper, fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: T.ink, padding: '5px 26px 5px 9px', marginLeft: 7, cursor: 'pointer' }}>
              {CATS.map((c) => <option key={c.key} value={c.key}>{c.en}</option>)}
            </select>
            <span style={{ position: 'absolute', right: 8, color: T.dim, pointerEvents: 'none', display: 'flex' }}><ChevronDown size={12} /></span>
          </span>
        </label>
        <div style={{ flex: 1 }} />
        <button onClick={submit} disabled={!title.trim() || busy} style={{ minHeight: 44, fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 9, border: 'none', cursor: title.trim() ? 'pointer' : 'default', background: title.trim() ? T.ink : T.hairSoft, color: title.trim() ? '#fff' : T.dim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {busy && <Loader2 size={13} className="comms-spin" />} {'Post recap'}
        </button>
      </div>
      {error && <div role="alert" style={{ marginTop: 8, color: T.terracotta, fontFamily: SANS, fontSize: 12.5 }}>{error}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RECAP detail + reply thread
// ─────────────────────────────────────────────────────────────────────────────
function LogEntryDetail({ pid, entry, meName, L, onBack, onReplied }: {
  pid: string; entry: LogEntryDTO; meName: string; L: L; onBack: () => void; onReplied: () => void;
}) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const dept = catDept(entry.category);

  const { data, loading, error: loadError, reload: load } = useCommsResource<{ replies: LogReplyDTO[] }>(
    `/api/comms/logbook/replies?pid=${encodeURIComponent(pid)}&entryId=${encodeURIComponent(entry.id)}`,
    { pollMs: 8000, keepDataOnError: true },
  );
  const replies = data?.replies ?? [];

  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setSendError(null);
    try {
      const r = await apiPost('/api/comms/logbook/replies', { pid, entryId: entry.id, body: t });
      if (!r.ok) { setSendError('The reply was not sent. Please try again.'); return; }
      setText(''); await load(); onReplied();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '22px 28px 60px' }}>
        <button onClick={onBack} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: T.dim, fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '4px 0' }}>
          <ArrowLeft size={15} /> {'Back to log'}
        </button>

        {/* Recap card */}
        <div style={{ border: `1px solid ${T.hair}`, borderRadius: 14, background: T.bg, padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <DeptDot dept={dept} size={7} />
            <MonoLabel style={{ fontSize: 10 }}>{catLabel(entry.category, L)}</MonoLabel>
            <span style={{ flex: 1 }} />
            <MonoLabel style={{ fontSize: 10 }}>{new Date(entry.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</MonoLabel>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 20, fontWeight: 700, color: T.ink, lineHeight: 1.25 }}>{entry.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <Avatar name={entry.authorName ?? 'Staff'} dept={dept} size={26} />
            <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: T.ink }}>{entry.authorName ?? 'Staff'}</span>
          </div>
          {entry.body && <div style={{ fontFamily: SANS, fontSize: 14.5, color: T.ink, lineHeight: 1.6, marginTop: 14, whiteSpace: 'pre-wrap' }}>{entry.body}</div>}
        </div>

        {/* Replies */}
        <div style={{ marginTop: 22 }}>
          <MonoLabel>{data ? (replies.length === 1 ? '1 reply' : `${replies.length} replies`) : (loading ? 'Loading replies' : 'Replies unavailable')}</MonoLabel>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && !data && <div role="status" style={{ color: T.dim, fontFamily: SANS, fontSize: 12.5 }}>{'Loading replies…'}</div>}
          {loadError && <div role="alert" style={{ color: T.terracotta, fontFamily: SANS, fontSize: 12.5, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1 }}>{data ? 'Replies could not refresh. Showing the last results.' : 'Replies could not load.'}</span><button onClick={() => void load()} aria-label={'Retry loading replies'} style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: `1px solid ${T.hair}`, background: T.bg, color: T.terracotta, cursor: 'pointer' }}><RefreshCw size={14} /></button></div>}
          {replies.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10 }}>
              <Avatar name={r.authorName ?? 'Staff'} dept="management" size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 700, color: T.ink }}>{r.authorName ?? 'Staff'}</span>
                  <MonoLabel style={{ fontSize: 9.5 }}>{fmtClock(r.createdAt)}</MonoLabel>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.ink, lineHeight: 1.5, marginTop: 2, whiteSpace: 'pre-wrap' }}>{r.body}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Reply composer */}
        {sendError && <div role="alert" style={{ marginTop: 14, color: T.terracotta, fontFamily: SANS, fontSize: 12.5 }}>{sendError}</div>}
        <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <Avatar name={meName} dept="management" size={28} me />
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={'Reply to this recap…'} rows={1}
            style={{ flex: 1, border: `1px solid ${T.hair}`, borderRadius: 12, background: T.paper, resize: 'vertical', fontFamily: SANS, fontSize: 14, color: T.ink, lineHeight: 1.5, padding: '10px 12px', outline: 'none', minHeight: 44 }} />
          <button onClick={send} disabled={!text.trim() || busy} title={'Send reply'} style={{ width: 44, height: 44, borderRadius: 10, border: 'none', cursor: text.trim() ? 'pointer' : 'default', background: text.trim() ? T.ink : T.hairSoft, color: text.trim() ? '#fff' : T.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {busy ? <Loader2 size={16} className="comms-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
