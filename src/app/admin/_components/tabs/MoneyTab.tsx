'use client';

/**
 * Money tab.
 *
 * Top (full-width):
 *   - Pilot-mode banner (only when MRR = 0)
 *   - Monthly summary chips (MRR / Cost (30d) / Margin / This month spent)
 *
 * Below (3-column horizontal):
 *   Expenses  │  Per-hotel economics  │  External links
 *
 * Claude API spend rolls into expenses automatically once claude_usage_log
 * starts populating. Until then the per-hotel Claude cost shows $0 —
 * console.anthropic.com link in the External column is the ground truth.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ExternalLink, Plus, Save, Trash2 } from 'lucide-react';

interface Expense {
  id: string;
  category: string;
  amount_cents: number;
  description: string | null;
  vendor: string | null;
  incurred_on: string;
  source: 'auto' | 'manual';
  property_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface HotelEcon {
  propertyId: string;
  propertyName: string | null;
  subscriptionStatus: string | null;
  mrrCents: number;
  claudeCostLast30dCents: number;
  smsCostLast30dCents: number;
  fleetAllocatedCostLast30dCents: number;
  totalCostLast30dCents: number;
  marginCents: number;
}

// Defaults shown in the dropdown out of the box. Anything else the user
// has previously entered gets folded in dynamically (see categoryOptions).
const DEFAULT_CATEGORIES: { key: string; label: string }[] = [
  { key: 'claude_api', label: 'Claude API' },
  { key: 'hosting',    label: 'Hosting (other)' },
  { key: 'twilio',     label: 'Twilio (SMS)' },
  { key: 'supabase',   label: 'Supabase' },
  { key: 'vercel',     label: 'Vercel' },
  { key: 'fly',        label: 'Fly.io' },
  { key: 'other',      label: 'Other' },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  DEFAULT_CATEGORIES.map((c) => [c.key, c.label]),
);

const CATEGORY_COLOR: Record<string, string> = {
  claude_api: '#a78bfa',
  hosting: '#60a5fa',
  twilio: '#fb923c',
  supabase: '#34d399',
  vercel: '#f472b6',
  fly: '#facc15',
  other: '#9ca3af',
};

// Custom categories get a deterministic color so the same name always
// shows up the same color across reloads.
const CUSTOM_PALETTE = ['#f87171', '#fbbf24', '#4ade80', '#22d3ee', '#818cf8', '#e879f9', '#2dd4bf'];
function colorFor(category: string): string {
  if (CATEGORY_COLOR[category]) return CATEGORY_COLOR[category];
  let h = 0;
  for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) | 0;
  return CUSTOM_PALETTE[Math.abs(h) % CUSTOM_PALETTE.length];
}

function labelFor(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

const NEW_CATEGORY_SENTINEL = '__new__';

export function MoneyTab() {
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [econ, setEcon] = useState<{ hotels: HotelEcon[]; totals: { mrrCents: number; claudeCostLast30dCents: number; smsCostLast30dCents: number; fleetAllocatedCostLast30dCents: number; totalCostLast30dCents: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [expRes, econRes] = await Promise.all([
        fetchWithAuth('/api/admin/expenses'),
        fetchWithAuth('/api/admin/per-hotel-economics'),
      ]);
      const [expJson, econJson] = await Promise.all([expRes.json(), econRes.json()]);
      if (expJson.ok) setExpenses(expJson.data.expenses);
      if (econJson.ok) setEcon(econJson.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  useEffect(() => { void load(); }, []);

  if (error) {
    return (
      <div style={{
        padding: '12px 14px',
        background: 'var(--red-dim)',
        border: '1px solid rgba(239,68,68,0.25)',
        borderRadius: '10px',
        color: 'var(--red)', fontSize: '13px',
      }}>{error}</div>
    );
  }

  if (!expenses || !econ) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  // Sum expenses for the current month
  const thisMonthCutoff = new Date();
  thisMonthCutoff.setDate(1);
  thisMonthCutoff.setHours(0, 0, 0, 0);
  const thisMonthCents = expenses
    .filter((e) => Date.parse(e.incurred_on) >= thisMonthCutoff.getTime())
    .reduce((s, e) => s + e.amount_cents, 0);

  const isPilot = econ.totals.mrrCents === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 1. Pilot banner */}
      {isPilot && (
        <div style={{
          padding: '14px 16px',
          background: 'rgba(212,144,64,0.08)',
          border: '1px solid rgba(212,144,64,0.2)',
          borderRadius: '10px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Pilot mode</div>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            All hotels are free. The cost numbers below are still real — useful to see how
            expensive each hotel is to run before billing flips on.
          </p>
        </div>
      )}

      {/* 2. Monthly summary */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <SummaryChip label="MRR" value={formatUSD(econ.totals.mrrCents)} color="var(--green)" />
        <SummaryChip label="Cost (30d)" value={formatUSD(econ.totals.totalCostLast30dCents)} color="var(--text-muted)" />
        <SummaryChip label="Margin (30d)" value={formatUSD(econ.totals.mrrCents - econ.totals.totalCostLast30dCents)}
          color={econ.totals.mrrCents - econ.totals.totalCostLast30dCents >= 0 ? 'var(--green)' : 'var(--red)'} />
        <SummaryChip label="This month spent" value={formatUSD(thisMonthCents)} color="var(--text-muted)" />
      </div>

      {/* 3-column horizontal layout: Expenses | Per-hotel economics | External */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '20px',
        alignItems: 'start',
      }}>
        <ExpensesSection expenses={expenses} reload={load} />

        <section style={{ minWidth: 0 }}>
          <h2 style={sectionTitle}>Per-hotel economics</h2>
          {econ.hotels.length === 0 ? (
            <EmptyState text="No hotels yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              {econ.hotels.map((h) => <HotelEconRow key={h.propertyId} row={h} />)}
            </div>
          )}
        </section>

        <section style={{ minWidth: 0 }}>
          <h2 style={sectionTitle}>External</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            <ExternalRow href="https://console.anthropic.com/cost"
              title="Claude API spend" subtitle="console.anthropic.com" />
            <ExternalRow href="https://dashboard.stripe.com/dashboard"
              title="Stripe dashboard" subtitle="Subscriptions, invoices, payouts" />
          </div>
        </section>
      </div>
    </div>
  );
}

function SummaryChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: '10px',
      border: `1px solid ${color}`,
      background: 'var(--surface-primary)',
      minWidth: '140px',
    }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 700, color, fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
        {value}
      </div>
    </div>
  );
}

function ExpensesSection({ expenses, reload }: { expenses: Expense[]; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ category: string; customCategory: string; amountDollars: string; description: string; vendor: string; incurredOn: string }>({
    category: 'hosting',
    customCategory: '',
    amountDollars: '',
    description: '',
    vendor: '',
    incurredOn: new Date().toISOString().slice(0, 10),
  });

  // Dropdown options = defaults + any custom categories already saved.
  const categoryOptions = React.useMemo(() => {
    const seen = new Set(DEFAULT_CATEGORIES.map((c) => c.key));
    const opts = DEFAULT_CATEGORIES.map((c) => ({ key: c.key, label: c.label }));
    for (const e of expenses) {
      if (!seen.has(e.category)) {
        seen.add(e.category);
        opts.push({ key: e.category, label: labelFor(e.category) });
      }
    }
    return opts;
  }, [expenses]);

  const isNewCategory = draft.category === NEW_CATEGORY_SENTINEL;
  const resolvedCategory = isNewCategory ? draft.customCategory.trim() : draft.category;

  const create = async () => {
    const dollars = parseFloat(draft.amountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    if (!resolvedCategory) return;
    await fetchWithAuth('/api/admin/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: resolvedCategory,
        amountCents: Math.round(dollars * 100),
        description: draft.description || null,
        vendor: draft.vendor || null,
        incurredOn: draft.incurredOn,
      }),
    });
    setAdding(false);
    setDraft({ category: 'hosting', customCategory: '', amountDollars: '', description: '', vendor: '', incurredOn: new Date().toISOString().slice(0, 10) });
    await reload();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this expense?')) return;
    await fetchWithAuth('/api/admin/expenses', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await reload();
  };

  return (
    <section style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h2 style={sectionTitle}>Expenses</h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-secondary" style={{ fontSize: '12px' }}>
            <Plus size={12} /> Add
          </button>
        )}
      </div>

      {adding && (
        <div style={{
          padding: '12px',
          background: 'var(--surface-primary)',
          border: '1px solid var(--amber)',
          borderRadius: '10px',
          marginBottom: '8px',
          // Narrower column = vertical form. The inputs flow naturally
          // top-to-bottom which is also easier to scan than the 5-up
          // horizontal row we used before.
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <FieldLabel text="Category">
            {isNewCategory ? (
              <input
                className="input"
                type="text"
                autoFocus
                placeholder="New category name"
                value={draft.customCategory}
                onChange={(e) => setDraft({ ...draft, customCategory: e.target.value })}
                onBlur={() => { if (!draft.customCategory.trim()) setDraft({ ...draft, category: 'hosting', customCategory: '' }); }}
                onKeyDown={(e) => { if (e.key === 'Escape') setDraft({ ...draft, category: 'hosting', customCategory: '' }); }}
                maxLength={60}
                style={{ fontSize: '12px' }}
              />
            ) : (
              <select
                className="input"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                style={{ fontSize: '12px' }}
              >
                {categoryOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                <option disabled>──────────</option>
                <option value={NEW_CATEGORY_SENTINEL}>+ New category…</option>
              </select>
            )}
          </FieldLabel>
          <FieldLabel text="Amount (USD)">
            <input className="input" type="number" step="0.01" placeholder="0.00" value={draft.amountDollars} onChange={(e) => setDraft({ ...draft, amountDollars: e.target.value })} style={{ fontSize: '12px' }} />
          </FieldLabel>
          <FieldLabel text="Description">
            <input className="input" type="text" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={{ fontSize: '12px' }} />
          </FieldLabel>
          <FieldLabel text="Date">
            <input className="input" type="date" value={draft.incurredOn} onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} style={{ fontSize: '12px' }} />
          </FieldLabel>
          <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
            <button
              onClick={create}
              className="btn btn-primary"
              disabled={!resolvedCategory || !(parseFloat(draft.amountDollars) > 0)}
              style={{ fontSize: '12px' }}
            >
              <Save size={12} /> Save
            </button>
            <button onClick={() => setAdding(false)} className="btn btn-secondary" style={{ fontSize: '12px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {expenses.length === 0 ? (
        <EmptyState text="No expenses yet — add one to start tracking your monthly burn." />
      ) : (
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: '10px',
          overflow: 'hidden',
          background: 'var(--surface-primary)',
        }}>
          {expenses.map((e, idx) => (
            <div key={e.id} style={{
              padding: '10px 14px',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto auto',
              gap: '12px',
              alignItems: 'center',
              borderBottom: idx < expenses.length - 1 ? '1px solid var(--border)' : 'none',
              fontSize: '12px',
            }}>
              <span style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: colorFor(e.category),
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {labelFor(e.category)}
                  {e.source === 'auto' && (
                    <span style={{ fontSize: '10px', marginLeft: '6px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>auto</span>
                  )}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '1px' }}>
                  {e.description ?? e.vendor ?? '—'} · {e.incurred_on}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {formatUSD(e.amount_cents)}
              </div>
              {e.source === 'manual' ? (
                <button onClick={() => remove(e.id)} aria-label="Delete"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex' }}>
                  <Trash2 size={12} color="var(--text-muted)" />
                </button>
              ) : <span style={{ width: '20px' }} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HotelEconRow({ row }: { row: HotelEcon }) {
  const isPilot = row.mrrCents === 0;
  const marginColor = isPilot ? 'var(--text-muted)'
    : row.marginCents >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <Link href={`/admin/properties/${row.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{
        padding: '12px 14px',
        background: 'var(--surface-primary)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{row.propertyName ?? '(unnamed)'}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{row.subscriptionStatus ?? '—'}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', fontSize: '11px' }}>
          <Cell label="MRR" value={formatUSD(row.mrrCents)} color="var(--green)" />
          <Cell label="Claude" value={formatUSD(row.claudeCostLast30dCents)} color="var(--text-secondary)" />
          <Cell label="SMS" value={formatUSD(row.smsCostLast30dCents)} color="var(--text-secondary)" />
          <Cell label="Margin" value={formatUSD(row.marginCents)} color={marginColor} />
        </div>
      </div>
    </Link>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color, marginTop: '1px' }}>{value}</div>
    </div>
  );
}

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{text}</span>
      {children}
    </label>
  );
}

function ExternalRow({ href, title, subtitle }: { href: string; title: string; subtitle: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 14px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      textDecoration: 'none',
      color: 'inherit',
      fontSize: '13px',
    }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: '2px' }}>{title}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{subtitle}</div>
      </div>
      <ExternalLink size={14} color="var(--text-muted)" />
    </a>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      padding: '20px',
      background: 'var(--surface-secondary)',
      border: '1px dashed var(--border)',
      borderRadius: '10px',
      textAlign: 'center',
      fontSize: '12px',
      color: 'var(--text-muted)',
    }}>{text}</div>
  );
}

function formatUSD(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : '';
  const abs = Math.abs(dollars);
  if (abs >= 1000) return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${sign}$${abs.toFixed(2)}`;
}

const sectionTitle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  marginBottom: '4px',
};
