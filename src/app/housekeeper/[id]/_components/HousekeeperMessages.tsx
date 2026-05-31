'use client';

import React from 'react';
import { MessageSquare, X, Send, ArrowLeft, Mic, Square, Megaphone, Plus, CheckCheck } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
import type { ConversationDTO, MessageDTO, StaffLite } from '@/lib/comms/types';

// Dead-simple floor messaging: a list of chats + announcements, tap one, type,
// send (text or voice). All reads/writes go through /api/housekeeper/messages/*
// (supabaseAdmin + pid+staffId capability) — never the browser DB client.

const T: Record<string, Record<HousekeeperLocale, string>> = {
  messages:      { en: 'Messages', es: 'Mensajes', ht: 'Mesaj', tl: 'Mga Mensahe', vi: 'Tin nhắn' },
  announcements: { en: 'Announcements', es: 'Anuncios', ht: 'Anons', tl: 'Mga Anunsyo', vi: 'Thông báo' },
  chats:         { en: 'Chats', es: 'Chats', ht: 'Chat', tl: 'Mga Chat', vi: 'Trò chuyện' },
  send:          { en: 'Send', es: 'Enviar', ht: 'Voye', tl: 'Ipadala', vi: 'Gửi' },
  type:          { en: 'Type a message…', es: 'Escribe un mensaje…', ht: 'Tape yon mesaj…', tl: 'Mag-type…', vi: 'Nhập tin nhắn…' },
  none:          { en: 'No messages yet', es: 'Sin mensajes', ht: 'Poko gen mesaj', tl: 'Wala pang mensahe', vi: 'Chưa có tin nhắn' },
  newChat:       { en: 'New chat', es: 'Nuevo chat', ht: 'Nouvo chat', tl: 'Bagong chat', vi: 'Trò chuyện mới' },
  recording:     { en: 'Recording… tap to send', es: 'Grabando… toca para enviar', ht: 'Anrejistreman…', tl: 'Nagre-record…', vi: 'Đang ghi…' },
  readonly:      { en: 'Read only', es: 'Solo lectura', ht: 'Li sèlman', tl: 'Basahin lang', vi: 'Chỉ đọc' },
  seeOriginal:   { en: 'see original', es: 'ver original', ht: 'wè orijinal', tl: 'tingnan ang orihinal', vi: 'xem bản gốc' },
  seeTranslation:{ en: 'see translation', es: 'ver traducción', ht: 'wè tradiksyon', tl: 'tingnan ang salin', vi: 'xem bản dịch' },
};

async function hkPost<T2>(url: string, body: unknown): Promise<T2 | null> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T2 };
    return json.ok ? (json.data ?? null) : null;
  } catch { return null; }
}

interface Inbox { me: { staffId: string; name: string; lang: string }; conversations: ConversationDTO[]; staff: StaffLite[] }

export function HousekeeperMessages({ pid, staffId, lang }: { pid: string; staffId: string; lang: HousekeeperLocale }) {
  const tt = (k: string) => T[k]?.[lang] ?? T[k]?.en ?? k;
  const [open, setOpen] = React.useState(false);
  const [inbox, setInbox] = React.useState<Inbox | null>(null);
  const [sel, setSel] = React.useState<ConversationDTO | null>(null);
  const [messages, setMessages] = React.useState<MessageDTO[]>([]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [showOrig, setShowOrig] = React.useState<Record<string, boolean>>({});
  const [recording, setRecording] = React.useState(false);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const recStart = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const unread = inbox?.conversations.reduce((s, c) => s + c.unread, 0) ?? 0;

  const loadInbox = React.useCallback(async () => {
    const r = await hkPost<Inbox>('/api/housekeeper/messages', { pid, staffId });
    if (r) setInbox(r);
  }, [pid, staffId]);

  const loadThread = React.useCallback(async () => {
    if (!sel) return;
    const r = await hkPost<{ messages: MessageDTO[] }>('/api/housekeeper/messages/thread', { pid, staffId, conversationId: sel.id });
    if (r) { setMessages(r.messages); setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 30); }
  }, [pid, staffId, sel]);

  React.useEffect(() => { if (open) void loadInbox(); }, [open, loadInbox]);
  React.useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => { if (!document.hidden) void loadInbox(); }, 8000);
    return () => clearInterval(iv);
  }, [open, loadInbox]);
  React.useEffect(() => { setMessages([]); if (sel) void loadThread(); }, [sel, loadThread]);
  React.useEffect(() => {
    if (!sel) return;
    const iv = setInterval(() => { if (!document.hidden) void loadThread(); }, 3000);
    return () => clearInterval(iv);
  }, [sel, loadThread]);

  const send = async () => {
    if (!sel || !text.trim() || busy) return;
    setBusy(true);
    try { await hkPost('/api/housekeeper/messages/send', { pid, staffId, conversationId: sel.id, body: text.trim() }); setText(''); await loadThread(); await loadInbox(); }
    finally { setBusy(false); }
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void finishVoice(); };
      recRef.current = rec; recStart.current = Date.now(); rec.start(); setRecording(true);
    } catch { /* mic denied */ }
  };
  const stopRec = () => { recRef.current?.stop(); setRecording(false); };
  const finishVoice = async () => {
    if (!sel) return;
    const dur = Date.now() - recStart.current;
    const blob = new Blob(chunks.current, { type: 'audio/webm' });
    if (!blob.size) return;
    setBusy(true);
    try {
      const pre = await hkPost<{ path: string; signedUrl: string }>('/api/housekeeper/messages/presign', { pid, staffId, conversationId: sel.id, kind: 'voice', filename: 'voice.webm' });
      if (!pre) return;
      const up = await fetch(pre.signedUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'audio/webm' } });
      if (!up.ok) return;
      const tr = await hkPost<{ text: string }>('/api/housekeeper/messages/transcribe', { pid, staffId, path: pre.path });
      await hkPost('/api/housekeeper/messages/send', { pid, staffId, conversationId: sel.id, body: tr?.text ?? '', msgType: 'voice', attachmentPath: pre.path, attachmentKind: 'voice', voiceDurationMs: dur });
      await loadThread();
    } finally { setBusy(false); }
  };

  const openDm = async (otherStaffId: string) => {
    const r = await hkPost<{ conversationId: string }>('/api/housekeeper/messages/dm', { pid, staffId, otherStaffId });
    if (r) { await loadInbox(); setShowNew(false); const fresh = await hkPost<Inbox>('/api/housekeeper/messages', { pid, staffId }); const c = fresh?.conversations.find((x) => x.id === r.conversationId); if (c) setSel(c); }
  };

  const isAnnouncement = sel?.kind === 'announcement';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.08)', background: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 15, fontFamily: 'var(--font-geist), sans-serif' }}
      >
        <MessageSquare size={18} /> {tt('messages')}
        {unread > 0 && <span style={{ background: '#B85C3D', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 999, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{unread}</span>}
      </button>

      {open && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 100, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-geist), sans-serif' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid rgba(0,0,0,0.08)', flexShrink: 0 }}>
            {sel ? (
              <button onClick={() => setSel(null)} style={btn}><ArrowLeft size={22} /></button>
            ) : (
              <button onClick={() => setOpen(false)} style={btn}><X size={22} /></button>
            )}
            <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>{sel ? sel.title : tt('messages')}</div>
            {!sel && <button onClick={() => setShowNew(true)} style={btn}><Plus size={22} /></button>}
          </div>

          {!sel ? (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {(inbox?.conversations ?? []).map((c) => (
                <button key={c.id} onClick={() => setSel(c)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: '16px', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(0,0,0,0.05)', cursor: 'pointer' }}>
                  {c.kind === 'announcement' && <Megaphone size={20} color="#5C7A60" />}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 16, fontWeight: c.unread > 0 ? 700 : 500 }}>{c.title}</span>
                    {c.lastMessagePreview && <span style={{ display: 'block', fontSize: 14, color: '#5C625C', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lastMessagePreview}</span>}
                  </span>
                  {c.unread > 0 && <span style={{ background: '#5C7A60', color: '#fff', fontSize: 12, fontWeight: 700, borderRadius: 999, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px' }}>{c.unread}</span>}
                </button>
              ))}
              {(inbox?.conversations.length ?? 0) === 0 && <div style={{ padding: 24, color: '#A6ABA6', fontSize: 15 }}>{tt('none')}</div>}
            </div>
          ) : (
            <>
              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {messages.map((m) => {
                  const so = !!showOrig[m.id];
                  if (m.senderKind === 'system') return <div key={m.id} style={{ alignSelf: 'center', fontSize: 13, color: '#A6ABA6' }}>{m.body}</div>;
                  return (
                    <div key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                      {!m.mine && <div style={{ fontSize: 12, color: m.senderKind === 'staxis' ? '#5C7A60' : '#5C625C', fontWeight: 600, marginBottom: 2, marginLeft: 4 }}>{m.senderKind === 'staxis' ? '✦ Staxis' : m.senderName}</div>}
                      <div style={{ background: m.mine ? '#5C7A60' : '#F0F2F0', color: m.mine ? '#fff' : '#1F231C', borderRadius: 16, padding: '10px 14px', fontSize: 16, lineHeight: 1.45, wordBreak: 'break-word' }}>
                        {m.attachmentKind === 'photo' && m.attachmentUrl && <img src={m.attachmentUrl} alt="" style={{ maxWidth: '100%', borderRadius: 10, marginBottom: m.body ? 6 : 0 }} />}
                        {m.attachmentKind === 'voice' && m.attachmentUrl && <audio controls src={m.attachmentUrl} style={{ width: '100%', marginBottom: 6 }} />}
                        {(so ? m.originalBody : m.body) && <span>{so ? m.originalBody : m.body}</span>}
                      </div>
                      {m.wasTranslated && <button onClick={() => setShowOrig((s) => ({ ...s, [m.id]: !s[m.id] }))} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#A6ABA6', padding: '2px 4px' }}>{so ? tt('seeTranslation') : tt('seeOriginal')}</button>}
                    </div>
                  );
                })}
                {messages.length === 0 && <div style={{ textAlign: 'center', color: '#A6ABA6', marginTop: 40, fontSize: 15 }}>{tt('none')}</div>}
              </div>

              {isAnnouncement ? (
                <div style={{ padding: 16, textAlign: 'center', color: '#A6ABA6', borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 14 }}>{tt('readonly')}</div>
              ) : (
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', padding: 12, flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={recording ? stopRec : startRec} style={btn}>{recording ? <Square size={24} color="#B85C3D" /> : <Mic size={24} color="#5C625C" />}</button>
                    <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} placeholder={tt('type')} style={{ flex: 1, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 20, padding: '12px 16px', fontSize: 16, outline: 'none' }} />
                    <button onClick={send} disabled={busy || !text.trim()} style={{ ...btn, background: '#5C7A60', borderRadius: '50%', width: 44, height: 44, opacity: busy || !text.trim() ? 0.5 : 1 }}><Send size={20} color="#fff" /></button>
                  </div>
                  {recording && <div style={{ fontSize: 14, color: '#B85C3D', marginTop: 8, textAlign: 'center' }}>● {tt('recording')}</div>}
                </div>
              )}
            </>
          )}

          {showNew && inbox && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setShowNew(false)}>
              <div style={{ background: '#fff', width: '100%', maxHeight: '70vh', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
                <div style={{ padding: 16, fontWeight: 700, fontSize: 17, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>{tt('newChat')}</div>
                <div style={{ overflowY: 'auto' }}>
                  {inbox.staff.map((s) => (
                    <button key={s.id} onClick={() => openDm(s.id)} style={{ width: '100%', textAlign: 'left', padding: '16px', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(0,0,0,0.05)', fontSize: 16, cursor: 'pointer' }}>{s.name}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

const btn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' };
