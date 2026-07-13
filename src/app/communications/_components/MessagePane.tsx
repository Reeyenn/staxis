'use client';
/* eslint-disable @next/next/no-img-element -- chat photo attachments are short-lived signed URLs from a private bucket; next/image can't optimize them and would need per-URL domain config */
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — the centre message pane, plus the on-demand
// right panels (Thread / Pinned / Members). The row and the composer live in
// MessageRow.tsx / Composer.tsx. All reads/writes go through /api/comms/* via
// the client. NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Send, Megaphone, Users, MessageSquare, X, Loader2, Pin, Search } from 'lucide-react';
import { apiPost } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO, MemberDTO, CommsDept } from '@/lib/comms/types';
import type { Me, L, RightPanel } from './comms-types-fe';
import { useCommsResource } from './comms-data';
import {
  T, SANS, MONO, deptColor, deptColorDark, Avatar, DeptDot, MonoLabel, renderInline,
  fmtClock, fmtDayLabel, dayKey, paneIcon, slideInNode,
} from './comms-ui';
import { MessageRow } from './MessageRow';
import { Composer } from './Composer';

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE PANE
// ─────────────────────────────────────────────────────────────────────────────
export interface MessagePaneProps {
  pid: string;
  me: Me;
  conversation: ConversationDTO;
  messages: MessageDTO[];
  online: Set<string>;
  memberCount: number | null;
  L: L;
  activeThreadId: string | null;
  activePanel: RightPanel;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onReloadThread: () => void | Promise<void>;
  onReloadBoot: () => void | Promise<void>;
  onOpenThread: (m: MessageDTO) => void;
  onTogglePanel: (p: Exclude<RightPanel, null>) => void;
  onReactToggle: (m: MessageDTO) => void;
  onPinToggle: (m: MessageDTO) => void;
  onTurnIntoTask: (m: MessageDTO) => void;
  onOpenSearch: () => void;
}

export function MessagePane(props: MessagePaneProps) {
  const { conversation: c, me, L, messages, memberCount } = props;
  const isAnnouncement = c.kind === 'announcement';
  const canPost = !isAnnouncement || me.isManager;
  const headerSub = c.kind === 'dm'
    ? L('Direct message', 'Mensaje directo')
    : `${memberCount ?? c.memberCount ?? ''}${memberCount != null || c.memberCount != null ? L(' members', ' miembros') : ''}`.trim();

  // Pre-compute which messages start a new day (so render stays pure).
  const dayBreaks = new Set<string>();
  let walkDay = '';
  for (const m of messages) {
    const dk = dayKey(m.createdAt);
    if (dk !== walkDay) { dayBreaks.add(m.id); walkDay = dk; }
  }
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: T.bg }}>
      {/* Header */}
      <div style={{ padding: '0 18px', height: 56, borderBottom: `1px solid ${T.hair}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ display: 'flex', color: deptColor(c.dept) }}>
          {c.kind === 'dm' ? <Avatar name={c.title} dept={c.dept} size={26} />
            : isAnnouncement ? <Megaphone size={18} />
            : <span style={{ fontFamily: SANS, fontSize: 18, color: T.ink, fontWeight: 600 }}>#</span>}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15.5, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</div>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: T.dim, whiteSpace: 'nowrap' }}>
            {isAnnouncement ? (me.isManager ? L('Broadcast to everyone', 'Difusión a todos') : L('Read-only', 'Solo lectura')) : headerSub}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {c.kind !== 'dm' && (
          <button onClick={() => props.onTogglePanel('members')} title={L('Members', 'Miembros')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 7, border: 'none', background: props.activePanel === 'members' ? T.forestTint : 'transparent', color: props.activePanel === 'members' ? deptColorDark(T.forest) : T.dim, cursor: 'pointer', fontFamily: SANS, fontSize: 12.5 }}>
            <Users size={15} /><span style={{ fontWeight: 600 }}>{memberCount ?? c.memberCount ?? ''}</span>
          </button>
        )}
        <button onClick={props.onOpenSearch} title={L('Search', 'Buscar')} style={paneIcon}><Search size={17} /></button>
        <button onClick={() => props.onTogglePanel('pinned')} title={L('Pinned', 'Fijados')}
          style={{ ...paneIcon, color: props.activePanel === 'pinned' ? deptColorDark(T.forest) : T.dim, background: props.activePanel === 'pinned' ? T.forestTint : 'transparent' }}><Pin size={16} /></button>
      </div>

      {/* Messages */}
      <div ref={props.scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 0' }}>
        {messages.length === 0 && (
          <div style={{ color: T.dim, fontFamily: SANS, fontSize: 13.5, textAlign: 'center', marginTop: 48 }}>
            {L('No messages yet — say hello.', 'Sin mensajes aún — saluda.')}
          </div>
        )}
        {messages.map((m, i) => {
          const showDay = dayBreaks.has(m.id);
          const prev = messages[i - 1];
          const grouped = !!prev && !showDay
            && prev.senderStaffId === m.senderStaffId && m.senderKind !== 'system' && prev.senderKind !== 'system'
            && !m.requiresAck && !(prev.replyCount && prev.replyCount > 0)
            && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000);
          return (
            <React.Fragment key={m.id}>
              {showDay && <DayDivider label={fmtDayLabel(m.createdAt, L('Today', 'Hoy'), L('Yesterday', 'Ayer'))} />}
              <MessageRow {...props} m={m} grouped={grouped} />
            </React.Fragment>
          );
        })}
      </div>

      {/* Composer (or read-only notice) */}
      {canPost
        ? <Composer {...props} />
        : <div style={{ borderTop: `1px solid ${T.hair}`, padding: 16, fontSize: 12.5, color: T.dim, textAlign: 'center', fontFamily: SANS }}>
            {L('Only managers can post announcements.', 'Solo los gerentes pueden publicar anuncios.')}
          </div>}
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 20px 12px' }}>
      <div style={{ flex: 1, height: 1, background: T.hair }} />
      <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, color: T.ink, border: `1px solid ${T.hair}`, borderRadius: 12, padding: '3px 12px', background: T.bg }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: T.hair }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT PANELS — Thread · Pinned · Members
// ─────────────────────────────────────────────────────────────────────────────
export function ThreadPanel({ pid, conversation: c, parent, L, onClose, onReload }: {
  pid: string; conversation: ConversationDTO; parent: MessageDTO; L: L; onClose: () => void; onReload: () => void | Promise<void>;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const { data, reload } = useCommsResource<{ parent: MessageDTO | null; replies: MessageDTO[] }>(
    `/api/comms/thread?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}&parentId=${encodeURIComponent(parent.id)}`,
    { pollMs: 4000, keepDataOnError: true },
  );
  const replies = data?.replies ?? [];
  // Show the freshest non-null parent the server has sent; until the first
  // fetch lands (or across a thread switch) keep the last one — same as the
  // old setParentMsg-on-success state.
  const lastParentRef = React.useRef(parent);
  if (data?.parent) lastParentRef.current = data.parent;
  const parentMsg = lastParentRef.current;

  React.useEffect(() => { slideInNode(ref.current); }, []);

  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try { await apiPost('/api/comms/send', { pid, conversationId: c.id, body, parentMessageId: parent.id }); setText(''); await reload(); await onReload(); }
    finally { setBusy(false); }
  };

  return (
    <div ref={ref} style={{ width: 380, flexShrink: 0, borderLeft: `1px solid ${T.hair}`, display: 'flex', flexDirection: 'column', background: T.bg, height: '100%' }}>
      <div style={{ padding: '0 14px', height: 56, borderBottom: `1px solid ${T.hair}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: T.ink }}>{L('Thread', 'Hilo')}</span>
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.kind === 'dm' ? c.title : '#' + c.title}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={paneIcon}><X size={17} /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        <ThreadMessage m={parentMsg} dept={c.dept} L={L} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px' }}>
          <span style={{ fontFamily: SANS, fontSize: 12, color: T.dim }}>{replies.length === 1 ? L('1 reply', '1 respuesta') : L(`${replies.length} replies`, `${replies.length} respuestas`)}</span>
          <div style={{ flex: 1, height: 1, background: T.hair }} />
        </div>
        {replies.map((r) => <ThreadMessage key={r.id} m={r} dept={c.dept} L={L} />)}
      </div>
      <div style={{ padding: '0 14px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, border: `1px solid ${T.hairer}`, borderRadius: 11, padding: '6px 6px 6px 12px', background: T.bg }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder={L('Reply…', 'Responder…')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 14, lineHeight: 1.5, color: T.ink, padding: '4px 0', maxHeight: 120 }} />
          <button onClick={send} disabled={!text.trim() || busy} aria-label={L('Send', 'Enviar')} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: text.trim() ? 'pointer' : 'default', background: text.trim() ? T.forest : T.hairSoft, color: text.trim() ? '#fff' : T.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {busy ? <Loader2 size={14} className="comms-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function ThreadMessage({ m, dept, L }: { m: MessageDTO; dept?: CommsDept; L: L }) {
  const isStaxis = m.senderKind === 'staxis';
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 20px' }}>
      <Avatar name={isStaxis ? 'Staxis' : m.senderName} dept={(isStaxis ? 'management' : dept) as CommsDept} size={32} me={m.mine} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 13.5, color: isStaxis ? deptColorDark(T.forest) : T.ink }}>{m.mine ? L('You', 'Tú') : (isStaxis ? 'Staxis' : m.senderName)}</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim }}>{fmtClock(m.createdAt)}</span>
        </div>
        {m.attachmentKind === 'photo' && m.attachmentUrl && <img src={m.attachmentUrl} alt="" style={{ maxWidth: 260, borderRadius: 8, border: `1px solid ${T.hair}`, marginTop: 4, display: 'block' }} />}
        {m.attachmentKind === 'voice' && m.attachmentUrl && <audio controls src={m.attachmentUrl} style={{ height: 34, maxWidth: 240, marginTop: 4 }} />}
        {m.body && <div style={{ fontFamily: SANS, fontSize: 14, lineHeight: 1.5, color: T.ink, wordBreak: 'break-word', marginTop: 1 }}>{renderInline(m.body)}</div>}
      </div>
    </div>
  );
}

export function PinnedPanel({ pid, conversation: c, L, onClose }: { pid: string; conversation: ConversationDTO; L: L; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const { data } = useCommsResource<{ pinned: MessageDTO[] }>(
    `/api/comms/pin?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}`,
    { keepDataOnError: true },
  );
  const pins = data?.pinned ?? [];
  React.useEffect(() => { slideInNode(ref.current); }, []);
  return (
    <div ref={ref} style={{ width: 380, flexShrink: 0, borderLeft: `1px solid ${T.hair}`, display: 'flex', flexDirection: 'column', background: T.bg, height: '100%' }}>
      <div style={{ padding: '0 14px', height: 56, borderBottom: `1px solid ${T.hair}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Pin size={16} /><span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: T.ink }}>{L('Pinned', 'Fijados')}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: T.dim }}>{pins.length}</span>
        <div style={{ flex: 1 }} /><button onClick={onClose} style={paneIcon}><X size={17} /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pins.map((m) => (
          <div key={m.id} style={{ border: `1px solid ${T.hair}`, borderRadius: 11, padding: '12px 13px', background: T.bg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <Avatar name={m.senderName} dept={c.dept} size={22} me={m.mine} />
              <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 13, color: T.ink }}>{m.mine ? L('You', 'Tú') : m.senderName}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim }}>{fmtClock(m.createdAt)}</span>
            </div>
            {m.attachmentKind === 'photo' && m.attachmentUrl && <img src={m.attachmentUrl} alt="" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 6, display: 'block' }} />}
            <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5, color: T.ink, wordBreak: 'break-word' }}>{m.body ? renderInline(m.body) : (m.attachmentKind === 'photo' ? L('Photo', 'Foto') : m.attachmentKind === 'voice' ? L('Voice message', 'Mensaje de voz') : '')}</div>
          </div>
        ))}
        {pins.length === 0 && <div style={{ color: T.dim, fontFamily: SANS, fontSize: 13, textAlign: 'center', padding: 24 }}>{L('Nothing pinned in this channel yet.', 'Nada fijado en este canal aún.')}</div>}
      </div>
    </div>
  );
}

export function MembersPanel({ pid, conversation: c, online, L, onClose, onMessage }: {
  pid: string; conversation: ConversationDTO; online: Set<string>; L: L; onClose: () => void; onMessage: (staffId: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const { data } = useCommsResource<{ members: MemberDTO[]; memberCount: number }>(
    `/api/comms/members?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}`,
    { keepDataOnError: true },
  );
  const members = data?.members ?? [];
  React.useEffect(() => { slideInNode(ref.current); }, []);
  return (
    <div ref={ref} style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${T.hair}`, display: 'flex', flexDirection: 'column', background: T.bg, height: '100%' }}>
      <div style={{ padding: '0 14px', height: 56, borderBottom: `1px solid ${T.hair}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Users size={16} /><span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: T.ink }}>{L('Members', 'Miembros')}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: T.dim }}>{members.length}</span>
        <div style={{ flex: 1 }} /><button onClick={onClose} style={paneIcon}><X size={17} /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
        {members.map((p) => {
          const on = online.has(p.staffId) || p.onShift;
          return (
            <div key={p.staffId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9 }}>
              <span style={{ position: 'relative', display: 'flex' }}>
                <Avatar name={p.name} dept={p.dept} size={32} me={p.isMe} />
                <span style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: on ? T.forest : T.dim, border: `1.5px solid ${T.bg}` }} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 13.5, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.isMe ? L('You', 'Tú') : p.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><DeptDot dept={p.dept} size={6} /><MonoLabel style={{ fontSize: 9.5 }}>{p.department ?? L('staff', 'personal')}</MonoLabel></div>
              </div>
              {!p.isMe && <button onClick={() => onMessage(p.staffId)} title={L('Message', 'Mensaje')} style={{ ...paneIcon, width: 28, height: 28 }}><MessageSquare size={15} /></button>}
            </div>
          );
        })}
        {members.length === 0 && <div style={{ color: T.dim, fontFamily: SANS, fontSize: 13, textAlign: 'center', padding: 24 }}>{L('No members.', 'Sin miembros.')}</div>}
      </div>
    </div>
  );
}
