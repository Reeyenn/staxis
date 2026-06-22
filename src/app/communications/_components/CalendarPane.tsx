'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Team Calendar — training days, vendor visits, brand audits.
// Promoted out of the Knowledge hub into its own top-level Communications
// sub-tab (mirrors the Log book tab). ALL STAFF read; MANAGERS add/delete — the
// "Add event" button is display-gated on isManager (role), and the server route
// (/api/knowledge/events) independently enforces writes via the
// manage_knowledge capability, so it stays per-hotel controllable from the
// Access tab. Reads/writes through /api/knowledge/* (service-role). NO SMS.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { CalendarDays, Plus, X, Trash2, Loader2 } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '@/lib/comms/client';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import type { L } from './comms-types-fe';
import { T, SANS as COMMS_SANS, SERIF, deptColorDark, tint, MonoLabel } from './comms-ui';

// The calendar body keeps the Snow design-system styling it had inside the
// Knowledge hub (var(--snow-*)), so it reads identically; only the surrounding
// shell + header now match the Communications tab system.
const SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

// ── shared styles (carried over verbatim from KnowledgePane) ─────────────────
const card: React.CSSProperties = { border: '1px solid var(--snow-rule)', borderRadius: 12, background: 'var(--snow-bg)' };
const primaryBtn: React.CSSProperties = { background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 6 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--snow-ink2)', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 5 };
const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--snow-ink2)' };
const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '9px 11px', fontFamily: SANS, fontSize: 14, outline: 'none', background: 'var(--snow-bg)', color: 'var(--snow-ink)', boxSizing: 'border-box' };
const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 4, display: 'block' };

function Loading({ L }: { L: L }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--snow-ink3)', fontSize: 13, padding: 20 }}><Loader2 size={15} className="spin" /> {L('Loading…', 'Cargando…')}</div>;
}
function Empty({ text }: { text: string }) {
  return <div style={{ color: 'var(--snow-ink3)', fontSize: 13.5, padding: '28px 8px', textAlign: 'center' }}>{text}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR mode (self-fetching) — owns the flex:1 / overflow scroll container,
// mirroring LogbookMode's shell with a serif page header.
// ─────────────────────────────────────────────────────────────────────────────
export function CalendarMode({ pid, isManager, L }: { pid: string; isManager: boolean; L: L }) {
  const [items, setItems] = React.useState<KnowledgeEventDTO[] | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ events: KnowledgeEventDTO[] }>(`/api/knowledge/events?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.events);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  const remove = async (ev: KnowledgeEventDTO) => {
    if (!window.confirm(L(`Delete "${ev.title}"?`, `¿Eliminar "${ev.title}"?`))) return;
    await apiDelete(`/api/knowledge/events?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(ev.id)}`);
    await load();
  };

  // Split upcoming vs past (today inclusive in upcoming).
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  const all = items ?? [];
  const upcoming = all.filter((e) => (e.endDate ?? e.eventDate) >= todayStr);
  const past = all.filter((e) => (e.endDate ?? e.eventDate) < todayStr).reverse();
  const count = all.length;

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ marginBottom: 7 }}><MonoLabel>{count === 1 ? L('1 event', '1 evento') : L(`${count} events`, `${count} eventos`)}</MonoLabel></div>
            <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Calendar', 'Calendario')}</div>
          </div>
          {isManager && (
            <button onClick={() => setAdding((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: `1px solid ${adding ? T.hair : tint(T.forest, .4)}`, background: adding ? T.bg : tint(T.forest, .12), color: adding ? T.dim : deptColorDark(T.forest), fontFamily: COMMS_SANS, fontSize: 13.5, fontWeight: 600 }}>
              {adding ? <><X size={15} /> {L('Cancel', 'Cancelar')}</> : <><Plus size={16} /> {L('Add event', 'Agregar evento')}</>}
            </button>
          )}
        </div>

        {adding && isManager && <EventEditor pid={pid} L={L} onDone={async () => { setAdding(false); await load(); }} onCancel={() => setAdding(false)} />}

        <div style={{ marginTop: 18 }}>
          {items === null ? <Loading L={L} /> : count === 0 ? (
            <Empty text={L('No events yet. Add training days, vendor visits, or brand audits.', 'Aún no hay eventos. Agrega días de capacitación, visitas de proveedores o auditorías.')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {upcoming.length > 0 && <EventList title={L('Upcoming', 'Próximos')} events={upcoming} isManager={isManager} onRemove={remove} L={L} />}
              {past.length > 0 && <EventList title={L('Past', 'Pasados')} events={past} isManager={isManager} onRemove={remove} L={L} dim />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EventList({ title, events, isManager, onRemove, L, dim }: { title: string; events: KnowledgeEventDTO[]; isManager: boolean; onRemove: (e: KnowledgeEventDTO) => void; L: L; dim?: boolean }) {
  return (
    <div style={{ opacity: dim ? 0.7 : 1 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.map((ev) => (
          <div key={ev.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 46 }}>
              <CalendarDays size={16} color="var(--snow-sage-deep)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ev.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--snow-ink2)' }}>{fmtRange(ev.eventDate, ev.endDate, L)}</div>
              {ev.notes && <div style={{ fontSize: 12.5, color: 'var(--snow-ink3)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{ev.notes}</div>}
            </div>
            {isManager && <button onClick={() => onRemove(ev)} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtRange(start: string, end: string | null, L: L): string {
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!end || end === start) return fmt(start);
  return `${fmt(start)} → ${fmt(end)}`;
}

function EventEditor({ pid, L, onDone, onCancel }: { pid: string; L: L; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = React.useState('');
  const [eventDate, setEventDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || !eventDate || busy) return;
    setBusy(true); setError(null);
    const r = await apiPost('/api/knowledge/events', { pid, title: title.trim(), eventDate, endDate: endDate || null, notes: notes.trim() || null });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error || L('Could not save. Try again.', 'No se pudo guardar. Inténtalo de nuevo.'));
  };

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16, maxWidth: 520 }}>
      <div>
        <label style={labelStyle}>{L('Title', 'Título')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={KNOWLEDGE_LIMITS.TITLE_MAX} placeholder={L('e.g. Fire safety training', 'ej. Capacitación contra incendios')} style={inputStyle} autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={labelStyle}>{L('Date', 'Fecha')}</label>
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={labelStyle}>{L('End date (optional)', 'Fecha fin (opcional)')}</label>
          <input type="date" value={endDate} min={eventDate || undefined} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>{L('Notes (optional)', 'Notas (opcional)')}</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>
      {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={busy || !title.trim() || !eventDate} style={{ ...primaryBtn, opacity: busy || !title.trim() || !eventDate ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : null} {L('Save', 'Guardar')}</button>
        <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}
