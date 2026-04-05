'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  getPublicAreas, setPublicArea, deletePublicArea,
  getDeepCleanConfig, setDeepCleanConfig,
  getDeepCleanRecords, markRoomDeepCleaned,
} from '@/lib/firestore';
import { getDefaultPublicAreas } from '@/lib/defaults';
import { daysSinceDeepClean } from '@/lib/calculations';
import { t } from '@/lib/translations';
import type { PublicArea, DeepCleanConfig, DeepCleanRecord } from '@/types';
import Link from 'next/link';
import { Wrench, Plus, Trash2, Check, ChevronDown, ChevronUp, Sparkles, AlertTriangle } from 'lucide-react';

// ── Inline field component ─────────────────────────────────────────────────

const Field = ({
  label, value, onChange, type = 'text', suffix = '', style = {},
}: {
  label: string; value: string | number; onChange: (v: string) => void;
  type?: string; suffix?: string; style?: React.CSSProperties;
}) => (
  <div style={{ ...style }}>
    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {label}
    </label>
    <div style={{ position: 'relative' }}>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="input"
        style={suffix ? { paddingRight: '42px' } : {}}
      />
      {suffix && (
        <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '13px' }}>
          {suffix}
        </span>
      )}
    </div>
  </div>
);

// ── Floor labels ───────────────────────────────────────────────────────────

const FLOORS = [
  { value: '1', label: 'Floor 1' },
  { value: '2', label: 'Floor 2' },
  { value: '3', label: 'Floor 3' },
  { value: '4', label: 'Floor 4' },
  { value: 'other', label: 'Other' },
];

const FREQ_OPTIONS = [
  { value: 1, label: 'Daily' },
  { value: 2, label: 'Every 2 days' },
  { value: 3, label: 'Every 3 days' },
  { value: 7, label: 'Weekly' },
];

// ── Area row ───────────────────────────────────────────────────────────────

function AreaRow({
  area, onUpdate, onDelete,
}: {
  area: PublicArea;
  onUpdate: (updated: PublicArea) => void;
  onDelete: () => void;
}) {
  const { lang } = useLang();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Collapsed summary */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
          padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left', color: 'var(--text-primary)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontWeight: 600, fontSize: '14px', lineHeight: 1.3, marginBottom: '2px' }}>
            {area.name}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {area.minutesPerClean}min · {area.locations} loc · {FREQ_OPTIONS.find(f => f.value === area.frequencyDays)?.label ?? `Every ${area.frequencyDays}d`}
          </p>
        </div>
        {expanded ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
      </button>

      {/* Expanded editor */}
      {expanded && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ paddingTop: '12px' }}>
            <Field label={t('name', lang)} value={area.name} onChange={v => onUpdate({ ...area, name: v })} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('floor', lang)}
              </label>
              <select
                value={area.floor}
                onChange={e => onUpdate({ ...area, floor: e.target.value })}
                className="input"
                style={{ width: '100%' }}
              >
                {FLOORS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('frequency', lang)}
              </label>
              <select
                value={area.frequencyDays}
                onChange={e => onUpdate({ ...area, frequencyDays: Number(e.target.value) })}
                className="input"
                style={{ width: '100%' }}
              >
                {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <Field
              label={t('minutesPerClean', lang)}
              value={area.minutesPerClean}
              onChange={v => onUpdate({ ...area, minutesPerClean: Number(v) || 0 })}
              type="number"
              suffix="min"
            />
            <Field
              label={t('locations', lang)}
              value={area.locations}
              onChange={v => onUpdate({ ...area, locations: Number(v) || 1 })}
              type="number"
            />
          </div>

          <button
            onClick={onDelete}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '10px', borderRadius: '8px', border: '1px solid rgba(220,38,38,0.2)',
              background: 'rgba(220,38,38,0.06)', color: '#dc2626',
              cursor: 'pointer', fontSize: '13px', fontWeight: 600,
            }}
          >
            <Trash2 size={14} /> {t('delete', lang)}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Floor tab labels (short for tabs) ──────────────────────────────────────

const FLOOR_TABS = [
  { value: '1', label: 'Floor 1' },
  { value: '2', label: 'Floor 2' },
  { value: '3', label: 'Floor 3' },
  { value: '4', label: 'Floor 4' },
  { value: 'other', label: 'Other' },
];

// ── Main page ──────────────────────────────────────────────────────────────

export default function OperationsConfigPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  // ── Public Areas state ────────────────────────────────────────────────────
  const [areas, setAreas] = useState<PublicArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeFloor, setActiveFloor] = useState('1');

  // ── Deep Cleaning state ───────────────────────────────────────────────────
  const [dcConfig, setDcConfig] = useState<DeepCleanConfig>({ frequencyDays: 90, minutesPerRoom: 60, targetPerWeek: 5 });
  const [dcRecords, setDcRecords] = useState<DeepCleanRecord[]>([]);
  const [dcLoading, setDcLoading] = useState(true);
  const [dcSaving, setDcSaving] = useState(false);
  const [dcSaved, setDcSaved] = useState(false);
  const [dcDirty, setDcDirty] = useState(false);
  const [dcNewRoom, setDcNewRoom] = useState('');
  const [dcNewBy, setDcNewBy] = useState('');
  const [dcMarking, setDcMarking] = useState(false);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // Load public areas
  useEffect(() => {
    if (!uid || !pid) return;
    setLoading(true);
    getPublicAreas(uid, pid).then(async (fetched) => {
      if (fetched.length > 0) {
        setAreas(fetched);
      } else {
        // Seed defaults on first load
        const defaults = getDefaultPublicAreas();
        const seeded: PublicArea[] = [];
        for (const area of defaults) {
          const id = crypto.randomUUID();
          const full = { id, ...area } as PublicArea;
          await setPublicArea(uid, pid, full);
          seeded.push(full);
        }
        setAreas(seeded);
      }
      setLoading(false);
    });
  }, [uid, pid]);

  // Load deep clean config + records
  useEffect(() => {
    if (!uid || !pid) return;
    setDcLoading(true);
    Promise.all([
      getDeepCleanConfig(uid, pid),
      getDeepCleanRecords(uid, pid),
    ]).then(([config, records]) => {
      setDcConfig(config);
      setDcRecords(records);
      setDcLoading(false);
    });
  }, [uid, pid]);

  const handleUpdate = (idx: number, updated: PublicArea) => {
    setAreas(prev => prev.map((a, i) => i === idx ? updated : a));
    setDirty(true);
  };

  const handleDelete = (idx: number) => {
    const area = areas[idx];
    setAreas(prev => prev.filter((_, i) => i !== idx));
    if (uid && pid) deletePublicArea(uid, pid, area.id);
    setDirty(true);
  };

  const handleAdd = () => {
    const id = crypto.randomUUID();
    const today = new Date().toLocaleDateString('en-CA');
    setAreas(prev => [...prev, {
      id,
      name: '',
      floor: activeFloor,
      locations: 1,
      frequencyDays: 1,
      minutesPerClean: 15,
      startDate: today,
    }]);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!uid || !pid) return;
    setSaving(true);
    try {
      await Promise.all(areas.map(a => setPublicArea(uid, pid, a)));
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  // ── Deep Cleaning handlers ────────────────────────────────────────────────

  const handleDcSave = async () => {
    if (!uid || !pid) return;
    setDcSaving(true);
    try {
      await setDeepCleanConfig(uid, pid, dcConfig);
      setDcSaved(true);
      setDcDirty(false);
      setTimeout(() => setDcSaved(false), 2500);
    } finally {
      setDcSaving(false);
    }
  };

  const handleMarkDeepCleaned = async () => {
    if (!uid || !pid || !dcNewRoom.trim()) return;
    setDcMarking(true);
    try {
      await markRoomDeepCleaned(uid, pid, dcNewRoom.trim(), dcNewBy.trim() || undefined);
      // Refresh records
      const updated = await getDeepCleanRecords(uid, pid);
      setDcRecords(updated);
      setDcNewRoom('');
      setDcNewBy('');
    } finally {
      setDcMarking(false);
    }
  };

  // Deep clean records sorted: overdue first (most overdue at top), then recently cleaned
  const today = new Date();
  const dcSorted = [...dcRecords].map(rec => ({
    ...rec,
    daysSince: daysSinceDeepClean(rec.roomNumber, dcRecords, today),
  })).sort((a, b) => b.daysSince - a.daysSince);

  // Count per floor for badges
  const floorCounts: Record<string, number> = {};
  for (const a of areas) floorCounts[a.floor] = (floorCounts[a.floor] || 0) + 1;

  // Filtered areas for the active floor tab
  const visibleAreas = areas
    .map((a, idx) => ({ area: a, idx }))
    .filter(({ area }) => area.floor === activeFloor);

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>

        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>
            ← {t('settings', lang)}
          </Link>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Wrench size={18} color="var(--amber)" /> {t('operationsConfig', lang)}
          </h1>
        </div>

        {/* Header + Add */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <p style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>Public Areas</p>
          <button
            onClick={handleAdd}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '6px 12px', borderRadius: '8px',
              background: 'rgba(27,58,92,0.08)', border: '1px solid rgba(27,58,92,0.15)',
              color: 'var(--navy)', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
            }}
          >
            <Plus size={14} /> {t('addPublicArea', lang)}
          </button>
        </div>

        {/* Floor tabs */}
        <div style={{
          display: 'flex', gap: '4px', marginBottom: '16px',
          background: 'rgba(0,0,0,0.03)', borderRadius: '10px', padding: '3px',
        }}>
          {FLOOR_TABS.map(f => {
            const isActive = activeFloor === f.value;
            const count = floorCounts[f.value] || 0;
            return (
              <button
                key={f.value}
                onClick={() => setActiveFloor(f.value)}
                style={{
                  flex: 1, padding: '8px 4px', borderRadius: '8px', border: 'none',
                  background: isActive ? 'white' : 'transparent',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  color: isActive ? 'var(--navy)' : 'var(--text-muted)',
                  fontWeight: isActive ? 700 : 500, fontSize: '13px',
                  cursor: 'pointer', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: '4px', transition: 'all 0.15s',
                }}
              >
                {f.label}
                {count > 0 && (
                  <span style={{
                    fontSize: '10px', fontWeight: 700, minWidth: '16px', height: '16px',
                    borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: isActive ? 'rgba(27,58,92,0.1)' : 'rgba(0,0,0,0.06)',
                    color: isActive ? 'var(--navy)' : 'var(--text-muted)',
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Area list for active floor */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {visibleAreas.map(({ area, idx }) => (
              <AreaRow
                key={area.id}
                area={area}
                onUpdate={updated => handleUpdate(idx, updated)}
                onDelete={() => handleDelete(idx)}
              />
            ))}

            {visibleAreas.length === 0 && (
              <div className="card" style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                {t('noAreasFloor', lang)}
              </div>
            )}
          </div>
        )}

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving || saved || !dirty}
          className={`btn btn-xl ${saved ? 'btn-green' : 'btn-primary'}`}
          style={{
            width: '100%', justifyContent: 'center', marginTop: '24px',
            opacity: (!dirty && !saved) ? 0.5 : 1,
          }}
        >
          {saved ? <><Check size={20} /> {t('saved', lang)}</> : saving ? t('saving', lang) : t('saveChanges', lang)}
        </button>

        {/* ─── Deep Cleaning Section ───────────────────────────────────────── */}
        <div style={{ marginTop: '40px', borderTop: '2px solid var(--border)', paddingTop: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Sparkles size={18} color="var(--amber)" />
            <p style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>Deep Cleaning</p>
          </div>

          {dcLoading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>
          ) : (
            <>
              {/* Config fields */}
              <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px' }}>
                  Set how often each room needs a deep clean and how long it takes. The system will flag overdue rooms and suggest deep cleans on light days.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                  <Field
                    label="Frequency"
                    value={dcConfig.frequencyDays}
                    onChange={v => { setDcConfig(c => ({ ...c, frequencyDays: Number(v) || 90 })); setDcDirty(true); }}
                    type="number"
                    suffix="days"
                  />
                  <Field
                    label="Time / Room"
                    value={dcConfig.minutesPerRoom}
                    onChange={v => { setDcConfig(c => ({ ...c, minutesPerRoom: Number(v) || 60 })); setDcDirty(true); }}
                    type="number"
                    suffix="min"
                  />
                  <Field
                    label="Target / Week"
                    value={dcConfig.targetPerWeek}
                    onChange={v => { setDcConfig(c => ({ ...c, targetPerWeek: Number(v) || 5 })); setDcDirty(true); }}
                    type="number"
                    suffix="rooms"
                  />
                </div>

                {/* Deep clean config save */}
                <button
                  onClick={handleDcSave}
                  disabled={dcSaving || dcSaved || !dcDirty}
                  className={`btn ${dcSaved ? 'btn-green' : 'btn-primary'}`}
                  style={{
                    width: '100%', justifyContent: 'center', marginTop: '14px',
                    padding: '10px', fontSize: '13px',
                    opacity: (!dcDirty && !dcSaved) ? 0.5 : 1,
                  }}
                >
                  {dcSaved ? <><Check size={16} /> Saved</> : dcSaving ? 'Saving...' : 'Save Deep Clean Settings'}
                </button>
              </div>

              {/* Mark room as deep cleaned */}
              <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
                <p style={{ fontWeight: 600, fontSize: '14px', marginBottom: '10px', color: 'var(--text-primary)' }}>
                  Mark Room as Deep Cleaned
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Room #
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. 201"
                      value={dcNewRoom}
                      onChange={e => setDcNewRoom(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleMarkDeepCleaned()}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Cleaned By
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Optional"
                      value={dcNewBy}
                      onChange={e => setDcNewBy(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleMarkDeepCleaned()}
                    />
                  </div>
                  <button
                    onClick={handleMarkDeepCleaned}
                    disabled={dcMarking || !dcNewRoom.trim()}
                    className="btn btn-primary"
                    style={{ padding: '10px 16px', fontSize: '13px', whiteSpace: 'nowrap', opacity: !dcNewRoom.trim() ? 0.5 : 1 }}
                  >
                    {dcMarking ? '...' : <><Check size={14} /> Mark</>}
                  </button>
                </div>
              </div>

              {/* Deep clean records list */}
              <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                  Room Tracker
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {dcRecords.length} room{dcRecords.length !== 1 ? 's' : ''} tracked
                </p>
              </div>

              {dcSorted.length === 0 ? (
                <div className="card" style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                  No deep clean records yet. Mark a room above to start tracking.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {dcSorted.map(rec => {
                    const overdue = rec.daysSince >= dcConfig.frequencyDays;
                    const warning = rec.daysSince >= dcConfig.frequencyDays * 0.8;
                    return (
                      <div
                        key={rec.roomNumber}
                        className="card"
                        style={{
                          padding: '12px 16px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          borderLeft: overdue ? '3px solid #dc2626' : warning ? '3px solid #f59e0b' : '3px solid #22c55e',
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: '15px', minWidth: '48px', color: 'var(--text-primary)' }}>
                          {rec.roomNumber}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                            Last cleaned: {rec.lastDeepClean}
                          </p>
                          {rec.cleanedBy && (
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                              By {rec.cleanedBy}
                            </p>
                          )}
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          {overdue ? (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              fontSize: '12px', fontWeight: 700, color: '#dc2626',
                              background: 'rgba(220,38,38,0.08)', padding: '3px 8px', borderRadius: '6px',
                            }}>
                              <AlertTriangle size={12} /> {rec.daysSince}d overdue
                            </span>
                          ) : warning ? (
                            <span style={{
                              fontSize: '12px', fontWeight: 600, color: '#f59e0b',
                              background: 'rgba(245,158,11,0.08)', padding: '3px 8px', borderRadius: '6px',
                            }}>
                              {rec.daysSince}d ago
                            </span>
                          ) : (
                            <span style={{
                              fontSize: '12px', fontWeight: 600, color: '#22c55e',
                              background: 'rgba(34,197,94,0.08)', padding: '3px 8px', borderRadius: '6px',
                            }}>
                              {rec.daysSince}d ago
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </AppLayout>
  );
}
