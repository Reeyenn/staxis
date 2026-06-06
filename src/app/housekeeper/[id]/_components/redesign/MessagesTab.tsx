'use client';

import React from 'react';
import {
  Megaphone,
  Users,
  Bell,
  Search,
  Plus,
  ChevronLeft,
  ChevronRight,
  Send,
  Pin,
} from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
import { t } from '@/lib/translations';
import { TOK } from './tokens';

/**
 * MessagesTab — the redesigned Communications surface (Claude Design handoff):
 * one recent-sorted inbox (announcements + group chats + DMs), a thread view,
 * and a DM-anyone compose picker.
 *
 * PHASE 1 (look-first): renders SAMPLE conversations so the design can be
 * reviewed end-to-end. The real wiring already exists at /api/housekeeper/
 * messages/* (see HousekeeperMessages.tsx) and is swapped in as the
 * "connect everything" follow-up — the chrome here is intentionally shaped
 * to match those DTOs.
 */

type ConvKind = 'announcement' | 'group' | 'dm';
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
  icon?: 'bell';
}
interface Msg {
  from: string;
  text: string;
  time: string;
}
interface Person {
  id: string;
  name: string;
  role: string;
  color: string;
  icon?: 'bell';
}

const ME = 'me';

// ── Sample data (placeholder; replaced by real comms in the wiring step) ──
const SAMPLE_CONVOS: Conv[] = [
  { id: 'a1', kind: 'announcement', name: 'Hotel Announcements', last: 'Pool closed for maintenance until 3 PM today.', time: '9:12', unread: 1, pinned: true, urgent: true },
  { id: 'g1', kind: 'group', name: '2nd Floor Team', members: 5, last: "Rosa: I'll take 214 and 216 👍", time: '9:20', unread: 2, color: '#0E7C7B' },
  { id: 'p_carla', kind: 'dm', name: 'Carla Núñez', role: 'Head Housekeeper', last: 'Can you start with the checkouts on floor 2?', time: '9:18', unread: 1, color: '#3B5BA5' },
  { id: 'p_desk', kind: 'dm', name: 'Front Desk', role: 'Reception', last: 'Guest in 208 asked for early check-in.', time: '9:05', unread: 1, color: '#0E7C7B', icon: 'bell' },
  { id: 'a2', kind: 'announcement', name: "Today's Priorities", last: 'VIP arriving in 305 at 2 PM — extra attention please.', time: '8:30', unread: 0 },
  { id: 'p_james', kind: 'dm', name: 'James Okoro', role: 'Maintenance', last: 'On my way to fix the sink in 215.', time: '8:47', unread: 0, color: '#B0712F' },
  { id: 'g2', kind: 'group', name: 'Housekeeping Team', members: 12, last: 'Carla: Great work yesterday, everyone!', time: '8:00', unread: 0, color: '#0E7C7B' },
  { id: 'p_rosa', kind: 'dm', name: 'Rosa Díaz', role: '2nd Floor', last: 'Thank you!! 🙏', time: 'Yest', unread: 0, color: '#8A5CB4' },
];

const SAMPLE_SEED: Record<string, Msg[]> = {
  a1: [{ from: 'Management', text: 'Pool closed for maintenance until 3 PM today. Please let guests know if they ask.', time: '9:12' }],
  a2: [
    { from: 'Management', text: 'Good morning team! A few priorities for today:', time: '8:30' },
    { from: 'Management', text: 'VIP arriving in 305 at 2 PM — please give it extra attention.', time: '8:30' },
    { from: 'Management', text: 'Late checkout approved for 412 (until 1 PM).', time: '8:31' },
  ],
  g1: [
    { from: 'Carla Núñez', text: 'Team, we have 6 checkouts on floor 2 today.', time: '9:00' },
    { from: 'Linh Tran', text: "I've got 208 and 210.", time: '9:14' },
    { from: 'Rosa Díaz', text: "I'll take 214 and 216 👍", time: '9:20' },
  ],
  g2: [{ from: 'Carla Núñez', text: 'Great work yesterday, everyone! 🎉', time: '8:00' }],
  p_carla: [
    { from: 'Carla Núñez', text: "Morning! How's it going?", time: '9:02' },
    { from: ME, text: 'Good morning! Just finished 112.', time: '9:10' },
    { from: 'Carla Núñez', text: 'Can you start with the checkouts on floor 2?', time: '9:18' },
  ],
  p_desk: [{ from: 'Front Desk', text: 'Guest in 208 asked for early check-in.', time: '9:05' }],
  p_james: [
    { from: ME, text: 'Sink in 215 is draining slowly.', time: '8:40' },
    { from: 'James Okoro', text: 'On my way to fix the sink in 215.', time: '8:47' },
  ],
  p_rosa: [
    { from: ME, text: 'Left extra towels in the 2nd floor closet for you.', time: 'Yest' },
    { from: 'Rosa Díaz', text: 'Thank you!! 🙏', time: 'Yest' },
  ],
};

const SAMPLE_PEOPLE: Person[] = [
  { id: 'p_carla', name: 'Carla Núñez', role: 'Head Housekeeper', color: '#3B5BA5' },
  { id: 'p_desk', name: 'Front Desk', role: 'Reception', color: '#0E7C7B', icon: 'bell' },
  { id: 'p_james', name: 'James Okoro', role: 'Maintenance', color: '#B0712F' },
  { id: 'p_rosa', name: 'Rosa Díaz', role: '2nd Floor', color: '#8A5CB4' },
  { id: 'p_linh', name: 'Linh Tran', role: '3rd Floor', color: '#2F8049' },
  { id: 'p_sofia', name: 'Sofía Marín', role: 'Laundry', color: '#C0603D' },
  { id: 'p_grace', name: 'Grace Bennett', role: 'Manager', color: '#5A6B8C' },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ conv, size = 46 }: { conv: Partial<Conv>; size?: number }) {
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
  if (conv.icon === 'bell')
    return (
      <span style={{ ...base, background: conv.color }}>
        <Bell size={size * 0.46} color="#fff" />
      </span>
    );
  return <span style={{ ...base, background: conv.color || '#3B5BA5' }}>{initials(conv.name || '?')}</span>;
}

function threadAccent(conv: Conv | null): string {
  if (!conv) return TOK.teal;
  if (conv.kind === 'announcement') return '#B0712F';
  return TOK.teal;
}

type View = 'inbox' | 'thread' | 'compose';

export function MessagesTab({
  lang,
  onUnreadChange,
}: {
  lang: HousekeeperLocale;
  onUnreadChange?: (n: number) => void;
}) {
  const [view, setView] = React.useState<View>('inbox');
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [store, setStore] = React.useState<Record<string, Msg[]>>(() => JSON.parse(JSON.stringify(SAMPLE_SEED)));
  const [unread, setUnread] = React.useState<Record<string, number>>(() =>
    Object.fromEntries(SAMPLE_CONVOS.map((c) => [c.id, c.unread || 0])),
  );

  const totalUnread = React.useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);
  React.useEffect(() => {
    onUnreadChange?.(totalUnread);
  }, [totalUnread, onUnreadChange]);

  const convs = React.useMemo(() => SAMPLE_CONVOS.map((c) => ({ ...c, unread: unread[c.id] ?? 0 })), [unread]);

  const convById = React.useCallback(
    (id: string | null): Conv | null => {
      if (!id) return null;
      const base = SAMPLE_CONVOS.find((c) => c.id === id);
      if (base) return { ...base, unread: unread[id] ?? 0 };
      const p = SAMPLE_PEOPLE.find((x) => x.id === id);
      return p
        ? { id: p.id, kind: 'dm', name: p.name, role: p.role, color: p.color, icon: p.icon, last: '', time: '', unread: 0 }
        : null;
    },
    [unread],
  );

  const openThread = (id: string) => {
    setActiveId(id);
    setView('thread');
    setUnread((u) => ({ ...u, [id]: 0 }));
  };
  const send = (id: string, text: string) => {
    if (!text.trim()) return;
    setStore((s) => ({ ...s, [id]: [...(s[id] || []), { from: ME, text: text.trim(), time: 'now' }] }));
  };

  const active = convById(activeId);

  if (view === 'thread' && active) {
    return (
      <Thread
        conv={active}
        messages={store[active.id] || []}
        accent={threadAccent(active)}
        lang={lang}
        onBack={() => setView('inbox')}
        onSend={send}
      />
    );
  }
  if (view === 'compose') {
    return <Compose lang={lang} onBack={() => setView('inbox')} onPick={(id) => openThread(id)} />;
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
      <div style={{ marginTop: 8 }}>
        {convs.map((c) => (
          <ConvRow key={c.id} conv={c} onTap={() => openThread(c.id)} />
        ))}
      </div>
    </div>
  );
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
  onBack,
  onSend,
}: {
  conv: Conv;
  messages: Msg[];
  accent: string;
  lang: HousekeeperLocale;
  onBack: () => void;
  onSend: (id: string, text: string) => void;
}) {
  const [text, setText] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const readOnly = conv.kind === 'announcement';
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);
  const submit = () => {
    if (!text.trim()) return;
    onSend(conv.id, text);
    setText('');
  };
  const sub =
    conv.kind === 'group'
      ? `${conv.members} ${t('hkMembers', lang)}`
      : conv.kind === 'announcement'
        ? t('hkFromManagement', lang)
        : conv.role || t('hkDirectMessage', lang);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#EFF1F4' }}>
      {/* header */}
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

      {/* messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {conv.kind === 'announcement' && (
          <div style={{ alignSelf: 'center', fontSize: 11.5, fontWeight: 600, color: TOK.ink3, background: '#E4E7EC', padding: '5px 12px', borderRadius: 99, marginBottom: 8 }}>
            📣 {t('hkAnnouncementsFromMgmt', lang)}
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.from === ME;
          const showName = !mine && conv.kind !== 'dm' && (i === 0 || messages[i - 1].from !== m.from);
          return (
            <div
              key={i}
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
              <span style={{ fontSize: 10, color: TOK.ink3, margin: '3px 6px 0' }}>{m.time === 'now' ? t('hkJustNow', lang) : m.time}</span>
            </div>
          );
        })}
      </div>

      {/* input */}
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

function Compose({ lang, onBack, onPick }: { lang: HousekeeperLocale; onBack: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = React.useState('');
  const list = SAMPLE_PEOPLE.filter(
    (p) => p.name.toLowerCase().includes(q.toLowerCase()) || (p.role || '').toLowerCase().includes(q.toLowerCase()),
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
              <Avatar conv={{ kind: 'dm', name: p.name, color: p.color, icon: p.icon }} size={44} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: TOK.ink }}>{p.name}</div>
                <div style={{ fontSize: 12.5, color: TOK.ink3 }}>{p.role}</div>
              </div>
              <ChevronRight size={18} color="#C5C9D0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
