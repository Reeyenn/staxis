'use client';

import React from 'react';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import {
  Megaphone,
  Users,
  Search,
  Plus,
  ChevronLeft,
  ChevronRight,
  Send,
  Pin,
  Loader2,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { fmtTimeOrDate as fmtTime } from '@/lib/format-date';
import { initialsOf } from '@/app/_components/ui/Avatar';
import type { HousekeeperLocale } from '@/lib/translations';
import { t } from '@/lib/translations';
import type { ConversationDTO, MessageDTO, StaffLite } from '@/lib/comms/types';
import {
  captureMessageScrollAnchor,
  restoreMessageScrollAnchor,
  type MessageCursor,
  type MessageScrollAnchor,
  type MessagesPageDTO,
} from '@/lib/comms/message-pagination';
import { TOK } from './tokens';

/**
 * MessagesTab — the redesigned Communications surface (Claude Design handoff),
 * wired to the real comms backend at /api/housekeeper/messages/* (the same
 * service-role, capability-gated routes the old HousekeeperMessages drawer
 * used). One recent-sorted inbox (announcements + channels + DMs), a thread
 * view, and a DM-anyone compose picker.
 */

type ConvKind = 'dm' | 'group' | 'announcement';
interface Conv {
  id: string;
  kind: ConvKind;
  name: string;
  role?: string;
  members?: number;
  last: string;
  time: string;
  unread: number;
  pinned?: boolean;
  urgent?: boolean;
  color?: string;
}
interface Msg {
  id: string;
  createdAt: string;
  from: string;
  text: string;
  time: string;
  mine: boolean;
}

const DEPT_COLOR: Record<string, string> = {
  management: '#5A6B8C',
  front_desk: '#0E7C7B',
  housekeeping: '#2F8049',
  maintenance: '#B0712F',
  laundry: '#C0603D',
};

async function hkPost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withStaffLinkTokenBody((body ?? {}) as Record<string, unknown>)),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T };
    return json.ok ? (json.data ?? null) : null;
  } catch {
    return null;
  }
}

function mapMessages(messages: MessageDTO[]): Msg[] {
  return messages.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    from: m.senderName,
    text: m.body,
    time: fmtTime(m.createdAt),
    mine: m.mine,
  }));
}

function mergeMessages(existing: Msg[], incoming: Msg[]): Msg[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    const timeOrder = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return timeOrder || a.id.localeCompare(b.id);
  });
}

function mapConv(c: ConversationDTO): Conv {
  const kind: ConvKind = c.kind === 'channel' ? 'group' : c.kind;
  return {
    id: c.id,
    kind,
    name: c.title,
    members: c.memberCount,
    last: c.lastMessagePreview ?? '',
    time: fmtTime(c.lastMessageAt),
    unread: c.unread ?? 0,
    pinned: c.kind === 'announcement',
    urgent: (c.pendingAck ?? 0) > 0,
    color: DEPT_COLOR[c.dept ?? ''] ?? '#3B5BA5',
  };
}

interface Inbox {
  me: { staffId: string; name: string; lang: string };
  conversations: ConversationDTO[];
  staff: StaffLite[];
}

type View = 'inbox' | 'thread' | 'compose';

export function MessagesTab({
  pid,
  staffId,
  lang,
  onUnreadChange,
}: {
  pid: string;
  staffId: string;
  lang: HousekeeperLocale;
  onUnreadChange?: (n: number) => void;
}) {
  const [inbox, setInbox] = React.useState<Inbox | null>(null);
  const [view, setView] = React.useState<View>('inbox');
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesError, setMessagesError] = React.useState<string | null>(null);
  const [messagesHasOlder, setMessagesHasOlder] = React.useState(false);
  const [messagesOlderKnown, setMessagesOlderKnown] = React.useState(false);
  const [messagesOlderLoading, setMessagesOlderLoading] = React.useState(false);
  const [messagesOlderError, setMessagesOlderError] = React.useState<string | null>(null);
  const messagesHasOlderRef = React.useRef(false);
  const olderHistoryRef = React.useRef(false);
  const threadRequestRef = React.useRef(0);
  const olderLoadRef = React.useRef<{ scope: string; cursor: MessageCursor; promise: Promise<void> } | null>(null);
  const olderScrollAnchorRef = React.useRef<{ requestId: number; anchor: MessageScrollAnchor } | null>(null);
  const messagesCursorRef = React.useRef<MessageCursor | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inboxRequestRef = React.useRef(0);
  messagesHasOlderRef.current = messagesHasOlder;

  const loadInbox = React.useCallback(async () => {
    const requestId = ++inboxRequestRef.current;
    const r = await hkPost<Inbox>('/api/housekeeper/messages', { pid, staffId });
    if (requestId !== inboxRequestRef.current) return;
    if (r) setInbox(r);
    setLoading(false);
  }, [pid, staffId]);

  React.useEffect(() => {
    threadRequestRef.current += 1;
    setInbox(null);
    setView('inbox');
    setActiveId(null);
    setMessages([]);
    setMessagesLoading(false);
    setMessagesError(null);
    setMessagesHasOlder(false);
    setMessagesOlderKnown(false);
    setMessagesOlderLoading(false);
    setMessagesOlderError(null);
    messagesHasOlderRef.current = false;
    olderHistoryRef.current = false;
    olderLoadRef.current = null;
    olderScrollAnchorRef.current = null;
    messagesCursorRef.current = null;
    setLoading(true);
    void loadInbox();
  }, [loadInbox]);

  const convs = React.useMemo(
    () => (inbox?.conversations ?? []).map(mapConv),
    [inbox],
  );
  const totalUnread = React.useMemo(() => convs.reduce((s, c) => s + c.unread, 0), [convs]);
  React.useEffect(() => {
    onUnreadChange?.(totalUnread);
  }, [totalUnread, onUnreadChange]);

  const active = React.useMemo(
    () => convs.find((c) => c.id === activeId) ?? null,
    [convs, activeId],
  );

  const openThread = React.useCallback(
    async (id: string) => {
      const requestId = ++threadRequestRef.current;
      setActiveId(id);
      setView('thread');
      setMessages([]);
      setMessagesLoading(true);
      setMessagesError(null);
      setMessagesHasOlder(false);
      setMessagesOlderKnown(false);
      setMessagesOlderLoading(false);
      setMessagesOlderError(null);
      messagesHasOlderRef.current = false;
      olderHistoryRef.current = false;
      olderLoadRef.current = null;
      olderScrollAnchorRef.current = null;
      messagesCursorRef.current = null;
      try {
        const data = await hkPost<MessagesPageDTO>(
          '/api/housekeeper/messages/thread',
          { pid, staffId, conversationId: id },
        );
        if (requestId !== threadRequestRef.current) return;
        if (data?.messages) {
          const page = mapMessages(data.messages);
          setMessages(page);
          messagesCursorRef.current = data.pagination.nextCursor;
          setMessagesHasOlder(data.pagination.hasOlder);
          setMessagesOlderKnown(true);
        } else {
          setMessagesError('Messages could not load. Check your connection and try again.');
        }
      } finally {
        if (requestId === threadRequestRef.current) setMessagesLoading(false);
      }
      if (requestId !== threadRequestRef.current) return;
      // Clear unread locally + on the server.
      setInbox((prev) =>
        prev
          ? {
              ...prev,
              conversations: prev.conversations.map((c) =>
                c.id === id ? { ...c, unread: 0 } : c,
              ),
            }
          : prev,
      );
      void hkPost('/api/housekeeper/messages/read', { pid, staffId, conversationId: id });
    },
    [pid, staffId],
  );

  const loadOlderMessages = React.useCallback((): Promise<void> => {
    if (!activeId || !messagesHasOlderRef.current) return Promise.resolve();
    const scope = `${pid}\u0000${staffId}\u0000${activeId}`;
    const cursor = messagesCursorRef.current;
    if (!cursor) {
      setMessagesHasOlder(false);
      setMessagesOlderKnown(true);
      return Promise.resolve();
    }
    const activeRequest = olderLoadRef.current;
    if (activeRequest?.scope === scope) return activeRequest.promise;
    const requestId = threadRequestRef.current;
    const scrollAnchor = scrollRef.current ? captureMessageScrollAnchor(scrollRef.current) : null;
    olderHistoryRef.current = true;
    setMessagesOlderLoading(true);
    setMessagesOlderError(null);

    let pending!: Promise<void>;
    pending = (async () => {
      try {
        const data = await hkPost<MessagesPageDTO>(
          '/api/housekeeper/messages/thread',
          { pid, staffId, conversationId: activeId, before: cursor.before, beforeId: cursor.beforeId },
        );
        if (requestId !== threadRequestRef.current) return;
        if (!data?.messages) {
          setMessagesOlderError('Older messages could not load.');
          return;
        }
        const page = mapMessages(data.messages);
        if (page.length > 0 && scrollAnchor) {
          olderScrollAnchorRef.current = { requestId, anchor: scrollAnchor };
        }
        if (page.length > 0) {
          setMessages((current) => mergeMessages(current, page));
        }
        messagesCursorRef.current = data.pagination.nextCursor;
        setMessagesHasOlder(data.pagination.hasOlder);
        setMessagesOlderKnown(true);
      } catch {
        if (requestId === threadRequestRef.current) setMessagesOlderError('Older messages could not load.');
      } finally {
        if (requestId === threadRequestRef.current) setMessagesOlderLoading(false);
        if (olderLoadRef.current?.promise === pending) olderLoadRef.current = null;
      }
    })();
    olderLoadRef.current = { scope, cursor, promise: pending };
    return pending;
  }, [activeId, pid, staffId]);

  React.useLayoutEffect(() => {
    const anchor = olderScrollAnchorRef.current;
    if (!anchor) return;
    olderScrollAnchorRef.current = null;
    if (anchor.requestId !== threadRequestRef.current) return;
    const element = scrollRef.current;
    if (element) restoreMessageScrollAnchor(element, anchor.anchor);
  }, [messages]);

  const send = React.useCallback(
    async (text: string) => {
      if (!activeId || !text.trim()) return;
      const requestId = threadRequestRef.current;
      const ok = await hkPost('/api/housekeeper/messages/send', {
        pid,
        staffId,
        conversationId: activeId,
        body: text.trim(),
        msgType: 'text',
      });
      if (ok !== null) {
        const data = await hkPost<MessagesPageDTO>(
          '/api/housekeeper/messages/thread',
          { pid, staffId, conversationId: activeId },
        );
        if (data?.messages && requestId === threadRequestRef.current) {
          const page = mapMessages(data.messages);
          if (olderHistoryRef.current) setMessages((current) => mergeMessages(current, page));
          else {
            setMessages(page);
            messagesCursorRef.current = data.pagination.nextCursor;
            setMessagesHasOlder(data.pagination.hasOlder);
            setMessagesOlderKnown(true);
          }
        }
      }
    },
    [pid, staffId, activeId],
  );

  const startDm = React.useCallback(
    async (otherStaffId: string) => {
      const data = await hkPost<{ conversationId: string }>(
        '/api/housekeeper/messages/dm',
        { pid, staffId, otherStaffId },
      );
      await loadInbox();
      if (data?.conversationId) void openThread(data.conversationId);
    },
    [pid, staffId, loadInbox, openThread],
  );

  if (view === 'thread' && active) {
    return (
      <Thread
        conv={active}
        messages={messages}
        accent={active.kind === 'announcement' ? '#B0712F' : TOK.teal}
        lang={lang}
        scrollRef={scrollRef}
        messagesLoading={messagesLoading}
        messagesError={messagesError}
        messagesHasOlder={messagesHasOlder}
        messagesOlderKnown={messagesOlderKnown}
        messagesOlderLoading={messagesOlderLoading}
        messagesOlderError={messagesOlderError}
        onLoadOlder={() => void loadOlderMessages()}
        onRetryMessages={() => { if (activeId) void openThread(activeId); }}
        onBack={() => setView('inbox')}
        onSend={send}
      />
    );
  }
  if (view === 'compose') {
    return (
      <Compose
        lang={lang}
        people={(inbox?.staff ?? []).filter((s) => s.id !== staffId)}
        onBack={() => setView('inbox')}
        onPick={startDm}
      />
    );
  }

  return (
    <div style={{ minHeight: '100%', background: '#fff' }}>
      <div style={{ padding: '20px 16px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-.02em', color: TOK.ink }}>{t('hkTabMessages', lang)}</h1>
        <button
          onClick={() => setView('compose')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 42,
            padding: '0 16px',
            borderRadius: 99,
            border: 'none',
            background: TOK.teal,
            color: '#fff',
            fontSize: 14.5,
            fontWeight: 800,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <Plus size={18} color="#fff" /> {t('hkNewMessage', lang)}
        </button>
      </div>
      {loading ? (
        <div style={{ padding: '40px 16px', textAlign: 'center', color: TOK.ink3, fontSize: 14 }}>…</div>
      ) : convs.length === 0 ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: TOK.ink3, fontSize: 14, lineHeight: 1.6 }}>
          {t('hkNoMessages', lang)}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {convs.map((c) => (
            <ConvRow key={c.id} conv={c} onTap={() => openThread(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ conv, size = 46 }: { conv: { kind?: ConvKind; name?: string; color?: string }; size?: number }) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontWeight: 800,
    fontSize: size * 0.36,
  };
  if (conv.kind === 'announcement')
    return (
      <span style={{ ...base, background: '#FBEFD9', color: '#9A6B12' }}>
        <Megaphone size={size * 0.48} color="#B0712F" />
      </span>
    );
  if (conv.kind === 'group')
    return (
      <span style={{ ...base, background: '#E2F0EF', color: '#0E7C7B' }}>
        <Users size={size * 0.5} color="#0E7C7B" />
      </span>
    );
  return <span style={{ ...base, background: conv.color || '#3B5BA5' }}>{initialsOf(conv.name || '?', '')}</span>;
}

function ConvRow({ conv, onTap }: { conv: Conv; onTap: () => void }) {
  const unread = conv.unread > 0;
  return (
    <button
      onClick={onTap}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '13px 16px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Avatar conv={conv} size={48} />
      <div style={{ flex: 1, minWidth: 0, borderBottom: '1px solid #F0F1F4', paddingBottom: 13, marginTop: 13, marginBottom: -13 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: unread ? 800 : 700,
              color: TOK.ink,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            {conv.pinned && <Pin size={13} color="#B0712F" />}
            {conv.name}
            {conv.urgent && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#D14343' }} />}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: unread ? TOK.teal : TOK.ink3, fontWeight: unread ? 700 : 500, flexShrink: 0 }}>
            {conv.time}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <span
            style={{
              flex: 1,
              fontSize: 13,
              color: unread ? TOK.ink2 : TOK.ink3,
              fontWeight: unread ? 600 : 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {conv.last}
          </span>
          {unread && (
            <span
              style={{
                minWidth: 20,
                height: 20,
                borderRadius: 99,
                background: TOK.teal,
                color: '#fff',
                fontSize: 11.5,
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 6px',
                flexShrink: 0,
              }}
            >
              {conv.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function Thread({
  conv,
  messages,
  accent,
  lang,
  scrollRef,
  messagesLoading,
  messagesError,
  messagesHasOlder,
  messagesOlderKnown,
  messagesOlderLoading,
  messagesOlderError,
  onLoadOlder,
  onRetryMessages,
  onBack,
  onSend,
}: {
  conv: Conv;
  messages: Msg[];
  accent: string;
  lang: HousekeeperLocale;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messagesLoading: boolean;
  messagesError: string | null;
  messagesHasOlder: boolean;
  messagesOlderKnown: boolean;
  messagesOlderLoading: boolean;
  messagesOlderError: string | null;
  onLoadOlder: () => void;
  onRetryMessages: () => void;
  onBack: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = React.useState('');
  const readOnly = conv.kind === 'announcement';
  const newestMessageRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const newestMessageId = messages[messages.length - 1]?.id ?? null;
    if (newestMessageId !== newestMessageRef.current && !messagesOlderLoading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    newestMessageRef.current = newestMessageId;
  }, [messages, messagesOlderLoading, scrollRef]);
  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };
  const sub =
    conv.kind === 'group'
      ? `${conv.members ?? 0} ${t('hkMembers', lang)}`
      : conv.kind === 'announcement'
        ? t('hkFromManagement', lang)
        : conv.role || t('hkDirectMessage', lang);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#EFF1F4' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #E6E8EC', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 12px' }}>
          <button
            onClick={onBack}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              height: 38,
              padding: '0 13px 0 9px',
              borderRadius: 11,
              border: 'none',
              background: '#F2F3F5',
              cursor: 'pointer',
              flexShrink: 0,
              fontSize: 13.5,
              fontWeight: 700,
              color: TOK.ink,
            }}
          >
            <ChevronLeft size={19} color={TOK.ink} /> {t('hkBack', lang)}
          </button>
          <Avatar conv={conv} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 800, color: TOK.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {conv.name}
            </div>
            <div style={{ fontSize: 11.5, color: TOK.ink3, fontWeight: 600 }}>{sub}</div>
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messagesLoading && messages.length === 0 && (
          <div role="status" aria-live="polite" style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, color: TOK.ink3, fontSize: 13, padding: 18 }}>
            <Loader2 size={15} className="comms-spin" aria-hidden="true" /> {'Loading messages…'}
          </div>
        )}
        {messagesError && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 11px', borderRadius: 9, border: '1px solid rgba(184,92,61,.24)', background: 'rgba(184,92,61,.08)', color: '#A84F37', fontSize: 12.5 }}>
            <AlertCircle size={15} aria-hidden="true" />
            <span style={{ flex: 1 }}>{'Messages could not load. Check your connection and try again.'}</span>
            <button onClick={onRetryMessages} disabled={messagesLoading} aria-label={'Retry loading messages'} style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid rgba(184,92,61,.28)', background: '#fff', color: '#A84F37', cursor: messagesLoading ? 'wait' : 'pointer' }}>
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {messagesOlderKnown && messages.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 10 }}>
            {messagesOlderError ? (
              <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 11px', borderRadius: 9, border: '1px solid rgba(184,92,61,.24)', background: 'rgba(184,92,61,.08)', color: '#A84F37', fontSize: 12.5 }}>
                <AlertCircle size={15} aria-hidden="true" />
                <span style={{ flex: 1 }}>{'Older messages could not load.'}</span>
                <button onClick={onLoadOlder} disabled={messagesOlderLoading} aria-label={'Retry loading older messages'} style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid rgba(184,92,61,.28)', background: '#fff', color: '#A84F37', cursor: messagesOlderLoading ? 'wait' : 'pointer' }}>
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
              </div>
            ) : messagesHasOlder ? (
              <button onClick={onLoadOlder} disabled={messagesOlderLoading} aria-busy={messagesOlderLoading} style={{ minHeight: 44, padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 9, border: '1px solid #DDE0E6', background: '#fff', color: TOK.teal, cursor: messagesOlderLoading ? 'wait' : 'pointer', fontSize: 12.5, fontWeight: 700 }}>
                {messagesOlderLoading ? <Loader2 size={14} className="comms-spin" aria-hidden="true" /> : null}
                <span>{messagesOlderLoading ? 'Loading older messages…' : 'Load older messages'}</span>
              </button>
            ) : (
              <div role="status" aria-live="polite" style={{ color: TOK.ink3, fontSize: 12 }}>{'No older messages.'}</div>
            )}
          </div>
        )}
        {conv.kind === 'announcement' && (
          <div style={{ alignSelf: 'center', fontSize: 11.5, fontWeight: 600, color: TOK.ink3, background: '#E4E7EC', padding: '5px 12px', borderRadius: 99, marginBottom: 8 }}>
            📣 {t('hkAnnouncementsFromMgmt', lang)}
          </div>
        )}
        {!messagesLoading && !messagesError && messages.length === 0 && (
          <div role="status" style={{ alignSelf: 'center', color: TOK.ink3, fontSize: 13, padding: 24 }}>{'No messages yet.'}</div>
        )}
        {messages.map((m, i) => {
          const mine = m.mine;
          const showName = !mine && conv.kind !== 'dm' && (i === 0 || messages[i - 1].from !== m.from);
          return (
            <div
              key={m.id}
              data-message-id={m.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: mine ? 'flex-end' : 'flex-start',
                marginTop: i > 0 && messages[i - 1].from !== m.from ? 8 : 0,
              }}
            >
              {showName && <span style={{ fontSize: 11, fontWeight: 700, color: accent, margin: '0 0 3px 6px' }}>{m.from}</span>}
              <div
                style={{
                  maxWidth: '80%',
                  padding: '9px 13px',
                  borderRadius: 16,
                  fontSize: 14.5,
                  lineHeight: 1.4,
                  background: mine ? accent : '#fff',
                  color: mine ? '#fff' : TOK.ink,
                  borderBottomRightRadius: mine ? 5 : 16,
                  borderBottomLeftRadius: mine ? 16 : 5,
                  boxShadow: mine ? 'none' : '0 1px 2px rgba(16,24,40,.06)',
                }}
              >
                {m.text}
              </div>
              <span style={{ fontSize: 10, color: TOK.ink3, margin: '3px 6px 0' }}>{m.time}</span>
            </div>
          );
        })}
      </div>

      <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #E6E8EC', padding: '10px 12px calc(10px + env(safe-area-inset-bottom, 8px))' }}>
        {readOnly ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, color: TOK.ink3, fontSize: 13, fontWeight: 600 }}>
            <Megaphone size={15} color={TOK.ink3} /> {t('hkOnlyManagersPost', lang)}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={t('hkMessagePlaceholder', lang)}
              style={{ flex: 1, height: 46, borderRadius: 23, border: '1px solid #DDE0E6', background: TOK.subtle, padding: '0 16px', fontSize: 15, outline: 'none' }}
            />
            <button
              onClick={submit}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 46,
                padding: '0 18px',
                borderRadius: 23,
                border: 'none',
                background: text.trim() ? accent : '#CDD2DA',
                color: '#fff',
                fontSize: 15,
                fontWeight: 800,
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'background .2s',
              }}
            >
              {t('hkSend', lang)} <Send size={16} color="#fff" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Compose({
  lang,
  people,
  onBack,
  onPick,
}: {
  lang: HousekeeperLocale;
  people: StaffLite[];
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = React.useState('');
  const list = people.filter(
    (p) =>
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      (p.department || '').toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div style={{ minHeight: '100%', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px' }}>
        <button
          onClick={onBack}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            height: 38,
            padding: '0 13px 0 9px',
            borderRadius: 11,
            border: 'none',
            background: '#F2F3F5',
            cursor: 'pointer',
            fontSize: 13.5,
            fontWeight: 700,
            color: TOK.ink,
          }}
        >
          <ChevronLeft size={19} color={TOK.ink} /> {t('hkBack', lang)}
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 800, color: TOK.ink }}>{t('hkNewMessage', lang)}</h1>
      </div>
      <div style={{ padding: '0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, height: 46, borderRadius: 14, background: '#F2F3F5', padding: '0 14px' }}>
          <Search size={18} color={TOK.ink3} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('hkSearchPeople', lang)}
            style={{ flex: 1, border: 'none', background: 'none', fontSize: 15, outline: 'none' }}
          />
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 800, color: TOK.ink3, letterSpacing: '.08em', textTransform: 'uppercase', margin: '18px 2px 8px' }}>
          {t('hkPeople', lang)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 13,
                padding: '11px 6px',
                background: 'none',
                border: 'none',
                borderBottom: '1px solid #F0F1F4',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Avatar conv={{ kind: 'dm', name: p.name, color: DEPT_COLOR[p.channel] ?? '#3B5BA5' }} size={44} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: TOK.ink }}>{p.name}</div>
                <div style={{ fontSize: 12.5, color: TOK.ink3 }}>{p.department || ''}</div>
              </div>
              <ChevronRight size={18} color="#C5C9D0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
