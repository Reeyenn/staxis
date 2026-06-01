'use client';
/* eslint-disable @next/next/no-img-element -- chat photo attachments are short-lived signed URLs from a private bucket; next/image can't optimize them and would need per-URL domain config */

import React from 'react';
import {
  Send, Mic, Square, Image as ImageIcon, Megaphone, ListTodo, MessageSquare,
  Sparkles, Check, CheckCheck, Plus, X, Users, Loader2, Wrench, AlertCircle, ClipboardList,
  ShieldCheck, ChevronDown, ChevronRight, Building2, BookOpen,
} from 'lucide-react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { apiGet, apiPost, apiPatch, uploadToSignedUrl } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO, TaskDTO, StaffLite, AckStatusDTO, CampaignStatusDTO } from '@/lib/comms/types';
import { KnowledgePane } from './KnowledgePane';

type BootstrapData = {
  me: { staffId: string; role: string; isManager: boolean; dept: string | null; lang: string; displayName: string; canOrgWide?: boolean };
  conversations: ConversationDTO[];
  staff: StaffLite[];
  unreadTotal: number;
};

const SNOW = {
  bg: 'var(--snow-bg)', ink: 'var(--snow-ink)', ink2: 'var(--snow-ink2)', ink3: 'var(--snow-ink3)',
  rule: 'var(--snow-rule)', ruleSoft: 'var(--snow-rule-soft)', sage: 'var(--snow-sage)', sageDeep: 'var(--snow-sage-deep)',
  sageDim: 'var(--snow-sage-dim)', warm: 'var(--snow-warm)',
};
const SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

export function CommsApp() {
  const { activePropertyId: pid } = useProperty();
  const { locale } = useLang();
  const L = React.useCallback((en: string, es: string) => (locale === 'es' ? es : en), [locale]);

  const [boot, setBoot] = React.useState<BootstrapData | null>(null);
  const [selId, setSelId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<MessageDTO[]>([]);
  const [view, setView] = React.useState<'chats' | 'tasks' | 'knowledge'>('chats');
  const [tasks, setTasks] = React.useState<TaskDTO[]>([]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [showOriginal, setShowOriginal] = React.useState<Record<string, boolean>>({});
  const [actionOffer, setActionOffer] = React.useState<null | { kind: 'work_order' | 'complaint'; description: string; roomNumber: string | null; severity: string | null }>(null);
  const [missBrief, setMissBrief] = React.useState<string | null>(null);
  const [handoffMode, setHandoffMode] = React.useState(false);
  // Announcement composer toggles (managers only).
  const [requireAck, setRequireAck] = React.useState(false);
  const [orgWide, setOrgWide] = React.useState(false);
  const [orgNotice, setOrgNotice] = React.useState<null | { postedCount: number; propertyCount: number; failedCount: number }>(null);
  const [composerError, setComposerError] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const recStartRef = React.useRef<number>(0);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const selConvo = boot?.conversations.find((c) => c.id === selId) ?? null;
  const isAnnouncement = selConvo?.kind === 'announcement';
  const canPostAnnouncement = isAnnouncement && !!boot?.me.isManager;

  // ── Bootstrap + poll ──
  const loadBoot = React.useCallback(async () => {
    if (!pid) return;
    const r = await apiGet<BootstrapData>(`/api/comms/bootstrap?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setBoot(r.data);
  }, [pid]);

  React.useEffect(() => { void loadBoot(); }, [loadBoot]);
  React.useEffect(() => {
    if (!pid) return;
    const iv = setInterval(() => { if (!document.hidden) void loadBoot(); }, 8000);
    return () => clearInterval(iv);
  }, [pid, loadBoot]);

  // ── Thread load + poll ──
  const loadThread = React.useCallback(async () => {
    if (!pid || !selId) return;
    const r = await apiGet<{ conversation: unknown; messages: MessageDTO[] }>(`/api/comms/messages?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(selId)}`);
    if (r.ok && r.data) {
      setMessages(r.data.messages);
      setTimeout(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, 30);
    }
  }, [pid, selId]);

  React.useEffect(() => { setMessages([]); if (selId) void loadThread(); }, [selId, loadThread]);
  React.useEffect(() => {
    if (!selId) return;
    const iv = setInterval(() => { if (!document.hidden) void loadThread(); }, 3000);
    return () => clearInterval(iv);
  }, [selId, loadThread]);

  // ── Tasks ──
  const loadTasks = React.useCallback(async () => {
    if (!pid) return;
    const r = await apiGet<{ tasks: TaskDTO[] }>(`/api/comms/tasks?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setTasks(r.data.tasks);
  }, [pid]);
  React.useEffect(() => { if (view === 'tasks') void loadTasks(); }, [view, loadTasks]);

  // ── Send ──
  const doSend = async () => {
    if (!pid || !selId) return;
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setComposerError(null);
    try {
      if (canPostAnnouncement) {
        const effOrgWide = orgWide && !!boot?.me.canOrgWide;
        const r = await apiPost<{ orgWide?: boolean; postedCount?: number; propertyCount?: number; failedCount?: number }>(
          '/api/comms/announce',
          { pid, body, requiresAck: requireAck || effOrgWide, orgWide: effOrgWide },
        );
        if (!r.ok) {
          // Keep the typed text + toggles so nothing the manager wrote is lost.
          setComposerError(r.status === 429
            ? L('Too many posts right now — wait a minute and try again.', 'Demasiadas publicaciones — espera un minuto e inténtalo de nuevo.')
            : L('Could not post the announcement. Please try again.', 'No se pudo publicar el anuncio. Inténtalo de nuevo.'));
          return;
        }
        if (effOrgWide && r.data?.orgWide) {
          setOrgNotice({ postedCount: r.data.postedCount ?? 0, propertyCount: r.data.propertyCount ?? 0, failedCount: r.data.failedCount ?? 0 });
        }
        setRequireAck(false);
        setOrgWide(false);
      } else if (handoffMode) {
        await apiPost('/api/comms/send', { pid, conversationId: selId, body, msgType: 'handoff', handoffShift: currentShift(), handoffOutstanding: body });
      } else {
        await apiPost('/api/comms/send', { pid, conversationId: selId, body });
        const mentionsStaxis = /@staxis/i.test(body);
        if (mentionsStaxis) {
          const q = body.replace(/@staxis/ig, '').trim() || body;
          await apiPost('/api/comms/assistant', { pid, conversationId: selId, question: q });
        } else {
          // Offer a one-tap action if the message looks operational.
          const det = await apiPost<{ action: { kind: string; description: string | null; roomNumber: string | null; severity: string | null } }>('/api/comms/detect-action', { pid, text: body });
          const a = det.data?.action;
          if (a && (a.kind === 'work_order' || a.kind === 'complaint')) {
            setActionOffer({ kind: a.kind, description: a.description ?? body, roomNumber: a.roomNumber, severity: a.severity });
          }
        }
      }
      setText('');
      setHandoffMode(false);
      await loadThread();
      await loadBoot();
    } finally {
      setBusy(false);
    }
  };

  const doAction = async () => {
    if (!pid || !selId || !actionOffer) return;
    setBusy(true);
    try {
      await apiPost('/api/comms/action', { pid, conversationId: selId, kind: actionOffer.kind, description: actionOffer.description, roomNumber: actionOffer.roomNumber, severity: actionOffer.severity });
      setActionOffer(null);
      await loadThread();
    } finally { setBusy(false); }
  };

  const turnIntoTask = async (m: MessageDTO) => {
    if (!pid) return;
    await apiPost('/api/comms/tasks', { pid, title: m.originalBody.slice(0, 200) || L('Message task', 'Tarea de mensaje'), sourceMessageId: m.id });
    setView('tasks');
  };

  const whatDidIMiss = async () => {
    if (!pid) return;
    setMissBrief(L('Summarizing…', 'Resumiendo…'));
    const r = await apiPost<{ summary: string; count: number }>('/api/comms/summary', { pid });
    setMissBrief(r.data?.summary || L('You are all caught up.', 'Estás al día.'));
  };

  // ── Voice ──
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void finishVoice(); };
      recorderRef.current = rec;
      recStartRef.current = Date.now();
      rec.start();
      setRecording(true);
    } catch { /* mic denied */ }
  };
  const stopRec = () => { recorderRef.current?.stop(); setRecording(false); };
  const finishVoice = async () => {
    if (!pid || !selId) return;
    const durMs = Date.now() - recStartRef.current;
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (blob.size === 0) return;
    setBusy(true);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: selId, kind: 'voice', filename: 'voice.webm' });
      if (!pre.data) return;
      const up = await uploadToSignedUrl(pre.data.signedUrl, blob);
      if (!up) return;
      const tr = await apiPost<{ text: string }>('/api/comms/transcribe', { pid, path: pre.data.path });
      await apiPost('/api/comms/send', { pid, conversationId: selId, body: tr.data?.text ?? '', msgType: 'voice', attachmentPath: pre.data.path, attachmentKind: 'voice', voiceDurationMs: durMs });
      await loadThread();
    } finally { setBusy(false); }
  };

  // ── Photo ──
  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pid || !selId) return;
    setBusy(true);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string }>('/api/comms/photo-presign', { pid, conversationId: selId, kind: 'photo', filename: file.name });
      if (!pre.data) return;
      const up = await uploadToSignedUrl(pre.data.signedUrl, file);
      if (!up) return;
      await apiPost('/api/comms/send', { pid, conversationId: selId, body: '', msgType: 'photo', attachmentPath: pre.data.path, attachmentKind: 'photo' });
      await loadThread();
    } finally { setBusy(false); }
  };

  const openDm = async (staffId: string) => {
    if (!pid) return;
    const r = await apiPost<{ conversationId: string }>('/api/comms/dm', { pid, otherStaffId: staffId });
    if (r.data?.conversationId) { await loadBoot(); setSelId(r.data.conversationId); setShowNew(false); setView('chats'); }
  };

  if (!pid) {
    return <div style={{ padding: 40, fontFamily: SANS, color: SNOW.ink2 }}>{L('Select a property to use Communications.', 'Selecciona una propiedad para usar Comunicaciones.')}</div>;
  }

  const channels = boot?.conversations.filter((c) => c.kind === 'channel') ?? [];
  const announce = boot?.conversations.filter((c) => c.kind === 'announcement') ?? [];
  const dms = boot?.conversations.filter((c) => c.kind === 'dm') ?? [];

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', fontFamily: SANS, color: SNOW.ink, background: SNOW.bg }}>
      {/* ── Left pane ── */}
      <div style={{ width: 320, borderRight: `1px solid ${SNOW.rule}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px 18px', borderBottom: `1px solid ${SNOW.rule}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{L('Communications', 'Comunicaciones')}</div>
          <button onClick={() => setShowNew(true)} title={L('New message', 'Nuevo mensaje')} style={iconBtn}><Plus size={18} color={SNOW.ink2} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, rowGap: 6, flexWrap: 'wrap', padding: '10px 14px', borderBottom: `1px solid ${SNOW.ruleSoft}` }}>
          <Tab active={view === 'chats'} onClick={() => setView('chats')} icon={<MessageSquare size={14} />} label={L('Chats', 'Chats')} />
          <Tab active={view === 'tasks'} onClick={() => setView('tasks')} icon={<ListTodo size={14} />} label={L('To-do', 'Tareas')} />
          <Tab active={view === 'knowledge'} onClick={() => setView('knowledge')} icon={<BookOpen size={14} />} label={L('Knowledge', 'Conocimiento')} />
          {view === 'chats' && (
            <button onClick={whatDidIMiss} style={{ ...pill, marginLeft: 'auto' }} title={L('What did I miss', 'Qué me perdí')}>
              <Sparkles size={13} color={SNOW.sageDeep} /> {L('Catch up', 'Ponerme al día')}
            </button>
          )}
        </div>

        {missBrief && (
          <div style={{ margin: 12, padding: 12, background: SNOW.sageDim, borderRadius: 10, fontSize: 12.5, color: SNOW.ink, whiteSpace: 'pre-wrap', position: 'relative' }}>
            <button onClick={() => setMissBrief(null)} style={{ ...iconBtn, position: 'absolute', top: 4, right: 4 }}><X size={13} /></button>
            <div style={{ fontWeight: 600, marginBottom: 4, color: SNOW.sageDeep }}>{L('What you missed', 'Lo que te perdiste')}</div>
            {missBrief}
          </div>
        )}

        {view === 'chats' ? (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            <Section label={L('Announcements', 'Anuncios')} />
            {announce.map((c) => <ConvoRow key={c.id} c={c} active={c.id === selId} onClick={() => setSelId(c.id)} icon={<Megaphone size={15} />} />)}
            <Section label={L('Channels', 'Canales')} />
            {channels.map((c) => <ConvoRow key={c.id} c={c} active={c.id === selId} onClick={() => setSelId(c.id)} icon={<Users size={15} />} />)}
            <Section label={L('Direct messages', 'Mensajes directos')} />
            {dms.length === 0 && <div style={{ padding: '6px 18px', fontSize: 12, color: SNOW.ink3 }}>{L('No conversations yet', 'Sin conversaciones')}</div>}
            {dms.map((c) => <ConvoRow key={c.id} c={c} active={c.id === selId} onClick={() => setSelId(c.id)} />)}
          </div>
        ) : view === 'tasks' ? (
          <TasksPane pid={pid} tasks={tasks} staff={boot?.staff ?? []} L={L} reload={loadTasks} />
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{L('Knowledge base', 'Base de conocimiento')}</div>
            <div style={{ fontSize: 12.5, color: SNOW.ink2, lineHeight: 1.5 }}>{L('SOPs, documents, contacts, and the team calendar — all in one place.', 'Procedimientos, documentos, contactos y el calendario del equipo — todo en un solo lugar.')}</div>
            <div style={{ fontSize: 12, color: SNOW.ink3, marginTop: 10, lineHeight: 1.5 }}>{L('Everyone can read. Managers can publish and edit.', 'Todos pueden leer. Los gerentes pueden publicar y editar.')}</div>
          </div>
        )}
      </div>

      {/* ── Right pane ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {view === 'knowledge' ? (
          <KnowledgePane pid={pid} isManager={!!boot?.me.isManager} L={L} />
        ) : view === 'tasks' ? (
          <EmptyHint text={L('Manage your team to-do list on the left.', 'Gestiona la lista de tareas a la izquierda.')} />
        ) : !selConvo ? (
          <EmptyHint text={L('Pick a conversation, or start a new message.', 'Elige una conversación o inicia un mensaje nuevo.')} />
        ) : (
          <>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${SNOW.rule}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              {isAnnouncement ? <Megaphone size={18} color={SNOW.sageDeep} /> : selConvo.kind === 'channel' ? <Users size={18} color={SNOW.ink2} /> : <MessageSquare size={18} color={SNOW.ink2} />}
              <div style={{ fontWeight: 600, fontSize: 15 }}>{selConvo.title}</div>
              {isAnnouncement && <span style={{ fontSize: 11, color: SNOW.ink3 }}>{canPostAnnouncement ? L('· broadcast to everyone', '· difusión a todos') : L('· read-only', '· solo lectura')}</span>}
            </div>

            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} pid={pid} isManager={!!boot?.me.isManager} showOriginal={!!showOriginal[m.id]} onToggleOriginal={() => setShowOriginal((s) => ({ ...s, [m.id]: !s[m.id] }))} onTurnIntoTask={() => turnIntoTask(m)} onChanged={async () => { await loadThread(); await loadBoot(); }} L={L} />
              ))}
              {messages.length === 0 && <div style={{ color: SNOW.ink3, fontSize: 13, textAlign: 'center', marginTop: 40 }}>{L('No messages yet.', 'Sin mensajes aún.')}</div>}
            </div>

            {actionOffer && (
              <div style={{ margin: '0 20px 8px', padding: 12, background: 'var(--snow-warm-dim)', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                {actionOffer.kind === 'work_order' ? <Wrench size={16} color={SNOW.warm} /> : <AlertCircle size={16} color={SNOW.warm} />}
                <span style={{ flex: 1 }}>{actionOffer.kind === 'work_order' ? L('Looks like a maintenance issue.', 'Parece un problema de mantenimiento.') : L('Looks like a guest complaint.', 'Parece una queja de huésped.')}</span>
                <button onClick={doAction} disabled={busy} style={primaryBtnSm}>{actionOffer.kind === 'work_order' ? L('Create work order', 'Crear orden') : L('Log complaint', 'Registrar queja')}</button>
                <button onClick={() => setActionOffer(null)} style={iconBtn}><X size={14} /></button>
              </div>
            )}

            {orgNotice && (
              <div style={{ margin: '0 20px 8px', padding: 12, background: 'var(--snow-sage-dim)', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <Building2 size={16} color={SNOW.sageDeep} />
                <span style={{ flex: 1 }}>
                  {L(`Mandatory read posted to ${orgNotice.postedCount} of ${orgNotice.propertyCount} properties. Open the announcement below to track who has read it.`,
                     `Lectura obligatoria enviada a ${orgNotice.postedCount} de ${orgNotice.propertyCount} propiedades. Abre el anuncio para ver quién la leyó.`)}
                  {orgNotice.failedCount > 0 && ' ' + L(`(${orgNotice.failedCount} failed)`, `(${orgNotice.failedCount} fallaron)`)}
                </span>
                <button onClick={() => setOrgNotice(null)} style={iconBtn}><X size={14} /></button>
              </div>
            )}

            {(!isAnnouncement || canPostAnnouncement) ? (
              <div style={{ borderTop: `1px solid ${SNOW.rule}`, padding: 12 }}>
                {canPostAnnouncement && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: (requireAck || orgWide) ? 700 : 500, color: (requireAck || orgWide) ? SNOW.sageDeep : SNOW.ink2 }}>
                      <input type="checkbox" checked={requireAck || orgWide} disabled={orgWide} onChange={(e) => setRequireAck(e.target.checked)} style={{ accentColor: 'var(--snow-sage-deep)' }} />
                      <ShieldCheck size={14} /> {L('Require acknowledgement', 'Requerir confirmación')}
                    </label>
                    {boot?.me.canOrgWide && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: orgWide ? 700 : 500, color: orgWide ? SNOW.sageDeep : SNOW.ink2 }}>
                        <input type="checkbox" checked={orgWide} onChange={(e) => setOrgWide(e.target.checked)} style={{ accentColor: 'var(--snow-sage-deep)' }} />
                        <Building2 size={14} /> {L('Send to all my properties', 'Enviar a todas mis propiedades')}
                      </label>
                    )}
                    {(requireAck || orgWide) && (
                      <span style={{ fontSize: 11.5, color: SNOW.ink3 }}>
                        {orgWide
                          ? L('Everyone at every property must tap “I read & understand”.', 'Todos en cada propiedad deben tocar “Leí y entiendo”.')
                          : L('Everyone must tap “I read & understand”.', 'Todos deben tocar “Leí y entiendo”.')}
                      </span>
                    )}
                  </div>
                )}
                {handoffMode && <div style={{ fontSize: 11, color: SNOW.sageDeep, marginBottom: 6, fontWeight: 600 }}>{L('Shift hand-off post', 'Publicación de relevo')} · {currentShift()}</div>}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  {canPostAnnouncement && (
                    <button onClick={async () => { if (!text.trim()) return; setBusy(true); const r = await apiPost<{ text: string }>('/api/comms/polish', { pid, text }); if (r.data?.text) setText(r.data.text); setBusy(false); }} title={L('AI polish', 'Pulir con IA')} style={iconBtn}><Sparkles size={18} color={SNOW.sageDeep} /></button>
                  )}
                  {!isAnnouncement && (
                    <>
                      <button onClick={recording ? stopRec : startRec} title={L('Voice message', 'Mensaje de voz')} style={iconBtn}>{recording ? <Square size={18} color={SNOW.warm} /> : <Mic size={18} color={SNOW.ink2} />}</button>
                      <label style={{ ...iconBtn, cursor: 'pointer' }} title={L('Photo', 'Foto')}>
                        <ImageIcon size={18} color={SNOW.ink2} />
                        <input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} />
                      </label>
                      <button onClick={() => setHandoffMode((v) => !v)} title={L('Hand-off post', 'Relevo')} style={{ ...iconBtn, background: handoffMode ? SNOW.sageDim : 'transparent' }}><ClipboardList size={18} color={handoffMode ? SNOW.sageDeep : SNOW.ink2} /></button>
                    </>
                  )}
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(); } }}
                    placeholder={isAnnouncement ? L('Write an announcement… (try AI polish)', 'Escribe un anuncio… (prueba pulir con IA)') : L('Message… (type @Staxis to ask the assistant)', 'Mensaje… (escribe @Staxis para el asistente)')}
                    rows={1}
                    style={{ flex: 1, resize: 'none', border: `1px solid ${SNOW.rule}`, borderRadius: 10, padding: '10px 12px', fontFamily: SANS, fontSize: 14, maxHeight: 120, outline: 'none' }}
                  />
                  <button onClick={doSend} disabled={busy || !text.trim()} style={{ ...primaryBtn, opacity: busy || !text.trim() ? 0.5 : 1 }}>
                    {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
                  </button>
                </div>
                {recording && <div style={{ fontSize: 12, color: SNOW.warm, marginTop: 6 }}>● {L('Recording… tap stop to send', 'Grabando… toca detener para enviar')}</div>}
                {composerError && <div style={{ fontSize: 12, color: SNOW.warm, marginTop: 6 }}>{composerError}</div>}
              </div>
            ) : (
              <div style={{ borderTop: `1px solid ${SNOW.rule}`, padding: 16, fontSize: 12.5, color: SNOW.ink3, textAlign: 'center' }}>
                {L('Only managers can post announcements.', 'Solo los gerentes pueden publicar anuncios.')}
              </div>
            )}
          </>
        )}
      </div>

      {showNew && boot && (
        <NewMessageModal staff={boot.staff} onPick={openDm} onClose={() => setShowNew(false)} L={L} />
      )}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── helpers / subcomponents ──

function currentShift(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'night';
}

const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 8, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const primaryBtn: React.CSSProperties = { background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const primaryBtnSm: React.CSSProperties = { background: 'var(--snow-warm)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: SANS };
const pill: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, background: 'var(--snow-sage-dim)', color: 'var(--snow-sage-deep)', border: 'none', borderRadius: 999, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SANS };
const ackBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: SANS };
const actionRequiredPill: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, background: 'var(--snow-warm-dim)', color: 'var(--snow-warm)', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 700, fontFamily: SANS };
const trackerToggle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--snow-ink2)', padding: 0, fontFamily: SANS };
const trackerLink: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--snow-sage-deep)', padding: '2px 0', fontFamily: SANS };

function Tab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, background: active ? 'var(--snow-sage-dim)' : 'transparent', color: active ? 'var(--snow-sage-deep)' : 'var(--snow-ink2)', border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SANS }}>
      {icon}{label}
    </button>
  );
}

function Section({ label }: { label: string }) {
  return <div style={{ padding: '12px 18px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)' }}>{label}</div>;
}

function ConvoRow({ c, active, onClick, icon }: { c: ConversationDTO; active: boolean; onClick: () => void; icon?: React.ReactNode }) {
  const pendingAck = c.pendingAck ?? 0;
  const needsAttention = c.unread > 0 || pendingAck > 0;
  return (
    <button onClick={onClick} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: active ? 'var(--snow-sage-dim)' : 'transparent', border: 'none', borderLeft: active ? '2px solid var(--snow-sage-deep)' : '2px solid transparent', cursor: 'pointer', fontFamily: SANS }}>
      {icon && <span style={{ color: 'var(--snow-ink2)', flexShrink: 0 }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: needsAttention ? 700 : 500, color: 'var(--snow-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
        {c.lastMessagePreview && <span style={{ display: 'block', fontSize: 12, color: 'var(--snow-ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lastMessagePreview}</span>}
      </span>
      {/* Un-acked required announcement(s): amber "needs action" pill, distinct from the unread count. */}
      {pendingAck > 0 && (
        <span title="Action required" style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'var(--snow-warm-dim)', color: 'var(--snow-warm)', fontSize: 11, fontWeight: 700, borderRadius: 999, height: 18, padding: '0 6px', flexShrink: 0 }}>
          <ShieldCheck size={11} />{pendingAck}
        </span>
      )}
      {c.unread > 0 && <span style={{ background: 'var(--snow-sage-deep)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 999, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px', flexShrink: 0 }}>{c.unread}</span>}
    </button>
  );
}

function MessageBubble({ m, pid, isManager, showOriginal, onToggleOriginal, onTurnIntoTask, onChanged, L }: { m: MessageDTO; pid: string; isManager: boolean; showOriginal: boolean; onToggleOriginal: () => void; onTurnIntoTask: () => void; onChanged: () => void | Promise<void>; L: (en: string, es: string) => string }) {
  const isStaxis = m.senderKind === 'staxis';
  const isSystem = m.senderKind === 'system';
  if (isSystem) {
    return <div style={{ alignSelf: 'center', fontSize: 12, color: 'var(--snow-ink3)', background: 'var(--snow-rule-soft)', padding: '4px 12px', borderRadius: 999 }}>{m.body}</div>;
  }
  return (
    <div style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
      {!m.mine && <div style={{ fontSize: 11, color: isStaxis ? 'var(--snow-sage-deep)' : 'var(--snow-ink2)', fontWeight: 600, marginBottom: 2, marginLeft: 4 }}>{isStaxis ? '✦ Staxis' : m.senderName}</div>}
      <div style={{ background: m.mine ? 'var(--snow-sage-deep)' : isStaxis ? 'var(--snow-sage-dim)' : 'var(--snow-rule-soft)', color: m.mine ? '#fff' : 'var(--snow-ink)', borderRadius: 14, padding: '9px 13px', fontSize: 14, lineHeight: 1.45, wordBreak: 'break-word' }}>
        {m.attachmentKind === 'photo' && m.attachmentUrl && <img src={m.attachmentUrl} alt="" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: m.body ? 6 : 0 }} />}
        {m.attachmentKind === 'voice' && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>🎤 {L('Voice message', 'Mensaje de voz')}{m.attachmentUrl ? '' : ''}</div>}
        {m.attachmentKind === 'voice' && m.attachmentUrl && <audio controls src={m.attachmentUrl} style={{ width: '100%', marginBottom: 6 }} />}
        {(showOriginal ? m.originalBody : m.body) && <span>{showOriginal ? m.originalBody : m.body}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 3, marginLeft: 4, alignItems: 'center', justifyContent: m.mine ? 'flex-end' : 'flex-start' }}>
        {m.wasTranslated && <button onClick={onToggleOriginal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--snow-ink3)', padding: 0 }}>{showOriginal ? L('see translation', 'ver traducción') : L('see original', 'ver original')}</button>}
        <button onClick={onTurnIntoTask} title={L('Turn into task', 'Convertir en tarea')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--snow-ink3)', padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}><ListTodo size={11} /> {L('task', 'tarea')}</button>
        {m.mine && m.seenBy && m.seenBy.length > 0 && <span style={{ fontSize: 11, color: 'var(--snow-sage-deep)', display: 'flex', alignItems: 'center', gap: 2 }} title={m.seenBy.map((s) => s.name).join(', ')}><CheckCheck size={12} /> {m.seenBy.length}</span>}
        {m.mine && (!m.seenBy || m.seenBy.length === 0) && <Check size={12} color="var(--snow-ink3)" />}
      </div>
      {m.requiresAck && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5, alignItems: m.mine ? 'flex-end' : 'flex-start' }}>
          {/* Recipient who actually owes it: must confirm until they tap. */}
          {m.mustAck && !m.acked && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={actionRequiredPill}><AlertCircle size={12} /> {L('Action required', 'Acción requerida')}</span>
              <AckButton pid={pid} m={m} onChanged={onChanged} L={L} />
            </div>
          )}
          {!m.mine && m.acked && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--snow-sage-deep)', fontWeight: 600 }}><ShieldCheck size={13} /> {L('Acknowledged', 'Confirmado')}</span>
          )}
          {/* Author / any manager: live who-has / who-hasn't tracker. */}
          {(m.mine || isManager) && <AckTracker pid={pid} m={m} L={L} />}
        </div>
      )}
    </div>
  );
}

// ── Acknowledgement: recipient button + manager tracker + campaign roll-up ──

function AckButton({ pid, m, onChanged, L }: { pid: string; m: MessageDTO; onChanged: () => void | Promise<void>; L: (en: string, es: string) => string }) {
  const [busy, setBusy] = React.useState(false);
  const ack = async () => {
    if (busy) return;
    setBusy(true);
    try { await apiPost('/api/comms/acknowledge', { pid, messageId: m.id }); await onChanged(); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={ack} disabled={busy} style={{ ...ackBtn, opacity: busy ? 0.6 : 1 }}>
      {busy ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} {L('I read & understand', 'Leí y entiendo')}
    </button>
  );
}

function AckTracker({ pid, m, L }: { pid: string; m: MessageDTO; L: (en: string, es: string) => string }) {
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
    <div style={{ width: '100%', maxWidth: 280 }}>
      <button onClick={() => setOpen((v) => !v)} style={trackerToggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ShieldCheck size={13} color="var(--snow-sage-deep)" />
        {status ? L(`${acked} of ${total} acknowledged`, `${acked} de ${total} confirmaron`) : L('Acknowledgement tracker', 'Seguimiento de confirmación')}
      </button>
      {open && status && (
        <div style={{ marginTop: 6, padding: 10, background: 'var(--snow-sage-dim)', borderRadius: 10, fontSize: 12, color: 'var(--snow-ink2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 6, background: 'var(--snow-rule-soft)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--snow-sage-deep)' }} />
          </div>
          {status.pending.length > 0 ? (
            <div><strong style={{ color: 'var(--snow-ink)' }}>{L('Waiting on', 'Falta')}:</strong> {status.pending.map((p) => p.name).join(', ')}</div>
          ) : (
            <div style={{ color: 'var(--snow-sage-deep)', fontWeight: 600 }}>{L('Everyone has acknowledged ✓', 'Todos confirmaron ✓')}</div>
          )}
          {status.ackedList.length > 0 && (
            <div style={{ color: 'var(--snow-ink3)' }}><strong style={{ color: 'var(--snow-ink2)' }}>{L('Read', 'Leyeron')}:</strong> {status.ackedList.map((a) => a.name).join(', ')}</div>
          )}
          {m.ackCampaignId && !showCampaign && (
            <button onClick={loadCampaign} style={trackerLink}><Building2 size={12} /> {L('View all-property completion', 'Ver avance de todas las propiedades')}</button>
          )}
          {showCampaign && campaign && <CampaignPanel campaign={campaign} L={L} />}
        </div>
      )}
    </div>
  );
}

function CampaignPanel({ campaign, L }: { campaign: CampaignStatusDTO; L: (en: string, es: string) => string }) {
  const pct = campaign.total ? Math.round((campaign.acked / campaign.total) * 100) : 0;
  return (
    <div style={{ marginTop: 4, padding: 8, background: 'var(--snow-bg)', border: '1px solid var(--snow-rule-soft)', borderRadius: 8 }}>
      <div style={{ fontWeight: 700, color: 'var(--snow-sage-deep)', marginBottom: 5, fontSize: 12 }}>
        {L(`${campaign.acked} of ${campaign.total} acknowledged · ${campaign.properties.length} properties · ${pct}%`,
           `${campaign.acked} de ${campaign.total} confirmaron · ${campaign.properties.length} propiedades · ${pct}%`)}
      </div>
      {campaign.properties.map((p) => (
        <div key={p.propertyId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: 'var(--snow-ink2)', padding: '2px 0' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.propertyName}</span>
          <span style={{ flexShrink: 0, color: p.acked >= p.total ? 'var(--snow-sage-deep)' : 'var(--snow-ink3)' }}>{p.acked}/{p.total}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--snow-ink3)', fontSize: 14, padding: 40, textAlign: 'center' }}>{text}</div>;
}

function NewMessageModal({ staff, onPick, onClose, L }: { staff: StaffLite[]; onPick: (id: string) => void; onClose: () => void; L: (en: string, es: string) => string }) {
  const [q, setQ] = React.useState('');
  const filtered = staff.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.3)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--snow-bg)', borderRadius: 16, width: 380, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 16px 48px rgba(31,35,28,0.18)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--snow-rule)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontFamily: SANS }}>{L('New message', 'Nuevo mensaje')}</span>
          <button onClick={onClose} style={iconBtn}><X size={16} /></button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('Search staff…', 'Buscar personal…')} style={{ margin: 14, padding: '10px 12px', border: '1px solid var(--snow-rule)', borderRadius: 10, fontFamily: SANS, fontSize: 14, outline: 'none' }} />
        <div style={{ overflowY: 'auto' }}>
          {filtered.map((s) => (
            <button key={s.id} onClick={() => onPick(s.id)} style={{ width: '100%', textAlign: 'left', padding: '10px 18px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--snow-rule-soft)', cursor: 'pointer', fontFamily: SANS, fontSize: 14 }}>
              {s.name} <span style={{ fontSize: 12, color: 'var(--snow-ink3)' }}>· {s.department ?? 'staff'}</span>
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: 18, color: 'var(--snow-ink3)', fontSize: 13 }}>{L('No staff found', 'Sin resultados')}</div>}
        </div>
      </div>
    </div>
  );
}

function TasksPane({ pid, tasks, staff, L, reload }: { pid: string; tasks: TaskDTO[]; staff: StaffLite[]; L: (en: string, es: string) => string; reload: () => void }) {
  const [title, setTitle] = React.useState('');
  const [assignee, setAssignee] = React.useState('');
  const [due, setDue] = React.useState('');
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const add = async () => {
    if (!title.trim()) return;
    await apiPost('/api/comms/tasks', { pid, title: title.trim(), assignedStaffId: assignee || undefined, dueAt: due ? new Date(due).toISOString() : undefined });
    setTitle(''); setAssignee(''); setDue(''); reload();
  };
  const toggle = async (t: TaskDTO) => { await apiPatch('/api/comms/tasks', { pid, taskId: t.id, status: t.status === 'done' ? 'open' : 'done' }); reload(); };
  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L('New task…', 'Nueva tarea…')} style={taskInput} />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={taskInput}>
          <option value="">{L('Assign to… (optional)', 'Asignar a… (opcional)')}</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={taskInput} />
        <button onClick={add} style={{ ...primaryBtn, justifyContent: 'center', padding: '9px' }}>{L('Add task', 'Agregar tarea')}</button>
      </div>
      {open.map((t) => <TaskRow key={t.id} t={t} onToggle={() => toggle(t)} L={L} />)}
      {done.length > 0 && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', margin: '12px 4px 6px' }}>{L('Done', 'Hechas')}</div>}
      {done.map((t) => <TaskRow key={t.id} t={t} onToggle={() => toggle(t)} L={L} />)}
      {tasks.length === 0 && <div style={{ padding: 12, fontSize: 13, color: 'var(--snow-ink3)' }}>{L('No tasks yet.', 'Sin tareas aún.')}</div>}
    </div>
  );
}
const taskInput: React.CSSProperties = { border: '1px solid var(--snow-rule)', borderRadius: 8, padding: '8px 10px', fontFamily: SANS, fontSize: 13, outline: 'none', background: 'var(--snow-bg)' };

function TaskRow({ t, onToggle, L }: { t: TaskDTO; onToggle: () => void; L: (en: string, es: string) => string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 6px', borderBottom: '1px solid var(--snow-rule-soft)' }}>
      <button onClick={onToggle} style={{ ...iconBtn, padding: 2, marginTop: 1 }}>
        <span style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${t.status === 'done' ? 'var(--snow-sage-deep)' : 'var(--snow-ink3)'}`, background: t.status === 'done' ? 'var(--snow-sage-deep)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.status === 'done' && <Check size={12} color="#fff" />}</span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: 'var(--snow-ink)', textDecoration: t.status === 'done' ? 'line-through' : 'none', opacity: t.status === 'done' ? 0.6 : 1 }}>{t.title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--snow-ink3)', display: 'flex', gap: 8 }}>
          {t.assignedStaffName && <span>{t.assignedStaffName}</span>}
          {t.assignedDepartment && <span>#{t.assignedDepartment}</span>}
          {t.dueAt && <span>{L('due', 'vence')} {new Date(t.dueAt).toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}
