'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  subscribeToInspections, addInspection, updateInspection, deleteInspection,
} from '@/lib/firestore';
import type { Inspection } from '@/types';
import {
  Plus, ClipboardCheck, AlertTriangle, Check, Calendar, Trash2, ChevronRight, X,
} from 'lucide-react';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_INSPECTIONS: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>[] = [
  { name: 'Elevator Inspection', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Fire Extinguisher Inspection', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Fire Sprinkler Inspection', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Fire Panel Inspection', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Breakfast / Health Inspection', propertyId: '', dueMonth: '', frequencyMonths: 6 },
  { name: 'Pool Inspection', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Backflow Preventer Test', propertyId: '', dueMonth: '', frequencyMonths: 12 },
  { name: 'Pest Control Inspection', propertyId: '', dueMonth: '', frequencyMonths: 3 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function currentYM(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(ym: string): string {
  if (!ym) return 'Not set';
  const [y, m] = ym.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

function addMonths(ym: string, months: number): string {
  const [y, m] = ym.split('-').map(Number);
  const date = new Date(y, m - 1 + months, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

type InspectionStatus = 'overdue' | 'due' | 'upcoming' | 'notset';

function getStatus(dueMonth: string): InspectionStatus {
  if (!dueMonth) return 'notset';
  const now = currentYM();
  if (dueMonth < now) return 'overdue';
  if (dueMonth === now) return 'due';
  return 'upcoming';
}

const STATUS_CONFIG = {
  overdue: { color: 'var(--red)', bg: 'var(--red-dim, rgba(220,38,38,0.08))', label: 'Overdue', labelEs: 'Vencida', icon: AlertTriangle },
  due:     { color: 'var(--amber)', bg: 'var(--amber-dim, rgba(245,158,11,0.08))', label: 'Due This Month', labelEs: 'Pendiente', icon: Calendar },
  upcoming:{ color: 'var(--green)', bg: 'var(--green-dim, rgba(34,197,94,0.06))', label: 'Good', labelEs: 'Al Día', icon: Check },
  notset:  { color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.08)', label: 'Set Date', labelEs: 'Sin Fecha', icon: Calendar },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function InspectionsView() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editModal, setEditModal] = useState<Inspection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Load Material Symbols Outlined font
  useEffect(() => {
    if (document.querySelector('link[href*="Material+Symbols+Outlined"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap';
    document.head.appendChild(link);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // Subscribe
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let isFirst = true;
    const unsub = subscribeToInspections(user.uid, activePropertyId, (items) => {
      setInspections(items);
      if (isFirst && items.length === 0 && !seeded) {
        setSeeded(true);
        DEFAULT_INSPECTIONS.forEach(def => {
          addInspection(user.uid, activePropertyId, { ...def, propertyId: activePropertyId })
            .catch(err => console.error('[inspections] seed default failed:', err));
        });
      }
      isFirst = false;
    });
    return unsub;
  }, [user, activePropertyId, seeded]);

  // Sort: overdue first, then due, then notset, then upcoming
  const sorted = useMemo(() => {
    const order: Record<InspectionStatus, number> = { overdue: 0, due: 1, notset: 2, upcoming: 3 };
    return [...inspections].sort((a, b) => {
      const sa = getStatus(a.dueMonth);
      const sb = getStatus(b.dueMonth);
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      return a.name.localeCompare(b.name);
    });
  }, [inspections]);

  const dueCount = useMemo(() => inspections.filter(i => getStatus(i.dueMonth) === 'due').length, [inspections]);
  const overdueCount = useMemo(() => inspections.filter(i => getStatus(i.dueMonth) === 'overdue').length, [inspections]);
  const alertCount = dueCount + overdueCount;

  if (!user || !activePropertyId) return null;

  const handleSaveEdit = async (id: string, updates: Partial<Inspection>) => {
    try {
      await updateInspection(user.uid, activePropertyId, id, updates);
      setEditModal(null);
      showToast(lang === 'es' ? 'Inspección actualizada' : 'Inspection updated');
    } catch (error) {
      console.error('Error updating inspection:', error);
      showToast(lang === 'es' ? 'Error al actualizar' : 'Error updating inspection');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteInspection(user.uid, activePropertyId, id);
      setEditModal(null);
      showToast(lang === 'es' ? 'Inspección eliminada' : 'Inspection removed');
    } catch (error) {
      console.error('Error deleting inspection:', error);
      showToast(lang === 'es' ? 'Error al eliminar' : 'Error removing inspection');
    }
  };

  // ─── Dynamic computed values ─────────────────────────────────────────────
  const totalInspections = inspections.length;
  const goodCount = inspections.filter(i => getStatus(i.dueMonth) === 'upcoming').length;
  const notsetCount = inspections.filter(i => getStatus(i.dueMonth) === 'notset').length;
  const healthPct = totalInspections > 0 ? Math.round(((goodCount) / totalInspections) * 100) : 100;

  // Icon mapping for inspection types
  const getInspectionIcon = (name: string): string => {
    const n = name.toLowerCase();
    if (n.includes('elevator')) return 'elevator';
    if (n.includes('fire ext')) return 'fire_extinguisher';
    if (n.includes('sprinkler') || n.includes('fire spr')) return 'fire_extinguisher';
    if (n.includes('fire panel')) return 'local_fire_department';
    if (n.includes('breakfast') || n.includes('health') || n.includes('kitchen')) return 'restaurant';
    if (n.includes('pool')) return 'pool';
    if (n.includes('backflow') || n.includes('water')) return 'water_damage';
    if (n.includes('pest')) return 'pest_control';
    if (n.includes('hvac') || n.includes('air')) return 'air';
    if (n.includes('roof')) return 'roofing';
    return 'assignment_turned_in';
  };

  const getIconBg = (status: InspectionStatus): string => {
    switch (status) {
      case 'overdue': return 'rgba(186,26,26,0.08)';
      case 'due': return 'rgba(211,228,248,0.3)';
      case 'upcoming': return 'rgba(0,101,101,0.06)';
      default: return '#f0eee9';
    }
  };

  const getIconColor = (status: InspectionStatus): string => {
    switch (status) {
      case 'overdue': return '#ba1a1a';
      case 'due': return '#506071';
      case 'upcoming': return '#006565';
      default: return '#454652';
    }
  };

  const getStatusPill = (status: InspectionStatus): { bg: string; color: string; label: string; labelEs: string } => {
    switch (status) {
      case 'overdue': return { bg: '#ffdad6', color: '#93000a', label: 'Overdue', labelEs: 'Vencida' };
      case 'due': return { bg: '#d3e4f8', color: '#394858', label: 'Due This Month', labelEs: 'Pendiente' };
      case 'upcoming': return { bg: 'rgba(0,101,101,0.08)', color: '#006565', label: 'Annual Compliance', labelEs: 'Al Día' };
      default: return { bg: '#eae8e3', color: '#454652', label: 'Set Date', labelEs: 'Sin Fecha' };
    }
  };

  const getFreqLabel = (months: number): string => {
    if (months === 1) return 'Monthly';
    if (months === 3) return 'Quarterly';
    if (months === 6) return 'Semi-Annual';
    if (months === 12) return 'Annual';
    return `Every ${months}mo`;
  };

  const getActionIcon = (status: InspectionStatus): string => {
    switch (status) {
      case 'overdue': return 'chevron_right';
      case 'due': return 'chevron_right';
      case 'upcoming': return 'add_task';
      default: return 'calendar_month';
    }
  };

  const getActionBg = (status: InspectionStatus): string => {
    switch (status) {
      case 'overdue': return '#364262';
      case 'due': return '#eae8e3';
      default: return '#eae8e3';
    }
  };

  const getActionColor = (status: InspectionStatus): string => {
    switch (status) {
      case 'overdue': return '#fff';
      default: return '#364262';
    }
  };

  // AI recommendation text
  const aiRecommendation = (() => {
    const overdueItems = inspections.filter(i => getStatus(i.dueMonth) === 'overdue');
    const dueItems = inspections.filter(i => getStatus(i.dueMonth) === 'due');
    if (overdueItems.length > 0) {
      const first = overdueItems[0];
      const otherOverdue = overdueItems.length > 1 ? overdueItems[1] : null;
      if (otherOverdue) {
        return `The **${first.name}** is currently overdue. Failure to inspect promptly may result in regulatory penalties. Our AI suggests scheduling this simultaneously with the **${otherOverdue.name}** check to reduce contractor call-out fees.`;
      }
      return `The **${first.name}** is currently overdue. Schedule this inspection as soon as possible to avoid regulatory penalties and maintain compliance.`;
    }
    if (dueItems.length > 0) {
      return `${dueItems.length} inspection${dueItems.length !== 1 ? 's' : ''} due this month. Schedule them together to minimize vendor coordination overhead and reduce costs.`;
    }
    return null;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* ── Asset Health Hero Card ── */}
      <div style={{
        background: '#f5f3ee', padding: '40px 48px', borderRadius: '20px',
        position: 'relative', overflow: 'hidden',
        border: '1px solid rgba(78,90,122,0.06)',
      }}>
        {/* Atmospheric blur */}
        <div style={{
          position: 'absolute', top: '-80px', right: '-80px', width: '240px', height: '240px',
          background: 'rgba(0,101,101,0.04)', borderRadius: '50%', filter: 'blur(60px)',
        }} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '24px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '18px' }}>⚡</span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#006565' }}>
                {lang === 'es' ? 'Inteligencia de Mantenimiento' : 'Maintenance Intelligence'}
              </span>
            </div>
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '36px', fontWeight: 600, color: '#1b1c19', lineHeight: 1.15, margin: 0 }}>
              {lang === 'es' ? 'Salud de Activos' : 'Asset Health'}<br />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262' }}>{healthPct}%</span> {lang === 'es' ? 'Óptimo' : 'Optimal'}
            </h2>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#454652', marginBottom: '8px' }}>
              {lang === 'es' ? 'Estado del Sistema' : 'System Status'}: {overdueCount > 0 ? (lang === 'es' ? 'Atención' : 'Attention') : (lang === 'es' ? 'Activo' : 'Active')}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              {overdueCount > 0 && (
                <div style={{
                  padding: '6px 14px', background: '#fff', borderRadius: '9999px',
                  border: '1px solid rgba(197,197,212,0.2)',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#ba1a1a' }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#1b1c19' }}>
                    {overdueCount} {lang === 'es' ? 'Crítico' : 'Critical'}
                  </span>
                </div>
              )}
              {(dueCount + goodCount + notsetCount) > 0 && (
                <div style={{
                  padding: '6px 14px', background: '#fff', borderRadius: '9999px',
                  border: '1px solid rgba(197,197,212,0.2)',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#d3e4f8' }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#1b1c19' }}>
                    {dueCount + goodCount + notsetCount} {lang === 'es' ? 'Próximas' : 'Upcoming'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Section Title + Sort ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '24px', fontWeight: 500, letterSpacing: '-0.02em', color: '#1b1c19', margin: 0 }}>
          {lang === 'es' ? 'Mantenimiento Preventivo' : 'Preventive Maintenance'}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#454652' }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 500 }}>
            {lang === 'es' ? 'Ordenar por: Prioridad' : 'Sort by: Priority'}
          </span>
        </div>
      </div>

      {/* ── Inspection Cards Feed ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {sorted.length === 0 ? (
          <div style={{
            background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(12px)',
            borderRadius: '16px', padding: '48px 24px', textAlign: 'center',
            border: '1px solid rgba(197,197,212,0.2)',
          }}>
            <ClipboardCheck size={28} color="#757684" style={{ margin: '0 auto 8px' }} />
            <p style={{ fontSize: '14px', color: '#757684' }}>
              {lang === 'es' ? 'No hay inspecciones configuradas' : 'No inspections set up yet'}
            </p>
          </div>
        ) : (
          sorted.map((item) => {
            const status = getStatus(item.dueMonth);
            const pill = getStatusPill(status);
            const isBorderLeft = status === 'upcoming' || status === 'overdue';
            return (
              <div
                key={item.id}
                onClick={() => setEditModal(item)}
                style={{
                  background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                  borderRadius: '16px', padding: '28px 32px',
                  border: '1px solid rgba(197,197,212,0.2)',
                  borderLeft: isBorderLeft ? `4px solid ${getIconColor(status)}` : undefined,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: '24px', cursor: 'pointer',
                  transition: 'transform 200ms cubic-bezier(0.2,0,0,1)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
              >
                {/* Left: Icon + Info */}
                <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flex: 1, minWidth: 0 }}>
                  <div style={{
                    width: '56px', height: '56px', borderRadius: '16px',
                    background: getIconBg(status),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <span className="material-symbols-outlined" style={{
                      fontSize: '26px', color: getIconColor(status),
                      fontVariationSettings: status === 'overdue' ? "'FILL' 1" : "'FILL' 0",
                    }}>
                      {getInspectionIcon(item.name)}
                    </span>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '3px' }}>
                      <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
                        {item.name}
                      </h3>
                      <span style={{
                        padding: '3px 10px', borderRadius: '9999px',
                        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                        background: pill.bg, color: pill.color,
                      }}>
                        {lang === 'es' ? pill.labelEs : pill.label}
                      </span>
                    </div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', margin: 0 }}>
                      {lang === 'es' ? 'Frecuencia' : 'Frequency'}: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{getFreqLabel(item.frequencyMonths)}</span>
                      {item.lastInspectedDate && (
                        <span> · {lang === 'es' ? 'Última' : 'Last'}: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{item.lastInspectedDate}</span></span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Right: Due date + action */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#757684', marginBottom: '3px' }}>
                      {item.dueMonth ? (lang === 'es' ? 'Próxima' : 'Next Due') : (lang === 'es' ? 'Frecuencia' : 'Frequency')}
                    </p>
                    <p style={{
                      fontFamily: "'JetBrains Mono', monospace", fontSize: '16px',
                      color: status === 'overdue' ? '#ba1a1a' : '#1b1c19', margin: 0,
                    }}>
                      {item.dueMonth ? item.dueMonth.replace('-', '.') : getFreqLabel(item.frequencyMonths)}
                    </p>
                  </div>
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%',
                    background: getActionBg(status), color: getActionColor(status),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'box-shadow 200ms',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
                      {getActionIcon(status)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* ── Inline "New Entry" card at bottom of list ── */}
        <div
          onClick={() => setShowAddModal(true)}
          style={{
            background: 'rgba(255,255,255,0.4)', backdropFilter: 'blur(12px)',
            borderRadius: '16px', padding: '28px 32px',
            border: '2px dashed rgba(197,197,212,0.3)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: '12px', cursor: 'pointer',
            transition: 'all 200ms cubic-bezier(0.2,0,0,1)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.7)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(54,66,98,0.3)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.4)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(197,197,212,0.3)'; }}
        >
          <div style={{
            width: '44px', height: '44px', borderRadius: '50%',
            background: '#364262', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Plus size={20} strokeWidth={2.5} />
          </div>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600, color: '#364262' }}>
            {lang === 'es' ? 'Agregar Inspección' : 'New Entry'}
          </span>
        </div>
      </div>

      {/* ── AI Concierge Recommendation ── */}
      {aiRecommendation && (
        <div style={{
          borderRadius: '16px', padding: '28px 32px',
          background: '#fff', border: '1px solid rgba(0,101,101,0.1)',
          position: 'relative', overflow: 'hidden', marginTop: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px' }}>
            <span style={{ fontSize: '24px', marginTop: '2px' }}>✨</span>
            <div>
              <h4 style={{ fontFamily: "'Inter', sans-serif", fontSize: '16px', fontWeight: 600, color: '#1b1c19', marginBottom: '8px' }}>
                {lang === 'es' ? 'Recomendación del Conserje' : 'Concierge Recommendation'}
              </h4>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#454652', lineHeight: 1.7, margin: 0 }}
                dangerouslySetInnerHTML={{
                  __html: aiRecommendation.replace(/\*\*(.*?)\*\*/g, '<span style="font-family: \'JetBrains Mono\', monospace; color: #364262; font-weight: 600;">$1</span>'),
                }}
              />
              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                <button style={{
                  background: '#006565', color: '#82e2e1', padding: '8px 20px', borderRadius: '9999px',
                  border: 'none', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '6px',
                  fontFamily: "'Inter', sans-serif",
                  transition: 'background 150ms',
                }}>
                  <Calendar size={14} />
                  {lang === 'es' ? 'Programar Lote' : 'Batch Schedule'}
                </button>
                <button style={{
                  background: 'transparent', color: '#454652', padding: '8px 20px', borderRadius: '9999px',
                  border: 'none', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                  fontFamily: "'Inter', sans-serif",
                  transition: 'background 150ms',
                }}>
                  {lang === 'es' ? 'Descartar' : 'Dismiss'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Inspection Modal */}
      <AddInspectionModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        uid={user.uid}
        pid={activePropertyId}
        onAdded={() => showToast(lang === 'es' ? 'Inspección agregada' : 'Inspection added')}
      />

      {/* Edit Inspection Modal */}
      {editModal && (
        <EditInspectionModal
          inspection={editModal}
          onClose={() => setEditModal(null)}
          onSave={(updates) => handleSaveEdit(editModal.id, updates)}
          onDelete={() => handleDelete(editModal.id)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
          padding: '12px 24px', borderRadius: '9999px',
          background: '#364262', color: '#fff',
          fontSize: '14px', fontWeight: 600, zIndex: 50,
          fontFamily: "'Inter', sans-serif",
          boxShadow: '0 8px 24px rgba(54,66,98,0.3)',
          backdropFilter: 'blur(12px)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Frequency Slider ────────────────────────────────────────────────────────

const FREQ_STOPS = [1, 3, 6, 12];
const SLIDER_LABELS = ['1mo', '3mo', '6mo', '1yr', 'Custom'];

function freqLabel(months: number, isCustom: boolean): string {
  if (isCustom) return 'Custom';
  if (months === 1) return 'Monthly';
  if (months === 3) return 'Quarterly';
  if (months === 6) return 'Every 6 months';
  if (months === 12) return 'Annual';
  return `Every ${months}mo`;
}

function FrequencySlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const presetIdx = FREQ_STOPS.indexOf(value);
  const [isCustom, setIsCustom] = useState(presetIdx === -1);
  const [customValue, setCustomValue] = useState(String(presetIdx === -1 ? value : 18));
  const sliderIdx = isCustom ? FREQ_STOPS.length : (presetIdx >= 0 ? presetIdx : FREQ_STOPS.length);
  const maxIdx = FREQ_STOPS.length;
  const fillPct = (sliderIdx / maxIdx) * 100;

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px',
      }}>
        <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
          Frequency
        </span>
        <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--navy, #1b3a5c)' }}>
          {isCustom ? `Every ${value} months` : freqLabel(value, false)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={maxIdx}
        step={1}
        value={sliderIdx}
        aria-label="Inspection frequency"
        onChange={e => {
          const i = parseInt(e.target.value);
          if (i < FREQ_STOPS.length) {
            setIsCustom(false);
            onChange(FREQ_STOPS[i]);
          } else {
            setIsCustom(true);
            onChange(parseInt(customValue) || 18);
          }
        }}
        style={{
          width: '100%', height: '6px', borderRadius: '99px',
          appearance: 'none', WebkitAppearance: 'none',
          background: `linear-gradient(to right, var(--navy, #1b3a5c) ${fillPct}%, rgba(0,0,0,0.1) ${fillPct}%)`,
          outline: 'none', cursor: 'pointer',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
        {SLIDER_LABELS.map((label, i) => (
          <span
            key={label}
            onClick={() => {
              if (i < FREQ_STOPS.length) { setIsCustom(false); onChange(FREQ_STOPS[i]); }
              else { setIsCustom(true); onChange(parseInt(customValue) || 18); }
            }}
            style={{
              fontSize: '10px',
              color: i === sliderIdx ? 'var(--navy, #1b3a5c)' : 'var(--text-muted)',
              fontWeight: i === sliderIdx ? 700 : 400,
              cursor: 'pointer', minWidth: '20px', textAlign: 'center',
            }}
          >
            {label}
          </span>
        ))}
      </div>

      {isCustom && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px',
          padding: '10px 12px', borderRadius: 'var(--radius-md)',
          border: '1.5px solid var(--border)', background: 'var(--bg)',
        }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Every</span>
          <input
            type="number"
            min="1"
            max="120"
            value={customValue}
            aria-label="Custom frequency in months"
            onChange={e => {
              setCustomValue(e.target.value);
              const v = parseInt(e.target.value);
              if (v && v > 0) onChange(v);
            }}
            autoFocus
            style={{
              width: '60px', padding: '6px 8px', borderRadius: '6px',
              border: '2px solid var(--navy, #1b3a5c)', background: 'var(--bg)',
              fontSize: '16px', fontWeight: 700, fontFamily: 'var(--font-mono)',
              textAlign: 'center', color: 'var(--navy, #1b3a5c)', outline: 'none',
            }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>months</span>
        </div>
      )}
    </div>
  );
}

// ─── Edit Inspection Modal ──────────────────────────────────────────────────

function EditInspectionModal({ inspection, onClose, onSave, onDelete }: {
  inspection: Inspection;
  onClose: () => void;
  onSave: (updates: Partial<Inspection>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(inspection.name);
  const [dueMonth, setDueMonth] = useState(inspection.dueMonth || currentYM());
  const [freq, setFreq] = useState(inspection.frequencyMonths);
  const [notes, setNotes] = useState(inspection.notes || '');
  const [lastInspected, setLastInspected] = useState(inspection.lastInspectedDate || '');
  const [dueMonthTouched, setDueMonthTouched] = useState(false);

  // Auto-compute Due Month from Last Inspected + Frequency.
  // Runs whenever lastInspected or freq changes, unless user manually edits Due Month.
  useEffect(() => {
    if (!lastInspected || dueMonthTouched) return;
    const [y, m] = lastInspected.split('-').map(Number);
    if (!y || !m) return;
    const lastYM = `${y}-${String(m).padStart(2, '0')}`;
    const next = addMonths(lastYM, freq);
    setDueMonth(next);
  }, [lastInspected, freq, dueMonthTouched]);

  const hasChanges = name !== inspection.name || dueMonth !== (inspection.dueMonth || currentYM())
    || freq !== inspection.frequencyMonths || notes !== (inspection.notes || '')
    || lastInspected !== (inspection.lastInspectedDate || '');

  // Reactive status — reflects the current form state, not the stored value,
  // so the colored accent updates live as the user picks a new date.
  const status = getStatus(dueMonth);
  const cfg = STATUS_CONFIG[status];
  const todayISO = new Date().toISOString().split('T')[0];

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    fontSize: '14px', color: 'var(--text-primary)',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)', borderRadius: 'var(--radius-lg)',
          width: '100%', maxWidth: '420px', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{
          padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Edit Inspection
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '28px', height: '28px', borderRadius: '6px',
              border: '1px solid var(--border)', background: 'var(--bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text-muted)',
            }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Inspection Name
            </label>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{
                width: '8px', height: '8px', borderRadius: '99px',
                background: cfg.color, flexShrink: 0,
              }} />
              Last Inspected
              <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: cfg.color }}>
                · {cfg.label}
              </span>
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                type="date"
                value={lastInspected}
                max={todayISO}
                onChange={e => { setLastInspected(e.target.value); setDueMonthTouched(false); }}
                style={{ ...inputStyle, flex: 1, borderLeftWidth: '4px', borderLeftColor: cfg.color }}
              />
              <button
                type="button"
                onClick={() => {
                  const today = new Date().toISOString().split('T')[0];
                  setLastInspected(today);
                  setDueMonthTouched(false);
                }}
                style={{
                  padding: '0 14px', borderRadius: 'var(--radius-md)',
                  background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                Today
              </button>
            </div>
          </div>

          <FrequencySlider value={freq} onChange={(v) => { setFreq(v); setDueMonthTouched(false); }} />

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Due Month {lastInspected && !dueMonthTouched && (
                <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>
                  · auto-calculated
                </span>
              )}
            </label>
            <input
              type="month"
              value={dueMonth}
              onChange={e => { setDueMonth(e.target.value); setDueMonthTouched(true); }}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Notes
            </label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Vendor, contact info, certificate #..."
              rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>

        <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={() => onSave({ name: name.trim(), dueMonth, frequencyMonths: freq, notes: notes.trim() || undefined, ...(lastInspected ? { lastInspectedDate: lastInspected } : {}) })}
            disabled={!hasChanges}
            style={{
              width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
              background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
              fontSize: '14px', fontWeight: 700, cursor: hasChanges ? 'pointer' : 'not-allowed',
              opacity: hasChanges ? 1 : 0.5,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            <Check size={16} />
            Save Changes
          </button>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onDelete}
              style={{
                flex: 1, padding: '10px', borderRadius: 'var(--radius-md)',
                background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid var(--red-border, rgba(220,38,38,0.2))',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
              }}
            >
              <Trash2 size={13} />
              Remove
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1, padding: '10px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                fontSize: '12px', fontWeight: 500, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Add Inspection Modal ────────────────────────────────────────────────────

function AddInspectionModal({ isOpen, onClose, uid, pid, onAdded }: {
  isOpen: boolean;
  onClose: () => void;
  uid: string;
  pid: string;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [dueMonth, setDueMonth] = useState(currentYM());
  const [freq, setFreq] = useState(12);
  const [lastInspected, setLastInspected] = useState('');
  const [dueMonthTouched, setDueMonthTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  // When "last inspected" is provided, auto-compute the next due month
  // from lastInspected + frequency (unless user has manually edited dueMonth).
  useEffect(() => {
    if (!lastInspected || dueMonthTouched) return;
    const [y, m] = lastInspected.split('-').map(Number);
    if (!y || !m) return;
    const lastYM = `${y}-${String(m).padStart(2, '0')}`;
    setDueMonth(addMonths(lastYM, freq));
  }, [lastInspected, freq, dueMonthTouched]);

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await addInspection(uid, pid, {
        propertyId: pid,
        name: name.trim(),
        dueMonth,
        frequencyMonths: freq,
        ...(lastInspected ? { lastInspectedDate: lastInspected } : {}),
      });
      onAdded();
      onClose();
      setName('');
      setDueMonth(currentYM());
      setFreq(12);
      setLastInspected('');
      setDueMonthTouched(false);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    fontSize: '14px', color: 'var(--text-primary)',
  };
  const todayISO = new Date().toISOString().split('T')[0];

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)', borderRadius: 'var(--radius-lg)',
          width: '100%', maxWidth: '420px', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{
          padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Add Inspection
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '28px', height: '28px', borderRadius: '6px',
              border: '1px solid var(--border)', background: 'var(--bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text-muted)',
            }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Inspection Name *
            </label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Fire Extinguisher" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Last Inspected <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                type="date"
                value={lastInspected}
                max={todayISO}
                onChange={e => { setLastInspected(e.target.value); setDueMonthTouched(false); }}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => {
                  const today = new Date().toISOString().split('T')[0];
                  setLastInspected(today);
                  setDueMonthTouched(false);
                }}
                style={{
                  padding: '0 14px', borderRadius: 'var(--radius-md)',
                  background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                Today
              </button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
              When was this last done? Leave blank if unknown — we&apos;ll use it to auto-set the next due date.
            </div>
          </div>
          <FrequencySlider value={freq} onChange={(v) => { setFreq(v); setDueMonthTouched(false); }} />
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Due Month {lastInspected && !dueMonthTouched && (
                <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>
                  · auto-calculated
                </span>
              )}
            </label>
            <input
              type="month"
              value={dueMonth}
              onChange={e => { setDueMonth(e.target.value); setDueMonthTouched(true); }}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ padding: '0 20px 16px' }}>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
            style={{
              width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
              background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
              fontSize: '14px', fontWeight: 700,
              cursor: (!name.trim() || saving) ? 'not-allowed' : 'pointer',
              opacity: (!name.trim() || saving) ? 0.5 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            <Plus size={16} />
            {saving ? 'Saving...' : 'Add Inspection'}
          </button>
        </div>
      </div>
    </div>
  );
}
