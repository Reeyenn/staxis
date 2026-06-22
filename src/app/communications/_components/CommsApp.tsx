'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic redesign — root.
// Sidebar (channels / DMs / announcements + Catch-up + Threads / To-do /
// Knowledge nav) · message pane · on-demand Thread/Pinned/Members panels ·
// Search palette · Catch-up popover. All data via /api/comms/*. NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Search, Sparkles, ListTodo, BookOpen, Notebook, CalendarDays, Megaphone, Plus, Reply, ArrowRight } from 'lucide-react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { apiGet, apiPost } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO, CommsDept } from '@/lib/comms/types';
import type { WorklistItem } from '@/lib/worklist/types';
import type { BootstrapData, ViewMode, RightPanel, L as LType } from './comms-types-fe';
import { T, SANS, SERIF, MONO, deptColor, deptColorDark, tint, Avatar, MonoLabel, Presence } from './comms-ui';
import { MessagePane, ThreadPanel, PinnedPanel, MembersPanel } from './MessagePane';
import { SearchPalette, CatchUp, NewMessageModal, TodoMode } from './CommsOverlays';
import { KnowledgePane } from './KnowledgePane';
import { LogbookMode } from './LogbookPane';
import { CalendarMode } from './CalendarPane';

export function CommsApp() {
  const { activePropertyId: pid } = useProperty();
  const { locale } = useLang();
  const L = React.useCallback<LType>((en, es) => (locale === 'es' ? es : en), [locale]);

  const [boot, setBoot] = React.useState<BootstrapData | null>(null);
  const [selId, setSelId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<MessageDTO[]>([]);
  const [mode, setMode] = React.useState<ViewMode>('chats');
  const [threadParent, setThreadParent] = React.useState<MessageDTO | null>(null);
  const [panel, setPanel] = React.useState<RightPanel>(null);
  const [catchOpen, setCatchOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [worklist, setWorklist] = React.useState<WorklistItem[]>([]);
  const [memberCount, setMemberCount] = React.useState<number | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
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
      if (v === 'logbook' || v === 'threads' || v === 'todo' || v === 'knowledge' || v === 'calendar') setMode(v);
    } catch { /* */ }
  }, []);

  const selConvo = boot?.conversations.find((c) => c.id === selId) ?? null;
  const online = React.useMemo(() => new Set(boot?.onlineStaffIds ?? []), [boot?.onlineStaffIds]);

  // ── Data ──────────────────────────────────────────────────────────────────
  const loadBoot = React.useCallback(async () => {
    if (!pid) return;
    const r = await apiGet<BootstrapData>(`/api/comms/bootstrap?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setBoot(r.data);
  }, [pid]);

  const loadThread = React.useCallback(async () => {
    if (!pid || !selId) return;
    const r = await apiGet<{ messages: MessageDTO[] }>(`/api/comms/messages?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(selId)}`);
    if (r.ok && r.data) {
      setMessages(r.data.messages);
      setTimeout(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, 30);
    }
  }, [pid, selId]);

  const loadWorklist = React.useCallback(async () => {
    if (!pid) return;
    const r = await apiGet<{ items: WorklistItem[] }>(`/api/worklist?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setWorklist(r.data.items);
  }, [pid]);

  React.useEffect(() => { void loadBoot(); void loadWorklist(); }, [loadBoot, loadWorklist]);
  React.useEffect(() => {
    if (!pid) return;
    const iv = setInterval(() => { if (!document.hidden) void loadBoot(); }, 8000);
    return () => clearInterval(iv);
  }, [pid, loadBoot]);

  React.useEffect(() => { setMessages([]); if (selId) void loadThread(); }, [selId, loadThread]);
  React.useEffect(() => {
    if (!selId || mode !== 'chats') return;
    const iv = setInterval(() => { if (!document.hidden) void loadThread(); }, 3000);
    return () => clearInterval(iv);
  }, [selId, mode, loadThread]);
  React.useEffect(() => { if (mode === 'todo') void loadWorklist(); }, [mode, loadWorklist]);
  React.useEffect(() => {
    if (mode !== 'todo' || !pid) return;
    const iv = setInterval(() => { if (!document.hidden) void loadWorklist(); }, 15000);
    return () => clearInterval(iv);
  }, [mode, pid, loadWorklist]);

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
  const selectConversation = (id: string) => { setSelId(id); setMode('chats'); setThreadParent(null); setPanel(null); };
  const switchMode = (m: ViewMode) => { setMode(m); if (m !== 'chats') { setThreadParent(null); setPanel(null); } };
  const jump = (id: string) => { selectConversation(id); setCatchOpen(false); setSearchOpen(false); };
  const openThread = (m: MessageDTO) => { setPanel(null); setThreadParent((cur) => (cur?.id === m.id ? null : m)); };
  const togglePanel = (p: Exclude<RightPanel, null>) => { setThreadParent(null); setPanel((cur) => (cur === p ? null : p)); };

  const reactToggle = async (m: MessageDTO) => {
    if (!pid) return;
    await apiPost('/api/comms/react', { pid, messageId: m.id });
    await loadThread();
  };
  const pinToggle = async (m: MessageDTO) => {
    if (!pid) return;
    await apiPost('/api/comms/pin', { pid, messageId: m.id, pinned: !m.pinned });
    await loadThread();
  };
  const turnIntoTask = async (m: MessageDTO) => {
    if (!pid) return;
    await apiPost('/api/comms/tasks', { pid, title: (m.originalBody || m.body).slice(0, 200) || L('Message task', 'Tarea de mensaje'), sourceMessageId: m.id });
    setMode('todo'); setThreadParent(null); setPanel(null);
    await loadWorklist();
  };
  const openDm = async (staffId: string) => {
    if (!pid) return;
    const r = await apiPost<{ conversationId: string }>('/api/comms/dm', { pid, otherStaffId: staffId });
    if (r.data?.conversationId) { await loadBoot(); selectConversation(r.data.conversationId); setShowNew(false); setSearchOpen(false); }
  };

  if (!mounted) {
    // Stable neutral shell for SSR + first client render (pid unknown yet).
    return <div style={{ height: 'calc(100vh - 64px)', background: T.bg }} />;
  }
  if (!pid) {
    return <div style={{ padding: 40, fontFamily: SANS, color: T.dim }}>{L('Select a property to use Communications.', 'Selecciona una propiedad para usar Comunicaciones.')}</div>;
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
        ? <ThreadPanel pid={pid} conversation={selConvo} parent={threadParent} L={L} onClose={() => setThreadParent(null)} onReload={loadThread} />
        : panel === 'pinned' && selConvo
        ? <PinnedPanel pid={pid} conversation={selConvo} L={L} onClose={() => setPanel(null)} />
        : panel === 'members' && selConvo
        ? <MembersPanel pid={pid} conversation={selConvo} online={online} L={L} onClose={() => setPanel(null)} onMessage={openDm} />
        : null)
    : null;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', fontFamily: SANS, color: T.ink, background: T.bg, position: 'relative' }}>
      {/* ── Sidebar ── */}
      <aside style={{ width: 272, background: T.bg, borderRight: `1px solid ${T.hair}`, display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
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
      <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
        {mode === 'chats' && (
          <>
            {selConvo
              ? <MessagePane
                  pid={pid} me={boot!.me} conversation={selConvo} messages={messages} online={online} memberCount={memberCount} L={L}
                  activeThreadId={threadParent?.id ?? null} activePanel={panel} scrollRef={scrollRef}
                  onReloadThread={loadThread} onReloadBoot={loadBoot} onOpenThread={openThread} onTogglePanel={togglePanel}
                  onReactToggle={reactToggle} onPinToggle={pinToggle} onTurnIntoTask={turnIntoTask} onOpenSearch={() => setSearchOpen(true)} />
              : <EmptyHint text={L('Pick a conversation, or start a new message.', 'Elige una conversación o inicia un mensaje nuevo.')} />}
            {right}
          </>
        )}
        {mode === 'threads' && <ThreadsList pid={pid} L={L} onOpen={(convId, parent) => { selectConversation(convId); setThreadParent(parent); }} />}
        {mode === 'todo' && <TodoMode pid={pid} items={worklist} staff={boot?.staff ?? []} L={L} reload={loadWorklist} />}
        {mode === 'knowledge' && <div style={{ flex: 1, overflowY: 'auto' }}><KnowledgePane pid={pid} isManager={!!boot?.me.isManager} L={L} /></div>}
        {mode === 'logbook' && <LogbookMode key={pid} pid={pid} meName={boot?.me.displayName ?? L('You', 'Tú')} L={L} />}
        {mode === 'calendar' && <CalendarMode key={pid} pid={pid} isManager={!!boot?.me.isManager} L={L} />}
      </div>

      {/* ── Overlays ── */}
      {catchOpen && <CatchUp pid={pid} conversations={conversations} L={L} onJump={jump} onClose={() => setCatchOpen(false)} />}
      {searchOpen && <SearchPalette pid={pid} L={L} onClose={() => setSearchOpen(false)} onJump={jump} onOpenDm={openDm} />}
      {showNew && boot && <NewMessageModal staff={boot.staff} L={L} onPick={openDm} onClose={() => setShowNew(false)} />}

      <style>{`.comms-spin{animation:comms-spin 1s linear infinite}@keyframes comms-spin{to{transform:rotate(360deg)}}`}</style>
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
        {show && <span style={{ position: 'absolute', left: 0, top: '100%', marginTop: 5, whiteSpace: 'nowrap', zIndex: 50, pointerEvents: 'none', background: T.ink, color: '#fff', fontFamily: SANS, fontSize: 11.5, fontWeight: 500, padding: '5px 9px', borderRadius: 7, boxShadow: '0 6px 18px rgba(24,22,17,.22)' }}>{tip}</span>}
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
  const [items, setItems] = React.useState<ThreadSummaryDTO[]>([]);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const r = await apiGet<{ threads: ThreadSummaryDTO[] }>(`/api/comms/threads?pid=${encodeURIComponent(pid)}`);
      if (live && r.ok && r.data) setItems(r.data.threads);
    })();
    return () => { live = false; };
  }, [pid]);
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ marginBottom: 7 }}><MonoLabel>{L(`${items.length} threads`, `${items.length} hilos`)}</MonoLabel></div>
        <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Threads', 'Hilos')}</div>
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.length === 0 && <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '22px 16px', textAlign: 'center', border: `1px dashed ${T.hair}`, borderRadius: 12 }}>{L('No threads yet. Reply to a message to start one.', 'Sin hilos aún. Responde a un mensaje para empezar uno.')}</div>}
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
