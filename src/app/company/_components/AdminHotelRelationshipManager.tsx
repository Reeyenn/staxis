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

function copy(lang: string, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

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
  if (!current && targetOrganizationId) return copy(lang, 'Acquire and link hotel', 'Adquirir y vincular hotel');
  if (current && !targetOrganizationId) return copy(lang, 'Deactivate company relationship', 'Desactivar relación empresarial');
  if (current && targetOrganizationId !== current.organizationId) return copy(lang, 'Transfer hotel', 'Transferir hotel');
  if (current && relationshipType !== current.relationshipType) return copy(lang, 'Change relationship type', 'Cambiar tipo de relación');
  return copy(lang, 'No relationship change', 'Sin cambio de relación');
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
      setError(caught instanceof Error ? caught.message : copy(
        lang,
        'Company search could not be loaded.',
        'No se pudo cargar la búsqueda de empresas.',
      ));
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
      if (!response.ok || !body.ok || !body.data) throw new Error(responseError(body, copy(
        lang,
        'Relationship impact could not be previewed.',
        'No se pudo obtener la vista previa del impacto de la relación.',
      )));
      setPreview(body.data);
      setIdempotencyKey(crypto.randomUUID());
    } catch (caught) {
      setPreview(null);
      setIdempotencyKey(null);
      setError(caught instanceof Error ? caught.message : copy(lang, 'Preview failed.', 'Falló la vista previa.'));
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
      if (!response.ok || !body.ok) throw new Error(responseError(body, copy(
        lang,
        'Relationship change could not be saved.',
        'No se pudo guardar el cambio de relación.',
      )));
      onCompleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Save failed.', 'Error al guardar.'));
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
      <button className={styles.dialogScrim} type="button" aria-label={copy(lang, 'Close dialog', 'Cerrar diálogo')} onClick={() => { if (!busy) onClose(); }} />
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
            <span>{copy(lang, 'Staxis platform administration', 'Administración de plataforma Staxis')}</span>
            <h2 id={titleId}>{copy(lang, 'Manage hotel company relationship', 'Administrar relación empresarial del hotel')}</h2>
          </div>
          <button ref={closeRef} className={styles.iconButton} type="button" disabled={busy} onClick={onClose} aria-label={copy(lang, 'Close', 'Cerrar')}><X size={18} /></button>
        </header>

        <p className={styles.dialogIntro} id={descriptionId}>
          {copy(
            lang,
            'Choose the hotel’s one primary company relationship. A transfer, deactivation, or type change takes effect immediately and is permanently audited.',
            'Elige la única relación empresarial principal del hotel. Una transferencia, desactivación o cambio de tipo entra en vigor inmediatamente y queda auditado permanentemente.',
          )}
        </p>

        <dl className={styles.dialogFacts}>
          <div><dt>{copy(lang, 'Hotel', 'Hotel')}</dt><dd>{workingProjection.property.name}</dd></div>
          <div><dt>{copy(lang, 'Current status', 'Estado actual')}</dt><dd>{current ? current.organizationName : copy(lang, 'Independent', 'Independiente')}</dd></div>
        </dl>

        <div className={styles.workflowForm}>
          <form className={styles.adminCompanySearch} onSubmit={searchCompanies}>
            <label className={styles.formField}>
              <span>{copy(lang, 'Find a company', 'Buscar una empresa')}</span>
              <span className={styles.inputWithIcon}>
                <Search size={15} aria-hidden="true" />
                <input value={searchQuery} maxLength={120} onChange={(event) => setSearchQuery(event.target.value)} placeholder={copy(lang, 'Search active management companies', 'Buscar empresas administradoras activas')} />
              </span>
            </label>
            <button className={styles.secondaryButton} type="submit" disabled={busy}>
              {busy ? <RefreshCw className={styles.buttonSpinnerDark} size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
              {copy(lang, 'Search', 'Buscar')}
            </button>
          </form>
          {workingProjection.organizationResultsTruncated ? (
            <p className={styles.adminDirectoryNotice}>{copy(
              lang,
              `Showing the first ${workingProjection.organizationResultLimit} matches. Narrow the search to find another company.`,
              `Se muestran las primeras ${workingProjection.organizationResultLimit} coincidencias. Refina la búsqueda para encontrar otra empresa.`,
            )}</p>
          ) : null}

          <div className={styles.formGrid}>
            <label className={styles.formField}>
              <span>{copy(lang, 'Relationship status / company', 'Estado de relación / empresa')}</span>
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
                <option value="independent">{copy(lang, 'Independent — no active company relationship', 'Independiente — sin relación empresarial activa')}</option>
                {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
              </select>
              <em>{copy(lang, 'Only active management or ownership companies are eligible.', 'Solo son elegibles las empresas administradoras o propietarias activas.')}</em>
            </label>
            <label className={styles.formField}>
              <span>{copy(lang, 'Relationship type', 'Tipo de relación')}</span>
              <select value={relationshipType} disabled={busy || !targetOrganizationId} onChange={(event) => { setRelationshipType(event.target.value as AdminHotelRelationshipType); invalidate(); }}>
                <option value="operator">{copy(lang, 'Operator', 'Operador')}</option>
                <option value="owner">{copy(lang, 'Owner', 'Propietario')}</option>
              </select>
              <em>{targetOrganizationId
                ? copy(lang, 'Defines the company’s governing relationship.', 'Define la relación de gobierno de la empresa.')
                : copy(lang, 'Not applicable while the hotel is independent.', 'No aplica mientras el hotel sea independiente.')}</em>
            </label>
          </div>

          {error ? <div className={styles.formError} role="alert">{error}</div> : null}

          {preview ? (
            <section className={`${styles.mutationPreview} ${preview.changed ? styles.lifecyclePreview : ''}`} aria-live="polite">
              <div className={styles.previewHeading}>
                {preview.changed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
                <div><strong>{label}</strong><span>{preview.changed
                  ? copy(lang, 'Exact impact calculated from current authorization state', 'Impacto exacto calculado a partir del estado de autorización actual')
                  : copy(lang, 'The requested relationship already matches', 'La relación solicitada ya coincide')}</span></div>
              </div>
              <dl>
                <div><dt>{copy(lang, 'Property grants revoked', 'Permisos de hotel revocados')}</dt><dd>{preview.impact.revokedPropertyGrantCount}</dd></div>
                <div><dt>{copy(lang, 'Invites revoked', 'Invitaciones revocadas')}</dt><dd>{preview.impact.revokedInvitationCount}</dd></div>
                <div><dt>{copy(lang, 'Requests cancelled', 'Solicitudes canceladas')}</dt><dd>{preview.impact.cancelledRequestCount}</dd></div>
                <div><dt>{copy(lang, 'Portfolio links removed', 'Vínculos de cartera eliminados')}</dt><dd>{preview.impact.removedPortfolioAssignmentCount}</dd></div>
                <div><dt>{copy(lang, 'After confirmation', 'Después de confirmar')}</dt><dd>{preview.targetOrganization?.name ?? copy(lang, 'Independent', 'Independiente')}</dd></div>
                <div><dt>{copy(lang, 'Effective', 'Vigencia')}</dt><dd>{copy(lang, 'Immediately', 'Inmediatamente')}</dd></div>
              </dl>
            </section>
          ) : (
            <div className={styles.reasonBox}>
              <strong>{copy(lang, 'Preview required', 'Vista previa obligatoria')}</strong>
              <span>{copy(lang, 'No relationship change is sent until Staxis recalculates the exact current impact and you confirm it.', 'No se envía ningún cambio hasta que Staxis recalcule el impacto actual exacto y lo confirmes.')}</span>
            </div>
          )}
        </div>

        <footer className={styles.dialogFooter}>
          <span><LockKeyhole size={13} aria-hidden="true" />{copy(lang, 'Admin rechecked at commit · audited', 'Administrador verificado al confirmar · auditado')}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>{copy(lang, 'Cancel', 'Cancelar')}</button>
            {!preview ? (
              <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void loadPreview()}>
                {busy ? <RefreshCw className={styles.buttonSpinner} size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                {copy(lang, 'Preview exact impact', 'Previsualizar impacto exacto')}
              </button>
            ) : (
              <button type="button" className={preview.changed ? styles.dangerButton : styles.primaryButton} disabled={busy} onClick={() => void commit()}>
                {busy ? <RefreshCw className={styles.buttonSpinner} size={14} aria-hidden="true" /> : <ArrowRightLeft size={14} aria-hidden="true" />}
                {preview.changed ? copy(lang, 'Confirm and apply', 'Confirmar y aplicar') : copy(lang, 'Confirm no change', 'Confirmar sin cambios')}
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
  adminToolsEnabled,
  lang,
  onChanged,
}: {
  propertyId: string;
  propertyName: string;
  adminToolsEnabled: boolean;
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
      throw new Error(responseError(body, copy(
        lang,
        'Current company relationship could not be verified.',
        'No se pudo verificar la relación empresarial actual.',
      )));
    }
    setProjection(body.data);
    return body.data;
  }, [lang, propertyId]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setProjection(null);
    setDialogOpen(false);
    void load().catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : copy(lang, 'Relationship load failed.', 'Falló la carga de la relación.'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lang, load, propertyId]);

  const completed = () => {
    setDialogOpen(false);
    setLoading(true);
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : copy(lang, 'Relationship reload failed.', 'Falló la recarga de la relación.'))).finally(() => setLoading(false));
    onChanged();
  };

  return (
    <section className={styles.adminRelationshipCard} aria-labelledby="admin-hotel-relationship-title" data-admin-hotel-relationship-manager>
      <div className={styles.adminRelationshipIcon}><Building2 size={20} aria-hidden="true" /></div>
      <div className={styles.adminRelationshipBody}>
        <span>{copy(lang, 'Staxis platform administration', 'Administración de plataforma Staxis')}</span>
        <h3 id="admin-hotel-relationship-title">{copy(lang, 'Company relationship and status', 'Relación empresarial y estado')}</h3>
        {loading ? (
          <p><RefreshCw className={styles.spin} size={14} aria-hidden="true" /> {copy(lang, 'Verifying the current primary relationship…', 'Verificando la relación principal actual…')}</p>
        ) : error ? (
          <p className={styles.adminRelationshipError}><AlertTriangle size={14} aria-hidden="true" /> {error}</p>
        ) : projection ? (
          <p>
            <Hotel size={14} aria-hidden="true" />
            <strong>{projection.property.name || propertyName}</strong>
            <ArrowRightLeft size={13} aria-hidden="true" />
            <strong>{projection.currentRelationship?.organizationName ?? copy(lang, 'Independent', 'Independiente')}</strong>
            <span className={`${styles.status} ${projection.currentRelationship ? styles.statusActive : styles.statusMuted}`}>
              {projection.currentRelationship
                ? copy(lang, `${projection.currentRelationship.relationshipType} · active`, `${projection.currentRelationship.relationshipType} · activa`)
                : copy(lang, 'Independent', 'Independiente')}
            </span>
          </p>
        ) : null}
        <small>{adminToolsEnabled
          ? copy(lang, 'Admin view is ON. Acquire, link, transfer, deactivate, or change owner/operator status through a confirmed impact preview.', 'La vista de administrador está ACTIVADA. Adquiere, vincula, transfiere, desactiva o cambia el estado propietario/operador mediante una vista previa confirmada.')
          : copy(lang, 'Turn on Admin view above to make a lifecycle change. This read-only status remains safe to inspect.', 'Activa la vista de administrador arriba para hacer un cambio de ciclo de vida. Este estado de solo lectura se puede revisar de forma segura.')}</small>
      </div>
      <div className={styles.adminRelationshipActions}>
        {error ? (
          <button className={styles.secondaryButton} type="button" disabled={loading} onClick={() => { setLoading(true); setError(''); void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Load failed')).finally(() => setLoading(false)); }}>
            <RefreshCw size={14} aria-hidden="true" />{copy(lang, 'Retry', 'Reintentar')}
          </button>
        ) : (
          <button className={styles.primaryButton} type="button" disabled={!adminToolsEnabled || loading || !projection} onClick={() => setDialogOpen(true)}>
            <ArrowRightLeft size={14} aria-hidden="true" />{copy(lang, 'Manage relationship', 'Administrar relación')}
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
