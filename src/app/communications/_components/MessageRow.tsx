'use client';
/* eslint-disable @next/next/no-img-element -- chat photo attachments are short-lived signed URLs from a private bucket; next/image can't optimize them and would need per-URL domain config */
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — one message row: avatar/body/attachments,
// hover toolbar, ✓ reactions, and the require-ack announcement controls
// (recipient button + manager tracker + org-wide campaign panel). Extracted
// from MessagePane.tsx unchanged.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Check, CheckCheck, Loader2, AlertCircle, ShieldCheck, ChevronDown, ChevronRight,
  Building2, Pin, Reply, ListTodo,
} from 'lucide-react';
import { apiGet, apiPost } from '@/lib/comms/client';
import type { MessageDTO, AckStatusDTO, CampaignStatusDTO, CommsDept } from '@/lib/comms/types';
import type { L } from './comms-types-fe';
import { useCommsResource } from './comms-data';
import { T, SANS, MONO, deptColorDark, tint, Avatar, MonoLabel, renderInline, fmtClock } from './comms-ui';
import type { MessagePaneProps } from './MessagePane';

const hoverTool: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function firstName(n: string): string { return (n ?? '').trim().split(/\s+/)[0] ?? ''; }

export function MessageRow({ m, grouped, me, pid, L, conversation, onOpenThread, onReactToggle, onPinToggle, onTurnIntoTask, onReloadThread, onReloadBoot, activeThreadId }: MessagePaneProps & { m: MessageDTO; grouped: boolean }) {
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
            {renderInline(text)}
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
        <div style={{ position: 'absolute', top: -12, right: 16, display: 'flex', gap: 1, background: T.bg, border: `1px solid ${T.hair}`, borderRadius: 8, boxShadow: '0 4px 14px rgba(31,35,28,.1)', padding: 2 }}>
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
  const [campaign, setCampaign] = React.useState<CampaignStatusDTO | null>(null);
  const [showCampaign, setShowCampaign] = React.useState(false);

  // Open-driven loader: nothing fetches until the tracker is first expanded;
  // while open it polls every 5s (hidden-gated); closing stops the poll but
  // keeps the last status so reopening shows it instantly, then refreshes.
  const [everOpened, setEverOpened] = React.useState(false);
  const { data: status, reload } = useCommsResource<AckStatusDTO>(
    `/api/comms/acknowledge/status?pid=${encodeURIComponent(pid)}&messageId=${encodeURIComponent(m.id)}`,
    { enabled: everOpened, pollMs: open ? 5000 : undefined, keepDataOnError: true },
  );
  const openedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) return;
    if (!openedRef.current) { openedRef.current = true; setEverOpened(true); return; }
    void reload();
  }, [open, reload]);

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
