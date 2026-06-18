// Manager Directory — three-column dept roster (DirV1Body from the design).
//
// Replaces the existing /staff Directory tab. The visual treatment changes
// (3 cards instead of a single department-filter list) but the underlying
// CRUD logic is preserved 1:1: same Add/Edit modal, same scheduling-manager
// swap guard, same delete confirm, same write-timeout protection. The
// modal additionally now has a "Linked login" picker that maps an account
// to this staff row (writes `accounts.staff_id` via /api/auth/team).

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { addStaffMember, updateStaffMember, deleteStaffMember } from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { canManageTeam } from '@/lib/roles';
import { DraftNumberInput } from '@/components/DraftNumberInput';
import type { StaffMember, StaffDepartment } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn } from './_tokens';
import { StaffAvatar, SeniorTag, SMTag, HoursBar, PageHeader } from './_people';

// ── Form types ────────────────────────────────────────────────────────────
interface StaffFormData {
  name: string;
  phone?: string;
  language: 'en' | 'es';
  department: StaffDepartment;
  isSenior: boolean;
  hourlyWage?: number;
  maxWeeklyHours: number;
  maxDaysPerWeek: number;
  vacationDates: string;
  isActive: boolean;
  isSchedulingManager: boolean;
}

const EMPTY_FORM: StaffFormData = {
  name: '', language: 'es', department: 'housekeeping',
  isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5,
  vacationDates: '', isActive: true, isSchedulingManager: false,
};

// Team-member shape returned by GET /api/auth/team (with our new staffId field).
interface TeamMember {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  staffId: string | null;
}

const DEPT_ORDER: ('housekeeping' | 'front_desk' | 'maintenance')[] = [
  'housekeeping', 'front_desk', 'maintenance',
];

export function ManagerDirectory() {
  const { user } = useAuth();
  const { activePropertyId, staff, refreshStaff } = useProperty();
  const { lang } = useLang();

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';
  // Wages are payroll-private and management-only. ManagerDirectory is only
  // mounted for managers (see /staff/page.tsx), but we still gate the wage
  // column + the wage fetch on the role so payroll can never render or be
  // requested for a non-manager if this component is ever reused.
  const isManager = !!user && canManageTeam(user.role);

  /* ── Modal state ── */
  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(null);
  const [originalLinkedAccountId, setOriginalLinkedAccountId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [swapConfirm, setSwapConfirm] = useState<
    { currentManagerId: string; currentManagerName: string; newName: string } | null
  >(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  // staffId → hourly wage. Fetched from the management-gated service-role
  // route (GET /api/staff/wages) — wages are deliberately NOT part of the
  // anon `staff` payload from useProperty(), so member.hourlyWage is always
  // undefined now and we read wages from this map instead.
  const [wages, setWages] = useState<Record<string, number | null>>({});
  // Did the user actually edit the wage field this modal session? Wage writes
  // fire ONLY when true — so a save can never clear a wage just because the
  // modal opened before GET /api/staff/wages resolved (the field starts blank,
  // and an untouched blank must not overwrite a real wage).
  const [wageTouched, setWageTouched] = useState(false);

  // Load the wage map when the directory mounts (managers only). Refreshed
  // locally after each successful wage write in performSave().
  useEffect(() => {
    if (!isManager || !pid) return;
    let active = true;
    fetchWithAuth(`/api/staff/wages?propertyId=${pid}`)
      .then(r => (r.ok ? r.json() : null))
      .then((body: { data?: { wages?: Record<string, number | null> } } | null) => {
        if (active) setWages(body?.data?.wages ?? {});
      })
      .catch(err => console.error('[ManagerDirectory] wages fetch failed', err));
    return () => { active = false; };
  }, [isManager, pid]);

  // Keep an open edit modal's wage field in sync with the async wages map
  // until the user types into it. Without this, opening a member before the
  // wages GET resolves would show a blank wage even though they have one; the
  // wageTouched gate then means an untouched field never writes, so a save
  // can't clear a wage just because of this load race.
  useEffect(() => {
    if (!showModal || !editMember || wageTouched) return;
    const loaded = wages[editMember.id] ?? undefined;
    setForm(f => (f.hourlyWage === loaded ? f : { ...f, hourlyWage: loaded }));
  }, [wages, showModal, editMember, wageTouched]);

  // Fetch team list once per modal open (so newly-added staff see the latest
  // accounts list without a full page reload).
  useEffect(() => {
    if (!showModal || !pid) return;
    let active = true;
    fetchWithAuth(`/api/auth/team?hotelId=${pid}`)
      .then(r => r.ok ? r.json() : null)
      .then((body: { data?: { team?: TeamMember[] } } | null) => {
        if (!active) return;
        const list = body?.data?.team ?? [];
        setTeam(list);
      })
      .catch(err => {
        console.error('[ManagerDirectory] team list failed', err);
      });
    return () => { active = false; };
  }, [showModal, pid]);

  const closeModal = () => {
    setShowModal(false);
    setSaving(false);
    setSaveError(null);
    setLinkedAccountId(null);
    setOriginalLinkedAccountId(null);
  };

  /* ── Open handlers ── */
  const openAdd = (dept: StaffDepartment = 'housekeeping') => {
    setEditMember(null);
    setForm({ ...EMPTY_FORM, department: dept });
    setWageTouched(false);
    setLinkedAccountId(null);
    setOriginalLinkedAccountId(null);
    setSaveError(null);
    setSaving(false);
    setShowModal(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({
      name: member.name,
      phone: member.phone,
      language: member.language,
      department: asDeptKey(member.department) as StaffDepartment,
      isSenior: member.isSenior,
      // member.hourlyWage no longer arrives over the anon client — read the
      // wage from the management-only map fetched above.
      hourlyWage: wages[member.id] ?? undefined,
      maxWeeklyHours: member.maxWeeklyHours,
      maxDaysPerWeek: member.maxDaysPerWeek ?? 5,
      vacationDates: (member.vacationDates ?? []).join('\n'),
      isActive: member.isActive ?? true,
      isSchedulingManager: member.isSchedulingManager === true,
    });
    setWageTouched(false);
    // linkedAccountId is set once the team list arrives — we look up the
    // account whose staff_id matches this member.id.
    setLinkedAccountId(null);
    setOriginalLinkedAccountId(null);
    setSaveError(null);
    setSaving(false);
    setShowModal(true);
  };

  // Once the team list arrives, fill in linkedAccountId from whichever
  // account (if any) is currently pointing at this staff row.
  useEffect(() => {
    if (!editMember || team.length === 0) return;
    const linked = team.find(t => t.staffId === editMember.id);
    const id = linked?.accountId ?? null;
    setLinkedAccountId(id);
    setOriginalLinkedAccountId(id);
  }, [editMember, team]);

  /* ── Save flow ── */
  const performSave = async () => {
    if (!uid || !pid || !form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const vacationDates = form.vacationDates
        .split('\n').map(s => s.trim())
        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      const data = {
        name: form.name.trim(),
        phone: form.phone?.trim() ?? '',
        language: form.language,
        department: form.department,
        isSenior: form.isSenior,
        // hourlyWage is intentionally NOT written here — it would travel over
        // the anon client. It's persisted separately through the management-
        // gated PUT /api/staff/wages below.
        maxWeeklyHours: form.maxWeeklyHours,
        maxDaysPerWeek: form.maxDaysPerWeek,
        vacationDates,
        isActive: form.isActive,
        isSchedulingManager: form.isSchedulingManager,
      };

      // Hard 15s timeout on the staff write — see notes in the legacy
      // /staff/page.tsx about why this matters (Supabase auth-lock wedge).
      let savedStaffId: string | null = editMember?.id ?? null;
      const writePromise: Promise<unknown> = editMember
        ? updateStaffMember(uid, pid, editMember.id, data)
        : addStaffMember(uid, pid, { ...data, scheduledToday: false, weeklyHours: 0 })
            .then((newId: string | void) => { if (typeof newId === 'string') savedStaffId = newId; });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Save timed out after 15s. Check your connection and try again.')),
          15000,
        );
      });
      try { await Promise.race([writePromise, timeoutPromise]); }
      finally { if (timeoutId) clearTimeout(timeoutId); }

      // ── Account link writes ────────────────────────────────────────────
      // Two cases:
      //   1. User picked/changed a linked login → PUT staffId on that account.
      //   2. User removed a previously-linked login → PUT staffId=null on
      //      the prior account.
      //
      // For new staff records, savedStaffId comes from addStaffMember's
      // return. For existing, it's the editMember.id we passed in.
      if (savedStaffId && originalLinkedAccountId !== linkedAccountId) {
        // Detach old account if it was set.
        if (originalLinkedAccountId && originalLinkedAccountId !== linkedAccountId) {
          await fetchWithAuth('/api/auth/team', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hotelId: pid, accountId: originalLinkedAccountId, staffId: null,
            }),
          }).catch(err => console.warn('[ManagerDirectory] unlink old account failed', err));
        }
        // Attach new account.
        if (linkedAccountId) {
          const linkRes = await fetchWithAuth('/api/auth/team', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hotelId: pid, accountId: linkedAccountId, staffId: savedStaffId,
            }),
          });
          if (!linkRes.ok) {
            const body = await linkRes.json().catch(() => ({}));
            throw new Error(body?.error || 'Failed to link login to staff record');
          }
        }
      }

      // ── Wage write (managers only, service-role) ──────────────────────────
      // Persist the wage through the management-gated route. NEVER through the
      // staff write above — that uses the anon client, which has no column-
      // level protection on hourly_wage. Fire ONLY when the manager actually
      // edited the wage field (wageTouched): an untouched field — including
      // one left blank because the wages map hadn't loaded when the modal
      // opened — must never overwrite the stored wage. A touched-then-cleared
      // field sends null, which is an explicit clear.
      if (isManager && savedStaffId && wageTouched) {
        const desiredWage = form.hourlyWage ?? null;
        const wageRes = await fetchWithAuth('/api/staff/wages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: pid, staffId: savedStaffId, hourlyWage: desiredWage }),
        });
        if (!wageRes.ok) {
          const body = await wageRes.json().catch(() => ({}));
          throw new Error(body?.error || 'Failed to save wage');
        }
        const sid = savedStaffId;
        setWages(w => ({ ...w, [sid]: desiredWage }));
      }

      try { await refreshStaff(); } catch (err) { console.warn('[ManagerDirectory] refresh failed', err); }
      closeModal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ManagerDirectory] save failed:', err);
      setSaveError(msg || 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (!uid || !pid || !form.name.trim()) return;
    // Scheduling Manager swap guard.
    if (form.isSchedulingManager) {
      const currentManager = staff.find(
        s => s.isSchedulingManager === true && s.id !== editMember?.id,
      );
      if (currentManager) {
        setSwapConfirm({
          currentManagerId: currentManager.id,
          currentManagerName: currentManager.name,
          newName: form.name.trim(),
        });
        return;
      }
    }
    await performSave();
  };

  const confirmSchedulingManagerSwap = async () => {
    if (!uid || !pid || !swapConfirm) return;
    setSaving(true);
    try {
      await updateStaffMember(uid, pid, swapConfirm.currentManagerId, { isSchedulingManager: false });
    } catch (err) {
      console.error('[ManagerDirectory] clear previous SM failed', err);
      setSaving(false);
      setSwapConfirm(null);
      return;
    }
    setSwapConfirm(null);
    setSaving(false);
    await performSave();
  };

  const handleDelete = (member: StaffMember) => {
    const msg = lang === 'es' ? `¿Eliminar a ${member.name}?` : `Delete ${member.name}?`;
    if (!window.confirm(msg)) return;
    if (uid && pid) {
      deleteStaffMember(uid, pid, member.id)
        .catch(err => console.error('[ManagerDirectory] delete failed:', err));
    }
  };

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

  // Accounts available to link: those without a staff_id, plus whichever
  // account is currently linked to this staff member (so the picker still
  // shows it after an open).
  const linkableAccounts = useMemo(() => {
    return team.filter(t => t.staffId === null || t.accountId === originalLinkedAccountId);
  }, [team, originalLinkedAccountId]);

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
        title={lang === 'es' ? 'La gente' : 'The people'}
        eyebrow={lang === 'es' ? 'Personal · Directorio' : 'Staff · Directory'}
        sub={lang === 'es'
          ? 'Lista de todo el personal de la propiedad — gerentes, camaristas, recepción y mantenimiento.'
          : 'Roster of everyone on the property — managers, housekeepers, front desk and maintenance.'}
        right={
          <div>
            <Caps>{total} on roster · {onShift} on shift</Caps>
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
          { eyebrow: 'Roster',   big: total,   sub: 'people on the books',     accent: '#5C7A60' },
          { eyebrow: 'On shift', big: onShift, sub: 'clocked in right now',    accent: '#C99644' },
          { eyebrow: 'Near OT',  big: nearOT,  sub: 'within 4h of weekly cap', accent: nearOT > 0 ? '#A04A2C' : T.ink3 },
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
                  }}>No one yet.</div>
                ) : (
                  g.list.map(s => (
                    <DirRow key={s.id} member={s} onClick={() => openEdit(s)}/>
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
              >+ Add to {m.label.toLowerCase()}</button>
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
          markWageTouched={() => setWageTouched(true)}
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
function DirRow({ member, onClick }: { member: StaffMember; onClick: () => void }) {
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
          }}>{member.phone ? formatPhone(member.phone) : 'No phone'}</span>
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

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 14px',
  borderRadius: 12, border: `1px solid ${T.rule}`,
  background: T.paper,
  fontFamily: fonts.sans, fontSize: 13, color: T.ink,
  outline: 'none',
};

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={{
        display: 'block', fontFamily: fonts.mono, fontSize: 10, fontWeight: 600,
        color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase',
        marginBottom: 6,
      }}>{label}</label>
      {children}
      {hint && (
        <p style={{
          margin: '6px 0 0', fontFamily: fonts.sans, fontSize: 11.5,
          color: T.ink3, lineHeight: 1.4,
        }}>{hint}</p>
      )}
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
