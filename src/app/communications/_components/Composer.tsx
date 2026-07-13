'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic — the composer (text · voice · photo ·
// @Staxis assistant · action detection · handoff · announcement + require-ack
// / org-wide controls). Extracted from MessagePane.tsx unchanged — the
// multi-step send sequences (send → assistant/detect-action → reload) are
// ported exactly.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Send, Mic, Square, Image as ImageIcon, X, Loader2, Wrench, AlertCircle, ShieldCheck,
  Building2, Paperclip, Bold, Italic, Strikethrough, AtSign, ClipboardList,
} from 'lucide-react';
import { apiPost, uploadToSignedUrl } from '@/lib/comms/client';
import { T, SANS, deptColorDark, tint, Tip, paneIcon, popNode } from './comms-ui';
import type { MessagePaneProps } from './MessagePane';

const fmtBtn: React.CSSProperties = { minWidth: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', fontFamily: SANS, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };

function currentShift(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'night';
}

export function Composer({ pid, me, conversation: c, L, onReloadThread, onReloadBoot }: MessagePaneProps) {
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
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Bold / italic / strike: wrap the current textarea selection in markdown
  // markers (or drop the markers at the cursor when nothing is selected).
  const wrap = (marker: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const sel = text.slice(start, end);
    setText(text.slice(0, start) + marker + sel + marker + text.slice(end));
    requestAnimationFrame(() => {
      const t = taRef.current; if (!t) return;
      t.focus();
      const a = start + marker.length;
      t.setSelectionRange(a, a + sel.length);
    });
  };
  const insertAt = (str: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + str + text.slice(end));
    requestAnimationFrame(() => {
      const t = taRef.current; if (!t) return;
      t.focus();
      const p = start + str.length;
      t.setSelectionRange(p, p);
    });
  };

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
          <Tip width={252} text={L(
            'Everyone has to tap “I read & understand.” It stays marked unread for them until they do — and you’ll see exactly who has and hasn’t.',
            'Todos deben tocar “Leí y entiendo”. Sigue como no leído hasta que lo hagan — y verás exactamente quién lo leyó y quién no.')}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: (requireAck || orgWide) ? 700 : 500, color: (requireAck || orgWide) ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
              <input type="checkbox" checked={requireAck || orgWide} disabled={orgWide} onChange={(e) => setRequireAck(e.target.checked)} style={{ accentColor: T.forestDeep }} />
              <ShieldCheck size={14} /> {L('Require acknowledgement', 'Requerir confirmación')}
            </label>
          </Tip>
          {me.canOrgWide && (
            <Tip width={252} text={L(
              'Posts this to every property you manage, and everyone at each one has to acknowledge it.',
              'Lo publica en todas las propiedades que gestionas, y todos en cada una deben confirmarlo.')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: orgWide ? 700 : 500, color: orgWide ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
                <input type="checkbox" checked={orgWide} onChange={(e) => setOrgWide(e.target.checked)} style={{ accentColor: T.forestDeep }} />
                <Building2 size={14} /> {L('Send to all my properties', 'Enviar a todas mis propiedades')}
              </label>
            </Tip>
          )}
        </div>
      )}
      {handoffMode && <div style={{ fontSize: 11, color: deptColorDark(T.forest), marginBottom: 6, fontWeight: 600, fontFamily: SANS }}>{L('Shift hand-off post', 'Publicación de relevo')} · {currentShift()}</div>}

      <div style={{ border: `1px solid ${T.hairer}`, borderRadius: 11, overflow: 'hidden', background: T.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <button style={{ ...fmtBtn, fontWeight: 700 }} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('**')} title={L('Bold', 'Negrita')}><Bold size={14} /></button>
          <button style={{ ...fmtBtn, fontStyle: 'italic' }} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('*')} title={L('Italic', 'Cursiva')}><Italic size={14} /></button>
          <button style={fmtBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('~~')} title={L('Strikethrough', 'Tachado')}><Strikethrough size={14} /></button>
          {!isAnnouncement && <span style={{ width: 1, height: 16, background: T.hair, margin: '0 4px' }} />}
          {!isAnnouncement && <button style={fmtBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAt('@')} title={L('Mention', 'Mencionar')}><AtSign size={15} /></button>}
          {!isAnnouncement && <>
            <button style={{ ...fmtBtn, color: recording ? T.terracotta : T.dim }} onClick={recording ? stopRec : startRec} title={L('Voice message', 'Mensaje de voz')}>{recording ? <Square size={15} /> : <Mic size={15} />}</button>
            <label style={{ ...fmtBtn, cursor: 'pointer' }} title={L('Photo', 'Foto')}><ImageIcon size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <label style={{ ...fmtBtn, cursor: 'pointer', position: 'relative' }} title={L('Attach a file', 'Adjuntar archivo')}><Paperclip size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <button style={{ ...fmtBtn, color: handoffMode ? deptColorDark(T.forest) : T.dim }} onClick={() => setHandoffMode((v) => !v)} title={L('Hand-off post', 'Relevo')}><ClipboardList size={15} /></button>
          </>}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '8px 8px 8px 12px' }}>
          <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); popNode(sendBtn.current); void doSend(); } }}
            placeholder={isAnnouncement ? L('Write an announcement…', 'Escribe un anuncio…') : L('Message…  (type @Staxis to ask the assistant)', 'Mensaje…  (escribe @Staxis para el asistente)')}
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
