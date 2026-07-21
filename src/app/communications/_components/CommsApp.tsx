'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic redesign — root.
// Sidebar (channels / DMs / announcements + Catch-up + Threads / To-do /
// Knowledge nav) · message pane · on-demand Thread/Pinned/Members panels ·
// Search palette · Catch-up popover. All data via /api/comms/*. NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Search, Sparkles, ListTodo, BookOpen, Notebook, CalendarDays, Phone, Megaphone, Plus, Reply, ArrowRight, ChevronLeft, AlertCircle, Loader2, RefreshCw, X } from 'lucide-react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { apiGet, apiPost } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO, CommsDept } from '@/lib/comms/types';
import type { WorklistItem } from '@/lib/worklist/types';
import { useCommsResource } from './comms-data';
import type { BootstrapData, ViewMode, RightPanel, L as LType } from './comms-types-fe';
import { T, SANS, SERIF, MONO, deptColor, deptColorDark, tint, Avatar, MonoLabel, Presence } from './comms-ui';
import { MessagePane, ThreadPanel, PinnedPanel, MembersPanel } from './MessagePane';
import { SearchPalette, CatchUp, NewMessageModal, TodoMode } from './CommsOverlays';
import { KnowledgePane } from './KnowledgePane';
import { LogbookMode } from './LogbookPane';
import { CalendarMode } from './CalendarPane';
import { ContactsMode } from './ContactsPane';

export function CommsApp() {
  const { activePropertyId } = useProperty();
  // A hotel switch is a resource-boundary change, not an ordinary refresh.
  // Remount the workspace so no conversations, messages, badges, or modal
  // state from the previous hotel can remain while the next request settles.
  return <CommsPropertyApp key={activePropertyId ?? 'no-property'} pid={activePropertyId} />;
}

function CommsPropertyApp({ pid }: { pid: string | null }) {
  const { locale } = useLang();
  const L = React.useCallback<LType>((en, es) => (locale === 'es' ? es : en), [locale]);

  const [selId, setSelId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<MessageDTO[]>([]);
  const [mode, setMode] = React.useState<ViewMode>('chats');
  const [threadParent, setThreadParent] = React.useState<MessageDTO | null>(null);
  const [panel, setPanel] = React.useState<RightPanel>(null);
  const [catchOpen, setCatchOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [memberCount, setMemberCount] = React.useState<number | null>(null);
  const [mobileDetail, setMobileDetail] = React.useState(false);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesError, setMessagesError] = React.useState<string | null>(null);
  const [mutationError, setMutationError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const threadRequestRef = React.useRef(0);
  // `pid` comes from a client-only context (reads localStorage), so it's null
  // during SSR but already set on the first client render. Branching the render
  // on it directly made the server HTML ("Select a property…") disagree with the
  // client (the full app) → React hydration mismatch (#418). Gate the pid branch
  // on `mounted` so SSR and the first client render produce identical markup.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
    // Dashboard "Go to Log Book" deep-links with ?view=logbook. Read it
    // client-only (after mount) so SSR/first-render markup stays identical —
    // same hydration discipline as the pid branch below (#418).
    try {
      const v = new URLSearchParams(window.location.search).get('view');
      if (v === 'logbook' || v === 'threads' || v === 'todo' || v === 'knowledge' || v === 'calendar' || v === 'contacts') {
        setMode(v);
        setMobileDetail(true);
      }
    } catch { /* */ }
  }, []);

  // ── Data ──────────────────────────────────────────────────────────────────
  // Bootstrap (sidebar + me + staff): 8s poll, last-good held through failed
  // polls. CommsApp's property-keyed boundary clears it on hotel switches.
  const { data: boot, loading: bootLoading, error: bootError, reload: loadBoot } = useCommsResource<BootstrapData>(
    `/api/comms/bootstrap?pid=${encodeURIComponent(pid ?? '')}`,
    { pollMs: 8000, keepDataOnError: true, enabled: !!pid },
  );
  // Worklist: fetched up-front for the sidebar badge; 15s poll only while the
  // To-do view is open (plus a refresh on entry, below).
  const { data: worklistData, loading: worklistLoading, error: worklistError, reload: loadWorklist } = useCommsResource<{ items: WorklistItem[] }>(
    `/api/worklist?pid=${encodeURIComponent(pid ?? '')}`,
    { pollMs: mode === 'todo' ? 15000 : undefined, keepDataOnError: true, enabled: !!pid },
  );
  const worklist = worklistData?.items ?? [];

  const selConvo = boot?.conversations.find((c) => c.id === selId) ?? null;
  const online = React.useMemo(() => new Set(boot?.onlineStaffIds ?? []), [boot?.onlineStaffIds]);

  // Messages stay hand-rolled: switching conversations must BLANK the pane
  // (not hold the previous thread's messages), and every successful fetch —
  // polls included — re-pins the scroll to the bottom. Neither survives
  // useCommsResource's silent keep-last-good source switches.
  const loadThread = React.useCallback(async (showLoading = false) => {
    if (!pid || !selId) return;
    const requestId = ++threadRequestRef.current;
    if (showLoading) setMessagesLoading(true);
    const r = await apiGet<{ messages: MessageDTO[] }>(`/api/comms/messages?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(selId)}`);
    if (requestId !== threadRequestRef.current) return;
    if (r.ok && r.data) {
      setMessages(r.data.messages);
      setMessagesError(null);
      setTimeout(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, 30);
    } else {
      setMessagesError(r.error || L('Could not load messages.', 'No se pudieron cargar los mensajes.'));
    }
    setMessagesLoading(false);
  }, [pid, selId, L]);

  React.useEffect(() => {
    threadRequestRef.current += 1;
    setMessages([]);
    setMessagesError(null);
    setMessagesLoading(!!selId);
    if (selId) void loadThread(true);
    return () => { threadRequestRef.current += 1; };
  }, [selId, loadThread]);
  React.useEffect(() => {
    if (!selId || mode !== 'chats') return;
    const iv = setInterval(() => { if (!document.hidden) void loadThread(); }, 3000);
    return () => clearInterval(iv);
  }, [selId, mode, loadThread]);
  React.useEffect(() => { if (mode === 'todo') void loadWorklist(); }, [mode, loadWorklist]);

  // Member count for the selected conversation header.
  React.useEffect(() => {
    setMemberCount(null);
    if (!pid || !selId || !selConvo || selConvo.kind === 'dm') return;
    let live = true;
    void (async () => {
      const r = await apiGet<{ memberCount: number }>(`/api/comms/members?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(selId)}`);
      if (live && r.ok && r.data) setMemberCount(r.data.memberCount);
    })();
    return () => { live = false; };
  }, [pid, selId, selConvo]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const selectConversation = (id: string) => { setSelId(id); setMode('chats'); setThreadParent(null); setPanel(null); setMobileDetail(true); };
  const switchMode = (m: ViewMode) => { setMode(m); setMobileDetail(true); if (m !== 'chats') { setThreadParent(null); setPanel(null); } };
  const jump = (id: string) => { selectConversation(id); setCatchOpen(false); setSearchOpen(false); };
  const openThread = (m: MessageDTO) => { setPanel(null); setThreadParent((cur) => (cur?.id === m.id ? null : m)); };
  const togglePanel = (p: Exclude<RightPanel, null>) => { setThreadParent(null); setPanel((cur) => (cur === p ? null : p)); };
  const showMobileList = () => { setMobileDetail(false); setThreadParent(null); setPanel(null); };
  const actionFailed = (en: string, es: string) => setMutationError(L(en, es));

  const reactToggle = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/react', { pid, messageId: m.id });
    if (!r.ok) { actionFailed('Could not update the acknowledgement. Please try again.', 'No se pudo actualizar la confirmación. Inténtalo de nuevo.'); return; }
    await loadThread();
  };
  const pinToggle = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/pin', { pid, messageId: m.id, pinned: !m.pinned });
    if (!r.ok) { actionFailed('Could not update the pinned message. Please try again.', 'No se pudo actualizar el mensaje fijado. Inténtalo de nuevo.'); return; }
    await loadThread();
  };
  const turnIntoTask = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/tasks', { pid, title: (m.originalBody || m.body).slice(0, 200) || L('Message task', 'Tarea de mensaje'), sourceMessageId: m.id });
    if (!r.ok) { actionFailed('Could not turn this message into a task. Please try again.', 'No se pudo convertir este mensaje en una tarea. Inténtalo de nuevo.'); return; }
    setMode('todo'); setThreadParent(null); setPanel(null);
    await loadWorklist();
  };
  const openDm = async (staffId: string) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost<{ conversationId: string }>('/api/comms/dm', { pid, otherStaffId: staffId });
    if (!r.ok || !r.data?.conversationId) { actionFailed('Could not start the direct message. Please try again.', 'No se pudo iniciar el mensaje directo. Inténtalo de nuevo.'); return; }
    await loadBoot(); selectConversation(r.data.conversationId); setShowNew(false); setSearchOpen(false);
  };

  if (!mounted) {
    // Stable neutral shell for SSR + first client render (pid unknown yet).
    // Same card frame as the real workspace so hydration doesn't flash.
    return <div style={{ flex: 1, minHeight: 0, background: T.bg, borderRadius: 18, border: '1px solid rgba(31,35,28,.08)' }} />;
  }
  if (!pid) {
    return <div style={{ padding: 40, fontFamily: SANS, color: T.dim }}>{L('Select a property to use Communications.', 'Selecciona una propiedad para usar Comunicaciones.')}</div>;
  }
  if (!boot) {
    return (
      <div className="comms-shell" style={{ display: 'flex', flex: 1, minHeight: 0, fontFamily: SANS, color: T.ink, background: T.bg, position: 'relative', borderRadius: 18, border: '1px solid rgba(31,35,28,.08)', boxShadow: '0 6px 16px -14px rgba(31,42,32,.35)', overflow: 'hidden' }}>
        <ResourceState
          loading={bootLoading || !bootError}
          title={bootLoading || !bootError ? L('Loading Communications…', 'Cargando Comunicaciones…') : L('Communications could not load', 'No se pudo cargar Comunicaciones')}
          detail={bootLoading || !bootError ? L('Getting conversations and staff for this property.', 'Obteniendo conversaciones y personal de esta propiedad.') : L('Check your connection, then try again. Your data has not been changed.', 'Revisa tu conexión e inténtalo de nuevo. Tus datos no se modificaron.')}
          retryLabel={L('Try again', 'Reintentar')}
          onRetry={() => void loadBoot()}
        />
      </div>
    );
  }

  const conversations = boot?.conversations ?? [];
  const announce = conversations.filter((c) => c.kind === 'announcement');
  const channels = conversations.filter((c) => c.kind === 'channel');
  const dms = conversations.filter((c) => c.kind === 'dm');
  const onShiftCount = (boot?.onlineStaffIds ?? []).filter((id) => id !== boot?.me.staffId).length;
  const catchCount = conversations.filter((c) => c.unread > 0 || (c.pendingAck ?? 0) > 0).length;
  const openItems = worklist.length;

  const right = mode === 'chats'
    ? (threadParent && selConvo
        ? <ThreadPanel key={`${selConvo.id}:${threadParent.id}`} pid={pid} conversation={selConvo} parent={threadParent} L={L} onClose={() => setThreadParent(null)} onReload={loadThread} />
        : panel === 'pinned' && selConvo
        ? <PinnedPanel pid={pid} conversation={selConvo} L={L} onClose={() => setPanel(null)} />
        : panel === 'members' && selConvo
        ? <MembersPanel pid={pid} conversation={selConvo} online={online} L={L} onClose={() => setPanel(null)} onMessage={openDm} />
        : null)
    : null;

  return (
    // Concourse shell: the workspace flexes to fill the space under the
    // floating pill bar as a rounded card (was `calc(100vh - 64px)` against
    // the old solid header — that left a top seam + bottom overflow).
    <div className={`comms-shell${mobileDetail ? ' comms-mobile-detail' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, fontFamily: SANS, color: T.ink, background: T.bg, position: 'relative', borderRadius: 18, border: '1px solid rgba(31,35,28,.08)', boxShadow: '0 6px 16px -14px rgba(31,42,32,.35)', overflow: 'hidden' }}>
      {/* ── Sidebar ── */}
      <aside className="comms-sidebar" style={{ width: 272, background: T.bg, borderRight: `1px solid ${T.hair}`, display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 16, color: T.ink }}>{L('Communications', 'Comunicaciones')}</div>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: T.dim, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <Presence on={onShiftCount > 0} size={7} /> {L(`${onShiftCount} on shift`, `${onShiftCount} en turno`)}
          </div>
        </div>

        <div style={{ padding: '10px 12px 6px' }}>
          <button onClick={() => setSearchOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 11px', borderRadius: 8, border: `1px solid ${T.hair}`, background: T.paper, color: T.dim, cursor: 'pointer', fontFamily: SANS, fontSize: 13 }}>
            <Search size={14} /> {L('Jump to or search…', 'Saltar a o buscar…')}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 14 }}>
          <div style={{ padding: '4px 8px 2px' }}>
            <button onClick={() => setCatchOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: T.forestTint, color: deptColorDark(T.forest), fontFamily: SANS, fontSize: 14, fontWeight: 600 }}>
              <Sparkles size={16} /> {L('Catch up', 'Ponerme al día')}
              {catchCount > 0 && <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, background: deptColorDark(T.forest), color: '#fff', borderRadius: 9, padding: '1px 7px' }}>{catchCount}</span>}
            </button>
          </div>
          <NavItem icon={<Reply size={17} />} label={L('Threads', 'Hilos')} active={mode === 'threads'} onClick={() => switchMode('threads')} />
          <NavItem icon={<ListTodo size={17} />} label={L('To-do', 'Tareas')} active={mode === 'todo'} onClick={() => switchMode('todo')} badge={openItems || undefined} />
          <NavItem icon={<BookOpen size={17} />} label={L('Knowledge', 'Conocimiento')} active={mode === 'knowledge'} onClick={() => switchMode('knowledge')} />
          <NavItem icon={<Notebook size={17} />} label={L('Log book', 'Bitácora')} active={mode === 'logbook'} onClick={() => switchMode('logbook')} />
          <NavItem icon={<CalendarDays size={17} />} label={L('Calendar', 'Calendario')} active={mode === 'calendar'} onClick={() => switchMode('calendar')} />
          <NavItem icon={<Phone size={17} />} label={L('Contacts', 'Contactos')} active={mode === 'contacts'} onClick={() => switchMode('contacts')} />

          <SidebarSection label={L('Announcements', 'Anuncios')} onAdd={() => setSearchOpen(true)} tip={L('Post an announcement', 'Publicar un anuncio')} />
          {announce.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
          <SidebarSection label={L('Channels', 'Canales')} onAdd={() => setSearchOpen(true)} tip={L('Browse channels', 'Ver canales')} />
          {channels.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
          <SidebarSection label={L('Direct messages', 'Mensajes directos')} onAdd={() => setShowNew(true)} tip={L('Start a direct message', 'Iniciar un mensaje directo')} />
          {dms.length === 0 && <div style={{ padding: '4px 20px', fontSize: 12, color: T.dim, fontFamily: SANS }}>{L('No conversations yet', 'Sin conversaciones')}</div>}
          {dms.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="comms-main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="comms-mobile-backbar">
          <button className="comms-mobile-back" onClick={showMobileList} aria-label={L('Back to conversations', 'Volver a conversaciones')}>
            <ChevronLeft size={20} aria-hidden="true" />
            <span>{L('Conversations', 'Conversaciones')}</span>
          </button>
        </div>
        <div className="comms-main-content" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', position: 'relative' }}>
          {mode === 'chats' && (
            <>
              {selConvo
                ? <MessagePane
                    pid={pid} me={boot.me} conversation={selConvo} messages={messages} online={online} memberCount={memberCount} L={L}
                    messagesLoading={messagesLoading} messagesError={messagesError} onRetryMessages={() => void loadThread(true)}
                    activeThreadId={threadParent?.id ?? null} activePanel={panel} scrollRef={scrollRef}
                    onReloadThread={loadThread} onReloadBoot={loadBoot} onOpenThread={openThread} onTogglePanel={togglePanel}
                    onReactToggle={reactToggle} onPinToggle={pinToggle} onTurnIntoTask={turnIntoTask} onOpenSearch={() => setSearchOpen(true)} />
                : <EmptyHint text={L('Pick a conversation, or start a new message.', 'Elige una conversación o inicia un mensaje nuevo.')} />}
              {right}
            </>
          )}
          {mode === 'threads' && <ThreadsList pid={pid} L={L} onOpen={(convId, parent) => { selectConversation(convId); setThreadParent(parent); }} />}
          {mode === 'todo' && <TodoMode pid={pid} items={worklist} staff={boot.staff ?? []} L={L} reload={loadWorklist} loading={worklistLoading} error={worklistError} />}
          {mode === 'knowledge' && <div style={{ flex: 1, overflowY: 'auto' }}><KnowledgePane pid={pid} isManager={!!boot.me.isManager} L={L} /></div>}
          {mode === 'logbook' && <LogbookMode key={pid} pid={pid} meName={boot.me.displayName ?? L('You', 'Tú')} L={L} />}
          {mode === 'calendar' && <CalendarMode key={pid} pid={pid} isManager={!!boot.me.isManager} L={L} />}
          {mode === 'contacts' && <ContactsMode key={pid} pid={pid} isManager={!!boot.me.isManager} L={L} />}
        </div>
      </div>

      {/* ── Overlays ── */}
      {catchOpen && <CatchUp pid={pid} conversations={conversations} L={L} onJump={jump} onClose={() => setCatchOpen(false)} />}
      {searchOpen && <SearchPalette pid={pid} L={L} onClose={() => setSearchOpen(false)} onJump={jump} onOpenDm={openDm} />}
      {showNew && boot && <NewMessageModal staff={boot.staff} L={L} onPick={openDm} onClose={() => setShowNew(false)} />}

      {(bootError || mutationError) && (
        <div className="comms-alert-stack">
          {bootError && (
            <div className="comms-action-alert" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span>{L('Conversations could not refresh. Showing the last results.', 'No se pudieron actualizar las conversaciones. Se muestran los últimos resultados.')}</span>
              <button onClick={() => void loadBoot()} aria-label={L('Retry loading conversations', 'Reintentar cargar conversaciones')}><RefreshCw size={17} aria-hidden="true" /></button>
            </div>
          )}
          {mutationError && (
            <div className="comms-action-alert" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span>{mutationError}</span>
              <button onClick={() => setMutationError(null)} aria-label={L('Dismiss error', 'Cerrar error')}><X size={18} aria-hidden="true" /></button>
            </div>
          )}
        </div>
      )}

      <style>{`
        .comms-spin{animation:comms-spin 1s linear infinite}
        @keyframes comms-spin{to{transform:rotate(360deg)}}
        .comms-mobile-backbar{display:none}
        .comms-alert-stack{position:absolute;right:16px;bottom:16px;z-index:90;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(420px,calc(100% - 32px))}
        .comms-action-alert{display:flex;align-items:center;gap:10px;width:100%;padding:12px 12px 12px 14px;border-left:3px solid ${T.terracotta};border-radius:9px;background:${T.ink};color:#fff;box-shadow:0 12px 32px rgba(31,35,28,.24);font:500 13px/1.4 ${SANS}}
        .comms-action-alert>span{flex:1;min-width:0}
        .comms-action-alert>button{width:44px;height:44px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer}
        .comms-action-alert>button:focus-visible,.comms-mobile-back:focus-visible{outline:2px solid ${T.teal};outline-offset:2px}
        @media(max-width:1100px){
          .comms-right-panel{position:absolute!important;inset:0!important;z-index:20!important;width:100%!important;max-width:none!important;border-left:0!important}
          .comms-right-panel button{min-height:44px}
        }
        @media(max-width:767px){
          .comms-shell{width:100%;border-radius:14px!important}
          .comms-sidebar{width:100%!important;border-right:0!important}
          .comms-sidebar button{min-height:44px}
          .comms-main{display:none!important;width:100%}
          .comms-mobile-detail .comms-sidebar{display:none!important}
          .comms-mobile-detail .comms-main{display:flex!important}
          .comms-mobile-backbar{display:flex;height:48px;flex-shrink:0;align-items:center;border-bottom:1px solid ${T.hairSoft};padding:0 6px;background:${T.bg}}
          .comms-mobile-back{min-width:44px;min-height:44px;display:inline-flex;align-items:center;gap:4px;padding:0 8px;border:0;border-radius:9px;background:transparent;color:${deptColorDark(T.forest)};font:600 13px ${SANS};cursor:pointer}
          .comms-main-content{width:100%;overflow:hidden}
          .comms-alert-stack{right:10px;bottom:10px;max-width:calc(100% - 20px)}
        }
        @media(prefers-reduced-motion:reduce){.comms-spin{animation:none}}
      `}</style>
    </div>
  );
}

function ResourceState({ loading, title, detail, retryLabel, onRetry }: { loading: boolean; title: string; detail: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div role={loading ? 'status' : 'alert'} aria-live={loading ? 'polite' : 'assertive'} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28, textAlign: 'center' }}>
      <style>{`@keyframes comms-resource-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.comms-resource-spin{animation:none!important}}`}</style>
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        {loading ? <Loader2 size={24} className="comms-resource-spin" style={{ animation: 'comms-resource-spin 1s linear infinite' }} color={T.forest} aria-hidden="true" /> : <AlertCircle size={24} color={T.terracotta} aria-hidden="true" />}
        <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: T.ink }}>{title}</div>
        <div style={{ fontFamily: SANS, fontSize: 13, lineHeight: 1.5, color: T.dim }}>{detail}</div>
        {!loading && <button onClick={onRetry} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '0 16px', borderRadius: 9, border: `1px solid ${T.hairer}`, background: T.bg, color: T.ink, fontFamily: SANS, fontWeight: 650, cursor: 'pointer' }}><RefreshCw size={15} aria-hidden="true" />{retryLabel}</button>}
      </div>
    </div>
  );
}

// ── Sidebar pieces ───────────────────────────────────────────────────────────
function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '6px 12px', border: 'none', cursor: 'pointer', background: active ? T.forestTint : 'transparent', color: active ? deptColorDark(T.forest) : T.ink, fontFamily: SANS, fontSize: 14, fontWeight: active ? 600 : 500 }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = T.paper; }} onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ color: active ? deptColorDark(T.forest) : T.dim, display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {badge ? <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.dim }}>{badge}</span> : null}
    </button>
  );
}

function SidebarSection({ label, onAdd, tip }: { label: string; onAdd: () => void; tip: string }) {
  const [show, setShow] = React.useState(false);
  return (
    <div style={{ padding: '16px 12px 4px', display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: T.dim, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <button onClick={onAdd} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} aria-label={tip}
          style={{ width: 17, height: 17, borderRadius: 5, border: 'none', background: show ? T.paper : 'transparent', color: show ? T.ink : T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: show ? 1 : 0.65 }}>
          <Plus size={13} />
        </button>
        {show && <span style={{ position: 'absolute', left: 0, top: '100%', marginTop: 5, whiteSpace: 'nowrap', zIndex: 50, pointerEvents: 'none', background: T.ink, color: '#fff', fontFamily: SANS, fontSize: 11.5, fontWeight: 500, padding: '5px 9px', borderRadius: 7, boxShadow: '0 6px 18px rgba(31,35,28,.22)' }}>{tip}</span>}
      </span>
    </div>
  );
}

function ConvoRow({ c, active, online, onClick, L }: { c: ConversationDTO; active: boolean; online: Set<string>; onClick: () => void; L: LType }) {
  const unread = c.unread > 0 || (c.pendingAck ?? 0) > 0;
  const count = c.unread > 0 ? c.unread : (c.pendingAck ?? 0);
  const isDm = c.kind === 'dm';
  const dmOnline = isDm && c.otherStaffId ? online.has(c.otherStaffId) : false;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '5px 12px 5px 22px',
      border: 'none', cursor: 'pointer', background: active ? T.ink : 'transparent', color: active ? '#fff' : (unread ? T.ink : T.dim),
      fontFamily: SANS, fontSize: 14, fontWeight: unread || active ? 600 : 500,
    }} onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = T.paper; }} onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      {isDm
        ? <span style={{ position: 'relative', display: 'flex' }}>
            <Avatar name={c.title} dept={c.dept} size={18} />
            <span style={{ position: 'absolute', right: -2, bottom: -2, width: 8, height: 8, borderRadius: '50%', background: dmOnline ? T.forest : T.dim, border: `1.5px solid ${active ? T.ink : T.bg}` }} />
          </span>
        : <span style={{ color: active ? 'rgba(255,255,255,.7)' : T.dim, display: 'flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>{c.kind === 'announcement' ? <Megaphone size={15} /> : <span style={{ fontFamily: SANS, fontSize: 15 }}>#</span>}</span>}
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
      {unread && !active && <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: T.terracotta, color: '#fff', fontFamily: SANS, fontWeight: 700, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{count}</span>}
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.dim, fontSize: 14, padding: 40, textAlign: 'center', fontFamily: SANS }}>{text}</div>;
}

// ── Threads mode (every conversation that has a live thread) ─────────────────
interface ThreadSummaryDTO { conversationId: string; conversationTitle: string; dept: CommsDept; parent: MessageDTO }
function ThreadsList({ pid, L, onOpen }: { pid: string; L: LType; onOpen: (convId: string, parent: MessageDTO) => void }) {
  const { data, loading, error, reload } = useCommsResource<{ threads: ThreadSummaryDTO[] }>(`/api/comms/threads?pid=${encodeURIComponent(pid)}`, { keepDataOnError: true });
  const items = data?.threads ?? [];
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ marginBottom: 7 }}><MonoLabel>{data ? L(`${items.length} threads`, `${items.length} hilos`) : (loading ? L('Loading threads', 'Cargando hilos') : L('Threads unavailable', 'Hilos no disponibles'))}</MonoLabel></div>
        <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Threads', 'Hilos')}</div>
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && items.length === 0 && <div role="status" style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}><Loader2 size={16} className="comms-spin" aria-hidden="true" /> {L('Loading threads…', 'Cargando hilos…')}</div>}
          {error && <div role="alert" style={{ fontFamily: SANS, fontSize: 13, color: T.terracotta, padding: '12px 14px', border: `1px solid ${tint(T.terracotta, .28)}`, background: tint(T.terracotta, .08), borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}><AlertCircle size={17} aria-hidden="true" /><span style={{ flex: 1 }}>{items.length > 0 ? L('Threads could not refresh. Showing the last results.', 'No se pudieron actualizar los hilos. Se muestran los últimos resultados.') : L('Threads could not load.', 'No se pudieron cargar los hilos.')}</span><button onClick={() => void reload()} style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: `1px solid ${tint(T.terracotta, .3)}`, background: T.bg, color: T.terracotta, cursor: 'pointer' }} aria-label={L('Retry loading threads', 'Reintentar cargar hilos')}><RefreshCw size={15} aria-hidden="true" /></button></div>}
          {!loading && !error && items.length === 0 && <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}>{L('No threads yet. Reply to a message to start one.', 'Sin hilos aún. Responde a un mensaje para empezar uno.')}</div>}
          {items.map(({ conversationId, conversationTitle, dept, parent }) => (
            <button key={parent.id} onClick={() => onOpen(conversationId, parent)} style={{ textAlign: 'left', border: `1px solid ${T.hair}`, borderRadius: 13, background: T.bg, cursor: 'pointer', padding: '14px 16px' }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = tint(deptColor(dept), .45))} onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.hair)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: SANS, fontSize: 14, color: deptColor(dept), fontWeight: 700 }}>{parent.conversationId ? '#' : '#'}</span>
                <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 13.5, color: T.ink }}>{conversationTitle}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Avatar name={parent.mine ? L('You', 'Tú') : parent.senderName} dept={dept} size={30} me={parent.mine} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: SANS, fontSize: 13, marginBottom: 2 }}><span style={{ fontWeight: 700, color: T.ink }}>{parent.mine ? L('You', 'Tú') : parent.senderName}</span></div>
                  <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.ink, lineHeight: 1.45 }}>{parent.body || (parent.attachmentKind === 'photo' ? L('Photo', 'Foto') : '')}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingLeft: 40 }}>
                <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: deptColorDark(T.teal) }}>{parent.replyCount === 1 ? L('1 reply', '1 respuesta') : L(`${parent.replyCount} replies`, `${parent.replyCount} respuestas`)}</span>
                <span style={{ color: T.dim, display: 'flex' }}><ArrowRight size={14} /></span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
