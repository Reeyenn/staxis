'use client';

/**
 * Money tab — Snow design (May 2026).
 *
 * Top: pilot-mode banner (when MRR = 0) + monthly summary chips
 *   (MRR / Cost (30d) / Margin / This month spent).
 *
 * Below (3-column grid):
 *   Expenses  │  Per-hotel economics  │  External links
 *
 * Claude API spend rolls into expenses automatically once claude_usage_log
 * starts populating. Until then the per-hotel Claude cost shows $0 —
 * console.anthropic.com link in External is the ground truth.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Btn, SerifNum, MonoNum,
} from '@/app/admin/_components/_snow';

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
  claude_api: '#7B6A97',
  hosting:    '#5E7A8C',
  twilio:     '#C99644',
  supabase:   '#5C7A60',
  vercel:     '#B8775E',
  fly:        '#8C6A33',
  other:      '#A6ABA6',
};

const CUSTOM_PALETTE = ['#B85C3D', '#C99644', '#5C7A60', '#5E7A8C', '#7B6A97', '#B8775E', '#688372'];

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
        padding: '14px 16px',
        background: T.warmDim,
        border: `1px solid rgba(184,92,61,0.25)`,
        borderRadius: 14,
        color: T.warm, fontSize: 13,
        fontFamily: FONT_SANS,
      }}>{error}</div>
    );
  }

  if (!expenses || !econ) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
      </div>
    );
  }

  const thisMonthCutoff = new Date();
  thisMonthCutoff.setDate(1);
  thisMonthCutoff.setHours(0, 0, 0, 0);
  const thisMonthCents = expenses
    .filter((e) => Date.parse(e.incurred_on) >= thisMonthCutoff.getTime())
    .reduce((s, e) => s + e.amount_cents, 0);

  const isPilot = econ.totals.mrrCents === 0;
  const marginCents = econ.totals.mrrCents - econ.totals.totalCostLast30dCents;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      {/* Pilot banner */}
      {isPilot && (
        <Card padding="16px 20px" style={{
          background: 'linear-gradient(180deg, rgba(215,176,126,0.10), rgba(215,176,126,0.02))',
          border: `1px solid rgba(140,106,51,0.20)`,
        }}>
          <Caps c={T.caramelDeep}>Pilot mode</Caps>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 22, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 4px',
            lineHeight: 1.2,
          }}>
            All hotels are <span style={{ fontStyle: 'italic' }}>free</span>.
          </h2>
          <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.55 }}>
            The cost numbers below are still real — useful to see how expensive each
            hotel is to run before billing flips on.
          </p>
        </Card>
      )}

      {/* Hero summary — italic-serif numbers in a single card row */}
      <Card padding="0">
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          <SummaryCell
            label="MRR"
            value={formatUSD(econ.totals.mrrCents)}
            tone="sage"
          />
          <SummaryCell
            label="Cost (30d)"
            value={formatUSD(econ.totals.totalCostLast30dCents)}
            tone="neutral"
          />
          <SummaryCell
            label="Margin (30d)"
            value={formatUSD(marginCents)}
            tone={marginCents >= 0 ? 'sage' : 'warm'}
          />
          <SummaryCell
            label="This month spent"
            value={formatUSD(thisMonthCents)}
            tone="caramel"
            last
          />
        </div>
      </Card>

      {/* 3-column grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 18,
        alignItems: 'start',
      }}>
        <ExpensesSection expenses={expenses} reload={load} />

        <section style={{ minWidth: 0 }}>
          <SectionTitle caps="Per-hotel" title="Per-hotel" italic="economics" />
          {econ.hotels.length === 0 ? (
            <EmptyState text="No hotels yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {econ.hotels.map((h) => <HotelEconRow key={h.propertyId} row={h} />)}
            </div>
          )}
        </section>

        <section style={{ minWidth: 0 }}>
          <SectionTitle caps="External" title="External" italic="dashboards" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
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

function SectionTitle({ caps, title, italic, right }: {
  caps: string; title: string; italic?: string; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 12, marginBottom: 4,
    }}>
      <div>
        <Caps>{caps}</Caps>
        <h2 style={{
          fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
          lineHeight: 1.15,
        }}>
          {title}
          {italic && <> <span style={{ fontStyle: 'italic' }}>{italic}</span></>}
        </h2>
      </div>
      {right}
    </div>
  );
}

function SummaryCell({ label, value, tone, last }: {
  label: string; value: string; tone: 'sage' | 'warm' | 'caramel' | 'neutral'; last?: boolean;
}) {
  const c = {
    sage:    T.sageDeep,
    warm:    T.warm,
    caramel: T.caramelDeep,
    neutral: T.ink,
  }[tone];
  return (
    <div style={{
      flex: '1 1 200px', minWidth: 160,
      padding: '18px 22px',
      borderRight: last ? 'none' : `1px solid ${T.rule}`,
    }}>
      <Caps size={9}>{label}</Caps>
      <div style={{ marginTop: 4 }}>
        <SerifNum size={32} italic c={c}>{value}</SerifNum>
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
      <SectionTitle
        caps="Expenses"
        title="Expenses"
        italic="& burn"
        right={!adding && (
          <Btn variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} /> Add
          </Btn>
        )}
      />

      {adding && (
        <Card padding="14px 16px" style={{
          marginTop: 8,
          border: `1px solid ${T.caramelDeep}`,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <FieldLabel text="Category">
            {isNewCategory ? (
              <input
                type="text"
                autoFocus
                placeholder="New category name"
                value={draft.customCategory}
                onChange={(e) => setDraft({ ...draft, customCategory: e.target.value })}
                onBlur={() => { if (!draft.customCategory.trim()) setDraft({ ...draft, category: 'hosting', customCategory: '' }); }}
                onKeyDown={(e) => { if (e.key === 'Escape') setDraft({ ...draft, category: 'hosting', customCategory: '' }); }}
                maxLength={60}
                style={inputStyle}
              />
            ) : (
              <select
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                style={inputStyle}
              >
                {categoryOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                <option disabled>──────────</option>
                <option value={NEW_CATEGORY_SENTINEL}>+ New category…</option>
              </select>
            )}
          </FieldLabel>
          <FieldLabel text="Amount (USD)">
            <input type="number" step="0.01" placeholder="0.00" value={draft.amountDollars}
              onChange={(e) => setDraft({ ...draft, amountDollars: e.target.value })} style={inputStyle} />
          </FieldLabel>
          <FieldLabel text="Description">
            <input type="text" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={inputStyle} />
          </FieldLabel>
          <FieldLabel text="Date">
            <input type="date" value={draft.incurredOn} onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} style={inputStyle} />
          </FieldLabel>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <Btn
              variant="primary"
              size="sm"
              onClick={create}
              disabled={!resolvedCategory || !(parseFloat(draft.amountDollars) > 0)}
            >
              <Save size={12} /> Save
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Btn>
          </div>
        </Card>
      )}

      {expenses.length === 0 ? (
        <EmptyState text="No expenses yet — add one to start tracking your monthly burn." />
      ) : (
        <Card padding="0" style={{ marginTop: 8 }}>
          {expenses.map((e, idx) => (
            <div key={e.id} style={{
              padding: '12px 16px',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto auto',
              gap: 12,
              alignItems: 'center',
              borderBottom: idx < expenses.length - 1 ? `1px solid ${T.rule}` : 'none',
              fontSize: 12,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: colorFor(e.category),
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
                  {labelFor(e.category)}
                  {e.source === 'auto' && (
                    <span style={{ fontSize: 9.5, marginLeft: 6, color: T.ink3, fontFamily: FONT_MONO, letterSpacing: '0.06em' }}>
                      AUTO
                    </span>
                  )}
                </div>
                <div style={{ color: T.ink3, fontSize: 11, marginTop: 1 }}>
                  {e.description ?? e.vendor ?? '—'} · {e.incurred_on}
                </div>
              </div>
              <MonoNum size={13} weight={600}>{formatUSD(e.amount_cents)}</MonoNum>
              {e.source === 'manual' ? (
                <button onClick={() => remove(e.id)} aria-label="Delete"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
                  <Trash2 size={12} color={T.ink3} />
                </button>
              ) : <span style={{ width: 20 }} />}
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

function HotelEconRow({ row }: { row: HotelEcon }) {
  const isPilot = row.mrrCents === 0;
  const marginColor = isPilot ? T.ink3
    : row.marginCents >= 0 ? T.sageDeep : T.warm;
  return (
    <Link href={`/admin/properties/${row.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card padding="14px 16px">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
            {row.propertyName ?? '(unnamed)'}
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, letterSpacing: '0.04em' }}>
            {(row.subscriptionStatus ?? '—').toUpperCase()}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Cell label="MRR" value={formatUSD(row.mrrCents)} c={T.sageDeep} />
          <Cell label="Claude" value={formatUSD(row.claudeCostLast30dCents)} c={T.ink2} />
          <Cell label="SMS" value={formatUSD(row.smsCostLast30dCents)} c={T.ink2} />
          <Cell label="Margin" value={formatUSD(row.marginCents)} c={marginColor} />
        </div>
      </Card>
    </Link>
  );
}

function Cell({ label, value, c }: { label: string; value: string; c: string }) {
  return (
    <div>
      <Caps size={9}>{label}</Caps>
      <div style={{ marginTop: 2 }}>
        <MonoNum size={12.5} weight={600} c={c}>{value}</MonoNum>
      </div>
    </div>
  );
}

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Caps>{text}</Caps>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 13, padding: '8px 12px',
  border: `1px solid ${T.rule}`, borderRadius: 10, outline: 'none',
  fontFamily: FONT_SANS, background: T.paper, color: T.ink,
  width: '100%', boxSizing: 'border-box',
};

function ExternalRow({ href, title, subtitle }: { href: string; title: string; subtitle: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 16px',
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 14,
      textDecoration: 'none',
      color: 'inherit',
      fontSize: 13,
    }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 2, color: T.ink, letterSpacing: '-0.005em' }}>{title}</div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, letterSpacing: '0.04em' }}>{subtitle}</div>
      </div>
      <ExternalLink size={14} color={T.ink3} />
    </a>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '24px 20px',
      background: T.ruleSoft,
      border: `1px dashed ${T.rule}`,
      borderRadius: 14,
      textAlign: 'center',
      fontSize: 12.5,
      color: T.ink2,
      fontStyle: 'italic',
      fontFamily: FONT_SERIF,
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
