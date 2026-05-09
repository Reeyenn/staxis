'use client';

/**
 * Money tab — Phase 8.
 *
 * Sections:
 *   1. Pilot-mode banner (until billing flips on)
 *   2. Monthly summary chips (MRR / total cost / margin)
 *   3. Expenses panel — list + manual entry form
 *   4. Per-hotel revenue vs cost cards
 *   5. Direct links to Claude console + Stripe dashboard
 *
 * Claude API spend rolls up here automatically once the CUA service
 * starts writing claude_usage_log rows. Until then the per-hotel
 * Claude cost shows $0 — fall back to console.anthropic.com link.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ExternalLink, Plus, Save, Trash2 } from 'lucide-react';

type Category = 'claude_api' | 'hosting' | 'twilio' | 'supabase' | 'vercel' | 'fly' | 'other';

interface Expense {
  id: string;
  category: Category;
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

const CATEGORY_LABEL: Record<Category, string> = {
  claude_api: 'Claude API',
  hosting: 'Hosting (other)',
  twilio: 'Twilio (SMS)',
  supabase: 'Supabase',
  vercel: 'Vercel',
  fly: 'Fly.io',
  other: 'Other',
};

const CATEGORY_COLOR: Record<Category, string> = {
  claude_api: '#a78bfa',
  hosting: '#60a5fa',
  twilio: '#fb923c',
  supabase: '#34d399',
  vercel: '#f472b6',
  fly: '#facc15',
  other: '#9ca3af',
};

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

      {/* 3. Expenses */}
      <ExpensesSection expenses={expenses} reload={load} />

      {/* 4. Per-hotel economics */}
      <section>
        <h2 style={sectionTitle}>Per-hotel economics (last 30 days)</h2>
        <p style={sectionHint}>
          Worst-margin hotels first. Cost = Claude API + SMS + an even share of fleet expenses.
        </p>
        {econ.hotels.length === 0 ? (
          <EmptyState text="No hotels yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {econ.hotels.map((h) => <HotelEconRow key={h.propertyId} row={h} />)}
          </div>
        )}
      </section>

      {/* 5. External links */}
      <section>
        <h2 style={sectionTitle}>External</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          <ExternalRow href="https://console.anthropic.com/cost"
            title="Claude API spend" subtitle="console.anthropic.com — actual numbers, never estimated" />
          <ExternalRow href="https://dashboard.stripe.com/dashboard"
            title="Stripe dashboard" subtitle="Subscriptions, invoices, payouts" />
        </div>
      </section>
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
  const [draft, setDraft] = useState<{ category: Category; amountDollars: string; description: string; vendor: string; incurredOn: string }>({
    category: 'hosting',
    amountDollars: '',
    description: '',
    vendor: '',
    incurredOn: new Date().toISOString().slice(0, 10),
  });

  const create = async () => {
    const dollars = parseFloat(draft.amountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    await fetchWithAuth('/api/admin/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: draft.category,
        amountCents: Math.round(dollars * 100),
        description: draft.description || null,
        vendor: draft.vendor || null,
        incurredOn: draft.incurredOn,
      }),
    });
    setAdding(false);
    setDraft({ category: 'hosting', amountDollars: '', description: '', vendor: '', incurredOn: new Date().toISOString().slice(0, 10) });
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
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div>
          <h2 style={sectionTitle}>Expenses</h2>
          <p style={sectionHint}>Last 12 months. Manual entries + auto-rolled Claude API spend.</p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-secondary" style={{ fontSize: '12px' }}>
            <Plus size={12} /> Add expense
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
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr 1fr auto',
          gap: '6px',
          alignItems: 'end',
        }}>
          <FieldLabel text="Category">
            <select className="input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })} style={{ fontSize: '12px' }}>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
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
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={create} className="btn btn-primary" style={{ fontSize: '12px' }}>
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
                background: CATEGORY_COLOR[e.category as Category] ?? '#9ca3af',
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {CATEGORY_LABEL[e.category as Category] ?? e.category}
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
};

const sectionHint: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  marginTop: '2px',
  marginBottom: '8px',
};
