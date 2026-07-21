// Manager Directory — three-column dept roster (DirV1Body from the design).
//
// Replaces the existing /staff Directory tab. The visual treatment changes
// (3 cards instead of a single department-filter list) but the underlying
// CRUD logic is preserved 1:1: same Add/Edit modal, same delete confirm,
// same write-timeout protection. The modal additionally now has a "Linked
// login" picker that maps an account to this staff row (writes
// `accounts.staff_id` via /api/auth/team).

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { addStaffMember, updateStaffMember, deleteStaffMember } from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { canManageTeam } from '@/lib/roles';
import { DraftNumberInput } from '@/components/DraftNumberInput';
import { InviteStaffPanel } from '@/components/team/InviteStaffPanel';
import invitePanelStyles from '@/components/team/InviteStaffPanel.module.css';
import type { StaffMember, StaffDepartment } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn, type DeptKey } from './_tokens';
import { StaffAvatar, SeniorTag, HoursBar } from './_people';

// A pending join request awaiting a manager's approve/deny.
interface JoinRequest {
  id: string;
  name: string;
  phone: string | null;
  language: 'en' | 'es';
  department: string;
  created_at: string;
}

// "how long ago" in plain words, EN/ES. Coarse buckets are enough here.
function timeAgo(iso: string, lang: 'en' | 'es'): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return lang === 'es' ? 'ahora mismo' : 'just now';
  if (mins < 60) return lang === 'es' ? `hace ${mins} min` : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return lang === 'es' ? `hace ${hrs} h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return lang === 'es' ? `hace ${days} d` : `${days}d ago`;
}

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
}

const EMPTY_FORM: StaffFormData = {
  name: '', language: 'es', department: 'housekeeping',
  isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5,
  vacationDates: '', isActive: true,
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

interface ContactSnapshot {
  propertyId: string;
  contacts: Record<string, string | null>;
}

const DEPT_ES: Record<string, string> = {
  housekeeping: 'Limpieza', front_desk: 'Recepción', maintenance: 'Mantenimiento', other: 'Otros',
};

const DEPT_ORDER: ('housekeeping' | 'front_desk' | 'maintenance')[] = [
  'housekeeping', 'front_desk', 'maintenance',
];

export function ManagerDirectory() {
  const { user } = useAuth();
  const { activePropertyId, staff, refreshStaff } = useProperty();
  const { lang } = useLang();

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';
  const activePidRef = useRef(pid);
  activePidRef.current = pid;
  // Wages are payroll-private and management-only. ManagerDirectory is only
  // mounted for managers (see /staff/page.tsx), but we still gate the wage
  // column + the wage fetch on the role so payroll can never render or be
  // requested for a non-manager if this component is ever reused.
  const isManager = !!user && canManageTeam(user.role);

  /* ── Invite + join-request queue state (managers only) ── */
  const [showInvite, setShowInvite] = useState(false);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  // Which request id currently has an approve/deny in flight (disables its row).
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    if (!isManager || !pid) return;
    try {
      const res = await fetchWithAuth(`/api/staff/join-requests?hotelId=${pid}`);
      if (!res.ok) return; // non-fatal; queue just stays as-is
      const body = await res.json() as { data?: { requests?: JoinRequest[] } };
      setRequests(body.data?.requests ?? []);
    } catch (err) {
      console.error('[ManagerDirectory] join-requests load failed', err);
    }
  }, [isManager, pid]);

  // Poll the queue on mount and every 30s while mounted (managers only).
  useEffect(() => {
    if (!isManager || !pid) return;
    void loadRequests();
    const iv = setInterval(() => { void loadRequests(); }, 30000);
    return () => clearInterval(iv);
  }, [isManager, pid, loadRequests]);

  const decideRequest = async (requestId: string, decision: 'approve' | 'deny') => {
    if (!pid || decidingId) return;
    setDecidingId(requestId);
    try {
      const res = await fetchWithAuth('/api/staff/join-requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: pid, requestId, decision }),
      });
      if (res.ok) {
        setRequests(rs => rs.filter(r => r.id !== requestId));
        if (decision === 'approve') {
          try { await refreshStaff(); } catch (err) { console.warn('[ManagerDirectory] refresh after approve failed', err); }
        }
        return;
      }
      // 409 = someone else already decided it (or it's already linked) → just
      // resync the queue so the stale row drops.
      if (res.status === 409) { void loadRequests(); return; }
      const body = await res.json().catch(() => ({})) as { error?: string };
      window.alert(body.error ?? (lang === 'es' ? 'No se pudo procesar. Intenta de nuevo.' : "Couldn't process that. Try again."));
    } catch (err) {
      console.error('[ManagerDirectory] decide request failed', err);
      window.alert(lang === 'es' ? 'No se pudo procesar — revisa tu conexión.' : "Couldn't process that — check your connection.");
    } finally {
      setDecidingId(null);
    }
  };

  const deptLabel = (dept: string): string => {
    const key = asDeptKey(dept);
    return lang === 'es' ? (DEPT_ES[key] ?? deptMeta[key].label) : deptMeta[key].label;
  };

  /* ── Modal state ── */
  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(null);
  const [originalLinkedAccountId, setOriginalLinkedAccountId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  // staffId → hourly wage. Fetched from the management-gated service-role
  // route (GET /api/staff/wages) — wages are deliberately NOT part of the
  // anon `staff` payload from useProperty(), so member.hourlyWage is always
  // undefined now and we read wages from this map instead.
  const [wages, setWages] = useState<Record<string, number | null>>({});
  // Phone numbers follow the same least-privilege shape as wages: the shared
  // browser roster never contains them. Keep the map tagged with its property
  // so a property switch can never render the previous hotel's contacts while
  // the next request is in flight.
  const [contactSnapshot, setContactSnapshot] = useState<ContactSnapshot | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const contacts = useMemo(
    () => contactSnapshot?.propertyId === pid ? contactSnapshot.contacts : {},
    [contactSnapshot, pid],
  );
  const contactsReady = contactSnapshot?.propertyId === pid;
  // Did the user actually edit the wage field this modal session? Wage writes
  // fire ONLY when true — so a save can never clear a wage just because the
  // modal opened before GET /api/staff/wages resolved (the field starts blank,
  // and an untouched blank must not overwrite a real wage).
  const [wageTouched, setWageTouched] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  useEffect(() => {
    if (!isManager || !pid) {
      setContactSnapshot(null);
      setContactsLoading(false);
      setContactsError(null);
      return;
    }
    let active = true;
    setContactsLoading(true);
    setContactsError(null);
    fetchWithAuth(`/api/staff/contacts?propertyId=${pid}`)
      .then(async r => {
        if (r.ok) return r.json();
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Contact request failed (${r.status})`);
      })
      .then((body: { data?: { contacts?: Record<string, string | null> } }) => {
        if (active) {
          setContactSnapshot({ propertyId: pid, contacts: body.data?.contacts ?? {} });
        }
      })
      .catch(err => {
        console.error('[ManagerDirectory] contacts fetch failed', err);
        if (active) {
          setContactsError(lang === 'es'
            ? 'No se pudieron cargar los teléfonos. Intenta actualizar.'
            : "Couldn't load phone numbers. Try refreshing.");
        }
      })
      .finally(() => { if (active) setContactsLoading(false); });
    return () => { active = false; };
  }, [isManager, pid, lang]);

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

  // As with wages, hydrate an already-open edit modal only while the manager
  // has not typed in the phone field. A late contact response must never
  // overwrite in-progress input, and an untouched blank must never clear the
  // stored number when the manager saves quickly.
  useEffect(() => {
    if (!showModal || !editMember || phoneTouched || !contactsReady) return;
    const loaded = contacts[editMember.id] ?? undefined;
    setForm(f => (f.phone === loaded ? f : { ...f, phone: loaded }));
  }, [contacts, contactsReady, showModal, editMember, phoneTouched]);

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
    createdIdRef.current = null;
  };

  /* ── Open handlers ── */
  const openAdd = (dept: StaffDepartment = 'housekeeping') => {
    setEditMember(null);
    createdIdRef.current = null;
    setForm({ ...EMPTY_FORM, department: dept });
    setWageTouched(false);
    setPhoneTouched(false);
    setLinkedAccountId(null);
    setOriginalLinkedAccountId(null);
    setSaveError(null);
    setSaving(false);
    setShowModal(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    createdIdRef.current = null;
    setForm({
      name: member.name,
      phone: contacts[member.id] ?? undefined,
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
    });
    setWageTouched(false);
    setPhoneTouched(false);
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
      };

      // Hard 15s timeout on the staff write — see notes in the legacy
      // /staff/page.tsx about why this matters (Supabase auth-lock wedge).
      const existingId = editMember?.id ?? createdIdRef.current;
      let savedStaffId: string | null = existingId;
      const writePromise: Promise<unknown> = existingId
        ? updateStaffMember(uid, pid, existingId, data)
        : addStaffMember(uid, pid, { ...data, scheduledToday: false, weeklyHours: 0 })
            .then((newId: string | void) => {
              if (typeof newId === 'string') { savedStaffId = newId; createdIdRef.current = newId; }
            });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Save timed out after 15s. Check your connection and try again.')),
          15000,
        );
      });
      try { await Promise.race([writePromise, timeoutPromise]); }
      finally { if (timeoutId) clearTimeout(timeoutId); }

      // The generic Supabase roster helper strips phone writes so a line-staff
      // browser cannot overwrite contact data via devtools. Persist contacts
      // only through the management-gated, property-scoped API. For edits we
      // write only after real user input; for a new record we always initialize
      // the field (and retry it if a later partial step failed).
      if (savedStaffId && (!editMember || phoneTouched)) {
        const desiredPhone = form.phone?.trim() ?? '';
        const contactRes = await fetchWithAuth('/api/staff/contacts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: pid, staffId: savedStaffId, phone: desiredPhone }),
        });
        if (!contactRes.ok) {
          throw new Error(lang === 'es'
            ? 'Detalles guardados, pero no se pudo actualizar el teléfono. Inténtalo de nuevo.'
            : "Details saved, but the phone couldn't be updated. Try again.");
        }
        const sid = savedStaffId;
        setContactSnapshot(current => {
          // A hotel switch while this request was in flight must not replace
          // the new hotel's contact snapshot with the old hotel's response.
          if (activePidRef.current !== pid) return current;
          return {
            propertyId: pid,
            contacts: { ...(current?.propertyId === pid ? current.contacts : {}), [sid]: desiredPhone || null },
          };
        });
      }

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
          const detachRes = await fetchWithAuth('/api/auth/team', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hotelId: pid, accountId: originalLinkedAccountId, staffId: null,
            }),
          });
          if (!detachRes.ok) {
            throw new Error(lang === 'es'
              ? 'Detalles guardados, pero no se pudo desvincular el inicio de sesión. Inténtalo de nuevo.'
              : "Details saved, but the login couldn't be unlinked. Try again.");
          }
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
            throw new Error(lang === 'es'
              ? 'Detalles guardados, pero no se pudo vincular el inicio de sesión. Inténtalo de nuevo.'
              : "Details saved, but the login couldn't be linked. Try again.");
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
          throw new Error(lang === 'es'
            ? 'Detalles guardados, pero no se pudo actualizar el salario. Inténtalo de nuevo.'
            : "Details saved, but the wage couldn't be updated. Try again.");
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

  const handleDelete = async (member: StaffMember) => {
    const msg = lang === 'es'
      ? `¿Eliminar a ${member.name}? También se eliminará su historial de horarios.`
      : `Delete ${member.name}? Their schedule history will be deleted too.`;
    if (!window.confirm(msg)) return;
    if (!uid || !pid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await deleteStaffMember(uid, pid, member.id);
      await refreshStaff();
      closeModal();
    } catch (err) {
      console.error('[ManagerDirectory] delete failed:', err);
      setSaveError(lang === 'es'
        ? 'No se pudo eliminar. Inténtalo de nuevo.'
        : "Couldn't delete. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  /* ── Derived ── */
  const total   = staff.length;
  const onShift = staff.filter(s => s.scheduledToday).length;
  const nearOT  = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 4).length;

  const groups = useMemo(() => {
    const byDept = (dept: DeptKey) => staff
      .filter(s => asDeptKey(s.department) === dept)
      .sort((a, b) => {
        if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const base: { dept: DeptKey; list: StaffMember[] }[] =
      DEPT_ORDER.map(dept => ({ dept, list: byDept(dept) }));
    const otherList = byDept('other');
    if (otherList.length > 0) base.push({ dept: 'other', list: otherList });
    return base;
  }, [staff]);

  // Accounts available to link: those without a staff_id, plus whichever
  // account is currently linked to this staff member (so the picker still
  // shows it after an open).
  const linkableAccounts = useMemo(() => {
    return team.filter(t => t.staffId === null || t.accountId === originalLinkedAccountId);
  }, [team, originalLinkedAccountId]);

  return (
    <div className="staff-directory-shell" style={{
      background: 'transparent', color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '24px 48px 130px',
    }}>
      <style>{`
        .staff-dir-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; align-items: flex-start; }
        @media (max-width: 900px) { .staff-dir-grid { grid-template-columns: 1fr; } }
        .staff-directory-shell { padding: 24px 48px 130px; }
        .staff-dir-row { cursor: pointer; transition: background 0.3s cubic-bezier(.22,1,.36,1); }
        .staff-dir-row:hover { background: rgba(31,35,28,0.04); }
        .staff-dir-row:focus-visible { outline: 2px solid ${T.brand}; outline-offset: -2px; }
        @media (max-width: 640px) { .staff-directory-shell { padding: 16px 16px 110px !important; } }
      `}</style>

      {/* Slim action row — Invite Staff (managers only). The page header was
          removed, so this is the directory's top-level action affordance. */}
      {isManager && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Btn variant="primary" size="md" onClick={() => setShowInvite(true)}>
            <UserPlus size={14} />
            {lang === 'es' ? 'Invitar Personal' : 'Invite Staff'}
          </Btn>
        </div>
      )}

      {isManager && contactsError && (
        <div role="alert" style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 12,
          color: '#B85C3D', background: 'rgba(184,92,61,0.08)',
          border: '1px solid rgba(184,92,61,0.25)', fontSize: 13,
        }}>{contactsError}</div>
      )}

      {/* Waiting-to-approve queue (managers only, hidden when empty) */}
      {isManager && requests.length > 0 && (
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
          boxShadow: T.cardShadow, marginBottom: 16, overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 18px', borderBottom: `1px solid ${T.rule}`,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: T.caramel }} />
            <span style={{ fontWeight: 600, fontSize: 14, color: T.ink, letterSpacing: '-0.01em' }}>
              {lang === 'es' ? 'Esperando aprobación' : 'Waiting to approve'}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{requests.length}</span>
          </div>
          {requests.map(r => {
            const busy = decidingId === r.id;
            return (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
                borderBottom: `1px solid ${T.ruleSoft}`, opacity: busy ? 0.55 : 1,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>{deptLabel(r.department)}</span>
                    <span style={{ fontSize: 10, color: T.ink3 }}>·</span>
                    <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>{timeAgo(r.created_at, lang)}</span>
                  </div>
                </div>
                <Btn variant="ghost" size="sm" onClick={() => decideRequest(r.id, 'deny')} disabled={busy}
                  style={{ color: '#B85C3D', borderColor: 'rgba(184,92,61,0.25)' }}>
                  {lang === 'es' ? 'Rechazar' : 'Deny'}
                </Btn>
                <Btn variant="primary" size="sm" onClick={() => decideRequest(r.id, 'approve')} disabled={busy}>
                  {lang === 'es' ? 'Aprobar' : 'Approve'}
                </Btn>
              </div>
            );
          })}
        </div>
      )}

      {/* KPI strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16,
      }}>
        {[
          { eyebrow: 'Roster',   big: total,   sub: 'people on the books',     accent: '#5C7A60' },
          { eyebrow: 'On shift', big: onShift, sub: 'clocked in right now',    accent: '#C99644' },
          { eyebrow: 'Near OT',  big: nearOT,  sub: 'within 4h of weekly cap', accent: nearOT > 0 ? '#B85C3D' : T.ink3 },
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
                fontFamily: fonts.sans, fontSize: 23, fontWeight: 600, color: T.ink,
                letterSpacing: '-0.02em', lineHeight: 1,
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
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              boxShadow: T.cardShadow, overflow: 'hidden',
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
                {g.list.map(s => (
                  <DirRow
                    key={s.id}
                    member={s}
                    phone={contacts[s.id]}
                    contactsReady={contactsReady}
                    contactsUnavailable={Boolean(contactsError) && !contactsLoading}
                    onClick={() => openEdit(s)}
                  />
                ))}
              </div>
              <button
                onClick={() => openAdd(g.dept as StaffDepartment)}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  padding: g.list.length === 0 ? '22px 16px' : '12px 16px',
                  borderTop: g.list.length === 0 ? 'none' : `1px dashed ${T.rule}`,
                  fontFamily: fonts.sans, fontSize: 13, fontWeight: 700,
                  color: T.ink2, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >+ {lang === 'es' ? `Añadir A ${DEPT_ES[g.dept] ?? m.label}` : `Add To ${m.label.replace(/\b[a-z]/g, c => c.toUpperCase())}`}</button>
            </div>
          );
        })}
      </div>

      {/* Invite Staff modal — same overlay + click-outside idiom as the edit
          modal. On close, re-poll the queue so a fresh signup that happened
          while the sheet was open shows up immediately. */}
      {showInvite && (
        <div
          className={invitePanelStyles.modalLayer}
          onClick={() => { setShowInvite(false); void loadRequests(); }}
        >
          <div
            className={invitePanelStyles.modalDialog}
            role="dialog"
            aria-modal="true"
            aria-label={lang === 'es' ? 'Invitar personal' : 'Invite staff'}
            tabIndex={-1}
            onClick={e => e.stopPropagation()}
          >
            <InviteStaffPanel
              hotelId={pid}
              lang={lang}
              variant="modal"
              onClose={() => { setShowInvite(false); void loadRequests(); }}
            />
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {showModal && (
        <StaffEditModal
          editMember={editMember}
          form={form}
          setForm={setForm}
          saving={saving}
          saveError={saveError}
          onClose={closeModal}
          onSave={performSave}
          onDelete={editMember ? () => handleDelete(editMember) : undefined}
          linkableAccounts={linkableAccounts}
          linkedAccountId={linkedAccountId}
          setLinkedAccountId={setLinkedAccountId}
          showWage={isManager}
          markPhoneTouched={() => setPhoneTouched(true)}
          markWageTouched={() => setWageTouched(true)}
          lang={lang}
        />
      )}
    </div>
  );
}

// ── Directory row ────────────────────────────────────────────────────────
function DirRow({
  member, phone, contactsReady, contactsUnavailable, onClick,
}: {
  member: StaffMember;
  phone: string | null | undefined;
  contactsReady: boolean;
  contactsUnavailable: boolean;
  onClick: () => void;
}) {
  const ring = member.scheduledToday ? '#5C7A60' : null; // sage accent = on shift
  return (
    <button
      type="button"
      className="staff-dir-row"
      onClick={onClick}
      aria-label={`Edit ${member.name}`}
      style={{
        width: '100%', textAlign: 'left', background: 'transparent', border: 0,
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
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <span style={{
            fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3,
          }}>{contactsUnavailable
              ? 'Unavailable'
              : !contactsReady
                ? 'Loading…'
                : phone
                  ? formatPhone(phone)
                  : 'No phone'}</span>
          <span style={{ fontSize: 10, color: T.ink3 }}>·</span>
          <span style={{
            fontFamily: fonts.mono, fontSize: 11, color: T.ink3,
          }}>{(member.language || 'es').toUpperCase()}</span>
        </div>
      </div>
      <HoursBar hrs={member.weeklyHours ?? 0} max={member.maxWeeklyHours ?? 40} width={56}/>
    </button>
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
  linkableAccounts, linkedAccountId, setLinkedAccountId, showWage,
  markPhoneTouched, markWageTouched, lang,
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
  markPhoneTouched: () => void;
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
          background: T.paper, borderRadius: 18,
          width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto',
          padding: '24px 26px',
          boxShadow: '0 24px 60px -8px rgba(31,42,32,0.24), 0 0 0 1px rgba(31,35,28,0.04)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 18,
        }}>
          <h2 style={{
            margin: 0, fontFamily: fonts.sans, fontSize: 18,
            color: T.ink, letterSpacing: '-0.02em', fontWeight: 600,
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
                      border: sel ? `1px solid ${T.brand}` : `1px solid ${T.rule}`,
                      background: sel ? T.brand : 'transparent',
                      color: sel ? '#FFFFFF' : T.ink2,
                      fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all .3s cubic-bezier(.22,1,.36,1)',
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
              onChange={e => {
                markPhoneTouched();
                setForm(f => ({ ...f, phone: e.target.value }));
              }}
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
          ].map(({ label, field }) => (
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
              background: 'rgba(184,92,61,0.08)',
              border: '1px solid rgba(184,92,61,0.25)',
              borderRadius: 12, color: '#B85C3D',
              fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.4,
            }}>{saveError}</div>
          )}

          {/* Action row */}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            {onDelete && (
              <Btn variant="ghost" size="md" onClick={onDelete}
                style={{ color: '#B85C3D', borderColor: 'rgba(184,92,61,0.25)' }}>
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
