'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic redesign — root.
// Sidebar (channels / DMs / announcements + To-do / Log book nav) · message
// pane · on-demand Thread/Pinned/Members panels · Search palette. All data via
// /api/comms/*. NO SMS.
//
// Retired 2026-07-27: the "Catch up" popover, and the "Threads" nav view (the
// aggregated list of every live thread). Threaded replies themselves are
// untouched — openThread below, ThreadPanel, GET /api/comms/thread (SINGULAR)
// and POST /api/comms/send with parentMessageId all still run the in-
// conversation reply drawer. Calendar also lost its nav item the same day: it
// is now a view inside To-do (see TodoMode).
//
// Retired 2026-07-28: the "Knowledge" and "Contacts" nav views. Both moved to
// the Knows tab's told half (/feed → Knows → "What you've told it"), which is
// where human-asserted knowledge now lives alongside what the copilot worked
// out on its own. The /api/knowledge/* routes are unchanged and still serve
// both — see KNOWLEDGE_CTX in lib/comms/route-helpers.ts for why they no
// longer gate on this section. ?view=knowledge and ?view=contacts redirect
// rather than falling through, so old links land on the real thing.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Search, ListTodo, Megaphone, Plus, ChevronLeft, AlertCircle, Loader2, RefreshCw, X } from 'lucide-react';
import { useProperty } from '@/contexts/PropertyContext';
import { apiGet, apiPost } from '@/lib/comms/client';
import type { ConversationDTO, MessageDTO } from '@/lib/comms/types';
import type { WorklistItem } from '@/lib/worklist/types';
import { useCommsResource } from './comms-data';
import type { BootstrapData, ViewMode, RightPanel, L as LType } from './comms-types-fe';
import { T, SANS, MONO, deptColorDark, Avatar, Presence } from './comms-ui';
import { MessagePane, ThreadPanel, PinnedPanel, MembersPanel } from './MessagePane';
import { SearchPalette, NewMessageModal } from './CommsOverlays';

/**
 * Coalesce concurrent attempts to run the same read into one request. The
 * active promise is released only after it settles, so a poll interval shorter
 * than the server response time cannot build an overlapping request train or
 * invalidate the slow-but-successful response that started first.
 */
export function createSingleFlightRequest<T>(request: () => Promise<T>): (ensureFresh?: boolean) => Promise<T> {
  let tail: Promise<T> | null = null;
  let trailingFresh: Promise<T> | null = null;
  let freshAgain = false;

  const release = (pending: Promise<T>) => {
    if (tail === pending) tail = null;
    if (trailingFresh === pending) trailingFresh = null;
  };

  return (ensureFresh = false) => {
    // Ordinary polls join the current/queued request. A mutation or explicit
    // retry can request one trailing read that begins only after the current
    // transport settles. Further fresh requests coalesce behind it; if one
    // arrives while that trailing read is already running, the loop performs
    // exactly one more read afterward so its caller cannot adopt an older
    // snapshot. Poll ticks never increase the queue.
    if (!tail) {
      const pending = Promise.resolve().then(request);
      tail = pending;
      void pending.then(() => release(pending), () => release(pending));
      return pending;
    }
    if (!ensureFresh) return tail;

    if (trailingFresh) {
      freshAgain = true;
      return trailingFresh;
    }

    const active = tail;
    const pending = (async () => {
      try { await active; } catch { /* the fresh read can recover */ }
      let result!: T;
      let lastError: unknown;
      do {
        freshAgain = false;
        try {
          result = await request();
          lastError = undefined;
        } catch (error) {
          lastError = error;
        }
      } while (freshAgain);
      if (lastError !== undefined) throw lastError;
      return result;
    })();
    trailingFresh = pending;
    tail = pending;
    // Both handlers return normally, so the housekeeping promise cannot create
    // an unhandled rejection when the request itself fails.
    void pending.then(() => release(pending), () => release(pending));
    return pending;
  };
}

export function CommsApp() {
  const { activePropertyId } = useProperty();
  // A hotel switch is a resource-boundary change, not an ordinary refresh.
  // Remount the workspace so no conversations, messages, badges, or modal
  // state from the previous hotel can remain while the next request settles.
  return <CommsPropertyApp key={activePropertyId ?? 'no-property'} pid={activePropertyId} />;
}

function CommsPropertyApp({ pid }: { pid: string | null }) {
  const L = React.useCallback<LType>((english) => english, []);

  const [selId, setSelId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<MessageDTO[]>([]);
  const [mode, setMode] = React.useState<ViewMode>('chats');
  const [threadParent, setThreadParent] = React.useState<MessageDTO | null>(null);
  const [panel, setPanel] = React.useState<RightPanel>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [memberCount, setMemberCount] = React.useState<number | null>(null);
  const [mobileDetail, setMobileDetail] = React.useState(false);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesError, setMessagesError] = React.useState<string | null>(null);
  const [mutationError, setMutationError] = React.useState<string | null>(null);
  /** Confirmation that "turn this into a task" landed, and where. */
  const [taskNotice, setTaskNotice] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const threadRequestRef = React.useRef(0);
  const threadLoadRef = React.useRef<{
    scope: string;
    token: object;
    run: (ensureFresh?: boolean) => Promise<void>;
  } | null>(null);
  // `pid` comes from a client-only context (reads localStorage), so it's null
  // during SSR but already set on the first client render. Branching the render
  // on it directly made the server HTML ("Select a property…") disagree with the
  // client (the full app) → React hydration mismatch (#418). Gate the pid branch
  // on `mounted` so SSR and the first client render produce identical markup.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
    // Every ?view= this tab ever answered still has to arrive somewhere real.
    // Read client-only (after mount) so SSR/first-render markup stays identical
    // (#418).
    //
    // To-do, Calendar and the Log book LEFT on 2026-07-30: the list of
    // everything that needs a person is the Staxis tab now, and the log book is
    // a button on it. Every one of those links redirects rather than falling
    // through, because falling through lands on Messages with no explanation
    // and reads as a broken button. Knowledge and Contacts left earlier, the
    // same way.
    try {
      const v = new URLSearchParams(window.location.search).get('view');
      if (v === 'todo' || v === 'calendar' || v === 'logbook') {
        window.location.replace('/feed');
      } else if (v === 'knowledge' || v === 'contacts') {
        window.location.replace('/feed?tab=knows');
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
  const selConvo = boot?.conversations.find((c) => c.id === selId) ?? null;
  const online = React.useMemo(() => new Set(boot?.onlineStaffIds ?? []), [boot?.onlineStaffIds]);

  // Messages stay hand-rolled: switching conversations must BLANK the pane
  // (not hold the previous thread's messages), and every successful fetch —
  // polls included — re-pins the scroll to the bottom. Neither survives
  // useCommsResource's silent keep-last-good source switches.
  const loadThread = React.useCallback((showLoading = false, ensureFresh = false): Promise<void> => {
    if (!pid || !selId) return Promise.resolve();
    if (showLoading) setMessagesLoading(true);
    const scope = `${pid}\u0000${selId}`;
    let loader = threadLoadRef.current;
    if (!loader || loader.scope !== scope) {
      const url = `/api/comms/messages?pid=${encodeURIComponent(pid)}&conversationId=${encodeURIComponent(selId)}`;
      const token = {};
      const nextLoader = {
        scope,
        token,
        run: createSingleFlightRequest(async () => {
          // A trailing request queued for an old conversation must evaporate
          // before it reaches the transport or advances the shared ticket.
          if (threadLoadRef.current?.token !== token) return;
          // Increment only when a transport actually starts. Poll ticks that
          // join this promise do not supersede its response.
          const requestId = ++threadRequestRef.current;
          const r = await apiGet<{ messages: MessageDTO[] }>(url);
          if (threadLoadRef.current?.token !== token || requestId !== threadRequestRef.current) return;
          if (r.ok && r.data) {
            setMessages(r.data.messages);
            setMessagesError(null);
            setTimeout(() => {
              if (threadLoadRef.current?.token === token && requestId === threadRequestRef.current) {
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
              }
            }, 30);
          } else {
            setMessagesError(r.error || 'Could not load messages.');
          }
        }),
      };
      loader = nextLoader;
      threadLoadRef.current = nextLoader;
    }
    if (ensureFresh) {
      // A poll that began before the mutation/manual retry is no longer an
      // acceptable UI snapshot. Invalidate its commit immediately; the queued
      // trailing transport takes its own newer ticket when it actually starts.
      threadRequestRef.current += 1;
    }
    const pending = loader.run(ensureFresh);
    if (showLoading) {
      const finishLoading = () => {
        if (threadLoadRef.current === loader) setMessagesLoading(false);
      };
      void pending.then(finishLoading, finishLoading);
    }
    return pending;
  }, [pid, selId]);

  React.useEffect(() => {
    threadRequestRef.current += 1;
    setMessages([]);
    setMessagesError(null);
    setMessagesLoading(!!selId);
    if (selId) void loadThread(true);
    return () => {
      threadRequestRef.current += 1;
      threadLoadRef.current = null;
    };
  }, [selId, loadThread]);
  React.useEffect(() => {
    if (!selId || mode !== 'chats') return;
    const iv = setInterval(() => { if (!document.hidden) void loadThread(); }, 3000);
    return () => clearInterval(iv);
  }, [selId, mode, loadThread]);
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
  const jump = (id: string) => { selectConversation(id); setSearchOpen(false); };
  const openThread = (m: MessageDTO) => { setPanel(null); setThreadParent((cur) => (cur?.id === m.id ? null : m)); };
  const togglePanel = (p: Exclude<RightPanel, null>) => { setThreadParent(null); setPanel((cur) => (cur === p ? null : p)); };
  const showMobileList = () => { setMobileDetail(false); setThreadParent(null); setPanel(null); };
  const actionFailed = (message: string) => setMutationError(message);

  const reactToggle = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/react', { pid, messageId: m.id });
    if (!r.ok) { actionFailed('Could not update the acknowledgement. Please try again.'); return; }
    await loadThread(false, true);
  };
  const pinToggle = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/pin', { pid, messageId: m.id, pinned: !m.pinned });
    if (!r.ok) { actionFailed('Could not update the pinned message. Please try again.'); return; }
    await loadThread(false, true);
  };
  const turnIntoTask = async (m: MessageDTO) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost('/api/comms/tasks', { pid, title: (m.originalBody || m.body).slice(0, 200) || 'Message task', sourceMessageId: m.id });
    if (!r.ok) { actionFailed('Could not turn this message into a task. Please try again.'); return; }
    // The to-do it just created lives on the Staxis list now, so this used to
    // switch to a nav item that no longer exists. Say where it went rather than
    // navigating away mid-conversation: the person is reading a thread, and
    // yanking them to another tab to look at a row they already know about is
    // the more annoying of the two wrong answers.
    setTaskNotice('Added to your Staxis list.');
  };
  const openDm = async (staffId: string) => {
    if (!pid) return;
    setMutationError(null);
    const r = await apiPost<{ conversationId: string }>('/api/comms/dm', { pid, otherStaffId: staffId });
    if (!r.ok || !r.data?.conversationId) { actionFailed('Could not start the direct message. Please try again.'); return; }
    await loadBoot(); selectConversation(r.data.conversationId); setShowNew(false); setSearchOpen(false);
  };

  if (!mounted) {
    // Stable neutral shell for SSR + first client render (pid unknown yet).
    // Same card frame as the real workspace so hydration doesn't flash.
    return <div style={{ flex: 1, minHeight: 0, background: T.bg, borderRadius: 18, border: '1px solid rgba(31,35,28,.08)' }} />;
  }
  if (!pid) {
    return <div style={{ padding: 40, fontFamily: SANS, color: T.dim }}>{'Select a property to use Communications.'}</div>;
  }
  if (!boot) {
    return (
      <div className="comms-shell" style={{ display: 'flex', flex: 1, minHeight: 0, fontFamily: SANS, color: T.ink, background: T.bg, position: 'relative', borderRadius: 18, border: '1px solid rgba(31,35,28,.08)', boxShadow: '0 6px 16px -14px rgba(31,42,32,.35)', overflow: 'hidden' }}>
        <ResourceState
          loading={bootLoading || !bootError}
          title={bootLoading || !bootError ? 'Loading Communications…' : 'Communications could not load'}
          detail={bootLoading || !bootError ? 'Getting conversations and staff for this property.' : 'Check your connection, then try again. Your data has not been changed.'}
          retryLabel={'Try again'}
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

  const right = mode === 'chats'
    ? (threadParent && selConvo
        ? <ThreadPanel key={`${selConvo.id}:${threadParent.id}`} pid={pid} conversation={selConvo} parent={threadParent} L={L} onClose={() => setThreadParent(null)} onReload={() => loadThread(false, true)} />
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
          <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 16, color: T.ink }}>{'Messages'}</div>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: T.dim, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <Presence on={onShiftCount > 0} size={7} /> {`${onShiftCount} on shift`}
          </div>
        </div>

        <div style={{ padding: '10px 12px 6px' }}>
          <button onClick={() => setSearchOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 11px', borderRadius: 8, border: `1px solid ${T.hair}`, background: T.paper, color: T.dim, cursor: 'pointer', fontFamily: SANS, fontSize: 13 }}>
            <Search size={14} /> {'Jump to or search…'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 4, paddingBottom: 14 }}>

          <SidebarSection label={'Announcements'} onAdd={() => setSearchOpen(true)} tip={'Post an announcement'} />
          {announce.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
          <SidebarSection label={'Channels'} onAdd={() => setSearchOpen(true)} tip={'Browse channels'} />
          {channels.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
          <SidebarSection label={'Direct messages'} onAdd={() => setShowNew(true)} tip={'Start a direct message'} />
          {dms.length === 0 && <div style={{ padding: '4px 20px', fontSize: 12, color: T.dim, fontFamily: SANS }}>{'No conversations yet'}</div>}
          {dms.map((c) => <ConvoRow key={c.id} c={c} active={mode === 'chats' && c.id === selId} online={online} onClick={() => selectConversation(c.id)} L={L} />)}
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="comms-main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="comms-mobile-backbar">
          <button className="comms-mobile-back" onClick={showMobileList} aria-label={'Back to conversations'}>
            <ChevronLeft size={20} aria-hidden="true" />
            <span>{'Conversations'}</span>
          </button>
        </div>
        <div className="comms-main-content" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', position: 'relative' }}>
          {mode === 'chats' && (
            <>
              {selConvo
                ? <MessagePane
                    pid={pid} me={boot.me} conversation={selConvo} messages={messages} online={online} memberCount={memberCount} L={L}
                    messagesLoading={messagesLoading} messagesError={messagesError} onRetryMessages={() => void loadThread(true, true)}
                    activeThreadId={threadParent?.id ?? null} activePanel={panel} scrollRef={scrollRef}
                    onReloadThread={() => loadThread(false, true)} onReloadBoot={loadBoot} onOpenThread={openThread} onTogglePanel={togglePanel}
                    onReactToggle={reactToggle} onPinToggle={pinToggle} onTurnIntoTask={turnIntoTask} onOpenSearch={() => setSearchOpen(true)} />
                : <EmptyHint text={'Pick a conversation, or start a new message.'} />}
              {right}
            </>
          )}
        </div>
      </div>

      {/* ── Overlays ── */}
      {searchOpen && <SearchPalette pid={pid} L={L} onClose={() => setSearchOpen(false)} onJump={jump} onOpenDm={openDm} />}
      {showNew && boot && <NewMessageModal staff={boot.staff} L={L} onPick={openDm} onClose={() => setShowNew(false)} />}

      {(bootError || mutationError || taskNotice) && (
        <div className="comms-alert-stack">
          {taskNotice && (
            /* "Turn this into a task" used to switch to the To-do nav item.
               That item is gone; the to-do is on the Staxis list. Say so and
               offer the way there, rather than yanking somebody out of a
               conversation they are in the middle of. */
            <div className="comms-action-alert" role="status">
              <ListTodo size={18} aria-hidden="true" />
              <span>{taskNotice}</span>
              <a href="/feed" style={{ fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>{'Open Staxis'}</a>
              <button onClick={() => setTaskNotice(null)} aria-label={'Dismiss'}><X size={18} aria-hidden="true" /></button>
            </div>
          )}
          {bootError && (
            <div className="comms-action-alert" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span>{'Conversations could not refresh. Showing the last results.'}</span>
              <button onClick={() => void loadBoot()} aria-label={'Retry loading conversations'}><RefreshCw size={17} aria-hidden="true" /></button>
            </div>
          )}
          {mutationError && (
            <div className="comms-action-alert" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span>{mutationError}</span>
              <button onClick={() => setMutationError(null)} aria-label={'Dismiss error'}><X size={18} aria-hidden="true" /></button>
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
