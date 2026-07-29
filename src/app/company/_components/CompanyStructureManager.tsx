'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Hotel,
  KeyRound,
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

function copy(lang: string, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

function portfolioTypeLabel(type: string, lang: string): string {
  const labels: Record<string, [string, string]> = {
    portfolio: ['Portfolio', 'Cartera'],
    region: ['Region', 'Región'],
    division: ['Division', 'División'],
    other: ['Group', 'Grupo'],
  };
  const label = labels[type] ?? labels.other;
  return copy(lang, label[0], label[1]);
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
        ?? copy(lang, 'Hotel', 'Hotel');
      return {
        title: copy(lang, `${hotelName} is not assigned to a portfolio or region`, `${hotelName} no está asignado a una cartera o región`),
        detail: copy(
          lang,
          'Company-wide access remains active, but portfolio-scoped people will not inherit this hotel until it is assigned.',
          'El acceso para toda la empresa permanece activo, pero las personas con alcance de cartera no heredarán este hotel hasta que se asigne.',
        ),
      };
    }
    if (problem.code === 'empty_portfolio') {
      const portfolioName = organization.portfolios.find((portfolio) => portfolio.id === problem.portfolioId)?.name
        ?? copy(lang, 'Portfolio or region', 'Cartera o región');
      return {
        title: copy(lang, `${portfolioName} has no hotels`, `${portfolioName} no tiene hoteles`),
        detail: copy(
          lang,
          'This active portfolio or region currently grants no hotel reach.',
          'Esta cartera o región activa actualmente no concede acceso a ningún hotel.',
        ),
      };
    }
    return {
      title: copy(lang, 'Company hotel relationships are protected', 'Las relaciones empresariales de los hoteles están protegidas'),
      detail: copy(
        lang,
        'Only a verified Staxis platform administrator can add, remove, or move a hotel between companies.',
        'Solo un administrador de plataforma Staxis verificado puede agregar, eliminar o mover un hotel entre empresas.',
      ),
    };
  };

  return (
    <section className={styles.overview} aria-labelledby="company-structure-overview-title">
      <div className={styles.heading}>
        <div>
          <span>{copy(lang, 'Structure and access health', 'Estado de estructura y acceso')}</span>
          <h2 id="company-structure-overview-title">
            {copy(lang, 'Company → portfolio/region → hotel', 'Empresa → cartera/región → hotel')}
          </h2>
          <p>{copy(
            lang,
            'This is the live structure used to calculate inherited hotel access. Warnings identify assignments or access boundaries that need attention.',
            'Esta es la estructura en vivo utilizada para calcular el acceso heredado a hoteles. Las advertencias identifican asignaciones o límites de acceso que requieren atención.',
          )}</p>
        </div>
        <span className={styles.liveBadge}><ShieldCheck size={14} aria-hidden="true" />{copy(lang, 'Current access', 'Acceso actual')}</span>
      </div>

      {loading ? (
        <div className={styles.overviewLoading} role="status" aria-live="polite">
          <RefreshCw className={styles.spin} size={17} aria-hidden="true" />
          <span>{copy(lang, 'Verifying current structure and access…', 'Verificando la estructura y el acceso actuales…')}</span>
        </div>
      ) : unavailable || legacyFallback ? (
        <div className={styles.overviewWarning} role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{legacyFallback
              ? copy(lang, 'Normalized company structure is not active', 'La estructura empresarial normalizada no está activa')
              : copy(lang, 'Live structure health is unavailable', 'El estado de la estructura en vivo no está disponible')}</strong>
            <span>{legacyFallback
              ? copy(
                  lang,
                  'Hotel access is being shown from the legacy account projection. Portfolio assignments cannot be safely changed here until access is migrated.',
                  'El acceso al hotel se muestra desde la proyección de cuenta heredada. Las asignaciones de cartera no se pueden cambiar de forma segura aquí hasta que se migre el acceso.',
                )
              : copy(
                  lang,
                  'Existing access remains visible below, but Staxis cannot verify structure problems or accept changes right now.',
                  'El acceso existente sigue visible abajo, pero Staxis no puede verificar problemas de estructura ni aceptar cambios en este momento.',
                )}</span>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.overviewStats}>
            <div><span>{copy(lang, 'Companies', 'Empresas')}</span><strong>{organizations.length}</strong></div>
            <div><span>{copy(lang, 'Portfolios / regions', 'Carteras / regiones')}</span><strong>{portfolios}</strong></div>
            <div><span>{copy(lang, 'Governed hotels', 'Hoteles administrados')}</span><strong>{hotels}</strong></div>
            <div className={attentionProblems.length > 0 ? styles.statAttention : undefined}>
              <span>{copy(lang, 'Needs attention', 'Requiere atención')}</span>
              <strong>{attentionProblems.length}</strong>
            </div>
          </div>

          {problems.length > 0 ? (
            <div className={styles.problemList} role="list" aria-label={copy(lang, 'Structure and access notices', 'Avisos de estructura y acceso')}>
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
              <span>{copy(
                lang,
                'No structure or inherited-access problems were detected in your current scope.',
                'No se detectaron problemas de estructura ni de acceso heredado dentro de tu alcance actual.',
              )}</span>
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
        throw new Error(responseError(body, copy(
          lang,
          'The impact preview could not be loaded.',
          'No se pudo cargar la vista previa del impacto.',
        )));
      }
      setPreview(body.data);
      idempotencyKeyRef.current = crypto.randomUUID();
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : copy(
        lang,
        'The impact preview could not be loaded.',
        'No se pudo cargar la vista previa del impacto.',
      ));
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
        throw new Error(responseError(body, copy(
          lang,
          'The hotel assignment could not be saved.',
          'No se pudo guardar la asignación del hotel.',
        )));
      }
      onCompleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(
        lang,
        'The hotel assignment could not be saved.',
        'No se pudo guardar la asignación del hotel.',
      ));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.scrim}
        aria-label={copy(lang, 'Close dialog', 'Cerrar diálogo')}
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
            <span>{copy(lang, 'Hotel structure', 'Estructura del hotel')}</span>
            <h2 id={titleId}>{hotel.name}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            disabled={busy}
            aria-label={copy(lang, 'Close', 'Cerrar')}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <p id={descriptionId} className={styles.dialogIntro}>
          {copy(
            lang,
            `Choose the portfolio and region assignments inside ${selection.organization.name}. This cannot move the hotel to another company.`,
            `Elige las asignaciones de cartera y región dentro de ${selection.organization.name}. Esto no puede mover el hotel a otra empresa.`,
          )}
        </p>

        <div className={styles.relationshipLock}>
          <LockKeyhole size={17} aria-hidden="true" />
          <div>
            <strong>{copy(lang, 'Company relationship is protected', 'La relación empresarial está protegida')}</strong>
            <span>
              {copy(
                lang,
                `${hotel.relationshipType === 'owner' ? 'Owner' : 'Operator'} · active. Only a verified Staxis platform administrator can change or transfer it.`,
                `${hotel.relationshipType === 'owner' ? 'Propietario' : 'Operador'} · activa. Solo un administrador de plataforma Staxis verificado puede cambiarla o transferirla.`,
              )}
            </span>
          </div>
        </div>

        {manageablePortfolios.length > 0 ? (
          <fieldset className={styles.assignmentChoices} disabled={busy || Boolean(preview)}>
            <legend>{copy(lang, 'Portfolio and region assignments', 'Asignaciones de cartera y región')}</legend>
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
            <span>{copy(
              lang,
              'There are no active portfolios or regions you are authorized to manage. Ask Staxis support to review the structure.',
              'No hay carteras ni regiones activas que tengas autorización para administrar. Pide al soporte de Staxis que revise la estructura.',
            )}</span>
          </div>
        )}

        {preview ? (
          <section className={styles.impact} aria-live="polite">
            <div className={styles.impactHeading}>
              <ShieldCheck size={18} aria-hidden="true" />
              <div>
                <strong>{copy(lang, 'Access impact preview', 'Vista previa del impacto en el acceso')}</strong>
                <span>{copy(
                  lang,
                  'This exact preview is bound to the current company access version.',
                  'Esta vista previa exacta está vinculada a la versión actual del acceso de la empresa.',
                )}</span>
              </div>
            </div>
            <dl>
              <div><dt>{copy(lang, 'Assignments added', 'Asignaciones agregadas')}</dt><dd>{preview.addedPortfolioIds.length}</dd></div>
              <div><dt>{copy(lang, 'Assignments removed', 'Asignaciones eliminadas')}</dt><dd>{preview.removedPortfolioIds.length}</dd></div>
              <div><dt>{copy(lang, 'People gaining hotel reach', 'Personas que obtienen acceso al hotel')}</dt><dd>{preview.gainingAccessCount}</dd></div>
              <div><dt>{copy(lang, 'People losing hotel reach', 'Personas que pierden acceso al hotel')}</dt><dd>{preview.losingAccessCount}</dd></div>
            </dl>
            <div className={styles.immediateWarning}>
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{copy(
                lang,
                'Saving takes effect immediately. Open sessions cannot use their prior hotel reach, and portfolio AI scope receipts are invalidated; affected people must re-resolve access.',
                'Al guardar, el cambio entra en vigor de inmediato. Las sesiones abiertas no pueden usar su acceso anterior a hoteles y los recibos de alcance de IA de cartera quedan invalidados; las personas afectadas deben volver a resolver el acceso.',
              )}</span>
            </div>
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={busy}
              />
              <span>{copy(
                lang,
                `I confirm these exact assignments for ${hotel.name} and understand the immediate access impact.`,
                `Confirmo estas asignaciones exactas para ${hotel.name} y comprendo el impacto inmediato en el acceso.`,
              )}</span>
            </label>
          </section>
        ) : null}

        {error ? <div className={styles.error} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div> : null}

        <footer className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>
            {copy(lang, 'Cancel', 'Cancelar')}
          </button>
          {stale ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onStale}
              disabled={busy}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {copy(lang, 'Reload current access', 'Recargar acceso actual')}
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
                {copy(lang, 'Edit assignments', 'Editar asignaciones')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={commit}
                disabled={busy || !confirmed}
              >
                {busy ? <RefreshCw className={styles.spin} size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                {copy(lang, 'Confirm and save', 'Confirmar y guardar')}
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
              {copy(lang, 'Preview access impact', 'Ver impacto en el acceso')}
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
        <div>
          <span>{copy(lang, 'Structure management', 'Administración de estructura')}</span>
          <h2 id="company-structure-management-title">
            {copy(lang, 'Company, portfolio, region, and hotel relationships', 'Relaciones de empresa, cartera, región y hotel')}
          </h2>
          <p>{copy(
            lang,
            'Portfolio assignments control inherited hotel reach. Company ownership and operator relationships are visible here but protected.',
            'Las asignaciones de cartera controlan el acceso heredado al hotel. Las relaciones de propiedad y operación de la empresa son visibles aquí, pero están protegidas.',
          )}</p>
        </div>
        <span className={styles.liveBadge}><KeyRound size={14} aria-hidden="true" />{copy(lang, 'Audited access', 'Acceso auditado')}</span>
      </div>

      <div className={styles.organizationList}>
        {structure.organizations.map((organization) => (
          <article key={organization.id} className={styles.organizationCard}>
            <header>
              <span className={styles.organizationIcon}><Building2 size={18} aria-hidden="true" /></span>
              <div>
                <strong>{organization.name}</strong>
                <span>{organization.hotels.length} {copy(lang, organization.hotels.length === 1 ? 'hotel' : 'hotels', organization.hotels.length === 1 ? 'hotel' : 'hoteles')} · {organization.portfolios.length} {copy(lang, 'portfolios/regions', 'carteras/regiones')}</span>
              </div>
              <span className={organization.canManagePortfolios ? styles.canManage : styles.readOnly}>
                {organization.canManagePortfolios
                  ? copy(lang, 'Can manage', 'Puede administrar')
                  : copy(lang, 'Read only', 'Solo lectura')}
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
                          ? copy(lang, 'Owner relationship', 'Relación de propietario')
                          : copy(lang, 'Operator relationship', 'Relación de operador')}
                        {' · '}
                        {assigned.length > 0
                          ? assigned.map((portfolio) => portfolio.name).join(', ')
                          : copy(lang, 'No portfolio or region', 'Sin cartera ni región')}
                      </span>
                    </div>
                    {hotel.manageable && organization.portfolios.some((portfolio) => portfolio.manageable) ? (
                      <button
                        type="button"
                        className={styles.editButton}
                        onClick={() => setSelection({ organization, propertyId: hotel.propertyId })}
                      >
                        <Layers3 size={14} aria-hidden="true" />
                        {copy(lang, 'Edit assignment', 'Editar asignación')}
                      </button>
                    ) : (
                      <span className={styles.lockedRelationship} title={copy(
                        lang,
                        'You do not have manage_portfolios for this scope.',
                        'No tienes manage_portfolios para este alcance.',
                      )}><LockKeyhole size={14} aria-hidden="true" />{copy(lang, 'Protected', 'Protegido')}</span>
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
