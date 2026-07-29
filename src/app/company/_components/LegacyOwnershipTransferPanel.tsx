'use client';

import React from 'react';
import { AlertTriangle, Crown, ShieldCheck, X } from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import {
  clearOwnershipTransferAttempt,
  findOwnershipTransferAttempt,
  getOrCreateOwnershipTransferAttempt,
} from '@/lib/ownership-transfer-attempt';
import type { AppRole } from '@/lib/roles';

import styles from '../CompanyAccess.module.css';

interface LegacyOwnershipUser {
  accountId: string;
  username: string;
  displayName: string;
  role: AppRole;
  active: boolean;
  propertyAccess: string[];
  managementSurface: 'legacy_hotel' | 'company_access';
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
}

function responseError(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const error = body.error as Record<string, unknown>;
    if (typeof error.message === 'string') return error.message;
    if (typeof error.error === 'string') return error.error;
  }
  return fallback;
}

function sameHotelSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function LegacyOwnershipTransferPanel({
  enabled,
  propertyId,
  propertyName,
  currentAccountId,
  currentRole,
  lang,
}: {
  enabled: boolean;
  propertyId: string | null;
  propertyName: string | null;
  currentAccountId: string;
  currentRole: AppRole;
  lang: string;
}) {
  const [users, setUsers] = React.useState<LegacyOwnershipUser[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [targetId, setTargetId] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [completedTargetName, setCompletedTargetName] = React.useState('');
  const loadRequestRef = React.useRef(0);
  const activeViewerRef = React.useRef<string | null>(null);
  const transferAttemptRef = React.useRef<{
    key: string;
    operationId: string;
    reason: string | null;
  } | null>(null);
  const replayedOperationsRef = React.useRef(new Set<string>());
  activeViewerRef.current = enabled && propertyId
    ? `${currentAccountId}:${propertyId}`
    : null;

  React.useEffect(() => {
    loadRequestRef.current += 1;
    setUsers([]);
    setTargetId('');
    setDialogOpen(false);
    setBusy(false);
    setError('');
    setCompletedTargetName('');
    transferAttemptRef.current = null;
  }, [currentAccountId, propertyId]);

  const load = React.useCallback(async () => {
    const requestedPropertyId = propertyId;
    const requestedViewer = requestedPropertyId
      ? `${currentAccountId}:${requestedPropertyId}`
      : null;
    const requestId = ++loadRequestRef.current;
    if (!enabled || !requestedPropertyId || activeViewerRef.current !== requestedViewer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetchWithAuth(
        `/api/company-access/legacy-ownership-transfer?propertyId=${encodeURIComponent(requestedPropertyId)}`,
      );
      const body = await response.json().catch(() => ({})) as Envelope<{ users: LegacyOwnershipUser[] }>;
      if (requestId !== loadRequestRef.current
          || activeViewerRef.current !== requestedViewer) return;
      if (!response.ok || !body.ok || !Array.isArray(body.data?.users)) {
        setError(responseError(body, 'Legacy ownership details could not be loaded.'));
        return;
      }
      setUsers(body.data.users);
    } catch (caught) {
      if (requestId !== loadRequestRef.current
          || activeViewerRef.current !== requestedViewer) return;
      console.error('[company-access:legacy-ownership-transfer] load failed', caught);
      setError('Legacy ownership details could not be loaded. Check your connection.');
    } finally {
      if (requestId === loadRequestRef.current
          && activeViewerRef.current === requestedViewer) setLoading(false);
    }
  }, [currentAccountId, enabled, propertyId]);

  React.useEffect(() => { void load(); }, [load]);

  const transferOwnership = React.useCallback(async (
    accountId: string,
    reason: string,
  ) => {
    const requestedPropertyId = propertyId;
    const requestedViewer = requestedPropertyId
      ? `${currentAccountId}:${requestedPropertyId}`
      : null;
    if (!enabled || !requestedPropertyId
        || activeViewerRef.current !== requestedViewer) return;

    const attemptKey = `${requestedPropertyId}:${accountId}`;
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* optional */ }
    const attempt = transferAttemptRef.current?.key === attemptKey
      ? transferAttemptRef.current
      : getOrCreateOwnershipTransferAttempt(
          storage,
          requestedPropertyId,
          accountId,
          reason || null,
          () => crypto.randomUUID(),
        );
    const operationId = attempt.operationId;
    const persistedReason = attempt.reason;
    transferAttemptRef.current = { key: attemptKey, operationId, reason: persistedReason };

    setBusy(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/legacy-ownership-transfer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: requestedPropertyId,
          accountId,
          action: 'transfer_ownership',
          newOwnerAccountId: accountId,
          operationId,
          reason: persistedReason,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<unknown>;
      const definitive = (response.ok && body.ok === true)
        || (!response.ok && response.status >= 400 && response.status < 500);
      if (definitive) {
        clearOwnershipTransferAttempt(storage, requestedPropertyId, accountId, operationId);
        if (transferAttemptRef.current?.operationId === operationId) {
          transferAttemptRef.current = null;
        }
      }
      if (activeViewerRef.current !== requestedViewer) return;
      if (!response.ok || !body.ok) {
        setError(responseError(body, 'Ownership transfer failed.'));
        return;
      }
      const target = users.find((candidate) => candidate.accountId === accountId);
      setCompletedTargetName(target?.displayName ?? 'the new owner');
      setDialogOpen(false);
    } catch (caught) {
      if (activeViewerRef.current !== requestedViewer) return;
      console.error('[company-access:legacy-ownership-transfer] transfer failed', caught);
      setError('Ownership transfer failed. It is safe to retry with the same selection.');
    } finally {
      if (activeViewerRef.current === requestedViewer) setBusy(false);
    }
  }, [currentAccountId, enabled, propertyId, users]);

  React.useEffect(() => {
    if (!enabled || loading || !propertyId || users.length === 0) return;
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { return; }
    const pending = findOwnershipTransferAttempt(
      storage,
      propertyId,
      users.map((user) => user.accountId),
    );
    if (!pending || replayedOperationsRef.current.has(pending.operationId)) return;
    replayedOperationsRef.current.add(pending.operationId);
    // Response loss can leave the former owner signed in as GM. The guarded
    // RPC recognizes the durable operation receipt before checking current
    // owner state, so this background replay safely settles and clears it.
    void transferOwnership(pending.newOwnerAccountId, pending.reason ?? '');
  }, [enabled, loading, propertyId, transferOwnership, users]);

  const caller = users.find((user) => user.accountId === currentAccountId) ?? null;
  const isCurrentLegacyOwner = currentRole === 'owner'
    && caller?.active === true
    && caller.role === 'owner'
    && caller.managementSurface === 'legacy_hotel';
  const eligibleTargets = caller ? users
    .filter((user) => (
      user.accountId !== currentAccountId
      && user.active
      && user.role !== 'owner'
      && user.role !== 'admin'
      && user.managementSurface === 'legacy_hotel'
      && sameHotelSet(user.propertyAccess, caller.propertyAccess)
    ))
    .sort((left, right) => left.displayName.localeCompare(right.displayName)) : [];
  const selectedTarget = eligibleTargets.find((user) => user.accountId === targetId) ?? null;

  if (!enabled) return null;
  if (loading && currentRole !== 'owner') return null;
  if (!loading && !isCurrentLegacyOwner && !completedTargetName
      && !(error && currentRole === 'owner')) return null;

  return (
    <section className={`${styles.sectionBlock} ${styles.legacyOwnershipSection}`} aria-labelledby="legacy-ownership-title">
      <div className={styles.sectionHeading}>
        <span className={styles.eyebrow}>{'Legacy hotel authority'}</span>
        <h2 id="legacy-ownership-title">{'Transfer hotel ownership'}</h2>
        <p>{`This independent hotel still uses legacy owner authority. The handoff is atomic, audited, and applies to the exact hotel set shared by both accounts.`}</p>
      </div>

      <div className={styles.legacyOwnershipCard}>
        <span className={styles.legacyOwnershipIcon} aria-hidden="true"><Crown size={19} /></span>
        <div className={styles.legacyOwnershipBody}>
          <strong>{propertyName ?? 'Selected hotel'}</strong>
          <span>{'Choose an active legacy account with the same complete hotel access. Your role will become General Manager after confirmation.'}</span>
        </div>

        {loading ? (
          <span className={styles.legacyOwnershipLoading} role="status">
            <span className={styles.buttonSpinnerDark} aria-hidden="true" />
            {'Checking eligible accounts…'}
          </span>
        ) : completedTargetName ? (
          <span className={styles.legacyOwnershipSuccess} role="status">
            <ShieldCheck size={16} aria-hidden="true" />
            {`${completedTargetName} is now the owner.`}
          </span>
        ) : eligibleTargets.length > 0 ? (
          <div className={styles.legacyOwnershipControls}>
            <label className={styles.formField}>
              <span>{'New owner'}</span>
              <select
                value={targetId}
                onChange={(event) => { setTargetId(event.target.value); setError(''); }}
                disabled={busy}
              >
                <option value="">{'Choose an eligible account'}</option>
                {eligibleTargets.map((target) => (
                  <option key={target.accountId} value={target.accountId}>
                    {target.displayName} (@{target.username})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={!selectedTarget || busy}
              onClick={() => setDialogOpen(true)}
            >
              <Crown size={15} aria-hidden="true" />
              {'Review handoff'}
            </button>
          </div>
        ) : (
          <span className={styles.legacyOwnershipEmpty}>{'No eligible replacement has the same complete hotel access yet.'}</span>
        )}
      </div>

      {error ? <div className={styles.formError} role="alert">{error}</div> : null}
      {dialogOpen && selectedTarget ? (
        <LegacyOwnershipTransferDialog
          target={selectedTarget}
          propertyName={propertyName}
          lang={lang}
          busy={busy}
          onClose={() => { if (!busy) setDialogOpen(false); }}
          onConfirm={(reason) => transferOwnership(selectedTarget.accountId, reason)}
        />
      ) : null}
    </section>
  );
}

function LegacyOwnershipTransferDialog({
  target,
  propertyName,
  lang,
  busy,
  onClose,
  onConfirm,
}: {
  target: LegacyOwnershipUser;
  propertyName: string | null;
  lang: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  const titleId = React.useId();
  const descriptionId = React.useId();
  const expected = 'transfer';
  const confirmed = confirmation.trim().toLowerCase() === expected;

  React.useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogScrim}
        aria-label={'Close ownership transfer'}
        onClick={onClose}
        disabled={busy}
      />
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${styles.workflowDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <span className={`${styles.dialogIcon} ${styles.iconRust}`}><Crown size={20} aria-hidden="true" /></span>
          <div>
            <span>{'Permanent authority handoff'}</span>
            <h2 id={titleId}>{'Transfer hotel ownership'}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            disabled={busy}
            aria-label={'Close'}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className={styles.dialogIntro}>{`${target.displayName} will become owner${propertyName ? ` for ${propertyName}` : ''}. Your role will become General Manager. Only the new owner can transfer ownership again.`}</p>
        <div className={styles.formNotice} role="note">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{'The server rechecks both accounts, exact hotel access, pending account changes, and your current owner authority before committing one atomic audit record.'}</span>
        </div>
        <div className={styles.workflowForm}>
          <label className={styles.formField}>
            <span>{'Reason (optional)'}</span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder={'For example: handoff after sale'}
            />
          </label>
          <label className={styles.formField}>
            <span>{`Type “${expected}” to confirm`}</span>
            <input
              type="text"
              value={confirmation}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </div>
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{'Atomic · audited · retry-safe'}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>
              {'Cancel'}
            </button>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={!confirmed || busy}
              onClick={() => onConfirm(reason)}
            >
              {busy ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <Crown size={15} aria-hidden="true" />}
              {busy ? 'Transferring…' : 'Transfer ownership'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
