// Manager Directory — three-column dept roster (DirV1Body from the design).
//
// Replaces the existing /staff Directory tab. The visual treatment changes
// (3 cards instead of a single department-filter list) but the underlying
// CRUD logic is preserved 1:1: same Add/Edit modal, same scheduling-manager
// swap guard, same delete confirm, same write-timeout protection. The
// modal additionally now has a "Linked login" picker that maps an account
// to this staff row (writes `accounts.staff_id` via /api/auth/team).

'use client';

import React, { useMemo } from 'react';
import { DraftNumberInput } from '@/components/DraftNumberInput';
import type { StaffMember, StaffDepartment } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn } from './_tokens';
import { StaffAvatar, SeniorTag, SMTag, HoursBar, PageHeader } from './_people';
import { inputStyle, Field } from './_fields';
import { useStaffDirectory, type StaffFormData, type TeamMember } from './useStaffDirectory';

const DEPT_ORDER: ('housekeeping' | 'front_desk' | 'maintenance')[] = [
  'housekeeping', 'front_desk', 'maintenance',
];

export function ManagerDirectory() {
  const {
    lang, isManager, staff,
    showModal, editMember,
    form, setForm,
    saving, saveError,
    swapConfirm, setSwapConfirm,
    linkedAccountId, setLinkedAccountId,
    linkableAccounts,
    openAdd, openEdit, closeModal,
    handleSave, handleDelete, confirmSchedulingManagerSwap,
    markWageTouched,
  } = useStaffDirectory();

  /* ── Derived ── */
  const total   = staff.length;
  const onShift = staff.filter(s => s.scheduledToday).length;
  const nearOT  = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 4).length;

  const groups = useMemo(() => DEPT_ORDER.map(dept => {
    const list = staff
      .filter(s => asDeptKey(s.department) === dept)
      .sort((a, b) => {
        if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { dept, list };
  }), [staff]);

  /* ── Missing scheduling manager warning ── */
  const hasSchedulingManager = useMemo(
    () => staff.some(s => s.isSchedulingManager === true && s.isActive !== false),
    [staff],
  );

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '24px 48px 48px',
    }}>
      <style>{`
        .staff-dir-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; align-items: flex-start; }
        @media (max-width: 900px) { .staff-dir-grid { grid-template-columns: 1fr; } }
        .staff-dir-row { cursor: pointer; transition: background 0.15s; }
        .staff-dir-row:hover { background: rgba(31,35,28,0.02); }
      `}</style>

      <PageHeader
        title={lang === 'es' ? 'El equipo' : 'The people'}
        eyebrow={lang === 'es' ? 'Personal · Directorio' : 'Staff · Directory'}
        sub={lang === 'es'
          ? 'Lista de todo el personal de la propiedad — gerentes, camaristas, recepción y mantenimiento.'
          : 'Roster of everyone on the property — managers, housekeepers, front desk and maintenance.'}
        right={
          <div>
            <Caps>{lang === 'es' ? `${total} en plantilla · ${onShift} en turno` : `${total} on roster · ${onShift} on shift`}</Caps>
          </div>
        }
      />

      {/* Missing scheduling-manager warning (preserved from legacy page) */}
      {total > 0 && !hasSchedulingManager && (
        <div style={{
          marginBottom: 16, padding: '12px 16px',
          background: 'rgba(201,150,68,0.12)',
          border: '1px solid rgba(140,106,51,0.32)',
          borderRadius: 12,
          display: 'flex', alignItems: 'flex-start', gap: 10,
          fontFamily: fonts.sans, fontSize: 13, color: '#6F5328', lineHeight: 1.45,
        }}>
          <strong style={{ color: '#5C4220' }}>
            {lang === 'es' ? 'Sin Responsable de Horarios.' : 'No Scheduling Manager set.'}
          </strong>{' '}
          {lang === 'es'
            ? 'Si un limpiador presiona "Necesito ayuda", nadie recibirá el mensaje. Abre un miembro del personal y activa "Responsable de horarios".'
            : 'If a housekeeper taps "Need Help", nobody will get texted. Open a staff member and toggle on "Scheduling Manager".'}
        </div>
      )}

      {/* KPI strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16,
      }}>
        {[
          { eyebrow: lang === 'es' ? 'Plantilla' : 'Roster',        big: total,   sub: lang === 'es' ? 'personas en plantilla'  : 'people on the books',     accent: '#5C7A60' },
          { eyebrow: lang === 'es' ? 'En turno' : 'On shift',       big: onShift, sub: lang === 'es' ? 'en turno ahora mismo'   : 'clocked in right now',    accent: '#C99644' },
          { eyebrow: lang === 'es' ? 'Casi horas extra' : 'Near OT', big: nearOT,  sub: lang === 'es' ? 'a 4h del límite semanal' : 'within 4h of weekly cap', accent: nearOT > 0 ? '#A04A2C' : T.ink3 },
        ].map((s, i) => (
          <div key={i} style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
            padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Caps size={9}>{s.eyebrow}</Caps>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.accent }}/>
            </div>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
            }}>
              <span style={{
                fontFamily: fonts.serif, fontSize: 32, color: T.ink,
                letterSpacing: '-0.03em', lineHeight: 1, fontStyle: 'italic',
              }}>{s.big}</span>
              <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2, textAlign: 'right' }}>{s.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 3-column dept cards */}
      <div className="staff-dir-grid">
        {groups.map(g => {
          const m = deptMeta[g.dept];
          return (
            <div key={g.dept} style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, overflow: 'hidden',
            }}>
              <div style={{
                padding: '16px 18px 12px', borderBottom: `1px solid ${T.rule}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.tone }}/>
                  <span style={{
                    fontWeight: 600, fontSize: 15, color: T.ink, letterSpacing: '-0.01em',
                  }}>{m.label}</span>
                </div>
                <span style={{
                  fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.04em',
                }}>{g.list.length}</span>
              </div>
              <div>
                {g.list.length === 0 ? (
                  <div style={{
                    padding: '20px 18px', fontFamily: fonts.sans, fontSize: 12.5,
                    color: T.ink3, textAlign: 'center',
                  }}>{lang === 'es' ? 'Nadie aún.' : 'No one yet.'}</div>
                ) : (
                  g.list.map(s => (
                    <DirRow key={s.id} member={s} lang={lang} onClick={() => openEdit(s)}/>
                  ))
                )}
              </div>
              <button
                onClick={() => openAdd(g.dept as StaffDepartment)}
                style={{
                  width: '100%', padding: '12px 16px', background: 'transparent',
                  border: 'none', borderTop: `1px dashed ${T.rule}`,
                  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
                  color: T.ink3, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >{lang === 'es' ? `+ Agregar a ${m.label.toLowerCase()}` : `+ Add to ${m.label.toLowerCase()}`}</button>
            </div>
          );
        })}
      </div>

      {/* Add/Edit modal */}
      {showModal && (
        <StaffEditModal
          editMember={editMember}
          form={form}
          setForm={setForm}
          saving={saving}
          saveError={saveError}
          onClose={closeModal}
          onSave={handleSave}
          onDelete={editMember ? () => { closeModal(); handleDelete(editMember); } : undefined}
          linkableAccounts={linkableAccounts}
          linkedAccountId={linkedAccountId}
          setLinkedAccountId={setLinkedAccountId}
          showWage={isManager}
          markWageTouched={markWageTouched}
          lang={lang}
        />
      )}

      {/* Scheduling manager swap confirmation */}
      {swapConfirm && (
        <SchedulingManagerSwapModal
          info={swapConfirm}
          saving={saving}
          lang={lang}
          onCancel={() => { if (!saving) setSwapConfirm(null); }}
          onConfirm={confirmSchedulingManagerSwap}
        />
      )}
    </div>
  );
}

// ── Directory row ────────────────────────────────────────────────────────
function DirRow({ member, lang, onClick }: { member: StaffMember; lang: 'en' | 'es'; onClick: () => void }) {
  const ring = member.scheduledToday ? '#5C7A60' : null;
  return (
    <div
      className="staff-dir-row"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px',
        opacity: member.isActive === false ? 0.45 : 1,
        borderBottom: `1px solid ${T.ruleSoft}`,
      }}
    >
      <StaffAvatar staff={member} size={36} ring={ring}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{
            fontWeight: 600, fontSize: 14, color: T.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{member.name}</span>
          {member.isSenior && <SeniorTag/>}
          {member.isSchedulingManager && <SMTag/>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <span style={{
            fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3,
          }}>{member.phone ? formatPhone(member.phone) : (lang === 'es' ? 'Sin teléfono' : 'No phone')}</span>
          <span style={{ fontSize: 10, color: T.ink3 }}>·</span>
          <span style={{
            fontFamily: fonts.mono, fontSize: 11, color: T.ink3,
          }}>{(member.language || 'es').toUpperCase()}</span>
        </div>
      </div>
      <HoursBar hrs={member.weeklyHours ?? 0} max={member.maxWeeklyHours ?? 40} width={56}/>
    </div>
  );
}

function formatPhone(p: string): string {
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return p;
}

// ── Modal ────────────────────────────────────────────────────────────────
function StaffEditModal({
  editMember, form, setForm, saving, saveError, onClose, onSave, onDelete,
  linkableAccounts, linkedAccountId, setLinkedAccountId, showWage, markWageTouched, lang,
}: {
  editMember: StaffMember | null;
  form: StaffFormData;
  setForm: React.Dispatch<React.SetStateAction<StaffFormData>>;
  saving: boolean;
  saveError: string | null;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  linkableAccounts: TeamMember[];
  linkedAccountId: string | null;
  setLinkedAccountId: (id: string | null) => void;
  showWage: boolean;
  markWageTouched: () => void;
  lang: 'en' | 'es';
}) {
  const departments: StaffDepartment[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(8px)',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.paper, borderRadius: 22,
          width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto',
          padding: '24px 26px',
          boxShadow: '0 24px 60px -8px rgba(31,35,28,0.20), 0 0 0 1px rgba(31,35,28,0.04)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 18,
        }}>
          <h2 style={{
            margin: 0, fontFamily: fonts.serif, fontSize: 22, fontStyle: 'italic',
            color: T.ink, letterSpacing: '-0.02em', fontWeight: 400,
          }}>
            {editMember ? editMember.name : (lang === 'es' ? 'Nuevo personal' : 'New staff member')}
          </h2>
          <button onClick={onClose} style={{
            background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: '50%',
            width: 28, height: 28, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: T.ink2, fontSize: 14, lineHeight: 1, padding: 0,
          }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Name */}
          <Field label={lang === 'es' ? 'Nombre' : 'Name'}>
            <input
              type="text" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              autoFocus placeholder="Maria L."
              style={inputStyle}
            />
          </Field>

          {/* Department */}
          <Field label={lang === 'es' ? 'Departamento' : 'Department'}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {departments.map(d => {
                const sel = form.department === d;
                return (
                  <button key={d}
                    onClick={() => setForm(f => ({ ...f, department: d }))}
                    style={{
                      padding: '6px 13px', borderRadius: 999,
                      border: sel ? `1px solid ${T.ink}` : `1px solid ${T.rule}`,
                      background: sel ? T.ink : 'transparent',
                      color: sel ? T.bg : T.ink2,
                      fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >{deptMeta[d].label}</button>
                );
              })}
            </div>
          </Field>

          {/* Phone */}
          <Field label={lang === 'es' ? 'Teléfono' : 'Phone'}>
            <input
              type="tel" value={form.phone ?? ''}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="(409) 555-1234"
              style={inputStyle}
            />
          </Field>

          {/* Language */}
          <Field label={lang === 'es' ? 'Idioma' : 'Language'}>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['en', 'es'] as const).map(l => {
                const sel = form.language === l;
                return (
                  <button key={l}
                    onClick={() => setForm(f => ({ ...f, language: l }))}
                    style={{
                      flex: 1, padding: '10px 14px', borderRadius: 12,
                      border: sel ? `1px solid ${T.sageDeep}` : `1px solid ${T.rule}`,
                      background: sel ? T.sageDim : 'transparent',
                      color: sel ? T.sageDeep : T.ink2,
                      fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >{l === 'en' ? 'English' : 'Español'}</button>
                );
              })}
            </div>
          </Field>

          {/* Hourly wage — management only (payroll-private). Hidden for any
              non-manager; the wage also never reaches a non-manager browser. */}
          {showWage && (
            <Field label={lang === 'es' ? 'Salario por hora' : 'Hourly wage'}>
              <input
                type="number" value={form.hourlyWage ?? ''} step="0.50" min="0"
                onChange={e => {
                  markWageTouched();
                  // Coerce non-finite parses (e.g. a lone ".") to undefined so a
                  // malformed entry reads as "no wage" rather than NaN — which
                  // JSON.stringify would otherwise send as null (a silent clear).
                  const parsed = parseFloat(e.target.value);
                  setForm(f => ({
                    ...f,
                    hourlyWage: Number.isFinite(parsed) ? parsed : undefined,
                  }));
                }}
                placeholder="15.00"
                style={{ ...inputStyle, fontFamily: fonts.mono }}
              />
            </Field>
          )}

          {/* Max hours + days grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={lang === 'es' ? 'Máx horas / sem' : 'Max h/wk'}>
              <DraftNumberInput
                value={form.maxWeeklyHours}
                onCommit={n => setForm(f => ({ ...f, maxWeeklyHours: n }))}
                min={1}
                width="100%"
                style={{ ...inputStyle, fontFamily: fonts.mono, textAlign: 'left' }}
              />
            </Field>
            <Field label={lang === 'es' ? 'Máx días / sem' : 'Max days/wk'}>
              <DraftNumberInput
                value={form.maxDaysPerWeek}
                onCommit={n => setForm(f => ({ ...f, maxDaysPerWeek: n }))}
                min={1} max={7}
                width="100%"
                style={{ ...inputStyle, fontFamily: fonts.mono, textAlign: 'left' }}
              />
            </Field>
          </div>

          {/* Toggles */}
          {[
            { label: lang === 'es' ? 'Activo' : 'Active', field: 'isActive' as const },
            { label: lang === 'es' ? 'Sénior' : 'Senior', field: 'isSenior' as const },
            {
              label: lang === 'es' ? 'Responsable de horarios' : 'Scheduling Manager',
              field: 'isSchedulingManager' as const,
              hint: lang === 'es'
                ? 'Recibe el mensaje cuando un limpiador presiona "Necesito ayuda". Una persona a la vez.'
                : 'Receives the SMS when a housekeeper taps "Need Help". One person at a time.',
            },
          ].map(({ label, field, hint }) => (
            <div key={field} style={{
              padding: '10px 14px',
              background: T.sageDim, borderRadius: 12,
              border: `1px solid ${T.rule}`,
            }}>
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                fontFamily: fonts.sans, fontSize: 13, color: T.ink, cursor: 'pointer',
              }}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={form[field] as boolean}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))}
                  style={{ width: 18, height: 18, cursor: 'pointer' }}
                />
              </label>
              {hint && (
                <p style={{
                  margin: '6px 0 0', fontFamily: fonts.sans, fontSize: 11,
                  color: T.ink2, lineHeight: 1.4,
                }}>{hint}</p>
              )}
            </div>
          ))}

          {/* Linked login picker */}
          <Field
            label={lang === 'es' ? 'Inicio de sesión (opcional)' : 'Linked login (optional)'}
            hint={lang === 'es'
              ? 'La cuenta vinculada verá su propio horario al abrir Personal.'
              : 'The linked account sees their own schedule when they open Staff.'}
          >
            <select
              value={linkedAccountId ?? ''}
              onChange={e => setLinkedAccountId(e.target.value || null)}
              style={{
                ...inputStyle,
                appearance: 'none', backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%235C625C' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E\")",
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 14px center', paddingRight: 36,
              }}
            >
              <option value="">{lang === 'es' ? 'Sin vincular' : 'Not linked'}</option>
              {linkableAccounts.map(a => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName} ({a.username}) · {a.role.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>

          {/* Vacation dates */}
          <Field
            label={lang === 'es' ? 'Fechas de vacaciones' : 'Vacation dates'}
            hint={lang === 'es' ? 'Una por línea, YYYY-MM-DD' : 'One per line, YYYY-MM-DD'}
          >
            <textarea
              value={form.vacationDates}
              onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))}
              rows={3}
              placeholder="2026-06-15"
              style={{
                ...inputStyle, fontFamily: fonts.mono, fontSize: 12, resize: 'vertical',
              }}
            />
          </Field>

          {saveError && (
            <div role="alert" style={{
              padding: '10px 14px',
              background: 'rgba(160,74,44,0.08)',
              border: '1px solid rgba(160,74,44,0.25)',
              borderRadius: 12, color: '#A04A2C',
              fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.4,
            }}>{saveError}</div>
          )}

          {/* Action row */}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            {onDelete && (
              <Btn variant="ghost" size="md" onClick={onDelete}
                style={{ color: '#A04A2C', borderColor: 'rgba(160,74,44,0.25)' }}>
                {lang === 'es' ? 'Eliminar' : 'Delete'}
              </Btn>
            )}
            <span style={{ flex: 1 }}/>
            <Btn variant="ghost" size="md" onClick={onClose}>
              {lang === 'es' ? 'Cancelar' : 'Cancel'}
            </Btn>
            <Btn
              variant="primary" size="md"
              onClick={onSave}
              disabled={saving || !form.name.trim()}
            >
              {saving
                ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                : editMember
                  ? (lang === 'es' ? 'Actualizar' : 'Update')
                  : (lang === 'es' ? 'Agregar' : 'Add')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Scheduling Manager swap modal ───────────────────────────────────────────
function SchedulingManagerSwapModal({
  info, saving, lang, onCancel, onConfirm,
}: {
  info: { currentManagerName: string; newName: string };
  saving: boolean;
  lang: 'en' | 'es';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.5)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.paper, borderRadius: 22,
          padding: '24px 26px', maxWidth: 440, width: '100%',
          boxShadow: '0 24px 60px -8px rgba(31,35,28,0.20)',
        }}
      >
        <h2 style={{
          margin: 0, fontFamily: fonts.serif, fontSize: 22, fontStyle: 'italic',
          color: T.ink, letterSpacing: '-0.02em', fontWeight: 400,
        }}>
          {lang === 'es' ? '¿Cambiar responsable de horarios?' : 'Switch Scheduling Manager?'}
        </h2>
        <p style={{
          margin: '14px 0 22px',
          fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, lineHeight: 1.55,
        }}>
          {lang === 'es' ? (
            <><strong style={{ color: T.ink }}>{info.currentManagerName}</strong> es el responsable actual.
            {' '}Si continúas, <strong style={{ color: T.ink }}>{info.newName}</strong> tomará ese rol
            y <strong style={{ color: T.ink }}>{info.currentManagerName}</strong> dejará de recibir los mensajes.</>
          ) : (
            <><strong style={{ color: T.ink }}>{info.currentManagerName}</strong> currently has this role.
            {' '}If you continue, <strong style={{ color: T.ink }}>{info.newName}</strong> will take it
            and <strong style={{ color: T.ink }}>{info.currentManagerName}</strong> will stop receiving alerts.</>
          )}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="md" onClick={onCancel} disabled={saving}>
            {lang === 'es' ? 'Cancelar' : 'Cancel'}
          </Btn>
          <Btn variant="primary" size="md" onClick={onConfirm} disabled={saving}>
            {saving
              ? (lang === 'es' ? 'Guardando…' : 'Saving…')
              : (lang === 'es' ? 'Sí, cambiar' : 'Yes, switch')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
