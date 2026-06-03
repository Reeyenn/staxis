'use client';
/* eslint-disable @next/next/no-img-element -- chat photo attachments are short-lived signed URLs from a private bucket; next/image can't optimize them and would need per-URL domain config */
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — the centre message pane + composer, plus the
// on-demand right panels (Thread / Pinned / Members). All reads/writes go
// through /api/comms/* via the client. NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Send, Mic, Square, Image as ImageIcon, Megaphone, Users, MessageSquare, Sparkles,
  Check, CheckCheck, X, Loader2, Wrench, AlertCircle, ShieldCheck, ChevronDown, ChevronRight,
  Building2, Pin, Reply, ListTodo, Paperclip, Bold, Italic, Strikethrough, AtSign,
  ClipboardList, Search, ArrowRight,
} from 'lucide-react';
import { apiGet, apiPost, uploadToSignedUrl } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO, StaffLite, MemberDTO, AckStatusDTO, CampaignStatusDTO, CommsDept } from '@/lib/comms/types';
import type { Me, L, RightPanel } from './comms-types-fe';
import {
  T, SANS, MONO, deptColor, deptColorDark, tint, Avatar, DeptDot, MonoLabel,
  fmtClock, fmtDayLabel, dayKey, paneIcon, slideInNode, popNode,
} from './comms-ui';

const hoverTool: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const fmtBtn: React.CSSProperties = { minWidth: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', fontFamily: SANS, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };

function currentShift(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'night';
}
function firstName(n: string): string { return (n ?? '').trim().split(/\s+/)[0] ?? ''; }

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
// ONE MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
function MessageRow({ m, grouped, me, pid, L, conversation, onOpenThread, onReactToggle, onPinToggle, onTurnIntoTask, onReloadThread, onReloadBoot, activeThreadId }: MessagePaneProps & { m: MessageDTO; grouped: boolean }) {
  const [hover, setHover] = React.useState(false);
  const [showOriginal, setShowOriginal] = React.useState(false);
  const isStaxis = m.senderKind === 'staxis';
  const isSystem = m.senderKind === 'system';
  const dept = (isStaxis ? 'management' : conversation.dept) as CommsDept;
  const active = activeThreadId === m.id;

  if (isSystem) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 20px' }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.04em', color: T.dim, background: T.paper, border: `1px solid ${T.hair}`, borderRadius: 6, padding: '3px 10px' }}>{m.body}</span>
      </div>
    );
  }

  const fn = firstName(me.displayName);
  const mentionsMe = !!fn && new RegExp(`@${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(m.originalBody);
  const text = showOriginal ? m.originalBody : m.body;

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'flex', gap: 10, padding: grouped ? '1px 20px' : '5px 20px', background: hover ? T.paper : (active ? tint(T.forest, .05) : 'transparent') }}>
      <div style={{ width: 36, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {grouped
          ? <span style={{ fontFamily: MONO, fontSize: 9, color: T.dim, marginTop: 4, opacity: hover ? 1 : 0 }}>{fmtClock(m.createdAt).replace(/[ap]$/, '')}</span>
          : <Avatar name={isStaxis ? 'Staxis' : m.senderName} dept={dept} size={36} me={m.mine} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: grouped ? 0 : 1 }}>
        {!grouped && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 1 }}>
            <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 14, color: isStaxis ? deptColorDark(T.forest) : T.ink, whiteSpace: 'nowrap' }}>{m.mine ? L('You', 'Tú') : (isStaxis ? 'Staxis' : m.senderName)}</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim }}>{fmtClock(m.createdAt)}</span>
            {m.handoffShift && <MonoLabel color={deptColorDark(T.forest)} style={{ fontSize: 9 }}>{L('hand-off', 'relevo')} · {m.handoffShift}</MonoLabel>}
          </div>
        )}

        {/* attachments */}
        {m.attachmentKind === 'photo' && m.attachmentUrl && (
          <img src={m.attachmentUrl} alt="" style={{ maxWidth: 320, maxHeight: 260, borderRadius: 10, border: `1px solid ${T.hair}`, marginTop: 2, marginBottom: text ? 6 : 0, display: 'block' }} />
        )}
        {m.attachmentKind === 'voice' && (
          <div style={{ marginTop: 2, marginBottom: text ? 6 : 0 }}>
            {m.attachmentUrl
              ? <audio controls src={m.attachmentUrl} style={{ height: 36, maxWidth: 280 }} />
              : <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim }}>🎤 {L('Voice message', 'Mensaje de voz')}</span>}
          </div>
        )}

        {text && (
          <div style={{ fontFamily: SANS, fontSize: 14.5, lineHeight: 1.5, color: T.ink, wordBreak: 'break-word' }}>
            {text}
            {mentionsMe && <span style={{ background: tint(T.teal, .14), color: deptColorDark(T.teal), borderRadius: 4, padding: '0 4px', marginLeft: 4, fontWeight: 600, fontSize: 13 }}>@{L('you', 'tú')}</span>}
          </div>
        )}

        {/* translation toggle + receipts */}
        <div style={{ display: 'flex', gap: 10, marginTop: 3, alignItems: 'center', flexWrap: 'wrap' }}>
          {m.wasTranslated && (
            <button onClick={() => setShowOriginal((v) => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: T.dim, padding: 0, fontFamily: SANS }}>
              {showOriginal ? L('see translation', 'ver traducción') : L('see original', 'ver original')}
            </button>
          )}
          {m.mine && m.seenBy && m.seenBy.length > 0 && (
            <span style={{ fontSize: 11, color: deptColorDark(T.forest), display: 'flex', alignItems: 'center', gap: 2, fontFamily: SANS }} title={m.seenBy.map((s) => s.name).join(', ')}>
              <CheckCheck size={12} /> {m.seenBy.length}
            </span>
          )}
        </div>

        {/* ✓ acknowledgement reactions */}
        {((m.ackCount ?? 0) > 0 || hover) && !isSystem && (
          <Reactions count={m.ackCount ?? 0} mine={!!m.ackedByMe} onToggle={() => onReactToggle(m)} L={L} />
        )}

        {/* require-ack announcement controls */}
        {m.requiresAck && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {m.mustAck && !m.acked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, background: tint(T.terracotta, .12), color: T.terracotta, borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 700, fontFamily: SANS }}><AlertCircle size={12} /> {L('Action required', 'Acción requerida')}</span>
                <AckButton pid={pid} m={m} onChanged={async () => { await onReloadThread(); await onReloadBoot(); }} L={L} />
              </div>
            )}
            {!m.mine && m.acked && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: deptColorDark(T.forest), fontWeight: 600, fontFamily: SANS }}><ShieldCheck size={13} /> {L('Acknowledged', 'Confirmado')}</span>
            )}
            {(m.mine || me.isManager) && <AckTracker pid={pid} m={m} L={L} />}
          </div>
        )}

        {/* thread indicator */}
        {(m.replyCount ?? 0) > 0 && (
          <button onClick={() => onOpenThread(m)} style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '4px 10px 4px 6px', borderRadius: 16,
            border: `1px solid ${active ? tint(T.teal, .4) : T.hair}`, background: active ? tint(T.teal, .08) : T.bg, cursor: 'pointer',
          }}>
            <div style={{ display: 'flex' }}>{(m.replyAuthorIds ?? []).slice(0, 3).map((id, i) => (
              <div key={id} style={{ marginLeft: i ? -6 : 0, border: `1.5px solid ${T.bg}`, borderRadius: '50%' }}><Avatar name={id} dept={conversation.dept} size={18} /></div>
            ))}</div>
            <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: deptColorDark(T.teal) }}>{m.replyCount === 1 ? L('1 reply', '1 respuesta') : L(`${m.replyCount} replies`, `${m.replyCount} respuestas`)}</span>
            {m.lastReplyAt && <span style={{ fontFamily: SANS, fontSize: 11.5, color: T.dim }}>{L('Last reply', 'Última')} {fmtClock(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>

      {/* hover toolbar */}
      {hover && (
        <div style={{ position: 'absolute', top: -12, right: 16, display: 'flex', gap: 1, background: T.bg, border: `1px solid ${T.hair}`, borderRadius: 8, boxShadow: '0 4px 14px rgba(24,22,17,.1)', padding: 2 }}>
          <button style={hoverTool} title={L('Acknowledge', 'Confirmar')} onClick={() => onReactToggle(m)}><Check size={16} color={m.ackedByMe ? deptColorDark(T.forest) : T.dim} /></button>
          {conversation.kind !== 'dm' && <button style={hoverTool} title={L('Reply in thread', 'Responder en hilo')} onClick={() => onOpenThread(m)}><Reply size={16} /></button>}
          <button style={hoverTool} title={m.pinned ? L('Unpin', 'Quitar fijado') : L('Pin', 'Fijar')} onClick={() => onPinToggle(m)}><Pin size={15} color={m.pinned ? deptColorDark(T.forest) : T.dim} /></button>
          <button style={hoverTool} title={L('Turn into task', 'Convertir en tarea')} onClick={() => onTurnIntoTask(m)}><ListTodo size={16} /></button>
        </div>
      )}
    </div>
  );
}

function Reactions({ count, mine, onToggle, L }: { count: number; mine: boolean; onToggle: () => void; L: L }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
      <button onClick={onToggle} title={L('Acknowledge', 'Confirmar')} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px 2px 7px', borderRadius: 13, cursor: 'pointer',
        border: `1px solid ${mine ? tint(T.forest, .45) : T.hair}`, background: mine ? tint(T.forest, .12) : T.paper, color: mine ? deptColorDark(T.forest) : T.ink,
      }}>
        <Check size={13} strokeWidth={2.4} />
        {count > 0 && <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600 }}>{count}</span>}
      </button>
    </div>
  );
}

// ── Announcement acknowledgement (recipient button + manager tracker) ────────
function AckButton({ pid, m, onChanged, L }: { pid: string; m: MessageDTO; onChanged: () => void | Promise<void>; L: L }) {
  const [busy, setBusy] = React.useState(false);
  const ack = async () => {
    if (busy) return;
    setBusy(true);
    try { await apiPost('/api/comms/acknowledge', { pid, messageId: m.id }); await onChanged(); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={ack} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 6, background: deptColorDark(T.forest), color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: SANS, opacity: busy ? 0.6 : 1 }}>
      {busy ? <Loader2 size={13} className="comms-spin" /> : <ShieldCheck size={13} />} {L('I read & understand', 'Leí y entiendo')}
    </button>
  );
}

function AckTracker({ pid, m, L }: { pid: string; m: MessageDTO; L: L }) {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<AckStatusDTO | null>(null);
  const [campaign, setCampaign] = React.useState<CampaignStatusDTO | null>(null);
  const [showCampaign, setShowCampaign] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await apiGet<AckStatusDTO>(`/api/comms/acknowledge/status?pid=${encodeURIComponent(pid)}&messageId=${encodeURIComponent(m.id)}`);
    if (r.ok && r.data) setStatus(r.data);
  }, [pid, m.id]);

  React.useEffect(() => {
    if (!open) return;
    void load();
    const iv = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(iv);
  }, [open, load]);

  const loadCampaign = async () => {
    if (!m.ackCampaignId) return;
    const r = await apiGet<CampaignStatusDTO>(`/api/comms/acknowledge/campaign?pid=${encodeURIComponent(pid)}&campaignId=${encodeURIComponent(m.ackCampaignId)}`);
    if (r.ok && r.data) { setCampaign(r.data); setShowCampaign(true); }
  };

  const total = status?.total ?? 0;
  const acked = status?.acked ?? 0;
  const pct = total ? Math.round((acked / total) * 100) : 0;
  return (
    <div style={{ width: '100%', maxWidth: 300 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: T.dim, padding: 0, fontFamily: SANS }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ShieldCheck size={13} color={deptColorDark(T.forest)} />
        {status ? L(`${acked} of ${total} acknowledged`, `${acked} de ${total} confirmaron`) : L('Acknowledgement tracker', 'Seguimiento de confirmación')}
      </button>
      {open && status && (
        <div style={{ marginTop: 6, padding: 10, background: T.forestTint, borderRadius: 10, fontSize: 12, color: T.ink, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 6, background: T.hairSoft, borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: deptColorDark(T.forest) }} />
          </div>
          {status.pending.length > 0
            ? <div><strong>{L('Waiting on', 'Falta')}:</strong> {status.pending.map((p) => p.name).join(', ')}</div>
            : <div style={{ color: deptColorDark(T.forest), fontWeight: 600 }}>{L('Everyone has acknowledged', 'Todos confirmaron')}</div>}
          {m.ackCampaignId && !showCampaign && (
            <button onClick={loadCampaign} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: deptColorDark(T.forest), padding: '2px 0', fontFamily: SANS }}>
              <Building2 size={12} /> {L('View all-property completion', 'Ver avance de todas las propiedades')}
            </button>
          )}
          {showCampaign && campaign && <CampaignPanel campaign={campaign} L={L} />}
        </div>
      )}
    </div>
  );
}

function CampaignPanel({ campaign, L }: { campaign: CampaignStatusDTO; L: L }) {
  const pct = campaign.total ? Math.round((campaign.acked / campaign.total) * 100) : 0;
  return (
    <div style={{ marginTop: 4, padding: 8, background: T.bg, border: `1px solid ${T.hairSoft}`, borderRadius: 8 }}>
      <div style={{ fontWeight: 700, color: deptColorDark(T.forest), marginBottom: 5, fontSize: 12, fontFamily: SANS }}>
        {L(`${campaign.acked} of ${campaign.total} · ${campaign.properties.length} properties · ${pct}%`, `${campaign.acked} de ${campaign.total} · ${campaign.properties.length} propiedades · ${pct}%`)}
      </div>
      {campaign.properties.map((p) => (
        <div key={p.propertyId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: T.dim, padding: '2px 0', fontFamily: SANS }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.propertyName}</span>
          <span style={{ flexShrink: 0, color: p.acked >= p.total ? deptColorDark(T.forest) : T.dim }}>{p.acked}/{p.total}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSER (full: text · voice · photo · AI polish · handoff · announcement)
// ─────────────────────────────────────────────────────────────────────────────
function Composer({ pid, me, conversation: c, L, onReloadThread, onReloadBoot }: MessagePaneProps) {
  const isAnnouncement = c.kind === 'announcement';
  const canPostAnnouncement = isAnnouncement && me.isManager;
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [requireAck, setRequireAck] = React.useState(false);
  const [orgWide, setOrgWide] = React.useState(false);
  const [handoffMode, setHandoffMode] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actionOffer, setActionOffer] = React.useState<null | { kind: 'work_order' | 'complaint'; description: string; roomNumber: string | null; severity: string | null }>(null);
  const [orgNotice, setOrgNotice] = React.useState<null | { postedCount: number; propertyCount: number; failedCount: number }>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const recStartRef = React.useRef(0);
  const sendBtn = React.useRef<HTMLButtonElement | null>(null);

  const reload = async () => { await onReloadThread(); await onReloadBoot(); };

  const doSend = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setError(null);
    try {
      if (canPostAnnouncement) {
        const effOrgWide = orgWide && !!me.canOrgWide;
        const r = await apiPost<{ orgWide?: boolean; postedCount?: number; propertyCount?: number; failedCount?: number }>(
          '/api/comms/announce', { pid, body, requiresAck: requireAck || effOrgWide, orgWide: effOrgWide },
        );
        if (!r.ok) {
          setError(r.status === 429
            ? L('Too many posts right now — wait a minute and try again.', 'Demasiadas publicaciones — espera un minuto e inténtalo de nuevo.')
            : L('Could not post the announcement. Please try again.', 'No se pudo publicar el anuncio. Inténtalo de nuevo.'));
          return;
        }
        if (effOrgWide && r.data?.orgWide) setOrgNotice({ postedCount: r.data.postedCount ?? 0, propertyCount: r.data.propertyCount ?? 0, failedCount: r.data.failedCount ?? 0 });
        setRequireAck(false); setOrgWide(false);
      } else if (handoffMode) {
        await apiPost('/api/comms/send', { pid, conversationId: c.id, body, msgType: 'handoff', handoffShift: currentShift(), handoffOutstanding: body });
      } else {
        await apiPost('/api/comms/send', { pid, conversationId: c.id, body });
        if (/@staxis/i.test(body)) {
          const q = body.replace(/@staxis/ig, '').trim() || body;
          await apiPost('/api/comms/assistant', { pid, conversationId: c.id, question: q });
        } else {
          const det = await apiPost<{ action: { kind: string; description: string | null; roomNumber: string | null; severity: string | null } }>('/api/comms/detect-action', { pid, text: body });
          const a = det.data?.action;
          if (a && (a.kind === 'work_order' || a.kind === 'complaint')) setActionOffer({ kind: a.kind, description: a.description ?? body, roomNumber: a.roomNumber, severity: a.severity });
        }
      }
      setText(''); setHandoffMode(false);
      await reload();
    } finally { setBusy(false); }
  };

  const doAction = async () => {
    if (!actionOffer) return;
    setBusy(true);
    try {
      await apiPost('/api/comms/action', { pid, conversationId: c.id, kind: actionOffer.kind, description: actionOffer.description, roomNumber: actionOffer.roomNumber, severity: actionOffer.severity });
      setActionOffer(null); await onReloadThread();
    } finally { setBusy(false); }
  };

  const polish = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { const r = await apiPost<{ text: string }>('/api/comms/polish', { pid, text }); if (r.data?.text) setText(r.data.text); }
    finally { setBusy(false); }
  };

  // voice
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void finishVoice(); };
      recorderRef.current = rec; recStartRef.current = Date.now(); rec.start(); setRecording(true);
    } catch { /* mic denied */ }
  };
  const stopRec = () => { recorderRef.current?.stop(); setRecording(false); };
  const finishVoice = async () => {
    const durMs = Date.now() - recStartRef.current;
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (blob.size === 0) return;
    setBusy(true);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: c.id, kind: 'voice', filename: 'voice.webm' });
      if (!pre.data) return;
      if (!(await uploadToSignedUrl(pre.data.signedUrl, blob))) return;
      const tr = await apiPost<{ text: string }>('/api/comms/transcribe', { pid, path: pre.data.path });
      await apiPost('/api/comms/send', { pid, conversationId: c.id, body: tr.data?.text ?? '', msgType: 'voice', attachmentPath: pre.data.path, attachmentKind: 'voice', voiceDurationMs: durMs });
      await reload();
    } finally { setBusy(false); }
  };

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: c.id, kind: 'photo', filename: file.name });
      if (!pre.data) return;
      if (!(await uploadToSignedUrl(pre.data.signedUrl, file))) return;
      await apiPost('/api/comms/send', { pid, conversationId: c.id, body: '', msgType: 'photo', attachmentPath: pre.data.path, attachmentKind: 'photo' });
      await reload();
    } finally { setBusy(false); }
  };

  const canSend = !!text.trim() && !busy;
  return (
    <div style={{ padding: '0 20px 16px' }}>
      {actionOffer && (
        <div style={{ margin: '0 0 8px', padding: 12, background: tint(T.terracotta, .08), borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontFamily: SANS }}>
          {actionOffer.kind === 'work_order' ? <Wrench size={16} color={T.terracotta} /> : <AlertCircle size={16} color={T.terracotta} />}
          <span style={{ flex: 1 }}>{actionOffer.kind === 'work_order' ? L('Looks like a maintenance issue.', 'Parece un problema de mantenimiento.') : L('Looks like a guest complaint.', 'Parece una queja de huésped.')}</span>
          <button onClick={doAction} disabled={busy} style={{ background: T.terracotta, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, cursor: 'pointer' }}>{actionOffer.kind === 'work_order' ? L('Create work order', 'Crear orden') : L('Log complaint', 'Registrar queja')}</button>
          <button onClick={() => setActionOffer(null)} style={paneIcon}><X size={14} /></button>
        </div>
      )}
      {orgNotice && (
        <div style={{ margin: '0 0 8px', padding: 12, background: T.forestTint, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontFamily: SANS }}>
          <Building2 size={16} color={deptColorDark(T.forest)} />
          <span style={{ flex: 1 }}>{L(`Mandatory read posted to ${orgNotice.postedCount} of ${orgNotice.propertyCount} properties.`, `Lectura obligatoria enviada a ${orgNotice.postedCount} de ${orgNotice.propertyCount} propiedades.`)}{orgNotice.failedCount > 0 ? ' ' + L(`(${orgNotice.failedCount} failed)`, `(${orgNotice.failedCount} fallaron)`) : ''}</span>
          <button onClick={() => setOrgNotice(null)} style={paneIcon}><X size={14} /></button>
        </div>
      )}

      {canPostAnnouncement && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: (requireAck || orgWide) ? 700 : 500, color: (requireAck || orgWide) ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
            <input type="checkbox" checked={requireAck || orgWide} disabled={orgWide} onChange={(e) => setRequireAck(e.target.checked)} style={{ accentColor: T.forestDeep }} />
            <ShieldCheck size={14} /> {L('Require acknowledgement', 'Requerir confirmación')}
          </label>
          {me.canOrgWide && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: orgWide ? 700 : 500, color: orgWide ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
              <input type="checkbox" checked={orgWide} onChange={(e) => setOrgWide(e.target.checked)} style={{ accentColor: T.forestDeep }} />
              <Building2 size={14} /> {L('Send to all my properties', 'Enviar a todas mis propiedades')}
            </label>
          )}
        </div>
      )}
      {handoffMode && <div style={{ fontSize: 11, color: deptColorDark(T.forest), marginBottom: 6, fontWeight: 600, fontFamily: SANS }}>{L('Shift hand-off post', 'Publicación de relevo')} · {currentShift()}</div>}

      <div style={{ border: `1px solid ${T.hairer}`, borderRadius: 11, overflow: 'hidden', background: T.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <button style={{ ...fmtBtn, fontWeight: 700 }} onClick={() => setText((t) => t + '**bold**')} title={L('Bold', 'Negrita')}><Bold size={14} /></button>
          <button style={{ ...fmtBtn, fontStyle: 'italic' }} onClick={() => setText((t) => t + '_italic_')} title={L('Italic', 'Cursiva')}><Italic size={14} /></button>
          <button style={fmtBtn} title={L('Strikethrough', 'Tachado')} onClick={() => setText((t) => t + '~~text~~')}><Strikethrough size={14} /></button>
          <span style={{ width: 1, height: 16, background: T.hair, margin: '0 4px' }} />
          {!isAnnouncement && <button style={fmtBtn} onClick={() => setText((t) => (t ? t + ' @' : '@'))} title={L('Mention', 'Mencionar')}><AtSign size={15} /></button>}
          {canPostAnnouncement && <button style={fmtBtn} onClick={polish} title={L('AI polish', 'Pulir con IA')}><Sparkles size={15} color={deptColorDark(T.forest)} /></button>}
          {!isAnnouncement && <>
            <button style={{ ...fmtBtn, color: recording ? T.terracotta : T.dim }} onClick={recording ? stopRec : startRec} title={L('Voice message', 'Mensaje de voz')}>{recording ? <Square size={15} /> : <Mic size={15} />}</button>
            <label style={{ ...fmtBtn, cursor: 'pointer' }} title={L('Photo', 'Foto')}><ImageIcon size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <label style={{ ...fmtBtn, cursor: 'pointer', position: 'relative' }} title={L('Attach a file', 'Adjuntar archivo')}><Paperclip size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <button style={{ ...fmtBtn, color: handoffMode ? deptColorDark(T.forest) : T.dim }} onClick={() => setHandoffMode((v) => !v)} title={L('Hand-off post', 'Relevo')}><ClipboardList size={15} /></button>
          </>}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '8px 8px 8px 12px' }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); popNode(sendBtn.current); void doSend(); } }}
            placeholder={isAnnouncement ? L('Write an announcement… (try AI polish)', 'Escribe un anuncio… (prueba pulir con IA)') : L('Message…  (type @Staxis to ask the assistant)', 'Mensaje…  (escribe @Staxis para el asistente)')}
            style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 14, lineHeight: 1.5, color: T.ink, padding: '4px 0', maxHeight: 120 }} />
          <button ref={sendBtn} onClick={() => { popNode(sendBtn.current); void doSend(); }} disabled={!canSend} aria-label={L('Send', 'Enviar')}
            style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: canSend ? 'pointer' : 'default', background: canSend ? T.forest : T.hairSoft, color: canSend ? '#fff' : T.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {busy ? <Loader2 size={15} className="comms-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
      {recording && <div style={{ fontSize: 12, color: T.terracotta, marginTop: 6, fontFamily: SANS }}>● {L('Recording… tap stop to send', 'Grabando… toca detener para enviar')}</div>}
      {error && <div style={{ fontSize: 12, color: T.terracotta, marginTop: 6, fontFamily: SANS }}>{error}</div>}
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
  const [replies, setReplies] = React.useState<MessageDTO[]>([]);
  const [parentMsg, setParentMsg] = React.useState<MessageDTO>(parent);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ parent: MessageDTO | null; replies: MessageDTO[] }>(`/api/comms/thread?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}&parentId=${encodeURIComponent(parent.id)}`);
    if (r.ok && r.data) { setReplies(r.data.replies); if (r.data.parent) setParentMsg(r.data.parent); }
  }, [pid, c.id, parent.id]);

  React.useEffect(() => { slideInNode(ref.current); }, []);
  React.useEffect(() => { void load(); const iv = setInterval(() => { if (!document.hidden) void load(); }, 4000); return () => clearInterval(iv); }, [load]);

  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try { await apiPost('/api/comms/send', { pid, conversationId: c.id, body, parentMessageId: parent.id }); setText(''); await load(); await onReload(); }
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
        {m.body && <div style={{ fontFamily: SANS, fontSize: 14, lineHeight: 1.5, color: T.ink, wordBreak: 'break-word', marginTop: 1 }}>{m.body}</div>}
      </div>
    </div>
  );
}

export function PinnedPanel({ pid, conversation: c, L, onClose }: { pid: string; conversation: ConversationDTO; L: L; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [pins, setPins] = React.useState<MessageDTO[]>([]);
  React.useEffect(() => { slideInNode(ref.current); }, []);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const r = await apiGet<{ pinned: MessageDTO[] }>(`/api/comms/pin?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}`);
      if (live && r.ok && r.data) setPins(r.data.pinned);
    })();
    return () => { live = false; };
  }, [pid, c.id]);
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
            <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5, color: T.ink, wordBreak: 'break-word' }}>{m.body || (m.attachmentKind === 'photo' ? L('Photo', 'Foto') : m.attachmentKind === 'voice' ? L('Voice message', 'Mensaje de voz') : '')}</div>
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
  const [members, setMembers] = React.useState<MemberDTO[]>([]);
  React.useEffect(() => { slideInNode(ref.current); }, []);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const r = await apiGet<{ members: MemberDTO[]; memberCount: number }>(`/api/comms/members?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(c.id)}`);
      if (live && r.ok && r.data) setMembers(r.data.members);
    })();
    return () => { live = false; };
  }, [pid, c.id]);
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
