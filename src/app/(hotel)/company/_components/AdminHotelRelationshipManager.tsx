'use client';

import React from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Building2,
  CheckCircle2,
  Hotel,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  AdminHotelRelationshipOrganization,
  AdminHotelRelationshipPreview,
  AdminHotelRelationshipProjection,
  AdminHotelRelationshipType,
} from '@/lib/company-access/admin-hotel-relationship';

import styles from '../CompanyAccess.module.css';

interface Envelope<T> { ok?: boolean; data?: T; error?: unknown }

function responseError(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const value = body.error as Record<string, unknown>;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
  }
  return fallback;
}

function useDialogBehavior(onClose: () => void, busy: boolean) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  React.useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, []);

  return { dialogRef, closeRef };
}

function actionLabel(
  projection: AdminHotelRelationshipProjection,
  targetOrganizationId: string | null,
  relationshipType: AdminHotelRelationshipType | null,
  lang: string,
): string {
  const current = projection.currentRelationship;
  if (!current && targetOrganizationId) return 'Acquire and link hotel';
  if (current && !targetOrganizationId) return 'Deactivate company relationship';
  if (current && targetOrganizationId !== current.organizationId) return 'Transfer hotel';
  if (current && relationshipType !== current.relationshipType) return 'Change relationship type';
  return 'No relationship change';
}

function RelationshipDialog({
  projection,
  lang,
  onSearch,
  onClose,
  onCompleted,
}: {
  projection: AdminHotelRelationshipProjection;
  lang: string;
  onSearch: (query: string) => Promise<AdminHotelRelationshipProjection>;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const initialCurrent = projection.currentRelationship;
  const [workingProjection, setWorkingProjection] = React.useState(projection);
  const [targetOrganizationId, setTargetOrganizationId] = React.useState<string | null>(
    initialCurrent?.organizationId ?? null,
  );
  const [selectedOrganization, setSelectedOrganization] = React.useState<AdminHotelRelationshipOrganization | null>(
    initialCurrent ? {
      id: initialCurrent.organizationId,
      name: initialCurrent.organizationName,
      type: initialCurrent.organizationType,
      status: 'active',
    } : null,
  );
  const [relationshipType, setRelationshipType] = React.useState<AdminHotelRelationshipType>(
    initialCurrent?.relationshipType ?? 'operator',
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [preview, setPreview] = React.useState<AdminHotelRelationshipPreview | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const { dialogRef, closeRef } = useDialogBehavior(onClose, busy);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const current = workingProjection.currentRelationship;

  const organizations = React.useMemo(() => {
    const candidates = selectedOrganization
      ? [selectedOrganization, ...workingProjection.organizations]
      : workingProjection.organizations;
    return [...new Map(candidates.map((organization) => [organization.id, organization])).values()];
  }, [selectedOrganization, workingProjection.organizations]);

  const invalidate = () => {
    setPreview(null);
    setIdempotencyKey(null);
    setError('');
  };

  const searchCompanies = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await onSearch(searchQuery);
      if (next.relationshipRevision !== workingProjection.relationshipRevision) {
        const nextCurrent = next.currentRelationship;
        setTargetOrganizationId(nextCurrent?.organizationId ?? null);
        setRelationshipType(nextCurrent?.relationshipType ?? 'operator');
        setSelectedOrganization(nextCurrent ? {
          id: nextCurrent.organizationId,
          name: nextCurrent.organizationName,
          type: nextCurrent.organizationType,
          status: 'active',
        } : null);
      }
      setWorkingProjection(next);
      invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Company search could not be loaded.');
    } finally {
      setBusy(false);
    }
  };

  const requestBody = () => ({
    propertyId: workingProjection.property.id,
    targetOrganizationId,
    relationshipType: targetOrganizationId ? relationshipType : null,
    expectedRelationshipRevision: workingProjection.relationshipRevision,
  });

  const loadPreview = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/admin/company-relationship/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody()),
      });
      const body = await response.json().catch(() => ({})) as Envelope<AdminHotelRelationshipPreview>;
      if (!response.ok || !body.ok || !body.data) throw new Error(responseError(body, 'Relationship impact could not be previewed.'));
      setPreview(body.data);
      setIdempotencyKey(crypto.randomUUID());
    } catch (caught) {
      setPreview(null);
      setIdempotencyKey(null);
      setError(caught instanceof Error ? caught.message : 'Preview failed.');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || !idempotencyKey || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/admin/company-relationship/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          ...requestBody(),
          previewFingerprint: preview.previewFingerprint,
          confirmed: true,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<unknown>;
      if (!response.ok || !body.ok) throw new Error(responseError(body, 'Relationship change could not be saved.'));
      onCompleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const label = actionLabel(
    workingProjection,
    targetOrganizationId,
    targetOrganizationId ? relationshipType : null,
    lang,
  );

  return (
    <div className={styles.dialogLayer}>
      <button className={styles.dialogScrim} type="button" aria-label={'Close dialog'} onClick={() => { if (!busy) onClose(); }} />
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${styles.workflowDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className={styles.dialogHeader}>
          <span className={`${styles.dialogIcon} ${styles.iconRust}`}><ArrowRightLeft size={19} aria-hidden="true" /></span>
          <div>
            <h2 id={titleId}>{'Manage hotel company relationship'}</h2>
          </div>
          <button ref={closeRef} className={styles.iconButton} type="button" disabled={busy} onClick={onClose} aria-label={'Close'}><X size={18} /></button>
        </header>

        <p className={styles.dialogIntro} id={descriptionId}>
          {'Choose the hotel’s one primary company relationship. A transfer, deactivation, or type change takes effect immediately and is permanently audited.'}
        </p>

        <dl className={styles.dialogFacts}>
          <div><dt>{'Hotel'}</dt><dd>{workingProjection.property.name}</dd></div>
          <div><dt>{'Current status'}</dt><dd>{current ? current.organizationName : 'Independent'}</dd></div>
        </dl>

        <div className={styles.workflowForm}>
          <form className={styles.adminCompanySearch} onSubmit={searchCompanies}>
            <label className={styles.formField}>
              <span>{'Find a company'}</span>
              <span className={styles.inputWithIcon}>
                <Search size={15} aria-hidden="true" />
                <input value={searchQuery} maxLength={120} onChange={(event) => setSearchQuery(event.target.value)} placeholder={'Search active management companies'} />
              </span>
            </label>
            <button className={styles.secondaryButton} type="submit" disabled={busy}>
              {busy ? <RefreshCw className={styles.buttonSpinnerDark} size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
              {'Search'}
            </button>
          </form>
          {workingProjection.organizationResultsTruncated ? (
            <p className={styles.adminDirectoryNotice}>{`Showing the first ${workingProjection.organizationResultLimit} matches. Narrow the search to find another company.`}</p>
          ) : null}

          <div className={styles.formGrid}>
            <label className={styles.formField}>
              <span>{'Relationship status / company'}</span>
              <select
                value={targetOrganizationId ?? 'independent'}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value === 'independent' ? null : event.target.value;
                  setTargetOrganizationId(id);
                  setSelectedOrganization(id ? organizations.find((organization) => organization.id === id) ?? null : null);
                  invalidate();
                }}
              >
                <option value="independent">{'Independent, no active company relationship'}</option>
                {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
              </select>
              <em>{'Only active management or ownership companies are eligible.'}</em>
            </label>
            <label className={styles.formField}>
              <span>{'Relationship type'}</span>
              <select value={relationshipType} disabled={busy || !targetOrganizationId} onChange={(event) => { setRelationshipType(event.target.value as AdminHotelRelationshipType); invalidate(); }}>
                <option value="operator">{'Operator'}</option>
                <option value="owner">{'Owner'}</option>
              </select>
              <em>{targetOrganizationId
                ? 'Defines the company’s governing relationship.'
                : 'Not applicable while the hotel is independent.'}</em>
            </label>
          </div>

          {error ? <div className={styles.formError} role="alert">{error}</div> : null}

          {preview ? (
            <section className={`${styles.mutationPreview} ${preview.changed ? styles.lifecyclePreview : ''}`} aria-live="polite">
              <div className={styles.previewHeading}>
                {preview.changed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
                <div><strong>{label}</strong><span>{preview.changed
                  ? 'Exact impact calculated from current authorization state'
                  : 'The requested relationship already matches'}</span></div>
              </div>
              <dl>
                <div><dt>{'Property grants revoked'}</dt><dd>{preview.impact.revokedPropertyGrantCount}</dd></div>
                <div><dt>{'Invites revoked'}</dt><dd>{preview.impact.revokedInvitationCount}</dd></div>
                <div><dt>{'Requests cancelled'}</dt><dd>{preview.impact.cancelledRequestCount}</dd></div>
                <div><dt>{'Portfolio links removed'}</dt><dd>{preview.impact.removedPortfolioAssignmentCount}</dd></div>
                <div><dt>{'After confirmation'}</dt><dd>{preview.targetOrganization?.name ?? 'Independent'}</dd></div>
                <div><dt>{'Effective'}</dt><dd>{'Immediately'}</dd></div>
              </dl>
            </section>
          ) : (
            <div className={styles.reasonBox}>
              <strong>{'Preview required'}</strong>
              <span>{'No relationship change is sent until Staxis recalculates the exact current impact and you confirm it.'}</span>
            </div>
          )}
        </div>

        <footer className={styles.dialogFooter}>
          <span><LockKeyhole size={13} aria-hidden="true" />{'Admin rechecked at commit · audited'}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>{'Cancel'}</button>
            {!preview ? (
              <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void loadPreview()}>
                {busy ? <RefreshCw className={styles.buttonSpinner} size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                {'Preview exact impact'}
              </button>
            ) : (
              <button type="button" className={preview.changed ? styles.dangerButton : styles.primaryButton} disabled={busy} onClick={() => void commit()}>
                {busy ? <RefreshCw className={styles.buttonSpinner} size={14} aria-hidden="true" /> : <ArrowRightLeft size={14} aria-hidden="true" />}
                {preview.changed ? 'Confirm and apply' : 'Confirm no change'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export function AdminHotelRelationshipManager({
  propertyId,
  propertyName,
  lang,
  onChanged,
}: {
  propertyId: string;
  propertyName: string;
  lang: string;
  onChanged: () => void;
}) {
  const [projection, setProjection] = React.useState<AdminHotelRelationshipProjection | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const load = React.useCallback(async (organizationQuery = '') => {
    const params = new URLSearchParams({ pid: propertyId });
    if (organizationQuery.trim()) params.set('q', organizationQuery.trim());
    const response = await fetchWithAuth(`/api/admin/company-relationship?${params.toString()}`);
    const body = await response.json().catch(() => ({})) as Envelope<AdminHotelRelationshipProjection>;
    if (!response.ok || !body.ok || !body.data || body.data.property.id !== propertyId) {
      throw new Error(responseError(body, 'Current company relationship could not be verified.'));
    }
    setProjection(body.data);
    return body.data;
  }, [propertyId]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setProjection(null);
    setDialogOpen(false);
    void load().catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'Relationship load failed.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lang, load, propertyId]);

  const completed = () => {
    setDialogOpen(false);
    setLoading(true);
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Relationship reload failed.')).finally(() => setLoading(false));
    onChanged();
  };

  return (
    <section className={styles.adminRelationshipCard} aria-labelledby="admin-hotel-relationship-title" data-admin-hotel-relationship-manager>
      <div className={styles.adminRelationshipIcon}><Building2 size={20} aria-hidden="true" /></div>
      <div className={styles.adminRelationshipBody}>
        <h3 id="admin-hotel-relationship-title">{'Company relationship and status'}</h3>
        {loading ? (
          <p><RefreshCw className={styles.spin} size={14} aria-hidden="true" /> {'Verifying the current primary relationship…'}</p>
        ) : error ? (
          <p className={styles.adminRelationshipError}><AlertTriangle size={14} aria-hidden="true" /> {error}</p>
        ) : projection ? (
          <p>
            <Hotel size={14} aria-hidden="true" />
            <strong>{projection.property.name || propertyName}</strong>
            <ArrowRightLeft size={13} aria-hidden="true" />
            <strong>{projection.currentRelationship?.organizationName ?? 'Independent'}</strong>
            <span className={`${styles.status} ${projection.currentRelationship ? styles.statusActive : styles.statusMuted}`}>
              {projection.currentRelationship
                ? `${projection.currentRelationship.relationshipType} · active`
                : 'Independent'}
            </span>
          </p>
        ) : null}
        <small>{'Every lifecycle change starts with a fresh impact preview and explicit confirmation.'}</small>
      </div>
      <div className={styles.adminRelationshipActions}>
        {error ? (
          <button className={styles.secondaryButton} type="button" disabled={loading} onClick={() => { setLoading(true); setError(''); void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Load failed')).finally(() => setLoading(false)); }}>
            <RefreshCw size={14} aria-hidden="true" />{'Retry'}
          </button>
        ) : (
          <button className={styles.primaryButton} type="button" disabled={loading || !projection} onClick={() => setDialogOpen(true)}>
            <ArrowRightLeft size={14} aria-hidden="true" />{'Manage relationship'}
          </button>
        )}
      </div>
      {dialogOpen && projection ? (
        <RelationshipDialog
          projection={projection}
          lang={lang}
          onSearch={load}
          onClose={() => setDialogOpen(false)}
          onCompleted={completed}
        />
      ) : null}
    </section>
  );
}
