'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Team Calendar — training days, vendor visits, brand audits.
// Lives INSIDE the To-do pane as its second view (List | Calendar switcher);
// it lost its own nav item on 2026-07-27. TodoMode owns the scroll container,
// the 760px column and the padding, so this file renders BARE — no outer
// wrapper, no second page frame — and takes the view switcher as a node to sit
// under its own header. ALL STAFF read; MANAGERS add/delete — the "Add event"
// button is display-gated on isManager (role), and the server route
// (/api/knowledge/events) independently enforces writes via the
// manage_knowledge capability, so it stays per-hotel controllable from the
// Access tab. Reads/writes through /api/knowledge/* (service-role). NO SMS.
//
// Styling is the Communications token set (comms-ui), NOT the Snow layer this
// pane used while it was a standalone tab: sitting next to the worklist, a
// second type family and a second button style read as two products.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { CalendarDays, Plus, X, Trash2, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { apiPost, apiDelete } from '@/lib/comms/client';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import type { L } from './comms-types-fe';
import { useCommsResource } from './comms-data';
import { T, SANS, SERIF, MONO, deptColorDark, tint, MonoLabel } from './comms-ui';

const cardStyle: React.CSSProperties = { border: `1px solid ${T.hair}`, borderRadius: 12, background: T.bg };
const fieldStyle: React.CSSProperties = {
  width: '100%', minHeight: 44, border: `1px solid ${T.hair}`, borderRadius: 10, padding: '10px 12px',
  fontFamily: SANS, fontSize: 14, outline: 'none', background: T.paper, color: T.ink, boxSizing: 'border-box',
};
const fieldLabelStyle: React.CSSProperties = {
  fontFamily: MONO, fontSize: 9.5, letterSpacing: '.13em', textTransform: 'uppercase',
  color: T.dim, marginBottom: 6, display: 'block',
};
const ghostBtnStyle: React.CSSProperties = {
  minHeight: 44, fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '9px 16px', borderRadius: 9,
  border: `1px solid ${T.hair}`, background: T.bg, color: T.dim, cursor: 'pointer',
};
const dashedBoxStyle: React.CSSProperties = {
  fontFamily: SANS, fontSize: 13.5, color: T.dim, padding: '26px 16px', textAlign: 'center',
  border: `1px dashed ${T.hair}`, borderRadius: 12,
};

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR view (self-fetching) — rendered bare inside TodoMode's frame.
// ─────────────────────────────────────────────────────────────────────────────
export function CalendarMode({ pid, isManager, L, switcher }: { pid: string; isManager: boolean; L: L; switcher?: React.ReactNode }) {
  const [adding, setAdding] = React.useState(false);
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const { data, loading, error: loadError, reload } = useCommsResource<{ events: KnowledgeEventDTO[] }>(`/api/knowledge/events?pid=${encodeURIComponent(pid)}`, { keepDataOnError: true });
  const items = data?.events ?? null;

  const remove = async (ev: KnowledgeEventDTO) => {
    if (!window.confirm(L(`Delete "${ev.title}"?`, `¿Eliminar "${ev.title}"?`))) return;
    setMutationError(null);
    const r = await apiDelete(`/api/knowledge/events?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(ev.id)}`);
    if (!r.ok) {
      setMutationError(L('The event was not deleted. Please try again.', 'No se eliminó el evento. Inténtalo de nuevo.'));
      return;
    }
    await reload();
  };

  // Split upcoming vs past (today inclusive in upcoming).
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  const all = items ?? [];
  const upcoming = all.filter((e) => (e.endDate ?? e.eventDate) >= todayStr);
  const past = all.filter((e) => (e.endDate ?? e.eventDate) < todayStr).reverse();
  const count = all.length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ marginBottom: 7 }}><MonoLabel>{data ? (count === 1 ? L('1 event', '1 evento') : L(`${count} events`, `${count} eventos`)) : (loading ? L('Loading events', 'Cargando eventos') : L('Events unavailable', 'Eventos no disponibles'))}</MonoLabel></div>
          <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Calendar', 'Calendario')}</div>
        </div>
        {isManager && (
          <button onClick={() => setAdding((v) => !v)} style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: `1px solid ${adding ? T.hair : tint(T.forest, .4)}`, background: adding ? T.bg : tint(T.forest, .12), color: adding ? T.dim : deptColorDark(T.forest), fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>
            {adding ? <><X size={15} /> {L('Cancel', 'Cancelar')}</> : <><Plus size={16} /> {L('Add event', 'Agregar evento')}</>}
          </button>
        )}
      </div>

      {switcher}

      {adding && isManager && <EventEditor pid={pid} L={L} onDone={async () => { setAdding(false); await reload(); }} onCancel={() => setAdding(false)} />}

      <div style={{ marginTop: 16 }}>
        {mutationError && (
          <div role="alert" style={{ marginBottom: 10, fontFamily: SANS, fontSize: 13, lineHeight: 1.45, color: T.terracotta, padding: '12px 14px', border: `1px solid ${tint(T.terracotta, .28)}`, background: tint(T.terracotta, .08), borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertCircle size={17} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{mutationError}</span>
            <button onClick={() => setMutationError(null)} aria-label={L('Dismiss error', 'Cerrar error')} style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 8, background: 'transparent', color: T.terracotta, cursor: 'pointer' }}><X size={17} aria-hidden="true" /></button>
          </div>
        )}
        {loadError && (
          <div role="alert" style={{ marginBottom: 10, fontFamily: SANS, fontSize: 13, lineHeight: 1.45, color: T.terracotta, padding: '12px 14px', border: `1px solid ${tint(T.terracotta, .28)}`, background: tint(T.terracotta, .08), borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertCircle size={17} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{data ? L('Events could not refresh. Showing the last results.', 'No se pudieron actualizar los eventos. Se muestran los últimos resultados.') : L('Events could not load. Check your connection and try again.', 'No se pudieron cargar los eventos. Revisa tu conexión e inténtalo de nuevo.')}</span>
            <button onClick={() => void reload()} aria-label={L('Retry loading events', 'Reintentar cargar eventos')} style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: `1px solid ${tint(T.terracotta, .3)}`, background: T.bg, color: T.terracotta, cursor: 'pointer' }}><RefreshCw size={15} aria-hidden="true" /></button>
          </div>
        )}
        {loading && !data ? (
          <div role="status" aria-live="polite" style={{ ...dashedBoxStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Loader2 size={16} className="comms-spin" aria-hidden="true" /> {L('Loading events…', 'Cargando eventos…')}
          </div>
        ) : data && count === 0 ? (
          <div style={dashedBoxStyle}>{L('No events yet. Add training days, vendor visits, or brand audits.', 'Aún no hay eventos. Agrega días de capacitación, visitas de proveedores o auditorías.')}</div>
        ) : data ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {upcoming.length > 0 && <EventList title={L('Upcoming', 'Próximos')} events={upcoming} isManager={isManager} onRemove={remove} L={L} />}
            {past.length > 0 && <EventList title={L('Past', 'Pasados')} events={past} isManager={isManager} onRemove={remove} L={L} dim />}
          </div>
        ) : null}
      </div>
    </>
  );
}

function EventList({ title, events, isManager, onRemove, L, dim }: { title: string; events: KnowledgeEventDTO[]; isManager: boolean; onRemove: (e: KnowledgeEventDTO) => void; L: L; dim?: boolean }) {
  return (
    <div style={{ opacity: dim ? 0.7 : 1 }}>
      <div style={{ marginBottom: 7 }}><MonoLabel>{title}</MonoLabel></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.map((ev) => (
          <div key={ev.id} style={{ ...cardStyle, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 46 }}>
              <CalendarDays size={16} color={T.forest} aria-hidden="true" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{ev.title}</div>
              <div style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim }}>{fmtRange(ev.eventDate, ev.endDate)}</div>
              {ev.notes && <div style={{ fontFamily: SANS, fontSize: 12.5, color: T.dim, marginTop: 3, whiteSpace: 'pre-wrap' }}>{ev.notes}</div>}
            </div>
            {isManager && (
              <button onClick={() => onRemove(ev)} title={L('Delete', 'Eliminar')} aria-label={L(`Delete ${ev.title}`, `Eliminar ${ev.title}`)}
                style={{ width: 44, height: 44, flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: T.dim }}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtRange(start: string, end: string | null): string {
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

  const canSave = !!title.trim() && !!eventDate && !busy;

  return (
    <div style={{ ...cardStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16, maxWidth: 520 }}>
      <div>
        <label style={fieldLabelStyle}>{L('Title', 'Título')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={KNOWLEDGE_LIMITS.TITLE_MAX} placeholder={L('e.g. Fire safety training', 'ej. Capacitación contra incendios')} style={fieldStyle} autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={fieldLabelStyle}>{L('Date', 'Fecha')}</label>
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={fieldStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={fieldLabelStyle}>{L('End date (optional)', 'Fecha fin (opcional)')}</label>
          <input type="date" value={endDate} min={eventDate || undefined} onChange={(e) => setEndDate(e.target.value)} style={fieldStyle} />
        </div>
      </div>
      <div>
        <label style={fieldLabelStyle}>{L('Notes (optional)', 'Notas (opcional)')}</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} rows={2} style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      {error && <div role="alert" style={{ fontFamily: SANS, fontSize: 12.5, lineHeight: 1.4, color: T.terracotta }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={!canSave}
          style={{ minHeight: 44, fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 9, border: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: canSave ? 'pointer' : 'default', background: canSave ? T.ink : T.hairSoft, color: canSave ? '#fff' : T.dim }}>
          {busy && <Loader2 size={13} className="comms-spin" aria-hidden="true" />} {L('Save', 'Guardar')}
        </button>
        <button onClick={onCancel} style={ghostBtnStyle}>{L('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}
