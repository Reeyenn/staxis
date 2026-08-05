'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The EMPLOYMENT half of one person's card in My Hotel → People.
//
// Ported 1:1 from the Staff → Directory edit modal when that screen was folded
// into My Hotel on 2026-07-27 and deleted (it lived at
// src/app/staff/_components/ManagerDirectory.tsx; `git log --diff-filter=D` if
// you need the original). Every field the Directory owned lives here, and —
// critically — so does every reason each one is written the way it is. This is
// now the ONLY editor for all of them. Three of these writes deliberately do
// NOT travel over the browser's anon Supabase client:
//
//   • hourly wage        → PUT  /api/staff/wages           (view_wages gated)
//   • auto-assign rank   → POST /api/housekeeping/staff-priority
//   • phone number       → PUT  /api/staff/contacts
//
// `staff` RLS is row-level only, so any authenticated hotel browser could
// otherwise read or overwrite a colleague's pay and contact details, and an
// UPDATE that RLS filters to zero rows is NOT an error — it silently does
// nothing. The auto-assign field is the sharpest case: this card is the ONLY
// editor for it anywhere in the app, so a silent no-op would strand a
// housekeeper as permanently un-assignable behind an "EXCLUDED" badge nobody
// could clear.
//
// This renders as a plain <section>, never a <form>, because it is slotted into
// the account dialog next to that dialog's own form.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { AlertCircle, CheckCircle2, Trash2, UserRoundCog } from 'lucide-react';

import { DraftNumberInput } from '@/components/DraftNumberInput';
import { fetchWithAuth } from '@/lib/api-fetch';
import { addStaffMember, updateStaffMember } from '@/lib/db';
import type { SchedulePriority, StaffDepartment, StaffMember } from '@/types';

import type { HotelTeamLang } from './HotelTeamPanel';
import styles from './HotelTeamPanel.module.css';

/** Just enough of an account row to offer it in the "linked login" picker. */
export interface EmploymentLinkAccount {
  accountId: string;
  displayName: string;
  username: string;
  role: string;
  staffId: string | null;
  historicalStaffId: string | null;
  propertyAccess: readonly string[];
  managementSurface: 'legacy_hotel' | 'company_access';
  staffLinkAllowed: boolean;
  lifecyclePending: boolean;
}

export interface PersonEmploymentFormProps {
  hotelId: string;
  /** Legacy first argument on the db/* helpers. Ignored by them; kept so the
   *  call sites stay identical to the ones this was ported from. */
  uid: string;
  lang: HotelTeamLang;
  /** The person's employment record, or null when they only have a login. */
  staff: StaffMember | null;
  /** Every login at this hotel, for the picker. */
  accounts: readonly EmploymentLinkAccount[];
  /** Whether this viewer may change this person's employment at all. */
  canEdit: boolean;
  /** `view_wages` — a MANAGER_FLOOR capability. False hides the field AND
   *  suppresses the write; PUT /api/staff/wages re-checks it server-side. */
  canViewWages: boolean;
  /** staffId → wage, fetched by the panel under the same capability gate. */
  wages: Readonly<Record<string, number | null>>;
  /** staffId → phone, fetched by the panel from /api/staff/contacts. */
  contacts: Readonly<Record<string, string | null>>;
  contactsReady: boolean;
  contactsUnavailable: boolean;
  onWageSaved: (staffId: string, wage: number | null) => void;
  onContactSaved: (staffId: string, phone: string | null) => void;
  /** Reload the roster and the account list. */
  onChanged: () => void | Promise<void>;
  /**
   * Close the whole person panel. Used when this panel can no longer describe
   * the person it was opened for: the employment record was deleted, or the
   * linked login changed and the roster is about to re-key their card.
   */
  onClosePanel: () => void;
}

interface EmploymentDraft {
  name: string;
  phone: string;
  language: 'en' | 'es';
  department: StaffDepartment;
  isSenior: boolean;
  hourlyWage?: number;
  maxWeeklyHours: number;
  maxDaysPerWeek: number;
  vacationDates: string;
  schedulePriority: SchedulePriority;
}

const DEPARTMENTS: readonly StaffDepartment[] = [
  'housekeeping',
  'front_desk',
  'maintenance',
  'other',
] as const;

const STAFF_WRITE_TIMEOUT_MS = 15_000;

function departmentLabel(value: string | undefined, lang: HotelTeamLang): string {
  const labels: Record<string, string> = {
    housekeeping: 'Housekeeping',
    front_desk: 'Front Desk',
    maintenance: 'Maintenance',
    other: 'Other',
  };
  return labels[value ?? 'other'] ?? labels.other;
}

function draftFrom(
  staff: StaffMember | null,
  wages: Readonly<Record<string, number | null>>,
  contacts: Readonly<Record<string, string | null>>,
): EmploymentDraft {
  return {
    name: staff?.name ?? '',
    phone: (staff ? contacts[staff.id] : null) ?? '',
    language: staff?.language ?? 'es',
    department: (staff?.department ?? 'housekeeping') as StaffDepartment,
    isSenior: staff?.isSenior ?? false,
    hourlyWage: (staff ? wages[staff.id] : null) ?? undefined,
    maxWeeklyHours: staff?.maxWeeklyHours ?? 40,
    maxDaysPerWeek: staff?.maxDaysPerWeek ?? 5,
    vacationDates: (staff?.vacationDates ?? []).join('\n'),
    schedulePriority: staff?.schedulePriority ?? 'normal',
  };
}

export function PersonEmploymentForm({
  hotelId,
  uid,
  lang,
  staff,
  accounts,
  canEdit,
  canViewWages,
  wages,
  contacts,
  contactsReady,
  contactsUnavailable,
  onWageSaved,
  onContactSaved,
  onChanged,
  onClosePanel,
}: PersonEmploymentFormProps) {
  const [draft, setDraft] = React.useState<EmploymentDraft>(
    () => draftFrom(staff, wages, contacts),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [deleteConfirming, setDeleteConfirming] = React.useState(false);
  // Did the manager actually touch these fields this session? Both start blank
  // whenever their async map has not resolved yet, and an untouched blank must
  // never overwrite a stored wage or phone number on save.
  const [wageTouched, setWageTouched] = React.useState(false);
  const [phoneTouched, setPhoneTouched] = React.useState(false);
  // A staff row created by a save whose LATER step failed. Retrying reuses it
  // instead of creating a second person.
  const createdIdRef = React.useRef<string | null>(null);
  const deleteConfirmRef = React.useRef<HTMLDivElement | null>(null);
  const headingId = React.useId();
  const nameId = React.useId();
  const departmentLabelId = React.useId();
  const phoneId = React.useId();
  const languageLabelId = React.useId();
  const wageId = React.useId();
  const maxHoursId = React.useId();
  const maxDaysId = React.useId();
  const priorityId = React.useId();
  const priorityHintId = React.useId();
  const loginId = React.useId();
  const loginHintId = React.useId();
  const vacationId = React.useId();
  const vacationHintId = React.useId();
  const deleteHeadingId = React.useId();

  const staffId = staff?.id ?? null;
  const linkedAccountId = React.useMemo(
    () => accounts.find((account) => staffId && account.staffId === staffId)?.accountId ?? null,
    [accounts, staffId],
  );
  const [nextAccountId, setNextAccountId] = React.useState<string | null>(linkedAccountId);
  // The picker offers unlinked logins plus whoever is already linked here, so
  // the current selection never disappears from its own menu.
  const linkableAccounts = React.useMemo(
    () => accounts.filter((account) => (
      account.accountId === linkedAccountId
      || (
        account.staffId === null
        && account.historicalStaffId === null
        && account.staffLinkAllowed
        && !account.lifecyclePending
      )
    )),
    [accounts, linkedAccountId],
  );

  // Late-arriving wage/phone maps hydrate the fields only while the manager has
  // not typed in them. Without this, opening a card before the fetch resolves
  // would show a blank field for somebody who does have a wage or a number.
  React.useEffect(() => {
    if (!staffId || wageTouched) return;
    const loaded = wages[staffId] ?? undefined;
    setDraft((current) => (current.hourlyWage === loaded ? current : { ...current, hourlyWage: loaded }));
  }, [staffId, wageTouched, wages]);

  React.useEffect(() => {
    if (!staffId || phoneTouched || !contactsReady) return;
    const loaded = contacts[staffId] ?? '';
    setDraft((current) => (current.phone === loaded ? current : { ...current, phone: loaded }));
  }, [contacts, contactsReady, phoneTouched, staffId]);

  React.useEffect(() => {
    setNextAccountId(linkedAccountId);
  }, [linkedAccountId]);

  React.useEffect(() => {
    if (deleteConfirming) deleteConfirmRef.current?.focus();
  }, [deleteConfirming]);

  const linkChanged = nextAccountId !== linkedAccountId;
  const trimmedName = draft.name.trim();

  const save = async () => {
    if (saving || !canEdit || !trimmedName) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const vacationDates = draft.vacationDates
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
      const record = {
        name: trimmedName,
        language: draft.language,
        department: draft.department,
        isSenior: draft.isSenior,
        maxWeeklyHours: draft.maxWeeklyHours,
        maxDaysPerWeek: draft.maxDaysPerWeek,
        vacationDates,
        // hourlyWage and schedulePriority are deliberately absent — see the
        // file header. They travel over their own service-role routes below.
      };

      // Hard timeout on the roster write: a wedged Supabase auth lock would
      // otherwise leave this dialog spinning forever.
      const existingId = staffId ?? createdIdRef.current;
      let savedStaffId: string | null = existingId;
      const write: Promise<unknown> = existingId
        ? updateStaffMember(uid, hotelId, existingId, record)
        // scheduledToday is DEPRECATED (2026-07-24) — a non-date-aware boolean
        // nothing writes. Housekeeping derives who is working from
        // scheduled_shifts. Kept only for the NOT NULL column default.
        : addStaffMember(uid, hotelId, {
            ...record,
            isActive: true,
            scheduledToday: false,
            weeklyHours: 0,
          })
            .then((newId: string | void) => {
              if (typeof newId === 'string') {
                savedStaffId = newId;
                createdIdRef.current = newId;
              }
            });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Saving took too long. Check your connection and try again.')),
          STAFF_WRITE_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([write, timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (!savedStaffId) throw new Error('Save failed.');

      // Phone: written only after real input on an existing person, always on a
      // brand-new one so the field is initialized.
      if (!existingId || phoneTouched) {
        const desiredPhone = draft.phone.trim();
        const response = await fetchWithAuth('/api/staff/contacts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: hotelId, staffId: savedStaffId, phone: desiredPhone }),
        });
        if (!response.ok) {
          throw new Error("Details saved, but the phone number couldn't be updated. Try again.");
        }
        onContactSaved(savedStaffId, desiredPhone || null);
      }

      // Linked login. Detach the previous account first so a staff row is never
      // claimed by two logins at once.
      if (linkChanged) {
        if (linkedAccountId) {
          const detach = await fetchWithAuth('/api/auth/team', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hotelId, accountId: linkedAccountId, staffId: null }),
          });
          if (!detach.ok) {
            throw new Error("Details saved, but the login couldn't be unlinked. Try again.");
          }
        }
        if (nextAccountId) {
          const attach = await fetchWithAuth('/api/auth/team', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hotelId, accountId: nextAccountId, staffId: savedStaffId }),
          });
          if (!attach.ok) {
            throw new Error("Details saved, but the login couldn't be linked. Try again.");
          }
        }
      }

      // Wage. Fires only when the manager actually edited the field AND may see
      // wages at all; the route enforces `view_wages` again on its own.
      if (canViewWages && wageTouched) {
        const desiredWage = draft.hourlyWage ?? null;
        const response = await fetchWithAuth('/api/staff/wages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: hotelId, staffId: savedStaffId, hourlyWage: desiredWage }),
        });
        if (!response.ok) {
          throw new Error("Details saved, but the pay rate couldn't be updated. Try again.");
        }
        onWageSaved(savedStaffId, desiredWage);
      }

      // Auto-assign eligibility. Housekeeping only — nothing auto-assigns the
      // other departments — and only when it changed.
      if (draft.department === 'housekeeping') {
        const previous = staff?.schedulePriority ?? 'normal';
        if (draft.schedulePriority !== previous) {
          const response = await fetchWithAuth('/api/housekeeping/staff-priority', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              propertyId: hotelId,
              staffId: savedStaffId,
              priority: draft.schedulePriority,
            }),
          });
          if (!response.ok) {
            throw new Error("Details saved, but the automatic room assignment setting couldn't be changed. Try again.");
          }
        }
      }

      createdIdRef.current = null;
      setWageTouched(false);
      setPhoneTouched(false);
      setSaved(true);

      // Changing the linked login re-keys this person's card: the roster merge
      // keys a linked human by their ACCOUNT and an unlinked one by their staff
      // row, so after a link or an unlink this panel is describing a person who
      // no longer exists in that shape. Left open, an unlink would leave the
      // login half sitting here under "No schedule profile" — copy that tells
      // the manager to Add the person, moments after their schedule profile
      // became its own card two inches away. Following it would create the
      // exact duplicate human this screen exists to eliminate. Close instead
      // and let the refreshed list show the truth.
      if (linkChanged) onClosePanel();

      await onChanged();
    } catch (saveError) {
      console.error('[PersonEmploymentForm] save failed', saveError);
      setError(saveError instanceof Error && saveError.message
        ? saveError.message
        : 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (saving || !staffId) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetchWithAuth(
        `/api/staff/operational?hotelId=${encodeURIComponent(hotelId)}&staffId=${encodeURIComponent(staffId)}`,
        { method: 'DELETE', timeoutMs: STAFF_WRITE_TIMEOUT_MS },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || 'Archive failed');
      }
      await onChanged();
      onClosePanel();
    } catch (deleteError) {
      console.error('[PersonEmploymentForm] delete failed', deleteError);
      setDeleteConfirming(false);
      setError("Couldn't remove this person from the schedule. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── People with a login and no employment record ─────────────────────────
  // An owner who never clocks in is the normal case. There is nothing to edit
  // here, and inventing an empty staff row for them would put a stranger on the
  // schedule. Say so plainly instead.
  if (!staff) {
    return (
      <section className={styles.employmentCard} aria-labelledby={headingId}>
        <div className={styles.employmentHeader}>
          <span className={styles.sectionIcon}><UserRoundCog size={18} aria-hidden="true" /></span>
          <div>
            <span>{'Employment'}</span>
            <h3 id={headingId}>{'No schedule profile'}</h3>
          </div>
        </div>
        <p className={styles.employmentCopy}>
          {'This person has a login but no schedule profile. Use Invite people, then choose NO LOGIN / Add to schedule only.'}
        </p>
      </section>
    );
  }

  // ── Read-only: the viewer may see this person but not change them ────────
  if (!canEdit) {
    return (
      <section className={styles.employmentCard} aria-labelledby={headingId}>
        <div className={styles.employmentHeader}>
          <span className={styles.sectionIcon}><UserRoundCog size={18} aria-hidden="true" /></span>
          <div>
            <span>{'Employment'}</span>
            <h3 id={headingId}>{'Schedule profile'}</h3>
          </div>
        </div>
        <dl className={styles.employmentFacts}>
          <div>
            <dt>{'Department'}</dt>
            <dd>{departmentLabel(staff.department, lang)}</dd>
          </div>
          <div>
            <dt>{'Hours cap'}</dt>
            <dd>{`${staff.maxWeeklyHours ?? 40}h · ${staff.maxDaysPerWeek ?? 5} days`}</dd>
          </div>
          <div>
            <dt>{'Status'}</dt>
            <dd>{staff.isActive === false
              ? 'Inactive'
              : 'Active'}</dd>
          </div>
        </dl>
        <p className={styles.employmentCopy}>
          {'You do not have permission to change this person’s employment details.'}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.employmentCard} aria-labelledby={headingId}>
      <div className={styles.employmentHeader}>
        <span className={styles.sectionIcon}><UserRoundCog size={18} aria-hidden="true" /></span>
        <div>
          <span>{'Employment'}</span>
          <h3 id={headingId}>{'Schedule profile and pay'}</h3>
        </div>
      </div>

      <div className={styles.dialogForm}>
        <label className={styles.field} htmlFor={nameId}>
          <span>{'Name'}</span>
          <input
            id={nameId}
            type="text"
            value={draft.name}
            onChange={(event) => { setDraft((c) => ({ ...c, name: event.target.value })); setSaved(false); }}
            maxLength={120}
            autoComplete="off"
            disabled={saving}
          />
        </label>

        <div className={styles.field}>
          <span id={departmentLabelId}>{'Department'}</span>
          <div className={styles.choiceRow} role="group" aria-labelledby={departmentLabelId}>
            {DEPARTMENTS.map((department) => (
              <button
                key={department}
                type="button"
                aria-pressed={draft.department === department}
                className={styles.choiceChip}
                onClick={() => { setDraft((c) => ({ ...c, department })); setSaved(false); }}
                disabled={saving}
              >
                {departmentLabel(department, lang)}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.field} htmlFor={phoneId}>
          <span>{'Phone'}</span>
          <input
            id={phoneId}
            type="tel"
            value={draft.phone}
            onChange={(event) => {
              setPhoneTouched(true);
              setSaved(false);
              setDraft((c) => ({ ...c, phone: event.target.value }));
            }}
            maxLength={30}
            autoComplete="tel"
            placeholder="(409) 555-1234"
            disabled={saving}
          />
          {contactsUnavailable ? (
            <small className={styles.cautionText}>{'Phone numbers could not be loaded. Saving this field will overwrite the stored number.'}</small>
          ) : null}
        </label>

        <div className={styles.field}>
          <span id={languageLabelId}>{'Preferred language'}</span>
          <div className={styles.choiceRow} role="group" aria-labelledby={languageLabelId}>
            {(['en', 'es'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={draft.language === value}
                className={styles.choiceChip}
                onClick={() => { setDraft((c) => ({ ...c, language: value })); setSaved(false); }}
                disabled={saving}
              >
                {value === 'en' ? 'English' : 'Español'}
              </button>
            ))}
          </div>
        </div>

        {/* Pay is payroll-private. `view_wages` sits on the manager floor, so it
            can never fall to line staff, and PUT /api/staff/wages checks it
            again server-side. */}
        {canViewWages ? (
          <label className={styles.field} htmlFor={wageId}>
            <span>{'Hourly pay'}</span>
            <input
              id={wageId}
              type="number"
              value={draft.hourlyWage ?? ''}
              step="0.50"
              min="0"
              onChange={(event) => {
                setWageTouched(true);
                setSaved(false);
                // A lone "." parses to NaN, which JSON.stringify would send as
                // null — a silent clear. Read it as "no wage entered" instead.
                const parsed = Number.parseFloat(event.target.value);
                setDraft((c) => ({ ...c, hourlyWage: Number.isFinite(parsed) ? parsed : undefined }));
              }}
              placeholder="15.00"
              disabled={saving}
            />
          </label>
        ) : null}

        <div className={styles.fieldGrid}>
          <label className={styles.field} htmlFor={maxHoursId}>
            <span>{'Max hours per week'}</span>
            <DraftNumberInput
              value={draft.maxWeeklyHours}
              onCommit={(value) => { setDraft((c) => ({ ...c, maxWeeklyHours: value })); setSaved(false); }}
              min={1}
              width="100%"
              disabled={saving}
              inputProps={{ id: maxHoursId }}
            />
          </label>
          <label className={styles.field} htmlFor={maxDaysId}>
            <span>{'Max days per week'}</span>
            <DraftNumberInput
              value={draft.maxDaysPerWeek}
              onCommit={(value) => { setDraft((c) => ({ ...c, maxDaysPerWeek: value })); setSaved(false); }}
              min={1}
              max={7}
              width="100%"
              disabled={saving}
              inputProps={{ id: maxDaysId }}
            />
          </label>
        </div>

        {/* The ONLY editor for auto-assign eligibility anywhere in Staxis. The
            housekeeping board shows "EXCLUDED" and cannot clear it. */}
        {draft.department === 'housekeeping' ? (
          <label className={styles.field} htmlFor={priorityId}>
            <span>{'Automatic room assignment'}</span>
            <select
              id={priorityId}
              aria-describedby={priorityHintId}
              value={draft.schedulePriority}
              onChange={(event) => {
                setSaved(false);
                setDraft((c) => ({ ...c, schedulePriority: event.target.value as SchedulePriority }));
              }}
              disabled={saving}
            >
              <option value="priority">{'First: give them rooms before the others'}</option>
              <option value="normal">{'Normal: share the work evenly'}</option>
              <option value="excluded">{'Never: don’t hand them rooms automatically'}</option>
            </select>
            <small id={priorityHintId}>{'How soon they get rooms when the board hands out the day’s work.'}</small>
          </label>
        ) : null}

        <div className={styles.toggleRow}>
          <label className={styles.toggleField}>
            <span>{'Senior'}</span>
            <input
              type="checkbox"
              checked={draft.isSenior}
              onChange={(event) => { setDraft((c) => ({ ...c, isSenior: event.target.checked })); setSaved(false); }}
              disabled={saving}
            />
          </label>
        </div>

        <label className={styles.field} htmlFor={loginId}>
          <span>{'Linked login'}</span>
          <select
            id={loginId}
            aria-describedby={loginHintId}
            value={nextAccountId ?? ''}
            onChange={(event) => { setNextAccountId(event.target.value || null); setSaved(false); }}
            disabled={saving}
          >
            <option value="">{'No login linked'}</option>
            {linkableAccounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {`${account.displayName} (@${account.username})`}
              </option>
            ))}
          </select>
          <small id={loginHintId}>{'The linked login sees this person’s own shifts in My Shifts. Without a link that page stays empty.'}</small>
        </label>

        <label className={styles.field} htmlFor={vacationId}>
          <span>{'Vacation dates'}</span>
          <textarea
            id={vacationId}
            aria-describedby={vacationHintId}
            value={draft.vacationDates}
            onChange={(event) => { setDraft((c) => ({ ...c, vacationDates: event.target.value })); setSaved(false); }}
            rows={3}
            placeholder="2026-06-15"
            disabled={saving}
          />
          <small id={vacationHintId}>{'One per line, YYYY-MM-DD.'}</small>
        </label>

        {saved && !error ? (
          <div className={styles.successNotice} role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <strong>{'Employment details saved'}</strong>
              <span>{'The roster is up to date.'}</span>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className={styles.dialogError} role="alert">
            <AlertCircle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {deleteConfirming ? (
          <div
            ref={deleteConfirmRef}
            className={styles.lifecycleConfirmation}
            role="alert"
            tabIndex={-1}
            aria-labelledby={deleteHeadingId}
          >
            <h3 id={deleteHeadingId}>{`Archive ${staff.name}'s schedule profile?`}</h3>
            <p>{'Past schedule history is kept. Any assignment today or later becomes an open shift for coverage. Their login, if any, is kept and keeps working.'}</p>
            <div className={styles.lifecycleConfirmationActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setDeleteConfirming(false)}
                disabled={saving}
              >
                {'Keep them'}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => void remove()}
                disabled={saving}
              >
                {'Archive schedule profile'}
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.dialogFooter}>
          <button
            type="button"
            className={styles.dangerGhostButton}
            onClick={() => setDeleteConfirming(true)}
            disabled={saving || deleteConfirming}
          >
            <Trash2 size={15} aria-hidden="true" />
            {'Archive schedule profile'}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void save()}
            disabled={saving || !trimmedName || deleteConfirming}
          >
            {saving
              ? <><span className={styles.buttonSpinner} aria-hidden="true" />{'Saving…'}</>
              : 'Save employment details'}
          </button>
        </div>
      </div>
    </section>
  );
}
