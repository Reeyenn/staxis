'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Hotel,
  Layers3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  CompanyStructureOrganization,
  CompanyStructureProjection,
  PortfolioAssignmentPreview,
} from '@/lib/company-access/structure';

import styles from './CompanyStructureManager.module.css';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

function portfolioTypeLabel(type: string, lang: string): string {
  const labels: Record<string, string> = {
    portfolio: 'Portfolio',
    region: 'Region',
    division: 'Division',
    other: 'Group',
  };
  return labels[type] ?? labels.other;
}

function responseError(body: Envelope<unknown>, fallback: string): string {
  return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
}

function useDialogBehavior(onClose: () => void, busy: boolean) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  React.useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
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
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
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

interface SelectedHotel {
  organization: CompanyStructureOrganization;
  propertyId: string;
}

export function CompanyStructureOverview({ structure, lang, loading, unavailable, legacyFallback }: {
  structure: CompanyStructureProjection | null;
  lang: string;
  loading: boolean;
  unavailable: boolean;
  legacyFallback: boolean;
}) {
  const organizations = structure?.organizations ?? [];
  const hotels = organizations.reduce((total, organization) => total + organization.hotels.length, 0);
  const portfolios = organizations.reduce((total, organization) => total + organization.portfolios.length, 0);
  const problems = organizations.flatMap((organization) => (
    organization.problems.map((problem) => ({ organization, problem }))
  ));
  const attentionProblems = problems.filter(({ problem }) => (
    problem.severity === 'warning' || problem.severity === 'critical'
  ));

  const problemCopy = ({ organization, problem }: (typeof problems)[number]) => {
    if (problem.code === 'hotel_without_portfolio') {
      const hotelName = organization.hotels.find((hotel) => hotel.propertyId === problem.propertyId)?.name
        ?? 'Hotel';
      return {
        title: `${hotelName} is not assigned to a portfolio or region`,
        detail: 'Company-wide access remains active, but portfolio-scoped people will not inherit this hotel until it is assigned.',
      };
    }
    if (problem.code === 'empty_portfolio') {
      const portfolioName = organization.portfolios.find((portfolio) => portfolio.id === problem.portfolioId)?.name
        ?? 'Portfolio or region';
      return {
        title: `${portfolioName} has no hotels`,
        detail: 'This active portfolio or region currently grants no hotel reach.',
      };
    }
    return {
      title: 'Company hotel relationships are protected',
      detail: 'Only a verified Staxis platform administrator can add, remove, or move a hotel between companies.',
    };
  };

  return (
    <section className={styles.overview} aria-labelledby="company-structure-overview-title">
      <div className={styles.heading}>
        <div>
          <span>{'Structure and access health'}</span>
          <h2 id="company-structure-overview-title">
            {'Company → portfolio/region → hotel'}
          </h2>
          <p>{'This is the live structure used to calculate inherited hotel access. Warnings identify assignments or access boundaries that need attention.'}</p>
        </div>
        <span className={styles.liveBadge}><ShieldCheck size={14} aria-hidden="true" />{'Current access'}</span>
      </div>

      {loading ? (
        <div className={styles.overviewLoading} role="status" aria-live="polite">
          <RefreshCw className={styles.spin} size={17} aria-hidden="true" />
          <span>{'Verifying current structure and access…'}</span>
        </div>
      ) : unavailable || legacyFallback ? (
        <div className={styles.overviewWarning} role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{legacyFallback
              ? 'Normalized company structure is not active'
              : 'Live structure health is unavailable'}</strong>
            <span>{legacyFallback
              ? 'Hotel access is being shown from the legacy account projection. Portfolio assignments cannot be safely changed here until access is migrated.'
              : 'Existing access remains visible below, but Staxis cannot verify structure problems or accept changes right now.'}</span>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.overviewStats}>
            <div><span>{'Companies'}</span><strong>{organizations.length}</strong></div>
            <div><span>{'Portfolios / regions'}</span><strong>{portfolios}</strong></div>
            <div><span>{'Governed hotels'}</span><strong>{hotels}</strong></div>
            <div className={attentionProblems.length > 0 ? styles.statAttention : undefined}>
              <span>{'Needs attention'}</span>
              <strong>{attentionProblems.length}</strong>
            </div>
          </div>

          {problems.length > 0 ? (
            <div className={styles.problemList} role="list" aria-label={'Structure and access notices'}>
              {problems.map((entry, index) => {
                const display = problemCopy(entry);
                const { problem } = entry;
                return (
                  <div
                    key={`${problem.code}:${problem.propertyId ?? problem.portfolioId ?? index}`}
                    className={problem.severity === 'warning' || problem.severity === 'critical'
                      ? styles.problemWarning
                      : styles.problemInfo}
                    role="listitem"
                  >
                    {problem.severity === 'warning' || problem.severity === 'critical'
                      ? <AlertTriangle size={17} aria-hidden="true" />
                      : <LockKeyhole size={17} aria-hidden="true" />}
                    <div><strong>{display.title}</strong><span>{display.detail}</span></div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.overviewClear}>
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>{'No structure or inherited-access problems were detected in your current scope.'}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AssignmentDialog({ selection, lang, onClose, onCompleted, onStale }: {
  selection: SelectedHotel;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
  onStale: () => void;
}) {
  const hotel = selection.organization.hotels.find(
    (candidate) => candidate.propertyId === selection.propertyId,
  );
  const manageablePortfolios = selection.organization.portfolios.filter(
    (portfolio) => portfolio.manageable,
  );
  const manageableIds = React.useMemo(
    () => new Set(manageablePortfolios.map((portfolio) => portfolio.id)),
    [manageablePortfolios],
  );
  const [desiredIds, setDesiredIds] = React.useState<string[]>(() => (
    hotel?.portfolioIds.filter((id) => manageableIds.has(id)).sort() ?? []
  ));
  const [preview, setPreview] = React.useState<PortfolioAssignmentPreview | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const idempotencyKeyRef = React.useRef<string | null>(null);
  const { dialogRef, closeRef } = useDialogBehavior(onClose, busy);
  const titleId = React.useId();
  const descriptionId = React.useId();

  if (!hotel) return null;

  const togglePortfolio = (portfolioId: string) => {
    setDesiredIds((current) => (
      current.includes(portfolioId)
        ? current.filter((id) => id !== portfolioId)
        : [...current, portfolioId].sort()
    ));
    setPreview(null);
    setConfirmed(false);
    setError(null);
    setStale(false);
    idempotencyKeyRef.current = null;
  };

  const requestPreview = async () => {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      const response = await fetchWithAuth('/api/company-access/structure/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: selection.organization.id,
          propertyId: hotel.propertyId,
          desiredPortfolioIds: desiredIds,
          expectedAccessEpoch: selection.organization.accessEpoch,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<PortfolioAssignmentPreview>;
      if (!response.ok || !body.ok || !body.data) {
        if (response.status === 403 || response.status === 409) setStale(true);
        throw new Error(responseError(body, 'The impact preview could not be loaded.'));
      }
      setPreview(body.data);
      idempotencyKeyRef.current = crypto.randomUUID();
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : 'The impact preview could not be loaded.');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || !confirmed) return;
    const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    setBusy(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/company-access/structure/commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          organizationId: preview.organizationId,
          propertyId: preview.propertyId,
          desiredPortfolioIds: preview.desiredPortfolioIds,
          expectedAccessEpoch: preview.expectedAccessEpoch,
          previewFingerprint: preview.previewFingerprint,
          confirmed: true,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<unknown>;
      if (!response.ok || !body.ok) {
        if (response.status === 403 || response.status === 409) setStale(true);
        throw new Error(responseError(body, 'The hotel assignment could not be saved.'));
      }
      onCompleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The hotel assignment could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.scrim}
        aria-label={'Close dialog'}
        onClick={() => { if (!busy) onClose(); }}
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
        <header className={styles.dialogHeader}>
          <span className={styles.dialogIcon}><Layers3 size={20} aria-hidden="true" /></span>
          <div>
            <span>{'Hotel structure'}</span>
            <h2 id={titleId}>{hotel.name}</h2>
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
        </header>

        <p id={descriptionId} className={styles.dialogIntro}>
          {`Choose the portfolio and region assignments inside ${selection.organization.name}. This cannot move the hotel to another company.`}
        </p>

        <div className={styles.relationshipLock}>
          <LockKeyhole size={17} aria-hidden="true" />
          <div>
            <strong>{'Company relationship is protected'}</strong>
            <span>
              {`${hotel.relationshipType === 'owner' ? 'Owner' : 'Operator'} · active. Only a verified Staxis platform administrator can change or transfer it.`}
            </span>
          </div>
        </div>

        {manageablePortfolios.length > 0 ? (
          <fieldset className={styles.assignmentChoices} disabled={busy || Boolean(preview)}>
            <legend>{'Portfolio and region assignments'}</legend>
            {manageablePortfolios.map((portfolio) => (
              <label key={portfolio.id}>
                <input
                  type="checkbox"
                  checked={desiredIds.includes(portfolio.id)}
                  onChange={() => togglePortfolio(portfolio.id)}
                />
                <span>
                  <strong>{portfolio.name}</strong>
                  <small>{portfolioTypeLabel(portfolio.type, lang)}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className={styles.notice}>
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{'There are no active portfolios or regions you are authorized to manage. Ask Staxis support to review the structure.'}</span>
          </div>
        )}

        {preview ? (
          <section className={styles.impact} aria-live="polite">
            <div className={styles.impactHeading}>
              <ShieldCheck size={18} aria-hidden="true" />
              <div>
                <strong>{'Access impact preview'}</strong>
                <span>{'This exact preview is bound to the current company access version.'}</span>
              </div>
            </div>
            <dl>
              <div><dt>{'Assignments added'}</dt><dd>{preview.addedPortfolioIds.length}</dd></div>
              <div><dt>{'Assignments removed'}</dt><dd>{preview.removedPortfolioIds.length}</dd></div>
              <div><dt>{'People gaining hotel reach'}</dt><dd>{preview.gainingAccessCount}</dd></div>
              <div><dt>{'People losing hotel reach'}</dt><dd>{preview.losingAccessCount}</dd></div>
            </dl>
            <div className={styles.immediateWarning}>
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{'Saving takes effect immediately. Open sessions cannot use their prior hotel reach, and portfolio AI scope receipts are invalidated; affected people must re-resolve access.'}</span>
            </div>
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={busy}
              />
              <span>{`I confirm these exact assignments for ${hotel.name} and understand the immediate access impact.`}</span>
            </label>
          </section>
        ) : null}

        {error ? <div className={styles.error} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div> : null}

        <footer className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>
            {'Cancel'}
          </button>
          {stale ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onStale}
              disabled={busy}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {'Reload current access'}
            </button>
          ) : preview ? (
            <>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                  setError(null);
                  setStale(false);
                  idempotencyKeyRef.current = null;
                }}
                disabled={busy}
              >
                {'Edit assignments'}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={commit}
                disabled={busy || !confirmed}
              >
                {busy ? <RefreshCw className={styles.spin} size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                {'Confirm and save'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={requestPreview}
              disabled={busy || manageablePortfolios.length === 0}
            >
              {busy ? <RefreshCw className={styles.spin} size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
              {'Preview access impact'}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function CompanyStructureManager({ structure, lang, onChanged }: {
  structure: CompanyStructureProjection;
  lang: string;
  onChanged: () => void;
}) {
  const [selection, setSelection] = React.useState<SelectedHotel | null>(null);

  return (
    <section className={styles.root} aria-labelledby="company-structure-management-title">
      <div className={styles.heading}>
        <h2 id="company-structure-management-title">{'Company structure'}</h2>
      </div>

      <div className={styles.organizationList}>
        {structure.organizations.map((organization) => (
          <article key={organization.id} className={styles.organizationCard}>
            <header>
              <span className={styles.organizationIcon}><Building2 size={18} aria-hidden="true" /></span>
              <div>
                <strong>{organization.name}</strong>
                <span>{organization.hotels.length} {organization.hotels.length === 1 ? 'hotel' : 'hotels'} · {organization.portfolios.length} {'portfolios/regions'}</span>
              </div>
              <span className={organization.canManagePortfolios ? styles.canManage : styles.readOnly}>
                {organization.canManagePortfolios
                  ? 'Can manage'
                  : 'Read only'}
              </span>
            </header>

            <div className={styles.hotelRows}>
              {organization.hotels.map((hotel) => {
                const assigned = organization.portfolios.filter((portfolio) => (
                  hotel.portfolioIds.includes(portfolio.id)
                ));
                return (
                  <div key={hotel.propertyId} className={styles.hotelRow}>
                    <span className={styles.hotelIcon}><Hotel size={16} aria-hidden="true" /></span>
                    <div className={styles.hotelCopy}>
                      <strong>{hotel.name}</strong>
                      <span>
                        {hotel.relationshipType === 'owner'
                          ? 'Owner relationship'
                          : 'Operator relationship'}
                        {' · '}
                        {assigned.length > 0
                          ? assigned.map((portfolio) => portfolio.name).join(', ')
                          : 'No portfolio or region'}
                      </span>
                    </div>
                    {hotel.manageable && organization.portfolios.some((portfolio) => portfolio.manageable) ? (
                      <button
                        type="button"
                        className={styles.editButton}
                        onClick={() => setSelection({ organization, propertyId: hotel.propertyId })}
                      >
                        <Layers3 size={14} aria-hidden="true" />
                        {'Edit assignment'}
                      </button>
                    ) : (
                      <span className={styles.lockedRelationship} title={'You do not have manage_portfolios for this scope.'}><LockKeyhole size={14} aria-hidden="true" />{'Protected'}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>

      {selection ? (
        <AssignmentDialog
          selection={selection}
          lang={lang}
          onClose={() => setSelection(null)}
          onCompleted={() => {
            setSelection(null);
            onChanged();
          }}
          onStale={() => {
            setSelection(null);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
