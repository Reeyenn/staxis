'use client';

import React from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';
import { titleCaseAccessValue } from '@/lib/company-access/dto';
import type {
  AdminEffectiveAccessData,
  AdminEffectiveAccessRow,
} from '@/lib/company-access/admin-effective-access-dto';
import styles from './AdminEffectiveAccess.module.css';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string | { message?: string };
}

function errorMessage(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

function dateLabel(value: string | null): string {
  if (!value) return 'No expiry';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown expiry';
  return `Expires ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function financialLabel(row: AdminEffectiveAccessRow): string {
  if (row.financialHotels.length === 0) return 'No financial visibility';
  if (row.financialHotels.length === row.hotels.length) return 'Financials at every covered hotel';
  return `Financials at ${row.financialHotels.length} of ${row.hotels.length} covered hotels`;
}

export function AdminEffectiveAccess({
  propertyId,
  organizationId,
  tone = 'light',
  refreshKey = 0,
  onChanged,
}: {
  propertyId?: string;
  organizationId?: string;
  tone?: 'light' | 'dark';
  refreshKey?: number;
  onChanged?: () => void | Promise<void>;
}) {
  const [data, setData] = React.useState<AdminEffectiveAccessData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyRow, setBusyRow] = React.useState<string | null>(null);
  const [savingCompanyAi, setSavingCompanyAi] = React.useState(false);

  const query = propertyId
    ? `propertyId=${encodeURIComponent(propertyId)}`
    : `organizationId=${encodeURIComponent(organizationId ?? '')}`;

  const load = React.useCallback(async () => {
    if (!propertyId && !organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth(`/api/admin/effective-access?${query}`);
      const body = await response.json().catch(() => ({})) as Envelope<AdminEffectiveAccessData>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(errorMessage(body, 'Authoritative access could not be loaded.'));
      }
      setData(body.data);
    } catch (caught) {
      setData(null);
      setError(caught instanceof Error ? caught.message : 'Authoritative access could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [organizationId, propertyId, query]);

  React.useEffect(() => { void load(); }, [load, refreshKey]);

  const changeCompanyAi = async () => {
    const setting = data?.aiControl.companySetting;
    if (!setting || savingCompanyAi) return;
    const next = !setting.enabled;
    setSavingCompanyAi(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/admin/effective-access', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: setting.organizationId,
          crossHotelAiChat: next,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<AdminEffectiveAccessData>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(errorMessage(body, 'Company portfolio AI permission could not be saved.'));
      }
      setData(body.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Company portfolio AI permission could not be saved.');
      await load();
    } finally {
      setSavingCompanyAi(false);
    }
  };

  const removeAccess = async (row: AdminEffectiveAccessRow) => {
    if (!row.mutation.allowed || busyRow) return;
    const coverage = row.hotels.map((hotel) => hotel.name).join(', ');
    if (!window.confirm(
      `Remove ${row.displayName}'s ${titleCaseAccessValue(row.role)} access?\n\n`
      + `This affects: ${coverage}. The authoritative permission record will be changed and audited.`,
    )) return;

    setBusyRow(row.id);
    setError(null);
    try {
      const response = row.mutation.kind === 'membership_hat'
        ? await fetchWithAuth('/api/admin/effective-access', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ membershipId: row.mutation.membershipId }),
          })
        : await fetchWithAuth(
            `/api/auth/team?hotelId=${encodeURIComponent(row.mutation.hotelId ?? '')}`
              + `&accountId=${encodeURIComponent(row.accountId)}`,
            { method: 'DELETE' },
          );
      const body = await response.json().catch(() => ({})) as Envelope<unknown>;
      if (!response.ok || !body.ok) {
        throw new Error(errorMessage(body, 'Access could not be removed.'));
      }
      if (onChanged) await onChanged();
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Access could not be removed.');
      await load();
    } finally {
      setBusyRow(null);
    }
  };

  const companySetting = data?.aiControl.companySetting;
  return (
    <section className={`${styles.root} ${tone === 'dark' ? styles.dark : ''}`} aria-busy={loading}>
      <div className={styles.header}>
        <div className={styles.headingCopy}>
          <h3>Effective access</h3>
          <p>Server-resolved people, winning entitlement source, and exact current hotel coverage.</p>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {data && (
        <div className={styles.aiPanel}>
          {companySetting && (
            <div className={styles.aiHeader}>
              <div>
                <span className={styles.aiTitle}>Company portfolio AI permission</span>
                <span className={styles.aiCopy}>
                  Company-specific <code>cross_hotel_ai_chat</code>. This is separate from the global model switch.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={companySetting.enabled}
                aria-label="Allow company-wide AI questions for this organization"
                className={styles.switch}
                data-checked={companySetting.enabled}
                disabled={!companySetting.mutable || savingCompanyAi}
                onClick={() => void changeCompanyAi()}
              >
                <span className={styles.switchKnob} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className={styles.globalLine} aria-label="Global AI feature state">
            <span>Global hotel AI · {data.aiControl.hotelFeature.enabled ? 'on' : 'off'}</span>
            <span>Global portfolio model · {data.aiControl.portfolioFeature.enabled ? 'on' : 'off'}</span>
            {companySetting && <span>Company portfolio permission · {companySetting.enabled ? 'on' : 'off'}</span>}
          </div>
        </div>
      )}

      {error && <div className={styles.error} role="alert">{error}</div>}
      {loading && !data ? (
        <div className={styles.message} role="status">Resolving authoritative access…</div>
      ) : data && data.rows.length === 0 ? (
        <div className={styles.message}>No one currently has effective access in this scope.</div>
      ) : data ? (
        <div className={styles.list} role="list">
          {data.rows.map((row) => (
            <article key={row.id} className={styles.row} role="listitem">
              <div className={styles.personLine}>
                <strong>{row.displayName}</strong>
                <span className={styles.badge}>{row.status}</span>
              </div>
              <div className={styles.profile}>
                {titleCaseAccessValue(row.role)} · {titleCaseAccessValue(row.profile)}
              </div>
              <div className={styles.metaLine}>
                <span><strong>Scope</strong> {titleCaseAccessValue(row.scopeType)} · {row.scopeLabel}</span>
                <span><strong>Source</strong> {row.source}</span>
              </div>
              <ul className={styles.hotels} aria-label={`Exact hotel coverage for ${row.displayName}`}>
                {row.hotels.map((hotel) => <li key={hotel.id} className={styles.hotelChip}>{hotel.name}</li>)}
              </ul>
              <div className={styles.stateLine}>
                <span><strong>Hotel AI</strong> {row.hotelAiEntitled ? 'entitled' : 'not entitled'}</span>
                <span><strong>Portfolio AI</strong> {row.portfolioAiEntitled ? 'entitled' : 'not entitled'}</span>
                <span><strong>Financials</strong> {financialLabel(row)}</span>
                <span><strong>State</strong> {row.mutation.label}</span>
                <span>{dateLabel(row.expiresAt)}</span>
              </div>
              {row.mutation.allowed && (
                <button
                  type="button"
                  className={styles.remove}
                  disabled={busyRow === row.id}
                  onClick={() => void removeAccess(row)}
                >
                  {busyRow === row.id ? 'Removing…' : `Remove ${titleCaseAccessValue(row.role)} access`}
                </button>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
