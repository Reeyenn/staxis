'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type { StaffDepartment, StaffMember } from '@/types';

import type { HotelTeamLang, HotelTeamLinkageState } from './HotelTeamPanel';
import styles from './OperationalStaffSection.module.css';

interface OperationalStaffSectionProps {
  hotelId: string;
  staff: StaffMember[];
  linkage: HotelTeamLinkageState;
  rosterUnavailable: boolean;
  lang: HotelTeamLang;
  canAddStaff: boolean;
  canResolveLinkage: boolean;
  onChanged: () => void | Promise<void>;
}

interface StaffDraft {
  name: string;
  department: StaffDepartment;
  phone: string;
  language: 'en' | 'es';
}

interface CreateOperationalStaffResponse {
  ok?: boolean;
  data?: { staffId?: string };
  error?: string;
  code?: string;
}

interface CreateOperationalStaffPayload {
  hotelId: string;
  name: string;
  department: StaffDepartment;
  phone: string;
  language: 'en' | 'es';
}

interface OperationalStaffAttempt {
  key: string;
  payload: CreateOperationalStaffPayload;
}

function freshDraft(): StaffDraft {
  return {
    name: '',
    department: 'housekeeping',
    phone: '',
    language: 'en',
  };
}

function freshIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `staff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function copy(lang: HotelTeamLang, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

function departmentLabel(department: StaffDepartment | undefined, lang: HotelTeamLang): string {
  const labels: Record<StaffDepartment, [string, string]> = {
    housekeeping: ['Housekeeping', 'Limpieza'],
    front_desk: ['Front Desk', 'Recepción'],
    maintenance: ['Maintenance', 'Mantenimiento'],
    other: ['Other', 'Otro'],
  };
  const pair = labels[department ?? 'other'];
  return copy(lang, pair[0], pair[1]);
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'S';
}

function AddOperationalStaffDialog({
  hotelId,
  lang,
  onClose,
  onAdded,
  onChanged,
  pendingAttempt,
  onPendingAttemptChange,
}: {
  hotelId: string;
  lang: HotelTeamLang;
  onClose: () => void;
  onAdded: (member: StaffMember) => void;
  onChanged: () => void | Promise<void>;
  pendingAttempt: OperationalStaffAttempt | null;
  onPendingAttemptChange: (attempt: OperationalStaffAttempt | null) => void;
}) {
  const [draft, setDraft] = React.useState<StaffDraft>(() => pendingAttempt
    ? {
        name: pendingAttempt.payload.name,
        department: pendingAttempt.payload.department,
        phone: pendingAttempt.payload.phone,
        language: pendingAttempt.payload.language,
      }
    : freshDraft());
  const [busy, setBusy] = React.useState(false);
  const [retryLocked, setRetryLocked] = React.useState(Boolean(pendingAttempt));
  const [error, setError] = React.useState('');
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const mountedRef = React.useRef(true);
  const busyRef = React.useRef(busy);
  const closeRef = React.useRef(onClose);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const nameId = React.useId();
  const departmentId = React.useId();
  const phoneId = React.useId();
  const languageId = React.useId();

  closeRef.current = onClose;

  const requestClose = React.useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  React.useEffect(() => {
    mountedRef.current = true;
    const returnFocusElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialogLayer = dialogRef.current?.parentElement ?? null;
    const backgroundStates = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialogLayer)
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    backgroundStates.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    nameRef.current?.focus();

    const focusableElements = () => dialogRef.current
      ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getAttribute('aria-hidden') !== 'true')
      : [];

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = focusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!dialogRef.current || !(event.target instanceof Node) || dialogRef.current.contains(event.target)) return;
      const first = focusableElements()[0] ?? dialogRef.current;
      first.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      mountedRef.current = false;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      backgroundStates.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      if (returnFocusElement?.isConnected) returnFocusElement.focus({ preventScroll: true });
    };
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    const name = draft.name.trim();
    if (!name) {
      setError(copy(lang, 'Enter the staff member’s name.', 'Ingresa el nombre del empleado.'));
      nameRef.current?.focus();
      return;
    }

    // The ref closes the same-tick gap before React commits the disabled state,
    // so a rapid second submit cannot start another request.
    busyRef.current = true;
    setBusy(true);
    setError('');
    let definitiveFailure = false;
    const attempt = pendingAttempt ?? {
      key: freshIdempotencyKey(),
      payload: {
        hotelId,
        name,
        department: draft.department,
        phone: draft.phone.trim(),
        language: draft.language,
      },
    };
    onPendingAttemptChange(attempt);
    try {
      const response = await fetchWithAuth('/api/staff/operational', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.payload),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as CreateOperationalStaffResponse;
      const staffId = body.data?.staffId;
      if (!response.ok || !body.ok || !staffId) {
        // A definitive validation/server failure gets a fresh operation on
        // manual retry. Network timeouts and "still processing" responses keep
        // the old key so an unknown successful write is safely deduped.
        if (body.code !== 'IdempotencyInProgress') {
          definitiveFailure = true;
          onPendingAttemptChange(null);
        }
        throw new Error(body.code || body.error || 'request_failed');
      }
      if (!mountedRef.current) return;
      const saved = attempt.payload;
      onAdded({
        id: staffId,
        name: saved.name,
        department: saved.department,
        phone: saved.phone,
        language: saved.language,
        isSenior: false,
        scheduledToday: false,
        weeklyHours: 0,
        maxWeeklyHours: 40,
        maxDaysPerWeek: 5,
        vacationDates: [],
        isActive: true,
        schedulePriority: 'normal',
      });
      onPendingAttemptChange(null);
      busyRef.current = false;
      setBusy(false);
      onClose();
      void Promise.resolve(onChanged()).catch(() => undefined);
    } catch (caught) {
      if (!mountedRef.current) return;
      const timedOut = caught instanceof DOMException
        && (caught.name === 'TimeoutError' || caught.name === 'AbortError');
      const accessChanged = caught instanceof Error
        && (caught.message === 'forbidden' || caught.message === 'unauthorized');
      const stillProcessing = caught instanceof Error && caught.message === 'IdempotencyInProgress';
      setRetryLocked(!definitiveFailure || timedOut || stillProcessing);
      setError(timedOut
        ? copy(
            lang,
            'The save took too long. Wait a moment, then try again; Staxis will reuse this request.',
            'El guardado tardó demasiado. Espera un momento y vuelve a intentarlo; Staxis reutilizará esta solicitud.',
          )
        : stillProcessing
          ? copy(
              lang,
              'That save is still processing. Wait a moment, then try again.',
              'Ese guardado todavía se está procesando. Espera un momento y vuelve a intentarlo.',
            )
          : accessChanged
          ? copy(
              lang,
              'Your team-management access changed. Refresh the page before trying again.',
              'Tu acceso para administrar el equipo cambió. Actualiza la página antes de intentarlo de nuevo.',
            )
          : copy(
              lang,
              'This staff member could not be added. Check your connection and try again.',
              'No se pudo agregar a este empleado. Revisa tu conexión e inténtalo de nuevo.',
            ));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <div className={styles.dialogLayer}>
      <div
        className={styles.dialogScrim}
        aria-hidden="true"
        onMouseDown={requestClose}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <span className={styles.dialogIcon} aria-hidden="true"><UserPlus size={19} /></span>
          <div>
            <span>{copy(lang, 'Operational roster', 'Registro operativo')}</span>
            <h2 id={titleId}>{copy(lang, 'Add staff without a login', 'Agregar personal sin acceso')}</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={requestClose}
            disabled={busy}
            aria-label={copy(lang, 'Close', 'Cerrar')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p id={descriptionId} className={styles.dialogIntro}>
          {copy(
            lang,
            'This creates a schedule-only staff profile. It does not create a Staxis login or send an invitation.',
            'Esto crea un perfil solo para horarios. No crea un acceso a Staxis ni envía una invitación.',
          )}
        </p>

        <form className={styles.dialogForm} onSubmit={submit}>
          <label className={styles.field} htmlFor={nameId}>
            <span>{copy(lang, 'Name', 'Nombre')}</span>
            <input
              ref={nameRef}
              id={nameId}
              type="text"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              maxLength={120}
              autoComplete="off"
              placeholder={copy(lang, 'Maria Lopez', 'María López')}
              disabled={busy || retryLocked}
              required
            />
          </label>

          <div className={styles.fieldGrid}>
            <label className={styles.field} htmlFor={departmentId}>
              <span>{copy(lang, 'Department', 'Departamento')}</span>
              <select
                id={departmentId}
                value={draft.department}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  department: event.target.value as StaffDepartment,
                }))}
                disabled={busy || retryLocked}
              >
                <option value="housekeeping">{copy(lang, 'Housekeeping', 'Limpieza')}</option>
                <option value="front_desk">{copy(lang, 'Front Desk', 'Recepción')}</option>
                <option value="maintenance">{copy(lang, 'Maintenance', 'Mantenimiento')}</option>
                <option value="other">{copy(lang, 'Other', 'Otro')}</option>
              </select>
            </label>

            <label className={styles.field} htmlFor={languageId}>
              <span>{copy(lang, 'Preferred language', 'Idioma preferido')}</span>
              <select
                id={languageId}
                value={draft.language}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  language: event.target.value as 'en' | 'es',
                }))}
                disabled={busy || retryLocked}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
          </div>

          <label className={styles.field} htmlFor={phoneId}>
            <span>{copy(lang, 'Phone (optional)', 'Teléfono (opcional)')}</span>
            <input
              id={phoneId}
              type="tel"
              value={draft.phone}
              onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))}
              maxLength={30}
              autoComplete="tel"
              placeholder="(555) 555-1234"
              disabled={busy || retryLocked}
            />
          </label>

          {error ? (
            <div className={styles.dialogError} role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className={styles.dialogFooter}>
            <button type="button" className={styles.secondaryButton} onClick={requestClose} disabled={busy}>
              {copy(lang, 'Cancel', 'Cancelar')}
            </button>
            <button type="submit" className={styles.primaryButton} disabled={busy || !draft.name.trim()}>
              {busy ? <LoaderCircle className={styles.buttonSpinner} size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
              {busy
                ? copy(lang, 'Adding…', 'Agregando…')
                : retryLocked
                  ? copy(lang, 'Retry add', 'Reintentar')
                  : copy(lang, 'Add staff', 'Agregar personal')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function OperationalStaffSection({
  hotelId,
  staff,
  linkage,
  rosterUnavailable,
  lang,
  canAddStaff,
  canResolveLinkage,
  onChanged,
}: OperationalStaffSectionProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [optimisticStaff, setOptimisticStaff] = React.useState<StaffMember[]>([]);
  const [pendingAttempt, setPendingAttempt] = React.useState<OperationalStaffAttempt | null>(null);
  const loadedStaffIdsRef = React.useRef(new Set(staff.map((member) => member.id)));
  const linkageReady = linkage.status === 'ready';
  const checkingLinkage = canResolveLinkage && linkage.status === 'loading';

  React.useEffect(() => {
    const loadedIds = new Set(staff.map((member) => member.id));
    loadedStaffIdsRef.current = loadedIds;
    setOptimisticStaff((current) => {
      const pending = current.filter((member) => !loadedIds.has(member.id));
      return pending.length === current.length ? current : pending;
    });
  }, [staff]);

  const visibleStaff = React.useMemo(() => {
    const loadedIds = new Set(staff.map((member) => member.id));
    const completeRoster = [
      ...staff,
      ...optimisticStaff.filter((member) => !loadedIds.has(member.id)),
    ];
    const linkedIds = new Set(linkageReady ? linkage.staffIds : []);
    const roster = linkageReady
      ? completeRoster.filter((member) => !linkedIds.has(member.id))
      : completeRoster;
    return [...roster].sort((left, right) => left.name.localeCompare(right.name));
  }, [linkage, linkageReady, optimisticStaff, staff]);

  const title = linkageReady
    ? copy(lang, 'Staff without a linked login', 'Personal sin acceso vinculado')
    : copy(lang, 'Operational staff', 'Personal operativo');
  const description = linkageReady
    ? copy(
        lang,
        'Schedule-only staff for assignments and printed rosters. No login is required.',
        'Personal solo para horarios, asignaciones y listas impresas. No se requiere acceso.',
      )
    : checkingLinkage
      ? copy(
          lang,
          'Checking which schedule staff already have a hotel login.',
          'Comprobando qué personal de horarios ya tiene acceso al hotel.',
        )
      : linkage.status === 'error'
        ? copy(
            lang,
            'Login links could not be checked, so the complete schedule roster is shown.',
            'No se pudieron comprobar los accesos, por lo que se muestra el registro completo.',
          )
        : copy(
            lang,
            'Staff used for schedules and printed rosters; no login is required.',
            'Personal utilizado para horarios y listas impresas; no se requiere acceso.',
          );

  return (
    <section className={styles.section} aria-labelledby="operational-staff-title">
      <div className={styles.sectionHeader}>
        <div className={styles.headingCopy}>
          <span>{copy(lang, 'Operational roster', 'Registro operativo')}</span>
          <h2 id="operational-staff-title">{title}</h2>
          <p>{description}</p>
        </div>
        {canAddStaff ? (
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setDialogOpen(true)}
            aria-haspopup="dialog"
          >
            <UserPlus size={16} aria-hidden="true" />
            {copy(lang, 'Add', 'Agregar')}
          </button>
        ) : null}
      </div>

      {checkingLinkage ? (
        <div className={styles.stateRow} role="status">
          <LoaderCircle className={styles.buttonSpinner} size={17} aria-hidden="true" />
          <span>{copy(lang, 'Checking staff login links…', 'Comprobando accesos del personal…')}</span>
        </div>
      ) : (
        <>
          {rosterUnavailable ? (
            <div className={`${styles.stateRow} ${styles.errorRow}`} role="alert">
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{copy(
                lang,
                'The schedule roster is temporarily unavailable. It will reconnect automatically.',
                'El registro de horarios no está disponible temporalmente. Se volverá a conectar automáticamente.',
              )}</span>
            </div>
          ) : null}

          {visibleStaff.length > 0 ? (
            <div className={styles.staffList} role="list">
              {visibleStaff.map((member) => (
                <div key={member.id} className={styles.staffRow} role="listitem">
                  <span className={styles.avatar} aria-hidden="true">{initials(member.name)}</span>
                  <div className={styles.rowBody}>
                    <strong>{member.name}</strong>
                    <span>{departmentLabel(member.department, lang)}</span>
                  </div>
                  <span className={`${styles.statusBadge}${member.isActive === false ? ` ${styles.inactiveBadge}` : ''}`}>
                    {member.isActive === false
                      ? copy(lang, 'Inactive', 'Inactivo')
                      : linkageReady
                        ? copy(lang, 'No login', 'Sin acceso')
                        : copy(lang, 'Schedule staff', 'Personal de horario')}
                  </span>
                </div>
              ))}
            </div>
          ) : rosterUnavailable ? null : (
            <div className={styles.stateRow} role="status">
              {linkageReady ? <CheckCircle2 size={17} aria-hidden="true" /> : <Users size={17} aria-hidden="true" />}
              <span>{linkageReady
                ? copy(lang, 'Everyone on the roster already has a linked login.', 'Todos en el registro ya tienen un acceso vinculado.')
                : copy(lang, 'No operational staff have been added yet.', 'Aún no se ha agregado personal operativo.')}</span>
            </div>
          )}
        </>
      )}

      {dialogOpen ? (
        <AddOperationalStaffDialog
          hotelId={hotelId}
          lang={lang}
          onClose={() => setDialogOpen(false)}
          onAdded={(member) => setOptimisticStaff((current) => (
            loadedStaffIdsRef.current.has(member.id)
              ? current.filter((item) => item.id !== member.id)
              : current.some((item) => item.id === member.id) ? current : [...current, member]
          ))}
          onChanged={onChanged}
          pendingAttempt={pendingAttempt}
          onPendingAttemptChange={setPendingAttempt}
        />
      ) : null}
    </section>
  );
}
