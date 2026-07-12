// useStaffDirectory — save orchestration for the Manager Directory tab.
//
// Everything the directory does other than render: the Add/Edit modal state,
// the async wages + team fetches, the scheduling-manager swap guard, the
// account-link writes, the management-gated wage write, and the 15s
// write-timeout protection. Extracted verbatim from ManagerDirectory so the
// component itself is render-only. Behaviour is unchanged — the wage-touched
// gate, the swap guard, and the auth-lock timeout race all move as-is.

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { addStaffMember, updateStaffMember, deleteStaffMember } from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { canManageTeam } from '@/lib/roles';
import type { StaffMember, StaffDepartment } from '@/types';
import { asDeptKey } from './_tokens';

// ── Form types ────────────────────────────────────────────────────────────
export interface StaffFormData {
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
export interface TeamMember {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  staffId: string | null;
}

export function useStaffDirectory() {
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
  // Returns true only when the staff row (and any account-link / wage writes)
  // committed successfully. Callers that chain further writes — the scheduling-
  // manager swap — depend on this so they never proceed after a failed save.
  const performSave = async (): Promise<boolean> => {
    if (!uid || !pid || !form.name.trim()) return false;
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
          () => reject(new Error(lang === 'es'
            ? 'El guardado expiró después de 15s. Revisa tu conexión e intenta de nuevo.'
            : 'Save timed out after 15s. Check your connection and try again.')),
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
            throw new Error(body?.error || (lang === 'es'
              ? 'No se pudo vincular el inicio de sesión al registro del personal'
              : 'Failed to link login to staff record'));
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
          throw new Error(body?.error || (lang === 'es'
            ? 'No se pudo guardar el salario'
            : 'Failed to save wage'));
        }
        const sid = savedStaffId;
        setWages(w => ({ ...w, [sid]: desiredWage }));
      }

      try { await refreshStaff(); } catch (err) { console.warn('[ManagerDirectory] refresh failed', err); }
      closeModal();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ManagerDirectory] save failed:', err);
      setSaveError(msg || (lang === 'es'
        ? 'No se pudo guardar. Intenta de nuevo.'
        : 'Save failed. Please try again.'));
      return false;
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
    const previousManagerId = swapConfirm.currentManagerId;
    setSwapConfirm(null);
    // Promote the new member FIRST. Only once their save is durable do we
    // demote the previous scheduling manager — so a failed new-member save can
    // never leave the hotel with NO scheduling manager (a "Need Help" text
    // would then reach nobody). If the new save fails, the previous manager
    // stays in place and the error surfaces via saveError. If the demotion
    // itself later fails, there are briefly two scheduling managers, which is
    // benign (the text still reaches someone) and clears on the next edit.
    const saved = await performSave();
    if (!saved) return;
    try {
      await updateStaffMember(uid, pid, previousManagerId, { isSchedulingManager: false });
      await refreshStaff();
    } catch (err) {
      console.error('[ManagerDirectory] demote previous SM failed', err);
    }
  };

  const handleDelete = (member: StaffMember) => {
    const msg = lang === 'es' ? `¿Eliminar a ${member.name}?` : `Delete ${member.name}?`;
    if (!window.confirm(msg)) return;
    if (uid && pid) {
      deleteStaffMember(uid, pid, member.id)
        .catch(err => console.error('[ManagerDirectory] delete failed:', err));
    }
  };

  // Accounts available to link: those without a staff_id, plus whichever
  // account is currently linked to this staff member (so the picker still
  // shows it after an open).
  const linkableAccounts = useMemo(() => {
    return team.filter(t => t.staffId === null || t.accountId === originalLinkedAccountId);
  }, [team, originalLinkedAccountId]);

  return {
    lang, isManager, staff,
    showModal, editMember,
    form, setForm,
    saving, saveError,
    swapConfirm, setSwapConfirm,
    linkedAccountId, setLinkedAccountId,
    linkableAccounts,
    openAdd, openEdit, closeModal,
    handleSave, handleDelete, confirmSchedulingManagerSwap,
    markWageTouched: () => setWageTouched(true),
  };
}
