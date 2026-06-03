'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Money · "Treasury" (dark).

   The design-handoff finalized Money screen (money.jsx → MoneyTreasury,
   final: 3), wired to the real Money data the prior MoneyTab used.

   Data (same endpoints the prior MoneyTab fetched):
     • GET    /api/admin/expenses              → ledger (auto + manual rows)
     • GET    /api/admin/per-hotel-economics   → per-hotel MRR / cost / margin
   Mutations kept verbatim:
     • POST   /api/admin/expenses  { category, amountCents, description,
                                     vendor, incurredOn }  → manual row
     • DELETE /api/admin/expenses  { id }                  → manual rows only

   Economics math (preserved from the prior tab + endpoint):
     per hotel  cost = claude + sms + fleetAlloc ;  margin = mrr − cost
   The endpoint already computes totalCostLast30dCents (= claude+sms+alloc)
   and marginCents (= mrr − total) per hotel, plus fleet-wide totals — we
   read those exact fields rather than recompute.

   Two summary groups (Revenue / Expenses / Profit):
     • "Total · to date"  — lifetime revenue (= total MRR; 0 in pilot since
        the endpoint has no monthly_amount_cents column yet) vs every logged
        expense the ledger returns (up to 12 months — the closest real
        "to date" figure; the prototype's MRR×months-active had per-hotel
        created dates the real endpoint doesn't expose).
     • "This month"       — current-month MRR vs current-month logged
        expenses (cutoff = 1st of month, mirrors the prior tab exactly).

   Pilot banner shows when total MRR = 0 (all hotels free) — data-driven.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  FONT_SERIF, FONT_MONO, FONT_SANS,
  Caps, Dot, Btn, SerifNum,
  countUp, sweepWidth, riseIn, usd, type DotTone,
} from '../kit';
import {
  SurfaceShell, DarkCard, DarkSpinner, dimWhite,
  Backdrop, MODAL_CARD,
} from '../surface-kit';

// ── Real API shapes (mirror the prior MoneyTab + the two endpoints) ──────
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

interface EconResponse {
  hotels: HotelEcon[];
  totals: {
    mrrCents: number;
    claudeCostLast30dCents: number;
    smsCostLast30dCents: number;
    fleetAllocatedCostLast30dCents: number;
    totalCostLast30dCents: number;
  };
}

// ── Category metadata (labels + colors per the design spec) ──────────────
interface CatDef { key: string; label: string; tone: DotTone | 'neutral'; }
const CATS: CatDef[] = [
  { key: 'claude_api', label: 'Claude API', tone: 'teal' },
  { key: 'twilio', label: 'Twilio (SMS)', tone: 'gold' },
  { key: 'supabase', label: 'Supabase', tone: 'forest' },
  { key: 'vercel', label: 'Vercel', tone: 'terracotta' },
  { key: 'fly', label: 'Fly.io', tone: 'gold' },
  { key: 'hosting', label: 'Hosting (other)', tone: 'teal' },
  { key: 'other', label: 'Other', tone: 'neutral' },
];
const NEW_CATEGORY_SENTINEL = '__new__';

const catLabel = (k: string): string => CATS.find((c) => c.key === k)?.label ?? k;
const catTone = (k: string): DotTone => {
  const t = CATS.find((c) => c.key === k)?.tone ?? 'neutral';
  return t === 'neutral' ? 'muted' : (t as DotTone);
};
const CAT_VAR: Record<string, string> = {
  teal: 'var(--teal)', gold: 'var(--gold)', forest: 'var(--forest)',
  terracotta: 'var(--terracotta)', neutral: 'var(--dim2)',
};
const catColor = (k: string): string => CAT_VAR[CATS.find((c) => c.key === k)?.tone ?? 'neutral'];

// ── This-month cutoff sum (mirrors prior tab exactly) ────────────────────
function thisMonthCents(list: Expense[]): number {
  const cut = new Date();
  cut.setDate(1);
  cut.setHours(0, 0, 0, 0);
  return list
    .filter((e) => Date.parse(e.incurred_on) >= cut.getTime())
    .reduce((s, e) => s + e.amount_cents, 0);
}

// ════════════════════════════════════════════════════════════════════════
//  SURFACE
// ════════════════════════════════════════════════════════════════════════
export function MoneySurface() {
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [econ, setEcon] = useState<EconResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<HotelEcon | null>(null);

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
      <SurfaceShell glow="forestTR">
        <span className="caps" style={{ color: dimWhite(.55) }}>Money · Treasury</span>
        <div style={{ marginTop: 18, color: 'var(--terracotta)', fontSize: 13 }}>{error}</div>
      </SurfaceShell>
    );
  }
  if (!expenses || !econ) {
    return (
      <SurfaceShell glow="forestTR">
        <span className="caps" style={{ color: dimWhite(.55) }}>Money · Treasury</span>
        <div style={{ padding: '80px 0', textAlign: 'center' }}><DarkSpinner /></div>
      </SurfaceShell>
    );
  }

  // Per-hotel rows, ranked best margin first (prototype sorts by margin desc).
  const hotels = [...econ.hotels].sort((a, b) => b.marginCents - a.marginCents);
  const isPilot = econ.totals.mrrCents === 0;

  // Total · to date vs This month.
  // Lifetime revenue = total MRR (0 while pilot — no monthly_amount_cents
  // column on the endpoint yet). Lifetime expense = every logged expense the
  // ledger returns (the closest real "to date" figure available).
  const lifeRevCents = econ.totals.mrrCents;
  const lifeExpCents = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const monthRevCents = econ.totals.mrrCents;
  const monthExpCents = thisMonthCents(expenses);

  // Spend by category · this month (from the ledger, this-month rows only).
  const monthCats = (() => {
    const cut = new Date(); cut.setDate(1); cut.setHours(0, 0, 0, 0);
    const m: Record<string, number> = {};
    for (const e of expenses) {
      if (Date.parse(e.incurred_on) < cut.getTime()) continue;
      m[e.category] = (m[e.category] ?? 0) + e.amount_cents;
    }
    return Object.entries(m).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  })();
  const catMax = Math.max(...monthCats.map((c) => c.v), 1);

  return (
    <SurfaceShell glow="forestTR">
      <span className="caps" style={{ color: dimWhite(.55) }}>Money · Treasury</span>

      {/* Pilot banner — data-driven, shows when total MRR = 0 */}
      {isPilot && (
        <div style={{
          margin: '14px 0 0',
          background: 'linear-gradient(180deg, rgba(201,154,46,.12), rgba(201,154,46,.02))',
          border: '1px solid rgba(201,154,46,.28)',
          borderRadius: 16, padding: '16px 20px',
        }}>
          <span className="caps" style={{ color: 'var(--gold)' }}>Pilot mode</span>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 22, fontWeight: 400,
            letterSpacing: '-0.02em', color: '#fff', margin: '4px 0',
          }}>
            All hotels are <span style={{ fontStyle: 'italic' }}>free</span>.
          </h2>
          <p style={{ fontSize: 13, color: dimWhite(.6), lineHeight: 1.5, margin: 0 }}>
            The cost numbers below are still real — see how expensive each hotel
            is to run before billing flips on.
          </p>
        </div>
      )}

      {/* Total · to date | This month — Revenue / Expenses / Profit */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 16, margin: '14px 0 26px',
      }}>
        <SummaryGroup title="Total · to date" revCents={lifeRevCents} expCents={lifeExpCents} />
        <SummaryGroup title="This month" revCents={monthRevCents} expCents={monthExpCents} accent />
      </div>

      {/* Spend by category · this month */}
      <div style={{
        marginBottom: 26, background: dimWhite(.04),
        border: `1px solid ${dimWhite(.12)}`, borderRadius: 14, padding: '16px 18px',
      }}>
        <span className="caps" style={{ color: dimWhite(.5) }}>Spend by category · this month</span>
        {monthCats.length === 0 ? (
          <p style={{ fontSize: 13, color: dimWhite(.45), fontStyle: 'italic', fontFamily: FONT_SERIF, margin: '12px 0 0' }}>
            No spend logged this month yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {monthCats.map((c) => <CatBar key={c.k} catKey={c.k} cents={c.v} max={catMax} />)}
          </div>
        )}
      </div>

      {/* Per-hotel economics | Expenses */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px,1fr))', gap: 20 }}>
        {/* Per-hotel economics · tap to break down */}
        <div style={{ minWidth: 0 }}>
          <span className="caps" style={{ color: dimWhite(.5) }}>Per-hotel economics · tap to break down</span>
          {hotels.length === 0 ? (
            <DarkEmptyInline text="No hotels yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {hotels.map((h) => (
                <button
                  key={h.propertyId}
                  onClick={() => setSel(h)}
                  style={{
                    textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
                    background: dimWhite(.05), border: `1px solid ${dimWhite(.12)}`,
                    borderRadius: 11, padding: '11px 13px', cursor: 'pointer', color: '#fff',
                    fontFamily: FONT_SANS,
                  }}
                >
                  <span style={{
                    fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{h.propertyName ?? '(unnamed)'}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--forest)' }}>{usd(h.mrrCents)}/mo</span>
                  <span className="mono" style={{ fontSize: 10.5, color: dimWhite(.5) }}>−{usd(h.totalCostLast30dCents)}</span>
                  <span className="mono" style={{
                    fontSize: 11, fontWeight: 700, width: 60, textAlign: 'right',
                    color: h.marginCents >= 0 ? 'var(--forest)' : 'var(--terracotta)',
                  }}>{usd(h.marginCents)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Expenses ledger + add form + external dashboards */}
        <ExpensesColumn expenses={expenses} reload={load} />
      </div>

      {sel && <HotelCostModal h={sel} onClose={() => setSel(null)} />}
    </SurfaceShell>
  );
}

// ── Summary group: Revenue / Expenses / Profit ───────────────────────────
function SummaryGroup({ title, revCents, expCents, accent }: {
  title: string; revCents: number; expCents: number; accent?: boolean;
}) {
  const profitCents = revCents - expCents;
  return (
    <div style={{
      background: accent ? 'rgba(60,156,104,.08)' : dimWhite(.04),
      border: `1px solid ${accent ? 'rgba(60,156,104,.25)' : dimWhite(.12)}`,
      borderRadius: 16, padding: '16px 20px',
    }}>
      <span className="caps" style={{ color: accent ? 'var(--forest)' : dimWhite(.55) }}>{title}</span>
      <div style={{ display: 'flex', gap: 24, marginTop: 12, flexWrap: 'wrap' }}>
        <SummaryFig label="Revenue" cents={revCents} c="var(--forest)" />
        <SummaryFig label="Expenses" cents={expCents} c="var(--terracotta)" neg />
        <SummaryFig label="Profit" cents={profitCents} c={profitCents >= 0 ? '#fff' : 'var(--terracotta)'} big />
      </div>
    </div>
  );
}

function SummaryFig({ label, cents, c, neg, big }: {
  label: string; cents: number; c: string; neg?: boolean; big?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const dollars = Math.abs(cents) / 100;
  const fmt = (x: number) => (neg ? '−$' : '$') + Math.round(x).toLocaleString();
  useEffect(() => { countUp(ref.current, 0, dollars, { dur: 1000, fmt }); }, [dollars]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.45), letterSpacing: '.1em' }}>{label.toUpperCase()}</div>
      <span ref={ref} className="serif-num" style={{ fontSize: big ? 32 : 26, color: c, marginTop: 3, display: 'inline-block' }}>
        {fmt(dollars)}
      </span>
    </div>
  );
}

// ── Category bar (dark) ──────────────────────────────────────────────────
function CatBar({ catKey, cents, max }: { catKey: string; cents: number; max: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (cents / max) * 100;
  useEffect(() => { sweepWidth(ref.current, pct, { dur: 760 }); }, [pct]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12,
        color: dimWhite(.85), width: 160, flexShrink: 0,
      }}>
        <Dot tone={catTone(catKey)} size={7} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{catLabel(catKey)}</span>
      </span>
      <div style={{ flex: 1, height: 9, background: dimWhite(.08), borderRadius: 5, overflow: 'hidden' }}>
        <div ref={ref} style={{ height: '100%', width: 0, background: catColor(catKey), borderRadius: 5 }} />
      </div>
      <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, width: 70, textAlign: 'right', flexShrink: 0, color: '#fff' }}>
        {usd(cents)}
      </span>
    </div>
  );
}

// ── Expenses column: ledger + add form + external dashboards ─────────────
function ExpensesColumn({ expenses, reload }: { expenses: Expense[]; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="caps" style={{ color: dimWhite(.5) }}>Expenses</span>
        {!adding && (
          <Btn size="sm" variant="ghost" onClick={() => setAdding(true)}
            style={{ color: '#fff', borderColor: dimWhite(.25), background: dimWhite(.06) }}>
            + Add expense
          </Btn>
        )}
      </div>

      {adding && <AddExpenseForm expenses={expenses} reload={reload} onClose={() => setAdding(false)} />}

      {expenses.length === 0 ? (
        <DarkEmptyInline text="No expenses yet — add one to start tracking burn." />
      ) : (
        <div style={{
          marginTop: 10, background: dimWhite(.04),
          border: `1px solid ${dimWhite(.12)}`, borderRadius: 12, overflow: 'hidden',
        }}>
          {expenses.map((e) => <ExpenseRow key={e.id} e={e} reload={reload} />)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Btn size="sm" variant="ghost" href="https://console.anthropic.com/cost"
          style={{ color: '#fff', borderColor: dimWhite(.25), background: dimWhite(.06) }}>Claude console ↗</Btn>
        <Btn size="sm" variant="ghost" href="https://dashboard.stripe.com/dashboard"
          style={{ color: '#fff', borderColor: dimWhite(.25), background: dimWhite(.06) }}>Stripe ↗</Btn>
      </div>
    </div>
  );
}

function ExpenseRow({ e, reload }: { e: Expense; reload: () => Promise<void> }) {
  const remove = async () => {
    if (!confirm('Delete this expense?')) return;
    await fetchWithAuth('/api/admin/expenses', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: e.id }),
    });
    await reload();
  };
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 11,
      alignItems: 'center', padding: '10px 13px',
      borderBottom: `1px solid ${dimWhite(.08)}`, fontSize: 12, fontFamily: FONT_SANS,
    }}>
      <Dot tone={catTone(e.category)} size={7} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {catLabel(e.category)}
          {e.source === 'auto' && (
            <span className="mono" style={{ fontSize: 8.5, marginLeft: 5, color: dimWhite(.4) }}>AUTO</span>
          )}
        </div>
        <div style={{ color: dimWhite(.5), fontSize: 11, marginTop: 1 }}>
          {e.description ?? e.vendor ?? '—'} · {e.incurred_on}
        </div>
      </div>
      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{usd(e.amount_cents)}</span>
      {e.source === 'manual' ? (
        <button onClick={remove} aria-label="Delete" title="Delete"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: dimWhite(.5), fontSize: 12 }}>
          ✕
        </button>
      ) : <span style={{ width: 12 }} />}
    </div>
  );
}

// ── Inline add-expense form (light card on the dark surface) ─────────────
function AddExpenseForm({ expenses, reload, onClose }: {
  expenses: Expense[]; reload: () => Promise<void>; onClose: () => void;
}) {
  const [category, setCategory] = useState('hosting');
  const [customCategory, setCustomCategory] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState(new Date().toISOString().slice(0, 10));

  // Default categories + any extra categories already present in the ledger.
  const categoryOptions = useMemo(() => {
    const seen = new Set(CATS.map((c) => c.key));
    const opts = CATS.map((c) => ({ key: c.key, label: c.label }));
    for (const e of expenses) {
      if (!seen.has(e.category)) {
        seen.add(e.category);
        opts.push({ key: e.category, label: catLabel(e.category) });
      }
    }
    return opts;
  }, [expenses]);

  const isNew = category === NEW_CATEGORY_SENTINEL;
  const resolved = isNew ? customCategory.trim() : category;
  const amtValid = parseFloat(amountDollars) > 0;

  const save = async () => {
    const dollars = parseFloat(amountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    if (!resolved) return;
    await fetchWithAuth('/api/admin/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: resolved,
        amountCents: Math.round(dollars * 100),
        description: description || null,
        vendor: null,
        incurredOn,
      }),
    });
    onClose();
    await reload();
  };

  const inp: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 11px',
    fontSize: 13, border: '1px solid var(--rule)', borderRadius: 10, outline: 'none',
    background: '#fff', color: 'var(--ink)', fontFamily: FONT_SANS,
  };

  return (
    <div style={{
      marginTop: 10, background: '#fff', border: '1px solid var(--gold-deep)',
      borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column',
      gap: 9, boxShadow: 'var(--shadow-md)', color: 'var(--ink)',
    }}>
      <label>
        <Caps size={9}>Category</Caps>
        {isNew ? (
          <input
            autoFocus
            placeholder="New category name"
            value={customCategory}
            onChange={(e) => setCustomCategory(e.target.value)}
            onBlur={() => { if (!customCategory.trim()) { setCategory('hosting'); setCustomCategory(''); } }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setCategory('hosting'); setCustomCategory(''); } }}
            maxLength={60}
            style={inp}
          />
        ) : (
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inp}>
            {categoryOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            <option disabled>──────────</option>
            <option value={NEW_CATEGORY_SENTINEL}>+ New category…</option>
          </select>
        )}
      </label>
      <label>
        <Caps size={9}>Amount (USD)</Caps>
        <input type="number" step="0.01" placeholder="0.00" value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)} style={inp} />
      </label>
      <label>
        <Caps size={9}>Description</Caps>
        <input value={description} onChange={(e) => setDescription(e.target.value)} style={inp} />
      </label>
      <label>
        <Caps size={9}>Date</Caps>
        <input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} style={inp} />
      </label>
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <Btn size="sm" variant="primary" onClick={save} disabled={!resolved || !amtValid}>Save</Btn>
        <Btn size="sm" variant="ghost" onClick={onClose}>Cancel</Btn>
      </div>
    </div>
  );
}

// ── Per-hotel cost-breakdown modal ───────────────────────────────────────
function HotelCostModal({ h, onClose }: { h: HotelEcon; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { riseIn(ref.current, { dy: 26, dur: 440 }); }, []);

  // Where the cost comes from — ranked; largest tagged TOP.
  const lines = [
    { label: 'Claude API', cents: h.claudeCostLast30dCents, tone: 'teal' as const },
    { label: 'SMS (Twilio)', cents: h.smsCostLast30dCents, tone: 'gold' as const },
    { label: 'Infrastructure', cents: h.fleetAllocatedCostLast30dCents, tone: 'terracotta' as const },
  ].sort((a, b) => b.cents - a.cents);
  const max = Math.max(...lines.map((l) => l.cents), 1);

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
        <Caps>Per-hotel economics</Caps>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 25, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 14px' }}>
          <span style={{ fontStyle: 'italic' }}>{h.propertyName ?? '(unnamed)'}</span>
        </h3>
        <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
          <div>
            <Caps size={9}>Revenue / mo</Caps>
            <div><SerifNum size={26} c="var(--forest-deep)">{usd(h.mrrCents)}</SerifNum></div>
          </div>
          <div>
            <Caps size={9}>Cost / mo</Caps>
            <div><SerifNum size={26} c="var(--terracotta)">{usd(h.totalCostLast30dCents)}</SerifNum></div>
          </div>
          <div>
            <Caps size={9}>Margin</Caps>
            <div><SerifNum size={26} c={h.marginCents >= 0 ? 'var(--forest-deep)' : 'var(--terracotta)'}>{usd(h.marginCents)}</SerifNum></div>
          </div>
        </div>
        <Caps size={9}>Where the cost comes from</Caps>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          {lines.map((l, i) => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, width: 130, flexShrink: 0 }}>
                <Dot tone={l.tone} size={7} />
                {l.label}
                {i === 0 && <span className="mono" style={{ fontSize: 8.5, color: 'var(--terracotta)', marginLeft: 2 }}>TOP</span>}
              </span>
              <div style={{ flex: 1, height: 9, background: 'var(--rule-soft)', borderRadius: 5, overflow: 'hidden' }}>
                <ModalBar pct={(l.cents / max) * 100} tone={l.tone} />
              </div>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, width: 64, textAlign: 'right', flexShrink: 0 }}>
                {usd(l.cents)}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18 }}><Btn variant="ghost" onClick={onClose}>Close</Btn></div>
      </div>
    </Backdrop>
  );
}

function ModalBar({ pct, tone }: { pct: number; tone: 'teal' | 'gold' | 'terracotta' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { sweepWidth(ref.current, pct, { dur: 700 }); }, [pct]);
  return <div ref={ref} style={{ height: '100%', width: 0, background: `var(--${tone})`, borderRadius: 5 }} />;
}

// ── Dashed empty-state inline on dark ────────────────────────────────────
function DarkEmptyInline({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 10, padding: '16px 14px', textAlign: 'center',
      border: `1px dashed ${dimWhite(.18)}`, borderRadius: 12,
      color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13,
    }}>{text}</div>
  );
}
