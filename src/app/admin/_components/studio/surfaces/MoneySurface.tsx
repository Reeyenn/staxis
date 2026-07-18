'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Money · "Treasury" (dark). v2 layout 2026-07-18 (owner
   feedback on v1: "should be dropdown buttons… one list, not two… need a
   history… need Total Spent… need to see where the numbers come from").

   Three collapsible sections under a 3-number hero:
     1. AI usage — live Anthropic bill per workspace; each workspace card
        expands into the per-MODEL lines the bill is actually made of.
     2. Subscriptions — ONE merged list: auto-detected services (fixed
        names, AUTO tag) + the founder's own typed lines + orphan flags.
     3. History — every month since day one, expandable into daily rows.
   Hero: Money out (subs/mo + AI MTD) · Total spent (AI since day one) ·
   Money in (Pilot).

   Data: GET/POST /api/admin/money/tech-stack. All bill numbers are REAL
   (Anthropic Cost Admin API) — never estimated. Flat lines are typed once
   (seeded from real receipts) and audited by the scheduled bookkeeper;
   the "Check my subscriptions" button files a request for that audit.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { FONT_SERIF, Dot, Btn, type DotTone } from '../kit';
import { SurfaceShell, DarkCard, DarkSpinner, dimWhite } from '../surface-kit';

// ── API shapes (mirror /api/admin/money/tech-stack) ──────────────────────
interface WorkspaceSpend { workspaceId: string | null; name: string; monthUsd: number; todayUsd: number }
interface StackData {
  connected: boolean;
  billing: {
    todayUsd: number; monthUsd: number; totalUsd: number; monthStart: string;
    byWorkspace: WorkspaceSpend[];
    days: Array<{ date: string; usd: number }>;
    byModel: Array<{ workspaceId: string | null; label: string; usd: number }>;
  } | null;
  learning: { monthUsd: number; runs: number };
  detected: { key: string; name: string; desc: string }[];
  subscriptions: { id: string; name: string; monthlyUsd: number; serviceKey?: string }[];
  /** Real receipt-backed charges (payment_history, 0320) — newest first. */
  payments: Array<{ date: string; vendor: string; description: string | null; amountUsd: number }>;
  paymentsTotalUsd: number;
  auditRequestedAt: string | null;
}

interface EditLine { id: string; name: string; monthlyUsd: string; serviceKey?: string }

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newId = () => `sub_${Math.random().toString(36).slice(2, 10)}`;

/** Model ids → names a person recognizes, keeping the version so two
 *  Sonnet generations don't collapse into identical rows. */
function modelName(raw: string): string {
  const s = raw.toLowerCase();
  const version = (s.match(/(\d+)-(\d+)/) ? s.match(/(\d+)-(\d+)/)![0].replace('-', '.') : s.match(/-(\d+)$/)?.[1]) ?? '';
  if (s.includes('opus')) return `Claude Opus ${version} (the smart one)`.replace('  ', ' ');
  if (s.includes('sonnet')) return `Claude Sonnet ${version} (the fast one)`.replace('  ', ' ');
  if (s.includes('haiku')) return `Claude Haiku ${version} (the cheap one)`.replace('  ', ' ');
  return raw;
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ── Animated open/close (same 0fr↔1fr pattern as Mission Control) ────────
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .26s ease' }} aria-hidden={!open}>
      <div style={{ overflow: 'hidden', opacity: open ? 1 : 0, transition: 'opacity .22s ease' }}>{children}</div>
    </div>
  );
}

/** One big dropdown section: caps title + right-side summary, click to open. */
function Section({ title, summary, defaultOpen, children }: {
  title: string; summary: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <DarkCard style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '14px 16px', color: '#fff' }}
      >
        <span className="caps" style={{ color: dimWhite(.6) }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {summary}
          <span className="mono" style={{ fontSize: 12, color: dimWhite(.4) }}>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      <Reveal open={open}>
        <div style={{ padding: '0 16px 16px' }}>{children}</div>
      </Reveal>
    </DarkCard>
  );
}

/** A workspace's bill card, expandable into its per-model lines. */
function WorkspaceCard({ w, models }: {
  w: WorkspaceSpend;
  models: Array<{ label: string; usd: number }>;
}) {
  const [open, setOpen] = useState(false);
  const isHotel = w.workspaceId === null;
  return (
    <div style={{ background: dimWhite(.04), border: `1px solid ${dimWhite(.12)}`, borderRadius: 11 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '12px 14px', color: '#fff' }}
      >
        <Dot tone={w.monthUsd > 0 ? 'forest' : 'muted'} size={7} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{w.name}</div>
          <div style={{ fontSize: 10.5, color: dimWhite(.45), marginTop: 1 }}>
            {isHotel ? 'Robots, Copilot, scanning, reports, map learning' : 'Future AI employees — their own bucket from day one'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
          <div className="mono" style={{ fontSize: 13 }}>{money(w.monthUsd)}</div>
          <div className="mono" style={{ fontSize: 9, color: dimWhite(.4) }}>{money(w.todayUsd)} TODAY · {open ? 'CLOSE ▴' : 'WHERE FROM ▾'}</div>
        </div>
      </button>
      <Reveal open={open}>
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${dimWhite(.08)}` }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: '.1em', color: dimWhite(.45), margin: '10px 0 6px' }}>WHERE THIS MONTH&rsquo;S NUMBER COMES FROM</div>
          {models.length === 0 ? (
            <div style={{ fontSize: 11.5, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>
              {isHotel ? 'No spend yet this month.' : 'Nothing yet — lines appear here the day an AI employee does its first work.'}
            </div>
          ) : (
            models.map((m) => (
              <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0' }}>
                <span style={{ fontSize: 11.5, color: dimWhite(.75), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName(m.label)}</span>
                <span className="mono" style={{ fontSize: 11, color: '#fff', flexShrink: 0 }}>{money(m.usd)}</span>
              </div>
            ))
          )}
          {isHotel && models.length > 0 && (
            <div style={{ fontSize: 10, color: dimWhite(.4), marginTop: 8, lineHeight: 1.45 }}>
              These are the AI brains everything shares — the robots, Copilot, scanning and map learning all draw from them. Straight from Anthropic&rsquo;s bill, to the penny.
            </div>
          )}
        </div>
      </Reveal>
    </div>
  );
}

/** One month of payment history, expandable into its individual charges. */
function MonthRow({ month, usd, items }: {
  month: string; usd: number;
  items: Array<{ date: string; vendor: string; description: string | null; amountUsd: number }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: dimWhite(.04), border: `1px solid ${dimWhite(.12)}`, borderRadius: 11 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '11px 14px', color: '#fff' }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>{monthLabel(month)}</span>
        <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.4) }}>{items.length} charge{items.length === 1 ? '' : 's'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mono" style={{ fontSize: 12.5 }}>{money(usd)}</span>
          <span className="mono" style={{ fontSize: 10, color: dimWhite(.4) }}>{open ? '▴' : 'WHAT ▾'}</span>
        </span>
      </button>
      <Reveal open={open}>
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${dimWhite(.08)}` }}>
          {items.map((p, i) => (
            <div key={`${p.date}-${p.vendor}-${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0' }}>
              <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.4), flexShrink: 0, width: 74 }}>{dayLabel(p.date)}</span>
              <span style={{ fontSize: 11.5, color: '#fff', fontWeight: 600, flexShrink: 0 }}>{p.vendor}</span>
              <span style={{ fontSize: 10.5, color: dimWhite(.45), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description ?? ''}</span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: '#fff', flexShrink: 0 }}>{money(p.amountUsd)}</span>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  );
}

export function MoneySurface() {
  const [d, setD] = useState<StackData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditRequestedAt, setAuditRequestedAt] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/money/tech-stack');
      const json = await res.json();
      if (json.ok) {
        const data = json.data as StackData;
        setD(data);
        setLines(data.subscriptions.map((s) => ({ id: s.id, name: s.name, monthlyUsd: String(s.monthlyUsd), serviceKey: s.serviceKey })));
        setAuditRequestedAt(data.auditRequestedAt);
        setLoadErr(null);
      } else setLoadErr(json.error ?? 'Could not load the money board.');
    } catch (e) { setLoadErr(`Network error: ${(e as Error).message}`); }
  };
  useEffect(() => { void load(); }, []);

  // "Check my subscriptions" — files a request for the scheduled bookkeeper
  // (which reads the founder's receipt emails on his Mac). Not instant.
  const requestAudit = async () => {
    setAuditBusy(true);
    try {
      const res = await fetchWithAuth('/api/admin/money/tech-stack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_audit' }),
      });
      const json = await res.json();
      if (json.ok) setAuditRequestedAt(json.data?.auditRequestedAt ?? new Date().toISOString());
    } finally { setAuditBusy(false); }
  };

  const save = async () => {
    setSaving(true); setSaveNote(null);
    try {
      const payload = lines
        .filter((s) => s.name.trim() !== '')
        .map((s) => ({ id: s.id, name: s.name.trim(), monthlyUsd: parseFloat(s.monthlyUsd) || 0, serviceKey: s.serviceKey }));
      const res = await fetchWithAuth('/api/admin/money/tech-stack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: payload }),
      });
      const json = await res.json();
      if (json.ok) { setDirty(false); setSaveNote('Saved.'); }
      else setSaveNote(json.error ?? 'Could not save.');
    } catch (e) { setSaveNote(`Network error: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  const setAmount = (id: string, value: string) => {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, monthlyUsd: value.replace(/[^0-9.]/g, '') } : l)));
    setDirty(true);
  };
  const setName = (id: string, value: string) => {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, name: value } : l)));
    setDirty(true);
  };
  const removeLine = (id: string) => { setLines((ls) => ls.filter((l) => l.id !== id)); setDirty(true); };
  const setServiceAmount = (svc: { key: string; name: string }, value: string) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.serviceKey === svc.key);
      if (existing) return ls.map((l) => (l.serviceKey === svc.key ? { ...l, monthlyUsd: value.replace(/[^0-9.]/g, '') } : l));
      return [...ls, { id: newId(), name: svc.name, monthlyUsd: value.replace(/[^0-9.]/g, ''), serviceKey: svc.key }];
    });
    setDirty(true);
  };

  if (loadErr) return <SurfaceShell glow="goldTR"><div style={{ color: 'var(--terracotta)', fontSize: 13 }}>{loadErr}</div></SurfaceShell>;
  if (!d) return <SurfaceShell glow="goldTR"><div style={{ padding: '80px 0', textAlign: 'center' }}><DarkSpinner /></div></SurfaceShell>;

  const flatTotal = lines.reduce((s, l) => s + (parseFloat(l.monthlyUsd) || 0), 0);
  const detectedKeys = new Set(d.detected.map((s) => s.key));
  const lineForService = (key: string) => lines.find((l) => l.serviceKey === key);
  const personalLines = lines.filter((l) => !l.serviceKey);
  const orphanLines = lines.filter((l) => l.serviceKey && !detectedKeys.has(l.serviceKey));

  // History: fold real charges into months (newest first, charges newest first).
  const monthsMap = new Map<string, { usd: number; items: StackData['payments'] }>();
  for (const p of d.payments) {
    const ym = p.date.slice(0, 7);
    const entry = monthsMap.get(ym) ?? { usd: 0, items: [] };
    entry.usd += p.amountUsd;
    entry.items.push(p);
    monthsMap.set(ym, entry);
  }
  const months = [...monthsMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const modelsFor = (workspaceId: string | null) =>
    (d.billing?.byModel ?? []).filter((m) => m.workspaceId === workspaceId).map(({ label, usd }) => ({ label, usd }));

  const inputStyle: React.CSSProperties = {
    fontSize: 12, padding: '6px 9px', borderRadius: 8, outline: 'none',
    background: 'rgba(0,0,0,.3)', color: '#fff', border: `1px solid ${dimWhite(.2)}`,
  };

  return (
    <SurfaceShell glow="goldTR">
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <span className="caps" style={{ color: dimWhite(.55) }}>Money · Treasury</span>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
            What Staxis <span style={{ fontStyle: 'italic' }}>costs to run</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {auditRequestedAt ? (
            <span className="mono" style={{ fontSize: 10, color: 'var(--forest)' }}>
              CHECK REQUESTED — Claude reads your receipts &amp; updates this board, usually same day
            </span>
          ) : (
            <Btn size="sm" variant="forest" onClick={() => void requestAudit()} disabled={auditBusy}>
              {auditBusy ? '…' : 'Check my subscriptions'}
            </Btn>
          )}
          <Btn size="sm" variant="ghost" onClick={() => { void load(); }} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Refresh</Btn>
        </div>
      </header>

      {/* ── Hero: money out · total spent · money in ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 18, alignItems: 'start' }}>
        <DarkCard>
          <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>Money out</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            <div>
              <span className="serif-num" style={{ fontSize: 30, color: '#fff' }}>{money(flatTotal)}</span>
              <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.5), marginLeft: 6 }}>/MO SUBSCRIPTIONS</span>
            </div>
            <div>
              <span className="serif-num" style={{ fontSize: 30, color: '#fff' }}>{d.billing ? money(d.billing.monthUsd) : '—'}</span>
              <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.5), marginLeft: 6 }}>AI THIS MONTH</span>
            </div>
          </div>
        </DarkCard>
        <DarkCard>
          <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>Total paid · everything, from real receipts</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
            <span className="serif-num" style={{ fontSize: 30, color: '#fff' }}>{money(d.paymentsTotalUsd)}</span>
            <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.5) }}>SINCE DEC 2025 · EVERY CHARGE IN HISTORY BELOW</span>
          </div>
        </DarkCard>
        <DarkCard>
          <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>Money in</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
            <span className="serif-num" style={{ fontSize: 30, color: '#fff' }}>$0.00</span>
            <span className="mono" style={{ fontSize: 9.5, color: 'var(--gold)' }}>PILOT — HOTELS DON&rsquo;T PAY YET</span>
          </div>
        </DarkCard>
      </div>

      {/* ── Three dropdown sections ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <Section
          title="AI usage · live from Anthropic"
          defaultOpen
          summary={<span className="mono" style={{ fontSize: 12, color: '#fff' }}>{d.billing ? `${money(d.billing.monthUsd)} this month` : 'feed not answering'}</span>}
        >
          {d.connected && d.billing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {d.billing.byWorkspace.map((w) => (
                <WorkspaceCard key={w.workspaceId ?? 'default'} w={w} models={modelsFor(w.workspaceId)} />
              ))}
              <div style={{ fontSize: 10.5, color: dimWhite(.4) }}>
                Map learning: {money(d.learning.monthUsd)} of this month&rsquo;s Hotel-AI number{d.learning.runs > 0 ? ` (${d.learning.runs} run${d.learning.runs === 1 ? '' : 's'})` : ''}. Click a card to see exactly which AI brains the money went to. ~5 min behind.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--gold)', lineHeight: 1.5 }}>
              The live billing feed isn&rsquo;t answering right now — no numbers is better than fake numbers. Refresh in a minute.
            </div>
          )}
        </Section>

        <Section
          title="Subscriptions · everything with a monthly price"
          summary={<span className="mono" style={{ fontSize: 12, color: '#fff' }}>{money(flatTotal)}/mo</span>}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {d.detected.map((svc) => {
              const line = lineForService(svc.key);
              const amount = line?.monthlyUsd ?? '';
              const hasPrice = line !== undefined && line.monthlyUsd.trim() !== '';
              const isFree = hasPrice && (parseFloat(amount) || 0) === 0;
              const tone: DotTone = hasPrice ? (isFree ? 'muted' : 'forest') : 'gold';
              return (
                <div key={svc.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderBottom: `1px solid ${dimWhite(.07)}` }}>
                  <Dot tone={tone} size={7} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>
                      {svc.name}
                      <span className="mono" style={{ fontSize: 8, color: dimWhite(.35), marginLeft: 7, letterSpacing: '.08em' }}>AUTO-FOUND</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: dimWhite(.45), marginTop: 1 }}>{svc.desc}</div>
                  </div>
                  {!hasPrice && <span className="mono" style={{ fontSize: 9, color: 'var(--gold)', flexShrink: 0 }}>SET PRICE →</span>}
                  {isFree && <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.45), flexShrink: 0 }}>FREE</span>}
                  <input
                    value={amount} placeholder="$/mo" inputMode="decimal" className="mono"
                    onChange={(e) => setServiceAmount(svc, e.target.value)}
                    style={{ ...inputStyle, width: 62, textAlign: 'right', flexShrink: 0 }}
                  />
                </div>
              );
            })}
            {orphanLines.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderBottom: `1px solid ${dimWhite(.07)}` }}>
                <Dot tone="gold" size={7} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>{l.name}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--gold)', marginTop: 1 }}>Not detected in the stack anymore — cancelled? Remove the line if so.</div>
                </div>
                <span className="mono" style={{ fontSize: 12, color: '#fff' }}>{money(parseFloat(l.monthlyUsd) || 0)}</span>
                <button onClick={() => removeLine(l.id)} aria-label={`Remove ${l.name}`}
                  style={{ background: 'none', border: 'none', color: dimWhite(.4), fontSize: 14, cursor: 'pointer', padding: 2 }}>×</button>
              </div>
            ))}
            {personalLines.map((l) => (
              <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 4px', borderBottom: `1px solid ${dimWhite(.07)}` }}>
                <Dot tone={(parseFloat(l.monthlyUsd) || 0) > 0 ? 'forest' : 'muted'} size={7} />
                <input value={l.name} placeholder="e.g. Claude Max plan"
                  onChange={(e) => setName(l.id, e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                <input value={l.monthlyUsd} placeholder="$/mo" inputMode="decimal" className="mono"
                  onChange={(e) => setAmount(l.id, e.target.value)} style={{ ...inputStyle, width: 62, textAlign: 'right' }} />
                <button onClick={() => removeLine(l.id)} aria-label={`Remove ${l.name || 'line'}`}
                  style={{ background: 'none', border: 'none', color: dimWhite(.4), fontSize: 14, cursor: 'pointer', padding: 2 }}>×</button>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button
                onClick={() => { setLines([...lines, { id: newId(), name: '', monthlyUsd: '' }]); setDirty(true); }}
                className="mono"
                style={{ background: 'none', border: `1px solid ${dimWhite(.2)}`, borderRadius: 7, color: dimWhite(.6), fontSize: 9.5, letterSpacing: '.06em', padding: '5px 11px', cursor: 'pointer' }}
              >+ ADD A LINE</button>
              {dirty && <Btn size="sm" variant="forest" onClick={() => void save()} disabled={saving}>{saving ? '…' : 'Save'}</Btn>}
              {saveNote && <span style={{ fontSize: 10.5, color: saveNote === 'Saved.' ? 'var(--forest)' : 'var(--terracotta)' }}>{saveNote}</span>}
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: '#fff' }}>{money(flatTotal)}/mo</span>
            </div>
            <div style={{ fontSize: 10.5, color: dimWhite(.4) }}>
              AUTO-FOUND rows are discovered from what the app is wired to — new services appear by themselves. The bottom rows are yours to type. The weekly receipt check keeps every number honest.
            </div>
          </div>
        </Section>

        <Section
          title="History · every real charge, month by month"
          summary={<span className="mono" style={{ fontSize: 12, color: '#fff' }}>{money(d.paymentsTotalUsd)} total</span>}
        >
          {months.length === 0 ? (
            <div style={{ fontSize: 11.5, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>No payments recorded yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {months.map(([ym, m]) => (
                <MonthRow key={ym} month={ym} usd={Math.round(m.usd * 100) / 100} items={m.items} />
              ))}
              <div style={{ fontSize: 10.5, color: dimWhite(.4), lineHeight: 1.5 }}>
                Built from your actual receipts and kept current by the weekly check. The Anthropic &ldquo;API credits&rdquo; charges here are what FUND the AI-usage section above — usage burns those credits{d.billing ? ` (${money(d.billing.totalUsd)} burned so far)` : ''}, so the two views are the same money at different moments.
              </div>
            </div>
          )}
        </Section>
      </div>
    </SurfaceShell>
  );
}
