'use client';

// ════════════════════════════════════════════════════════════════════════════
// Complaints / Service Recovery — the register that lives on Front Desk.
//
// Reads are realtime via the anon client (subscribeToComplaints) exactly like
// the Rooms view next to it. WRITES go through /api/complaints/* (server,
// service-role) so the AI categorize / auto-route / SMS pipeline runs there.
// Styled to match the Front Desk page (Inter + Material Symbols + its palette)
// rather than the snow tabs, so it feels native to this screen.
// ════════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { subscribeToComplaints, subscribeToStaff } from '@/lib/db';
import type { StaffMember } from '@/types';
import {
  type Complaint, type ComplaintCategory, type ComplaintSeverity,
  COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES,
  isOverdue, isCallbackDue, isOpenStatus,
} from '@/lib/complaints-shared';
import { useToast, ToastHost } from '@/app/_components/ui/toast';

/* ── palette (matches front-desk/page.tsx) ── */
const INK = '#1b1c19', INK2 = '#757684', NAVY = '#364262', TEAL = '#006565', RED = '#ba1a1a', GOLD = '#B8853A';
const BORDER = '#d5d2ca', CARD = 'rgba(255,255,255,0.8)', SANS = 'Inter, sans-serif', MONO = "'JetBrains Mono', monospace";

const sevColor = (s: ComplaintSeverity) => (s === 'high' ? RED : s === 'medium' ? GOLD : TEAL);
const catLabel = (c: ComplaintCategory, es: boolean): string => {
  const en: Record<ComplaintCategory, string> = {
    maintenance: 'Maintenance', cleanliness: 'Cleanliness', noise: 'Noise', service: 'Service',
    billing: 'Billing', amenities: 'Amenities', other: 'Other',
  };
  const esm: Record<ComplaintCategory, string> = {
    maintenance: 'Mantenimiento', cleanliness: 'Limpieza', noise: 'Ruido', service: 'Servicio',
    billing: 'Facturación', amenities: 'Servicios', other: 'Otro',
  };
  return (es ? esm : en)[c];
};
const sevLabel = (s: ComplaintSeverity, es: boolean) =>
  es ? { low: 'Baja', medium: 'Media', high: 'Alta' }[s] : { low: 'Low', medium: 'Med', high: 'High' }[s];
const statusLabel = (s: Complaint['status'], es: boolean) =>
  es ? { open: 'Abierta', in_progress: 'En proceso', resolved: 'Resuelta', closed: 'Cerrada' }[s]
     : { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' }[s];

function timeAgo(d: Date | null, es: boolean): string {
  if (!d) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return es ? 'ahora' : 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) return { ok: false, error: json?.error || `HTTP ${res.status}` };
    return { ok: true, data: json?.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

type StatusFilter = 'all' | 'open' | 'assigned' | 'resolved';

export function ComplaintsTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';

  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [catFilter, setCatFilter] = useState<ComplaintCategory | 'all'>('all');
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Shared toast primitive (F7) — 2.6s teal pill, top-center.
  const { toasts, show } = useToast({ durationMs: 2600, max: 1 });

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToComplaints(user.uid, activePropertyId, setComplaints);
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToStaff(user.uid, activePropertyId, setStaff);
  }, [user, activePropertyId]);

  const flash = (m: string) => { show(m); };

  const now = new Date(); // render-time clock, used only in list-row badges (JSX)
  const callbacksDue = useMemo(() => {
    const n = new Date();
    return complaints
      .filter((c) => isCallbackDue(c, n))
      .sort((a, b) => (a.callbackAt?.getTime() ?? 0) - (b.callbackAt?.getTime() ?? 0));
  }, [complaints]);

  // repeat-issue map: key room|category → count (for the "3rd AC complaint" flag)
  const repeatKey = (c: Complaint) => `${c.roomNumber ?? ''}|${c.category}`;
  const repeatCounts = useMemo(() => {
    const m = new Map<string, number>();
    const monthAgo = Date.now() - 30 * 864e5;
    for (const c of complaints) {
      if (!c.roomNumber || !c.createdAt || c.createdAt.getTime() < monthAgo) continue;
      m.set(repeatKey(c), (m.get(repeatKey(c)) ?? 0) + 1);
    }
    return m;
  }, [complaints]);

  const filtered = useMemo(() => {
    return complaints.filter((c) => {
      if (catFilter !== 'all' && c.category !== catFilter) return false;
      if (statusFilter === 'open') return isOpenStatus(c.status);
      if (statusFilter === 'assigned') return isOpenStatus(c.status) && !!c.assignedTo;
      if (statusFilter === 'resolved') return c.status === 'resolved' || c.status === 'closed';
      return true;
    });
  }, [complaints, statusFilter, catFilter]);

  const counts = useMemo(() => {
    const n = new Date();
    return {
      open: complaints.filter((c) => isOpenStatus(c.status)).length,
      overdue: complaints.filter((c) => isOverdue(c, n)).length,
      callbacks: complaints.filter((c) => isCallbackDue(c, n)).length,
    };
  }, [complaints]);

  const detail = detailId ? complaints.find((c) => c.id === detailId) ?? null : null;

  return (
    <div style={{ minHeight: 'calc(100dvh - 130px)', background: '#fbf9f4' }}>
      <div style={{ padding: '24px 28px 120px', maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: SANS, fontWeight: 700, fontSize: 24, color: INK, margin: 0, letterSpacing: '-0.02em' }}>
              {es ? 'Quejas' : 'Complaints'}
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13.5, color: INK2, fontFamily: SANS }}>
              {es
                ? `${counts.open} abiertas · ${counts.overdue} atrasadas · ${counts.callbacks} llamadas hoy`
                : `${counts.open} open · ${counts.overdue} overdue · ${counts.callbacks} callbacks due`}
            </p>
          </div>
          <button onClick={() => setShowNew(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderRadius: 9999,
            background: NAVY, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: SANS, fontSize: 14, fontWeight: 600,
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>add</span>
            {es ? 'Nueva queja' : 'New complaint'}
          </button>
        </div>

        {/* Today's callbacks */}
        {callbacksDue.length > 0 && (
          <div style={{
            marginBottom: 20, padding: '16px 18px', borderRadius: 18,
            background: 'rgba(184,133,58,0.08)', border: '1px solid rgba(184,133,58,0.25)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, color: GOLD }}>phone_callback</span>
              <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 14, color: INK }}>
                {es ? 'Llamadas de seguimiento de hoy' : "Today's callbacks"}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {callbacksDue.map((c) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <button onClick={() => setDetailId(c.id)} style={{
                    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0,
                    fontFamily: SANS, fontSize: 13.5, color: INK,
                  }}>
                    {c.roomNumber ? `${es ? 'Hab.' : 'Room'} ${c.roomNumber} · ` : ''}{c.guestName || (es ? 'Huésped' : 'Guest')}
                    <span style={{ color: INK2 }}> — {c.description.slice(0, 50)}</span>
                  </button>
                  <button onClick={() => doCallbackDone(c.id)} style={{
                    flexShrink: 0, padding: '6px 12px', borderRadius: 9999, border: `1px solid ${TEAL}`,
                    background: 'transparent', color: TEAL, cursor: 'pointer', fontFamily: SANS, fontSize: 12, fontWeight: 600,
                  }}>{es ? 'Hecho' : 'Done'}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {([
            ['open', es ? 'Abiertas' : 'Open'], ['assigned', es ? 'Asignadas' : 'Assigned'],
            ['resolved', es ? 'Resueltas' : 'Resolved'], ['all', es ? 'Todas' : 'All'],
          ] as [StatusFilter, string][]).map(([k, lbl]) => (
            <Pill key={k} active={statusFilter === k} onClick={() => setStatusFilter(k)}>{lbl}</Pill>
          ))}
          <span style={{ width: 1, background: BORDER, margin: '2px 4px' }} />
          <Pill active={catFilter === 'all'} onClick={() => setCatFilter('all')}>{es ? 'Todas' : 'All types'}</Pill>
          {COMPLAINT_CATEGORIES.map((c) => (
            <Pill key={c} active={catFilter === c} onClick={() => setCatFilter(c)}>{catLabel(c, es)}</Pill>
          ))}
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 16px' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: INK2, display: 'block', marginBottom: 12 }}>sentiment_satisfied</span>
            <p style={{ color: INK2, fontSize: 15, margin: 0, fontFamily: SANS }}>
              {es ? 'No hay quejas con este filtro' : 'No complaints match this filter'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map((c) => {
              const rc = repeatCounts.get(repeatKey(c)) ?? 0;
              const overdue = isOverdue(c, now);
              return (
                <button key={c.id} onClick={() => setDetailId(c.id)} className="fd-room-card" style={{
                  display: 'block', textAlign: 'left', width: '100%', padding: 16, borderRadius: 16,
                  background: CARD, border: `1px solid ${overdue ? 'rgba(186,26,26,0.4)' : BORDER}`, cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, color: INK }}>
                      {c.roomNumber ? `#${c.roomNumber}` : '—'}
                    </span>
                    <Tag color={sevColor(c.severity)}>{sevLabel(c.severity, es)}</Tag>
                    <Tag color={NAVY}>{catLabel(c.category, es)}</Tag>
                    <Tag color={isOpenStatus(c.status) ? INK2 : TEAL}>{statusLabel(c.status, es)}</Tag>
                    {c.linkedWorkOrderId && (
                      <span title={es ? 'Orden de trabajo creada' : 'Work order created'} className="material-symbols-outlined" style={{ fontSize: 16, color: NAVY }}>build</span>
                    )}
                    {rc >= 2 && (
                      <Tag color={RED}>{es ? `${rc}ª vez · 30 días` : `${rc}× this month`}</Tag>
                    )}
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: INK2 }}>{timeAgo(c.createdAt, es)}</span>
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 14, color: INK, lineHeight: 1.4 }}>{c.description}</div>
                  <div style={{ marginTop: 6, fontFamily: SANS, fontSize: 12, color: INK2 }}>
                    {c.guestName ? `${c.guestName} · ` : ''}
                    {c.assignedName ? `${es ? 'Asignada a' : 'Assigned'} ${c.assignedName}` : (es ? 'Sin asignar' : 'Unassigned')}
                    {c.callbackAt && !c.callbackDone ? ` · ${es ? 'llamada' : 'callback'} ${c.callbackAt.toLocaleDateString(es ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' })}` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showNew && <NewComplaintSheet es={es} onClose={() => setShowNew(false)} pid={activePropertyId!} createdByName={user?.displayName} onDone={(msg) => { setShowNew(false); flash(msg); }} />}
      {detail && (
        <DetailSheet
          es={es} pid={activePropertyId!} complaint={detail} staff={staff}
          onClose={() => setDetailId(null)} onAction={(msg) => flash(msg)}
        />
      )}

      <ToastHost
        toasts={toasts}
        position="top"
        offset="24px"
        zIndex={1100}
        toastStyle={{
          padding: '14px 24px', borderRadius: 9999, background: TEAL, color: '#fff',
          fontWeight: 600, fontSize: 14, fontFamily: SANS, boxShadow: '0 12px 32px rgba(0,101,101,0.25)',
        }}
      />
    </div>
  );

  async function doCallbackDone(id: string) {
    const r = await postJson('/api/complaints/update', { pid: activePropertyId, complaintId: id, action: 'callback_done' });
    flash(r.ok ? (es ? 'Llamada marcada como hecha' : 'Callback marked done') : (es ? 'Error' : `Error: ${r.error}`));
  }
}

/* ── small presentational helpers ── */
function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '7px 14px', borderRadius: 9999, whiteSpace: 'nowrap', cursor: 'pointer',
      border: active ? `1px solid ${NAVY}` : `1px solid ${BORDER}`,
      background: active ? NAVY : 'rgba(255,255,255,0.7)', color: active ? '#fff' : '#454652',
      fontSize: 13, fontWeight: 600, fontFamily: SANS,
    }}>{children}</button>
  );
}
function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 9999,
      background: `${color}14`, color, border: `1px solid ${color}33`,
      fontSize: 11, fontWeight: 600, fontFamily: SANS, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(27,28,25,0.4)', backdropFilter: 'blur(8px)' }} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1001, background: '#fbf9f4',
        borderRadius: '32px 32px 0 0', padding: '16px 24px 28px', maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 -16px 48px rgba(0,0,0,0.12)', maxWidth: 640, margin: '0 auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <div style={{ width: 40, height: 4, borderRadius: 9999, background: BORDER }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ fontFamily: SANS, fontWeight: 700, fontSize: 20, color: INK, margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: '#454652' }}>close</span>
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12,
  border: `1px solid ${BORDER}`, background: '#fff', fontFamily: SANS, fontSize: 14, color: INK, outline: 'none',
};
const fieldLabel: React.CSSProperties = { fontFamily: SANS, fontSize: 12, fontWeight: 600, color: INK2, marginBottom: 6, display: 'block' };

function NewComplaintSheet({ es, onClose, pid, createdByName, onDone }: {
  es: boolean; onClose: () => void; pid: string; createdByName?: string; onDone: (msg: string) => void;
}) {
  const [description, setDescription] = useState('');
  const [roomNumber, setRoomNumber] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestContact, setGuestContact] = useState('');
  const [category, setCategory] = useState<ComplaintCategory | ''>('');
  const [severity, setSeverity] = useState<ComplaintSeverity | ''>('');
  const [busy, setBusy] = useState(false);
  const canSave = description.trim().length > 2 && !busy;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    const r = await postJson('/api/complaints/log', {
      pid, description: description.trim(), roomNumber: roomNumber.trim() || undefined,
      guestName: guestName.trim() || undefined, guestContact: guestContact.trim() || undefined,
      category: category || undefined, severity: severity || undefined, createdByName,
    });
    setBusy(false);
    if (r.ok) {
      const d = r.data as { linkedWorkOrderId?: string | null; repeatCount?: number } | undefined;
      let msg = es ? 'Queja registrada' : 'Complaint logged';
      if (d?.linkedWorkOrderId) msg += es ? ' · orden de trabajo creada' : ' · work order created';
      if (d?.repeatCount && d.repeatCount > 0) msg += es ? ` · problema recurrente (${d.repeatCount}ª)` : ` · repeat issue (${d.repeatCount} prior)`;
      onDone(msg);
    } else {
      onDone((es ? 'Error: ' : 'Error: ') + r.error);
    }
  };

  return (
    <Sheet title={es ? 'Nueva queja' : 'New complaint'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={fieldLabel}>{es ? '¿Qué pasó? *' : "What's the issue? *"}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder={es ? 'p. ej. La A/C de la 214 no enfría, el huésped está molesto' : "e.g. Room 214 A/C not cooling, guest is upset"}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: INK2, fontFamily: SANS, fontStyle: 'italic' }}>
            {es ? 'La categoría y la gravedad se detectan automáticamente si las dejas en blanco.' : 'Category & severity are auto-detected if left on Auto.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 120px' }}>
            <label style={fieldLabel}>{es ? 'Habitación' : 'Room'}</label>
            <input value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} placeholder="214" style={inputStyle} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={fieldLabel}>{es ? 'Huésped' : 'Guest name'}</label>
            <input value={guestName} onChange={(e) => setGuestName(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={fieldLabel}>{es ? 'Contacto' : 'Guest contact'}</label>
            <input value={guestContact} onChange={(e) => setGuestContact(e.target.value)} placeholder={es ? 'teléfono / correo' : 'phone / email'} style={inputStyle} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={fieldLabel}>{es ? 'Categoría' : 'Category'}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as ComplaintCategory | '')} style={inputStyle}>
              <option value="">{es ? 'Automática' : 'Auto-detect'}</option>
              {COMPLAINT_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c, es)}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={fieldLabel}>{es ? 'Gravedad' : 'Severity'}</label>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as ComplaintSeverity | '')} style={inputStyle}>
              <option value="">{es ? 'Automática' : 'Auto-detect'}</option>
              {COMPLAINT_SEVERITIES.map((s) => <option key={s} value={s}>{sevLabel(s, es)}</option>)}
            </select>
          </div>
        </div>
        <button onClick={submit} disabled={!canSave} style={{
          padding: 14, borderRadius: 9999, border: 'none', background: canSave ? NAVY : 'rgba(54,66,98,0.4)',
          color: '#fff', fontFamily: SANS, fontSize: 15, fontWeight: 600, cursor: canSave ? 'pointer' : 'not-allowed',
        }}>{busy ? (es ? 'Guardando…' : 'Saving…') : (es ? 'Registrar queja' : 'Log complaint')}</button>
      </div>
    </Sheet>
  );
}

function DetailSheet({ es, pid, complaint, staff, onClose, onAction }: {
  es: boolean; pid: string; complaint: Complaint; staff: StaffMember[];
  onClose: () => void; onAction: (msg: string) => void;
}) {
  const c = complaint;
  const [busy, setBusy] = useState(false);
  const [assignTo, setAssignTo] = useState(c.assignedTo ?? '');
  const [resNotes, setResNotes] = useState(c.resolutionNotes ?? '');
  const [callbackAt, setCallbackAt] = useState('');
  const [draft, setDraft] = useState<{ guestMessage: string; makeGood: string } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const run = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    const r = await postJson('/api/complaints/update', { pid, complaintId: c.id, ...body });
    setBusy(false);
    onAction(r.ok ? okMsg : (es ? 'Error: ' : 'Error: ') + r.error);
    if (r.ok) onClose();
  };

  const assign = async () => {
    const sel = staff.find((s) => s.id === assignTo);
    await run(
      { action: 'assign', assignedTo: assignTo || null, assignedName: sel?.name ?? null, assignedDept: c.assignedDept ?? undefined },
      es ? 'Queja asignada' : 'Complaint assigned',
    );
  };
  const resolve = async () => run({ action: 'status', status: 'resolved', resolutionNotes: resNotes.trim() || undefined }, es ? 'Queja resuelta' : 'Complaint resolved');
  const reopen = async () => run({ action: 'status', status: 'open' }, es ? 'Queja reabierta' : 'Complaint reopened');
  const schedule = async () => {
    if (!callbackAt) return;
    await run({ action: 'schedule_callback', callbackAt: new Date(callbackAt).toISOString() }, es ? 'Llamada programada' : 'Callback scheduled');
  };

  const genDraft = async () => {
    setDraftBusy(true);
    const r = await postJson('/api/complaints/draft', { pid, complaintId: c.id });
    setDraftBusy(false);
    if (r.ok) setDraft(r.data as { guestMessage: string; makeGood: string });
    else onAction((es ? 'Error: ' : 'Error: ') + r.error);
  };

  return (
    <Sheet title={`${c.roomNumber ? `${es ? 'Hab.' : 'Room'} ${c.roomNumber}` : (es ? 'Queja' : 'Complaint')}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* summary */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tag color={sevColor(c.severity)}>{sevLabel(c.severity, es)}</Tag>
          <Tag color={NAVY}>{catLabel(c.category, es)}</Tag>
          <Tag color={isOpenStatus(c.status) ? INK2 : TEAL}>{statusLabel(c.status, es)}</Tag>
          {c.linkedWorkOrderId && <Tag color={NAVY}>{es ? 'Orden de trabajo' : 'Work order'}</Tag>}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 15, color: INK, lineHeight: 1.5 }}>{c.description}</div>
        {(c.guestName || c.guestContact) && (
          <div style={{ fontFamily: SANS, fontSize: 13, color: INK2 }}>
            {c.guestName}{c.guestContact ? ` · ${c.guestContact}` : ''}
          </div>
        )}

        {/* Assign */}
        <div>
          <label style={fieldLabel}>{es ? 'Asignar a' : 'Assign to'}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="">{es ? 'Sin asignar' : 'Unassigned'}</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.department ? ` (${s.department})` : ''}</option>)}
            </select>
            <button onClick={assign} disabled={busy} style={btn(NAVY)}>{es ? 'Asignar' : 'Assign'}</button>
          </div>
        </div>

        {/* Resolve / reopen */}
        {isOpenStatus(c.status) ? (
          <div>
            <label style={fieldLabel}>{es ? 'Notas de resolución' : 'Resolution notes'}</label>
            <textarea value={resNotes} onChange={(e) => setResNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
            <button onClick={resolve} disabled={busy} style={{ ...btn(TEAL), marginTop: 8, width: '100%' }}>
              {es ? 'Marcar como resuelta' : 'Mark resolved'}
            </button>
          </div>
        ) : (
          <button onClick={reopen} disabled={busy} style={btn('#454652')}>{es ? 'Reabrir' : 'Reopen'}</button>
        )}

        {/* Callback scheduling */}
        <div>
          <label style={fieldLabel}>{es ? 'Programar llamada de seguimiento' : 'Schedule satisfaction callback'}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <button onClick={schedule} disabled={busy || !callbackAt} style={btn(GOLD)}>{es ? 'Programar' : 'Schedule'}</button>
          </div>
          {c.callbackAt && (
            <p style={{ margin: '6px 0 0', fontSize: 12, color: INK2, fontFamily: SANS }}>
              {c.callbackDone ? (es ? '✓ Llamada completada' : '✓ Callback done')
                : `${es ? 'Programada para' : 'Scheduled for'} ${c.callbackAt.toLocaleString(es ? 'es-US' : 'en-US')}`}
            </p>
          )}
        </div>

        {/* AI service-recovery draft */}
        <div style={{ padding: 14, borderRadius: 14, background: 'rgba(0,101,101,0.05)', border: '1px solid rgba(0,101,101,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: TEAL }}>
              {es ? 'Borrador de recuperación (IA)' : 'AI service-recovery draft'}
            </span>
            <button onClick={genDraft} disabled={draftBusy} style={btn(TEAL)}>
              {draftBusy ? (es ? 'Generando…' : 'Drafting…') : (es ? 'Generar' : 'Draft')}
            </button>
          </div>
          {draft && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={fieldLabel}>{es ? 'Mensaje al huésped (edítalo)' : 'Guest message (edit before sending)'}</label>
                <textarea defaultValue={draft.guestMessage} rows={4} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
              </div>
              <div style={{ fontFamily: SANS, fontSize: 13, color: INK }}>
                <strong>{es ? 'Compensación sugerida: ' : 'Suggested make-good: '}</strong>{draft.makeGood}
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    flexShrink: 0, padding: '10px 16px', borderRadius: 9999, border: 'none', background: color,
    color: '#fff', fontFamily: SANS, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
}
