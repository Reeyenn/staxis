'use client';


export const dynamic = 'force-dynamic';
// Settings → Shifts. Manager defines named shift templates per
// department (e.g. "Morning HK: 8a–4p"). The /staff Schedule grid
// cell-edit popover offers these as one-click picks.
//
// Backed by /api/staff-schedule/presets. Bulk-save model: any preset
// removed from the array is deleted (cascade nulls out
// scheduled_shifts.preset_id but doesn't remove the shift).

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { ShiftPreset, StaffDepartment } from '@/types';
import { T, fonts, deptMeta, Btn, Caps } from '@/app/staff/_components/_tokens';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';

interface DraftPreset {
  // local id (uuid from server, or 'new-N' for unsaved rows)
  localId: string;
  serverId?: string;
  name: string;
  department: StaffDepartment;
  startTime: string;
  endTime: string;
  sortOrder: number;
}

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const DEFAULT_TEMPLATES: Omit<DraftPreset, 'localId' | 'sortOrder'>[] = [
  { name: 'Housekeeping AM', department: 'housekeeping', startTime: '08:00', endTime: '16:00' },
  { name: 'Housekeeping PM', department: 'housekeeping', startTime: '09:00', endTime: '17:00' },
  { name: 'Front desk AM',   department: 'front_desk',   startTime: '07:00', endTime: '15:00' },
  { name: 'Front desk PM',   department: 'front_desk',   startTime: '15:00', endTime: '23:00' },
  { name: 'Front desk overnight', department: 'front_desk', startTime: '23:00', endTime: '07:00' },
  { name: 'Maintenance',     department: 'maintenance',  startTime: '08:00', endTime: '16:00' },
];

export default function ShiftPresetsPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const can = useCan();

  // Gated by per-hotel manage_shifts (default: every role; admin can restrict).
  if (!user || !can('manage_shifts')) {
    return <AppLayout><div style={{ padding: 24 }}>Manager access only.</div></AppLayout>;
  }

  return <AppLayout><ShiftPresetsBody pid={activePropertyId ?? ''} lang={lang}/></AppLayout>;
}

function ShiftPresetsBody({ pid, lang }: { pid: string; lang: 'en' | 'es' }) {
  const [drafts, setDrafts] = useState<DraftPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Initial load.
  useEffect(() => {
    if (!pid) return;
    let active = true;
    setLoading(true);
    fetchWithAuth(`/api/staff-schedule/presets?hotelId=${pid}`)
      .then(r => r.ok ? r.json() : null)
      .then((body: { data?: { presets?: ShiftPreset[] } } | null) => {
        if (!active) return;
        const list = body?.data?.presets ?? [];
        setDrafts(list.map((p, i) => ({
          localId: p.id,
          serverId: p.id,
          name: p.name,
          department: p.department,
          startTime: p.startTime,
          endTime: p.endTime,
          sortOrder: p.sortOrder ?? i,
        })));
        setLoading(false);
      })
      .catch(err => {
        console.error('[shifts:settings] load failed', err);
        if (active) { setError('Failed to load presets'); setLoading(false); }
      });
    return () => { active = false; };
  }, [pid]);

  const groups = useMemo(() => {
    const map: Record<StaffDepartment, DraftPreset[]> = {
      housekeeping: [], front_desk: [], maintenance: [], other: [],
    };
    for (const d of drafts) map[d.department].push(d);
    return map;
  }, [drafts]);

  const addNew = (dept: StaffDepartment) => {
    const localId = `new-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setDrafts(prev => [...prev, {
      localId, name: '', department: dept,
      startTime: '08:00', endTime: '16:00',
      sortOrder: prev.filter(p => p.department === dept).length,
    }]);
  };

  const updateField = (localId: string, patch: Partial<DraftPreset>) => {
    setDrafts(prev => prev.map(p => p.localId === localId ? { ...p, ...patch } : p));
  };

  const removeRow = (localId: string) => {
    setDrafts(prev => prev.filter(p => p.localId !== localId));
  };

  const seedDefaults = () => {
    setDrafts(DEFAULT_TEMPLATES.map((d, i) => ({
      ...d, localId: `new-seed-${i}`, sortOrder: i,
    })));
  };

  const save = async () => {
    if (!pid) return;
    // Validate.
    for (const d of drafts) {
      if (!d.name.trim()) { setError(`"${d.department}" preset needs a name`); return; }
      if (!TIME_RE.test(d.startTime) || !TIME_RE.test(d.endTime)) {
        setError(`"${d.name}" has an invalid time (use HH:MM, e.g. 08:00)`); return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId: pid,
          presets: drafts.map((d, i) => ({
            id: d.serverId,
            name: d.name.trim(),
            department: d.department,
            startTime: d.startTime,
            endTime: d.endTime,
            sortOrder: i,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Save failed');
      }
      setSavedAt(Date.now());
      // Reload to pick up new server ids.
      const reload = await fetchWithAuth(`/api/staff-schedule/presets?hotelId=${pid}`).then(r => r.json());
      const list = reload?.data?.presets ?? [];
      setDrafts(list.map((p: ShiftPreset, i: number) => ({
        localId: p.id, serverId: p.id, name: p.name, department: p.department,
        startTime: p.startTime, endTime: p.endTime, sortOrder: p.sortOrder ?? i,
      })));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%', padding: '24px 48px 48px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <Link href="/settings" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: fonts.sans, fontSize: 12, color: T.ink2,
          textDecoration: 'none', marginBottom: 14,
        }}>
          <ChevronLeft size={14}/> {lang === 'es' ? 'Configuración' : 'Settings'}
        </Link>

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
          marginBottom: 22, gap: 24,
        }}>
          <div>
            <Caps>{lang === 'es' ? 'Configuración · Turnos' : 'Settings · Shifts'}</Caps>
            <h1 style={{
              fontFamily: fonts.serif, fontSize: 36, color: T.ink,
              margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.1, fontWeight: 400,
            }}>
              <span style={{ fontStyle: 'italic' }}>
                {lang === 'es' ? 'Plantillas de turnos' : 'Shift presets'}
              </span>
            </h1>
            <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginTop: 6, maxWidth: 560, lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Define los turnos que usas con más frecuencia. Aparecerán como opciones al asignar a alguien en el horario semanal.'
                : 'Define the shifts you use most often. They’ll show up as one-click picks when you assign someone in the week grid.'}
            </p>
          </div>
        </div>

        {loading ? (
          <Caps>{lang === 'es' ? 'CARGANDO…' : 'LOADING…'}</Caps>
        ) : drafts.length === 0 ? (
          <div style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: '28px 24px',
            textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          }}>
            <div style={{ fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.01em' }}>
              {lang === 'es' ? 'Sin turnos configurados.' : 'No shifts configured yet.'}
            </div>
            <div style={{ fontSize: 13, color: T.ink2, maxWidth: 420, lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Empieza con un set típico (HK 8a–4p, Recepción AM/PM/Nocturno, Mantenimiento). Puedes editar después.'
                : 'Start with a typical set (HK 8a–4p, Front desk AM/PM/Overnight, Maintenance). You can edit afterwards.'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn variant="primary" size="md" onClick={seedDefaults}>
                {lang === 'es' ? 'Cargar predeterminados' : 'Load defaults'}
              </Btn>
              <Btn variant="ghost" size="md" onClick={() => addNew('housekeeping')}>
                {lang === 'es' ? '+ Empezar vacío' : '+ Start blank'}
              </Btn>
            </div>
          </div>
        ) : (
          <>
            {(['housekeeping', 'front_desk', 'maintenance'] as StaffDepartment[]).map(dept => {
              const m = deptMeta[dept];
              const list = groups[dept];
              return (
                <section key={dept} style={{
                  background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
                  marginBottom: 14, overflow: 'hidden',
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '16px 18px 12px', borderBottom: `1px solid ${T.rule}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.tone }}/>
                      <span style={{ fontWeight: 600, fontSize: 15, color: T.ink }}>{m.label}</span>
                    </div>
                    <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>
                      {list.length} {list.length === 1 ? 'preset' : 'presets'}
                    </span>
                  </div>

                  {list.length === 0 && (
                    <div style={{ padding: '18px 18px', textAlign: 'center', color: T.ink3, fontSize: 12.5 }}>
                      {lang === 'es' ? 'Sin turnos.' : 'No shifts yet.'}
                    </div>
                  )}

                  {list.map(p => (
                    <div key={p.localId} style={{
                      display: 'grid', gridTemplateColumns: '1fr 110px 110px 36px',
                      gap: 10, alignItems: 'center',
                      padding: '10px 18px', borderBottom: `1px solid ${T.ruleSoft}`,
                    }}>
                      <input
                        value={p.name}
                        onChange={e => updateField(p.localId, { name: e.target.value })}
                        placeholder={lang === 'es' ? 'Nombre (p. ej. Mañana HK)' : 'Name (e.g. Morning HK)'}
                        style={inputStyle}
                      />
                      <input
                        value={p.startTime}
                        onChange={e => updateField(p.localId, { startTime: e.target.value })}
                        placeholder="08:00"
                        style={{ ...inputStyle, fontFamily: fonts.mono, textAlign: 'center' }}
                      />
                      <input
                        value={p.endTime}
                        onChange={e => updateField(p.localId, { endTime: e.target.value })}
                        placeholder="16:00"
                        style={{ ...inputStyle, fontFamily: fonts.mono, textAlign: 'center' }}
                      />
                      <button
                        onClick={() => removeRow(p.localId)}
                        title="Remove"
                        style={{
                          width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
                          background: 'transparent', border: `1px solid ${T.rule}`,
                          color: '#A04A2C',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      ><Trash2 size={14}/></button>
                    </div>
                  ))}

                  <button
                    onClick={() => addNew(dept)}
                    style={{
                      width: '100%', padding: '12px 16px', background: 'transparent',
                      border: 'none', borderTop: `1px dashed ${T.rule}`,
                      fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
                      color: T.ink3, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                  >
                    <Plus size={14}/> {lang === 'es' ? `Agregar turno a ${m.label}` : `Add shift to ${m.label}`}
                  </button>
                </section>
              );
            })}

            {error && (
              <div role="alert" style={{
                padding: '10px 14px', background: 'rgba(160,74,44,0.08)',
                border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
                color: '#A04A2C', fontSize: 13, marginTop: 10,
              }}>{error}</div>
            )}

            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16,
              alignItems: 'center',
            }}>
              {savedAt && (
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.06em' }}>
                  SAVED · {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <Btn variant="primary" size="md" onClick={save} disabled={saving}>
                {saving
                  ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                  : (lang === 'es' ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '8px 12px', borderRadius: 10, border: `1px solid ${T.rule}`,
  background: T.paper, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
  outline: 'none',
};
