'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications overlays: SearchPalette · NewMessageModal.
//
// Communications is MESSAGES now. TodoMode, its worklist, its composer, its
// assign modal and the team calendar it hosted were deleted on 2026-07-30 and
// did not come back in another shape: the list of everything that needs a
// person is the Staxis tab, and it is ONE list rather than a filtered view with
// source tags and date buckets. Removed 2026-07-27: the "Catch up" popover,
// the Threads list, and Calendar's own nav item.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import {
  Search, X, Megaphone, ArrowUpRight, AlertCircle, Loader2, RefreshCw,
} from 'lucide-react';
import { apiGet } from '@/lib/comms/client';
import type { StaffLite, SearchHitDTO, CommsDept } from '@/lib/comms/types';
import type { L } from './comms-types-fe';
import {
  T, SANS, SERIF, MONO, deptColor, deptLabel, tint, Avatar, DeptDot, MonoLabel, CommsOverlay,
} from './comms-ui';

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH PALETTE
// ─────────────────────────────────────────────────────────────────────────────
export function SearchPalette({ pid, hotelName, L, onClose, onJump, onOpenDm }: {
  pid: string; hotelName?: string; L: L; onClose: () => void; onJump: (conversationId: string) => void; onOpenDm: (staffId: string) => void;
}) {
  const [q, setQ] = React.useState('');
  const [hits, setHits] = React.useState<SearchHitDTO[]>([]);
  const [searching, setSearching] = React.useState(true);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [searchNonce, setSearchNonce] = React.useState(0);
  const inp = React.useRef<HTMLInputElement | null>(null);
  const searchRequest = React.useRef(0);

  React.useEffect(() => { inp.current?.focus(); }, []);
  // Debounced live search (220ms per keystroke) — stays hand-rolled;
  // useCommsResource has no debounce.
  React.useEffect(() => {
    const requestId = ++searchRequest.current;
    setSearching(true); setSearchError(null); setHits([]);
    const id = setTimeout(async () => {
      const r = await apiGet<{ hits: SearchHitDTO[] }>(`/api/comms/search?pid=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      if (requestId !== searchRequest.current) return;
      if (r.ok && r.data) {
        setHits(r.data.hits);
      } else {
        setSearchError('Search could not load. Check your connection and try again.');
      }
      setSearching(false);
    }, 220);
    return () => { clearTimeout(id); searchRequest.current += 1; };
  }, [pid, q, searchNonce, L]);

  const channels = hits.filter((h) => h.kind === 'channel');
  const people = hits.filter((h) => h.kind === 'person');
  const messages = hits.filter((h) => h.kind === 'message');
  const rowStyle: React.CSSProperties = { minHeight: 44, display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'transparent', cursor: 'pointer' };
  const hov = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = T.paper);
  const out = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'transparent');

  return (
    <CommsOverlay onClose={onClose} scrim="rgba(31,35,28,.22)" align="top" paddingTop={84} escToClose
      cardStyle={{ width: 560, maxWidth: '92%', maxHeight: '70%', background: T.bg, borderRadius: 14, border: `1px solid ${T.hair}`, boxShadow: '0 24px 64px rgba(31,35,28,.22)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${T.hairSoft}` }}>
          <span style={{ color: T.dim, display: 'flex' }}><Search size={18} /></span>
          <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder={'Search messages, channels and people…'}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: SANS, fontSize: 15, color: T.ink }} />
          {hotelName && <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 9.5, color: T.dim }}>{`Hotel · ${hotelName}`}</span>}
          <button onClick={onClose} aria-label={'Close search'} style={{ minWidth: 44, minHeight: 44, fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: T.dim, border: `1px solid ${T.hair}`, borderRadius: 6, padding: '3px 7px', background: 'transparent', cursor: 'pointer' }}>ESC</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0 12px' }}>
          {channels.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{'Channels'}</MonoLabel></div>
            {channels.map((h) => (
              <button key={'c' + h.conversationId} onClick={() => h.conversationId && onJump(h.conversationId)} style={rowStyle} onMouseEnter={hov} onMouseLeave={out}>
                <span style={{ color: deptColor(h.dept), display: 'flex' }}>{h.title === 'Announcements' ? <Megaphone size={16} /> : <span style={{ fontFamily: SANS, fontSize: 16, fontWeight: 600 }}>#</span>}</span>
                <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: T.ink, flex: 1 }}>{h.title}</span>
                {h.subtitle && <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim }}>{h.subtitle}</span>}
              </button>
            ))}
          </div>}
          {people.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{'People'}</MonoLabel></div>
            {people.map((h) => (
              <button key={'p' + h.staffId} onClick={() => h.staffId && onOpenDm(h.staffId)} style={rowStyle} onMouseEnter={hov} onMouseLeave={out}>
                <Avatar name={h.title} dept={h.dept} size={26} />
                <span style={{ fontFamily: SANS, fontSize: 14, color: T.ink, flex: 1 }}><span style={{ fontWeight: 600 }}>{h.title}</span>{h.subtitle && <span style={{ color: T.dim, fontSize: 12 }}> · {h.subtitle}</span>}</span>
              </button>
            ))}
          </div>}
          {messages.length > 0 && <div style={{ marginBottom: 8 }}><div style={{ padding: '8px 16px 4px' }}><MonoLabel>{`Messages (${messages.length})`}</MonoLabel></div>
            {messages.map((h, i) => (
              <button key={'m' + i} onClick={() => h.conversationId && onJump(h.conversationId)} style={{ ...rowStyle, alignItems: 'flex-start' }} onMouseEnter={hov} onMouseLeave={out}>
                <Avatar name={h.title} dept={h.dept} size={26} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim }}><span style={{ fontWeight: 600, color: T.ink }}>{h.title}</span> · {h.subtitle}</span>
                  <span style={{ display: 'block', fontFamily: SANS, fontSize: 13.5, color: T.ink, lineHeight: 1.4 }}>{h.snippet}</span>
                </span>
              </button>
            ))}
          </div>}
          {searching && hits.length === 0 && <div role="status" style={{ padding: '24px 16px', textAlign: 'center', fontFamily: SANS, fontSize: 13.5, color: T.dim }}><Loader2 size={16} className="comms-spin" aria-hidden="true" /> {'Searching…'}</div>}
          {searchError && <div role="alert" style={{ margin: '8px 16px', padding: '12px 14px', borderRadius: 10, border: `1px solid ${tint(T.terracotta, .28)}`, background: tint(T.terracotta, .08), color: T.terracotta, fontFamily: SANS, fontSize: 13, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 10 }}><AlertCircle size={17} aria-hidden="true" /><span style={{ flex: 1 }}>{hits.length > 0 ? 'Search could not refresh. Showing the last results.' : searchError}</span><button onClick={() => setSearchNonce((n) => n + 1)} aria-label={'Retry search'} style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: `1px solid ${tint(T.terracotta, .3)}`, background: T.bg, color: T.terracotta, cursor: 'pointer' }}><RefreshCw size={15} aria-hidden="true" /></button></div>}
          {!searching && !searchError && hits.length === 0 && <div style={{ padding: '24px 16px', textAlign: 'center', fontFamily: SANS, fontSize: 13.5, color: T.dim }}>{q ? `No results for “${q}”.` : 'Type to search.'}</div>}
        </div>
    </CommsOverlay>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW MESSAGE (DM picker)
// ─────────────────────────────────────────────────────────────────────────────
export function NewMessageModal({ staff, hotelName, L, onPick, onClose }: { staff: StaffLite[]; hotelName?: string; L: L; onPick: (staffId: string) => void; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const filtered = staff.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <CommsOverlay onClose={onClose} scrim="rgba(31,35,28,.3)"
      cardStyle={{ background: T.bg, borderRadius: 16, width: 400, maxWidth: '92%', maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(31,35,28,.2)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.hair}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontFamily: SANS, fontSize: 15 }}>{'New message'}{hotelName ? <span style={{ fontWeight: 500, color: T.dim, fontSize: 11.5 }}>{` · ${hotelName}`}</span> : null}</span>
          <button onClick={onClose} aria-label={'Close new message'} style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} aria-hidden="true" /></button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={'Search staff…'} style={{ margin: 14, padding: '10px 12px', border: `1px solid ${T.hair}`, borderRadius: 10, fontFamily: SANS, fontSize: 14, outline: 'none' }} />
        <div style={{ overflowY: 'auto' }}>
          {filtered.map((s) => (
            <button key={s.id} onClick={() => onPick(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 18px', background: 'transparent', border: 'none', borderBottom: `1px solid ${T.hairSoft}`, cursor: 'pointer', fontFamily: SANS, fontSize: 14 }}>
              <Avatar name={s.name} dept={(s.channel === 'all_staff' ? 'management' : s.channel) as CommsDept} size={28} />
              <span>{s.name} <span style={{ fontSize: 12, color: T.dim }}>· {s.department ?? 'staff'}</span></span>
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: 18, color: T.dim, fontSize: 13, fontFamily: SANS }}>{'No staff found'}</div>}
        </div>
    </CommsOverlay>
  );
}
