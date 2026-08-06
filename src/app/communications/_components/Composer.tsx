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
import { apiPost, resolveAgentAction, uploadToSignedUrl } from '@/lib/comms/client';
import { T, SANS, deptColorDark, tint, Tip, paneIcon, popNode } from './comms-ui';
import type { MessagePaneProps } from './MessagePane';
import { reportCompanionFlow } from '@/components/companion/companion-events';

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
  // What @Staxis PROPOSED in this thread and is waiting on a yes for. Staxis
  // never writes on its own: a work order or a complaint it suggests is held
  // until the person who asked approves it here.
  const [staxisCards, setStaxisCards] = React.useState<{ pendingActionId: string; summary: string }[]>([]);
  const [staxisOutcome, setStaxisOutcome] = React.useState<string | null>(null);
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
            ? 'Too many posts right now. Wait a minute and try again.'
            : 'Could not post the announcement. Please try again.');
          return;
        }
        if (effOrgWide && r.data?.orgWide) setOrgNotice({ postedCount: r.data.postedCount ?? 0, propertyCount: r.data.propertyCount ?? 0, failedCount: r.data.failedCount ?? 0 });
        setRequireAck(false); setOrgWide(false);
        // Posted by hand, and post_announcement is a real tool. On success only,
        // after the post landed. The companion shows the tip at most once ever,
        // and never while somebody is still typing. See decideTeachMoment.
        reportCompanionFlow('announcement');
      } else if (handoffMode) {
        const r = await apiPost('/api/comms/send', { pid, conversationId: c.id, body, msgType: 'handoff', handoffShift: currentShift(), handoffOutstanding: body });
        if (!r.ok) { setError('Could not send the hand-off. Please try again.'); return; }
      } else {
        const sent = await apiPost('/api/comms/send', { pid, conversationId: c.id, body });
        if (!sent.ok) { setError('Message could not be sent. Please try again.'); return; }
        if (/@staxis/i.test(body)) {
          const q = body.replace(/@staxis/ig, '').trim() || body;
          const assistant = await apiPost<{ pendingActions?: { pendingActionId: string; summary: string }[] }>(
            '/api/comms/assistant', { pid, conversationId: c.id, question: q },
          );
          if (!assistant.ok) setError('Your message was sent, but Staxis could not answer right now.');
          // Anything it wants to CHANGE comes back as a proposal, never as a
          // done deal. Show it, and let this person decide.
          setStaxisCards(assistant.data?.pendingActions ?? []);
          setStaxisOutcome(null);
        } else {
          const det = await apiPost<{ action: { kind: string; description: string | null; roomNumber: string | null; severity: string | null } }>('/api/comms/detect-action', { pid, text: body });
          const a = det.data?.action;
          if (a && (a.kind === 'work_order' || a.kind === 'complaint')) setActionOffer({ kind: a.kind, description: a.description ?? body, roomNumber: a.roomNumber, severity: a.severity });
        }
      }
      setText(''); setHandoffMode(false);
      await reload();
    } catch {
      setError('Message could not be sent. Please try again.');
    } finally { setBusy(false); }
  };

  const doAction = async () => {
    if (!actionOffer) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPost('/api/comms/action', { pid, conversationId: c.id, kind: actionOffer.kind, description: actionOffer.description, roomNumber: actionOffer.roomNumber, severity: actionOffer.severity });
      if (!r.ok) { setError('Could not create the action. Please try again.'); return; }
      setActionOffer(null); await onReloadThread();
    } finally { setBusy(false); }
  };

  const decideStaxisCard = async (pendingActionId: string, decision: 'approve' | 'deny') => {
    setBusy(true); setError(null);
    try {
      const outcome = await resolveAgentAction(pid, pendingActionId, decision, me.lang);
      setStaxisCards((cards) => cards.filter((card) => card.pendingActionId !== pendingActionId));
      if (outcome.error) { setError(outcome.error); return; }
      setStaxisOutcome(outcome.summary || (outcome.denied ? 'Left alone.' : 'Done.'));
      await onReloadThread();
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
    } catch { setError('Microphone access is unavailable. Check your browser permission and try again.'); }
  };
  const stopRec = () => { recorderRef.current?.stop(); setRecording(false); };
  const finishVoice = async () => {
    const durMs = Date.now() - recStartRef.current;
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (blob.size === 0) return;
    setBusy(true); setError(null);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: c.id, kind: 'voice', filename: 'voice.webm' });
      if (!pre.ok || !pre.data) { setError('Voice message could not be prepared. Please try again.'); return; }
      if (!(await uploadToSignedUrl(pre.data.signedUrl, blob))) { setError('Voice message upload failed. Please try again.'); return; }
      const tr = await apiPost<{ text: string }>('/api/comms/transcribe', { pid, path: pre.data.path });
      const sent = await apiPost('/api/comms/send', { pid, conversationId: c.id, body: tr.data?.text ?? '', msgType: 'voice', attachmentPath: pre.data.path, attachmentKind: 'voice', voiceDurationMs: durMs });
      if (!sent.ok) { setError('Voice message could not be sent. Please try again.'); return; }
      await reload();
    } finally { setBusy(false); }
  };

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: c.id, kind: 'photo', filename: file.name });
      if (!pre.ok || !pre.data) { setError('Photo could not be prepared. Please try again.'); return; }
      if (!(await uploadToSignedUrl(pre.data.signedUrl, file))) { setError('Photo upload failed. Please try again.'); return; }
      const sent = await apiPost('/api/comms/send', { pid, conversationId: c.id, body: '', msgType: 'photo', attachmentPath: pre.data.path, attachmentKind: 'photo' });
      if (!sent.ok) { setError('Photo could not be sent. Please try again.'); return; }
      await reload();
    } finally { setBusy(false); }
  };

  const canSend = !!text.trim() && !busy;
  return (
    <div style={{ padding: '0 20px 16px' }}>
      {actionOffer && (
        <div style={{ margin: '0 0 8px', padding: 12, background: tint(T.terracotta, .08), borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, fontFamily: SANS }}>
          {actionOffer.kind === 'work_order' ? <Wrench size={16} color={T.terracotta} /> : <AlertCircle size={16} color={T.terracotta} />}
          <span style={{ flex: 1 }}>{actionOffer.kind === 'work_order' ? 'Looks like a maintenance issue.' : 'Looks like a guest complaint.'}</span>
          <button onClick={doAction} disabled={busy} style={{ background: T.terracotta, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, cursor: 'pointer' }}>{actionOffer.kind === 'work_order' ? 'Create work order' : 'Log complaint'}</button>
          <button onClick={() => setActionOffer(null)} style={paneIcon}><X size={14} /></button>
        </div>
      )}
      {staxisCards.map((card) => (
        <div key={card.pendingActionId} style={{ margin: '0 0 8px', padding: 12, background: T.forestTint, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, fontFamily: SANS }}>
          <ClipboardList size={16} color={deptColorDark(T.forest)} />
          <span style={{ flex: 1 }}>{card.summary || 'Staxis wants to make a change.'}</span>
          <button onClick={() => void decideStaxisCard(card.pendingActionId, 'approve')} disabled={busy} style={{ background: T.forestDeep, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, cursor: 'pointer' }}>{'Do it'}</button>
          <button onClick={() => void decideStaxisCard(card.pendingActionId, 'deny')} disabled={busy} style={{ background: 'transparent', color: T.dim, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, cursor: 'pointer' }}>{'Not now'}</button>
        </div>
      ))}
      {staxisOutcome && (
        <div style={{ margin: '0 0 8px', padding: 12, background: T.forestTint, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontFamily: SANS }}>
          <ClipboardList size={16} color={deptColorDark(T.forest)} />
          <span style={{ flex: 1 }}>{staxisOutcome}</span>
          <button onClick={() => setStaxisOutcome(null)} style={paneIcon}><X size={14} /></button>
        </div>
      )}
      {orgNotice && (
        <div style={{ margin: '0 0 8px', padding: 12, background: T.forestTint, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontFamily: SANS }}>
          <Building2 size={16} color={deptColorDark(T.forest)} />
          <span style={{ flex: 1 }}>{`Mandatory read posted to ${orgNotice.postedCount} of ${orgNotice.propertyCount} properties.`}{orgNotice.failedCount > 0 ? ' ' + `(${orgNotice.failedCount} failed)` : ''}</span>
          <button onClick={() => setOrgNotice(null)} style={paneIcon}><X size={14} /></button>
        </div>
      )}

      {canPostAnnouncement && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <Tip width={252} text={'Everyone has to tap “I read & understand.” It stays marked unread for them until they do, and you’ll see exactly who has and hasn’t.'}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: (requireAck || orgWide) ? 700 : 500, color: (requireAck || orgWide) ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
              <input type="checkbox" checked={requireAck || orgWide} disabled={orgWide} onChange={(e) => setRequireAck(e.target.checked)} style={{ accentColor: T.forestDeep }} />
              <ShieldCheck size={14} /> {'Require acknowledgement'}
            </label>
          </Tip>
          {me.canOrgWide && (
            <Tip width={252} text={'Posts this to every property you manage, and everyone at each one has to acknowledge it.'}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: orgWide ? 700 : 500, color: orgWide ? deptColorDark(T.forest) : T.dim, fontFamily: SANS }}>
                <input type="checkbox" checked={orgWide} onChange={(e) => setOrgWide(e.target.checked)} style={{ accentColor: T.forestDeep }} />
                <Building2 size={14} /> {'Send to all my properties'}
              </label>
            </Tip>
          )}
        </div>
      )}
      {handoffMode && <div style={{ fontSize: 11, color: deptColorDark(T.forest), marginBottom: 6, fontWeight: 600, fontFamily: SANS }}>{'Shift hand-off post'} · {currentShift()}</div>}

      <div style={{ border: `1px solid ${T.hairer}`, borderRadius: 11, overflow: 'hidden', background: T.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <button style={{ ...fmtBtn, fontWeight: 700 }} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('**')} title={'Bold'}><Bold size={14} /></button>
          <button style={{ ...fmtBtn, fontStyle: 'italic' }} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('*')} title={'Italic'}><Italic size={14} /></button>
          <button style={fmtBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('~~')} title={'Strikethrough'}><Strikethrough size={14} /></button>
          {!isAnnouncement && <span style={{ width: 1, height: 16, background: T.hair, margin: '0 4px' }} />}
          {!isAnnouncement && <button style={fmtBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAt('@')} title={'Mention'}><AtSign size={15} /></button>}
          {!isAnnouncement && <>
            <button style={{ ...fmtBtn, color: recording ? T.terracotta : T.dim }} onClick={recording ? stopRec : startRec} title={'Voice message'}>{recording ? <Square size={15} /> : <Mic size={15} />}</button>
            <label style={{ ...fmtBtn, cursor: 'pointer' }} title={'Photo'}><ImageIcon size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <label style={{ ...fmtBtn, cursor: 'pointer', position: 'relative' }} title={'Attach a file'}><Paperclip size={15} /><input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} /></label>
            <button style={{ ...fmtBtn, color: handoffMode ? deptColorDark(T.forest) : T.dim }} onClick={() => setHandoffMode((v) => !v)} title={'Hand-off post'}><ClipboardList size={15} /></button>
          </>}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '8px 8px 8px 12px' }}>
          <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); popNode(sendBtn.current); void doSend(); } }}
            placeholder={isAnnouncement ? 'Write an announcement…' : 'Message…  (type @Staxis to ask the assistant)'}
            style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 14, lineHeight: 1.5, color: T.ink, padding: '4px 0', maxHeight: 120 }} />
          <button ref={sendBtn} onClick={() => { popNode(sendBtn.current); void doSend(); }} disabled={!canSend} aria-label={'Send'}
            style={{ width: 44, height: 44, borderRadius: 9, border: 'none', cursor: canSend ? 'pointer' : 'default', background: canSend ? T.forest : T.hairSoft, color: canSend ? '#fff' : T.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {busy ? <Loader2 size={15} className="comms-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
      {recording && <div style={{ fontSize: 12, color: T.terracotta, marginTop: 6, fontFamily: SANS }}>● {'Recording… tap stop to send'}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: T.terracotta, marginTop: 6, fontFamily: SANS }}>{error}</div>}
    </div>
  );
}
