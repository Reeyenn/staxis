'use client';

export const dynamic = 'force-dynamic';

// Settings → Labor Budget. Owner/GM/admin sets the daily + weekly
// labor budget + the overtime threshold. The LaborCostBanner on the
// Schedule tab uses these to show over/under-budget badges; the OT
// detector uses the threshold hours.
//
// Reads + writes through /api/properties/labor-budget.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { ChevronLeft, DollarSign } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { canManageTeam } from '@/lib/roles';

interface BudgetState {
  dailyBudget: string;
  weeklyBudget: string;
  overtimeThresholdHours: string;
}

const EMPTY_STATE: BudgetState = {
  dailyBudget: '',
  weeklyBudget: '',
  overtimeThresholdHours: '40',
};

function centsToDollarsString(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(0);
}

function dollarsStringToCents(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default function LaborBudgetPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  // Owner/GM/admin only.
  if (!user || !canManageTeam(user.role)) {
    return (
      <AppLayout>
        <div style={{ padding: 24 }}>
          {lang === 'es' ? 'Solo accesible para administradores.' : 'Manager access only.'}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <LaborBudgetBody pid={activePropertyId ?? ''} lang={lang} />
    </AppLayout>
  );
}

function LaborBudgetBody({ pid, lang }: { pid: string; lang: 'en' | 'es' }) {
  const [state, setState] = useState<BudgetState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Load current values.
  useEffect(() => {
    if (!pid) return;
    let active = true;
    setLoading(true);
    fetchWithAuth(`/api/properties/labor-budget?propertyId=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then((body: {
        ok?: boolean;
        data?: {
          dailyBudgetCents: number | null;
          weeklyBudgetCents: number | null;
          legacyWeeklyBudgetDollars: number | null;
          overtimeThresholdHours: number;
        };
        error?: string;
      }) => {
        if (!active) return;
        if (!body.ok || !body.data) {
          setError(body.error ?? 'Could not load budget settings');
          return;
        }
        // Use cents columns when present; fall back to the legacy
        // weekly_budget dollar column for properties whose owner
        // hasn't touched the new settings yet (migration 0229 backfills
        // those automatically, but we double-check here).
        const dailyCents = body.data.dailyBudgetCents;
        let weeklyCents = body.data.weeklyBudgetCents;
        if (weeklyCents === null && typeof body.data.legacyWeeklyBudgetDollars === 'number') {
          weeklyCents = Math.round(body.data.legacyWeeklyBudgetDollars * 100);
        }
        setState({
          dailyBudget: centsToDollarsString(dailyCents),
          weeklyBudget: centsToDollarsString(weeklyCents),
          overtimeThresholdHours: String(body.data.overtimeThresholdHours ?? 40),
        });
      })
      .catch(err => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Network error');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pid]);

  const save = useCallback(async () => {
    if (!pid) return;
    setSaving(true);
    setError(null);
    try {
      const dailyCents = dollarsStringToCents(state.dailyBudget);
      const weeklyCents = dollarsStringToCents(state.weeklyBudget);
      const otHours = Number.parseFloat(state.overtimeThresholdHours.trim() || '40');
      if (!Number.isFinite(otHours) || otHours <= 0 || otHours > 168) {
        setError(lang === 'es'
          ? 'El umbral de horas extras debe estar entre 0 y 168.'
          : 'Overtime threshold must be between 0 and 168 hours.');
        setSaving(false);
        return;
      }
      // Empty string → null (clear).
      if (state.dailyBudget.trim() && dailyCents === null) {
        setError(lang === 'es' ? 'Presupuesto diario inválido.' : 'Invalid daily budget.');
        setSaving(false);
        return;
      }
      if (state.weeklyBudget.trim() && weeklyCents === null) {
        setError(lang === 'es' ? 'Presupuesto semanal inválido.' : 'Invalid weekly budget.');
        setSaving(false);
        return;
      }
      const res = await fetchWithAuth('/api/properties/labor-budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: pid,
          dailyBudgetCents: dailyCents,
          weeklyBudgetCents: weeklyCents,
          overtimeThresholdHours: otHours,
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Save failed');
        return;
      }
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, [pid, state, lang]);

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 600 }}>
      <div>
        <Link href="/settings" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: 'var(--text-muted)', fontSize: 13, textDecoration: 'none',
          paddingBottom: 12,
        }}>
          <ChevronLeft size={14} />
          {lang === 'es' ? 'Configuración' : 'Settings'}
        </Link>
        <h1 style={{
          fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 17,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <DollarSign size={15} color="var(--navy)" />
          {lang === 'es' ? 'Presupuesto de personal' : 'Labor budget'}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.45 }}>
          {lang === 'es'
            ? 'Define un presupuesto opcional por día y semana. El panel de horario mostrará si el día va por encima o por debajo.'
            : 'Set an optional daily and weekly labor budget. The Schedule banner will show whether you\'re over or under.'}
        </p>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {lang === 'es' ? 'Cargando…' : 'Loading…'}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field
            label={lang === 'es' ? 'Presupuesto diario (USD)' : 'Daily budget (USD)'}
            hint={lang === 'es'
              ? 'Déjalo vacío para no comparar con un presupuesto.'
              : 'Leave blank to skip the budget comparison.'}
          >
            <input
              type="number"
              min={0}
              step={10}
              value={state.dailyBudget}
              onChange={e => setState(s => ({ ...s, dailyBudget: e.target.value }))}
              placeholder="400"
              style={inputStyle}
            />
          </Field>

          <Field
            label={lang === 'es' ? 'Presupuesto semanal (USD)' : 'Weekly budget (USD)'}
            hint={lang === 'es'
              ? 'Usado por el reporte semanal.'
              : 'Used by the weekly report.'}
          >
            <input
              type="number"
              min={0}
              step={50}
              value={state.weeklyBudget}
              onChange={e => setState(s => ({ ...s, weeklyBudget: e.target.value }))}
              placeholder="2800"
              style={inputStyle}
            />
          </Field>

          <Field
            label={lang === 'es' ? 'Horas hasta horas extras' : 'Hours to overtime'}
            hint={lang === 'es'
              ? 'Mostraremos una alerta cuando alguien llegue aquí. Federal: 40h.'
              : 'We\'ll alert when someone hits this. Federal default: 40h.'}
          >
            <input
              type="number"
              min={1}
              max={168}
              step={1}
              value={state.overtimeThresholdHours}
              onChange={e => setState(s => ({ ...s, overtimeThresholdHours: e.target.value }))}
              style={inputStyle}
            />
          </Field>

          {error && (
            <div role="alert" style={{
              padding: '10px 14px',
              background: 'rgba(160,74,44,0.08)',
              border: '1px solid rgba(160,74,44,0.25)',
              borderRadius: 12, color: '#A04A2C',
              fontSize: 13, lineHeight: 1.4,
            }}>{error}</div>
          )}

          {savedAt && !error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(92,122,96,0.08)',
              border: '1px solid rgba(92,122,96,0.25)',
              borderRadius: 12, color: 'var(--snow-sage-deep, #3F5A45)',
              fontSize: 13,
            }}>{lang === 'es' ? 'Guardado.' : 'Saved.'}</div>
          )}

          <button
            type="button"
            disabled={saving}
            onClick={() => { void save(); }}
            style={{
              padding: '10px 18px',
              borderRadius: 10,
              border: '1px solid var(--text-primary, #1A1F1B)',
              background: 'var(--text-primary, #1A1F1B)',
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              cursor: saving ? 'wait' : 'pointer',
              alignSelf: 'flex-start',
              opacity: saving ? 0.65 : 1,
            }}
          >
            {saving
              ? (lang === 'es' ? 'Guardando…' : 'Saving…')
              : (lang === 'es' ? 'Guardar' : 'Save')}
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid var(--text-muted-2, #d9dad6)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
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
        display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
        color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase',
        marginBottom: 6,
      }}>{label}</label>
      {children}
      {hint && (
        <p style={{
          margin: '6px 0 0', fontSize: 11.5,
          color: 'var(--text-muted)', lineHeight: 1.4,
        }}>{hint}</p>
      )}
    </div>
  );
}
