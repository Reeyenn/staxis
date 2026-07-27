'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The one "Add" in My Hotel → People.
//
// Adds a person to the SCHEDULE. It creates a `staff` row and nothing else —
// no Staxis login, no invitation, no email. The dialog says so in its own
// words, because "Add" next to a list of logins reads like "make an account"
// and it is not.
//
// Moved out of OperationalStaffSection on 2026-07-27 when the two People lists
// were merged into one. Behavior is unchanged, including the part that matters
// most: the write goes through POST /api/staff/operational under an
// Idempotency-Key, so a timeout followed by a retry cannot create the same
// person twice. A definitive validation failure gets a fresh key; a timeout or
// an "in progress" answer keeps the old one.
//
// The dialog opens pre-scoped to the department whose Add button was pressed,
// the way the old Directory's per-column "+ Add to Housekeeping" did.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, UserPlus, X } from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type { StaffDepartment, StaffMember } from '@/types';

import type { HotelTeamLang } from './HotelTeamPanel';
import styles from './HotelTeamPanel.module.css';

interface CreateStaffPayload {
  hotelId: string;
  name: string;
  department: StaffDepartment;
  phone: string;
  language: 'en' | 'es';
}

export interface AddStaffAttempt {
  key: string;
  payload: CreateStaffPayload;
}

interface CreateStaffResponse {
  ok?: boolean;
  data?: { staffId?: string };
  error?: string;
  code?: string;
}

interface AddStaffDialogProps {
  hotelId: string;
  hotelName: string;
  lang: HotelTeamLang;
  initialDepartment: StaffDepartment;
  onClose: () => void;
  onAdded: (member: StaffMember) => void;
  onChanged: () => void | Promise<void>;
  pendingAttempt: AddStaffAttempt | null;
  onPendingAttemptChange: (attempt: AddStaffAttempt | null) => void;
}

function copy(lang: HotelTeamLang, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

function freshIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `staff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function AddStaffDialog({
  hotelId,
  hotelName,
  lang,
  initialDepartment,
  onClose,
  onAdded,
  onChanged,
  pendingAttempt,
  onPendingAttemptChange,
}: AddStaffDialogProps) {
  const [name, setName] = React.useState(pendingAttempt?.payload.name ?? '');
  const [department, setDepartment] = React.useState<StaffDepartment>(
    pendingAttempt?.payload.department ?? initialDepartment,
  );
  const [phone, setPhone] = React.useState(pendingAttempt?.payload.phone ?? '');
  const [language, setLanguage] = React.useState<'en' | 'es'>(
    pendingAttempt?.payload.language ?? 'en',
  );
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
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(copy(lang, 'Enter the person’s name.', 'Ingresa el nombre de la persona.'));
      nameRef.current?.focus();
      return;
    }

    // The ref closes the same-tick gap before React commits the disabled
    // state, so a rapid second submit cannot start another request.
    busyRef.current = true;
    setBusy(true);
    setError('');
    let definitiveFailure = false;
    const attempt = pendingAttempt ?? {
      key: freshIdempotencyKey(),
      payload: {
        hotelId,
        name: trimmedName,
        department,
        phone: phone.trim(),
        language,
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
      const body = await response.json().catch(() => ({})) as CreateStaffResponse;
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
        // DEPRECATED (2026-07-24): staff.scheduled_today is a non-date-aware
        // boolean that nothing ever writes. Housekeeping derives who is
        // working from scheduled_shifts (src/lib/schedule/active-crew.ts).
        // Kept only to satisfy the NOT NULL column default.
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
                'This person could not be added. Check your connection and try again.',
                'No se pudo agregar a esta persona. Revisa tu conexión e inténtalo de nuevo.',
              ));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <div className={styles.dialogLayer}>
      <div className={styles.dialogScrim} aria-hidden="true" onMouseDown={requestClose} />
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
          <span className={styles.dialogIcon}><UserPlus size={19} aria-hidden="true" /></span>
          <div>
            <span>{hotelName}</span>
            <h2 id={titleId}>{copy(lang, 'Add someone to the schedule', 'Agregar a alguien al horario')}</h2>
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
              value={name}
              onChange={(event) => setName(event.target.value)}
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
                value={department}
                onChange={(event) => setDepartment(event.target.value as StaffDepartment)}
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
                value={language}
                onChange={(event) => setLanguage(event.target.value as 'en' | 'es')}
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
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
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
            <button type="submit" className={styles.primaryButton} disabled={busy || !name.trim()}>
              {busy
                ? <><span className={styles.buttonSpinner} aria-hidden="true" />{copy(lang, 'Adding…', 'Agregando…')}</>
                : retryLocked
                  ? copy(lang, 'Retry add', 'Reintentar')
                  : copy(lang, 'Add to schedule', 'Agregar al horario')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
