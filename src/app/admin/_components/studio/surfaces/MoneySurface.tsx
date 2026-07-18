'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Money · "Treasury" (dark). Full rebuild 2026-07-18.

   Owner's spec: one page that always knows what running Staxis costs —
   the ENTIRE tech stack — with as little typing as possible. Replaced the
   old ledger of hand-typed expenses and the per-hotel profit math (both
   killed on owner order: stale inputs, no payers yet).

   Data: GET/POST /api/admin/money/tech-stack
     • billing   — REAL Anthropic dollars (Cost Admin API), split into the
                   Hotel-AI and AI-employees buckets. Never estimated.
     • detected  — services the app is provably wired to, discovered from
                   its own configuration. New integration ⇒ its row appears
                   by itself and asks for a price. Removed ⇒ leftover price
                   lines get flagged "not detected".
     • learning  — measured map-learning spend (workflow_jobs).
     • subscriptions — flat monthly lines { id, name, monthlyUsd,
                   serviceKey? }; serviceKey ties a line to a detected
                   service, the rest are the founder's personal subs.

   Money-in stays a single honest Pilot card until hotels pay.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { FONT_SERIF, Caps, Dot, Btn, type DotTone } from '../kit';
import { SurfaceShell, DarkCard, DarkSpinner, dimWhite } from '../surface-kit';

// ── API shapes (mirror /api/admin/money/tech-stack) ──────────────────────
interface WorkspaceSpend { workspaceId: string | null; name: string; monthUsd: number; todayUsd: number }
interface StackData {
  connected: boolean;
  billing: { todayUsd: number; monthUsd: number; monthStart: string; byWorkspace: WorkspaceSpend[] } | null;
  learning: { monthUsd: number; runs: number };
  detected: { key: string; name: string; desc: string }[];
  subscriptions: { id: string; name: string; monthlyUsd: number; serviceKey?: string }[];
}

/** Editable local copy of a flat line — amount kept as a string while typing. */
interface EditLine { id: string; name: string; monthlyUsd: string; serviceKey?: string }

const money = (n: number) => `$${n.toFixed(2)}`;
const newId = () => `sub_${Math.random().toString(36).slice(2, 10)}`;

export function MoneySurface() {
  const [d, setD] = useState<StackData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/money/tech-stack');
      const json = await res.json();
      if (json.ok) {
        const data = json.data as StackData;
        setD(data);
        setLines(data.subscriptions.map((s) => ({ id: s.id, name: s.name, monthlyUsd: String(s.monthlyUsd), serviceKey: s.serviceKey })));
        setLoadErr(null);
      } else setLoadErr(json.error ?? 'Could not load the money board.');
    } catch (e) { setLoadErr(`Network error: ${(e as Error).message}`); }
  };
  useEffect(() => { void load(); }, []);

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
  /** Typing a price for a detected service that has no line yet creates one. */
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
        <Btn size="sm" variant="ghost" onClick={() => { void load(); }} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Refresh</Btn>
      </header>

      {/* ── Hero: money out vs money in ─────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 26, alignItems: 'start' }}>
        <DarkCard>
          <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>Money out</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
            <div>
              <span className="serif-num" style={{ fontSize: 34, color: '#fff' }}>{money(flatTotal)}</span>
              <span className="mono" style={{ fontSize: 10, color: dimWhite(.5), marginLeft: 6 }}>/MO SUBSCRIPTIONS</span>
            </div>
            <div>
              <span className="serif-num" style={{ fontSize: 34, color: '#fff' }}>{d.billing ? money(d.billing.monthUsd) : '—'}</span>
              <span className="mono" style={{ fontSize: 10, color: dimWhite(.5), marginLeft: 6 }}>AI THIS MONTH · REAL BILL</span>
            </div>
          </div>
        </DarkCard>
        <DarkCard>
          <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>Money in</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
            <span className="serif-num" style={{ fontSize: 34, color: '#fff' }}>$0.00</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--gold)' }}>PILOT — HOTELS DON’T PAY YET</span>
          </div>
        </DarkCard>
      </div>

      {/* ── The tech-stack board ─────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>

        {/* Group 1 — live-billed (Anthropic) */}
        <div>
          <span className="caps" style={{ color: dimWhite(.5) }}>Billed by usage · live from Anthropic</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {d.connected && d.billing ? (
              <>
                {d.billing.byWorkspace.map((w) => (
                  <DarkCard key={w.workspaceId ?? 'default'} style={{ padding: '12px 15px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Dot tone={w.monthUsd > 0 ? 'forest' : 'muted'} size={7} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{w.name}</div>
                        <div style={{ fontSize: 10.5, color: dimWhite(.45), marginTop: 1 }}>
                          {w.workspaceId === null ? 'Robots, Copilot, scanning, reports — everything hotels use' : 'Future AI employees — their own bucket from day one'}
                        </div>
                      </div>
                      <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
                        <div className="mono" style={{ fontSize: 13, color: '#fff' }}>{money(w.monthUsd)}</div>
                        <div className="mono" style={{ fontSize: 9, color: dimWhite(.4) }}>{money(w.todayUsd)} TODAY</div>
                      </div>
                    </div>
                  </DarkCard>
                ))}
                <div style={{ fontSize: 10.5, color: dimWhite(.4), padding: '0 3px' }}>
                  Includes map learning: {money(d.learning.monthUsd)} this month{d.learning.runs > 0 ? ` (${d.learning.runs} run${d.learning.runs === 1 ? '' : 's'})` : ''}. Numbers come straight from Anthropic, ~5 min behind.
                </div>
              </>
            ) : (
              <DarkCard style={{ padding: '12px 15px' }}>
                <div style={{ fontSize: 12, color: 'var(--gold)', lineHeight: 1.5 }}>
                  The live billing feed isn’t answering right now — no numbers is better than fake numbers. Refresh in a minute.
                </div>
              </DarkCard>
            )}
          </div>
        </div>

        {/* Group 2 — auto-detected stack */}
        <div>
          <span className="caps" style={{ color: dimWhite(.5) }}>Detected in your stack · found automatically</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {d.detected.map((svc) => {
              const line = lineForService(svc.key);
              const amount = line?.monthlyUsd ?? '';
              const hasPrice = line !== undefined && line.monthlyUsd.trim() !== '';
              const isFree = hasPrice && (parseFloat(amount) || 0) === 0;
              const tone: DotTone = hasPrice ? (isFree ? 'muted' : 'forest') : 'gold';
              return (
                <DarkCard key={svc.key} style={{ padding: '11px 15px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Dot tone={tone} size={7} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{svc.name}</div>
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
                </DarkCard>
              );
            })}
            {orphanLines.map((l) => (
              <DarkCard key={l.id} style={{ padding: '11px 15px', borderColor: 'rgba(201,154,46,.35)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Dot tone="gold" size={7} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{l.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--gold)', marginTop: 1 }}>Not detected in the stack anymore — cancelled? Remove the line if so.</div>
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: '#fff' }}>{money(parseFloat(l.monthlyUsd) || 0)}</span>
                  <button onClick={() => removeLine(l.id)} aria-label={`Remove ${l.name}`}
                    style={{ background: 'none', border: 'none', color: dimWhite(.4), fontSize: 14, cursor: 'pointer', padding: 2 }}>×</button>
                </div>
              </DarkCard>
            ))}
            <div style={{ fontSize: 10.5, color: dimWhite(.4), padding: '0 3px' }}>
              Found from what the app is actually wired to — plug in a new service and its row appears here by itself.
            </div>
          </div>
        </div>

        {/* Group 3 — personal subscriptions + total */}
        <div>
          <span className="caps" style={{ color: dimWhite(.5) }}>Your own subscriptions · type once</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {personalLines.length === 0 && (
              <div style={{ fontSize: 11.5, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic', padding: '4px 3px' }}>
                Things no server can see — your Claude plan, Codex, …
              </div>
            )}
            {personalLines.map((l) => (
              <DarkCard key={l.id} style={{ padding: '10px 13px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input value={l.name} placeholder="e.g. Claude Max plan"
                    onChange={(e) => setName(l.id, e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                  <input value={l.monthlyUsd} placeholder="$/mo" inputMode="decimal" className="mono"
                    onChange={(e) => setAmount(l.id, e.target.value)} style={{ ...inputStyle, width: 62, textAlign: 'right' }} />
                  <button onClick={() => removeLine(l.id)} aria-label={`Remove ${l.name || 'line'}`}
                    style={{ background: 'none', border: 'none', color: dimWhite(.4), fontSize: 14, cursor: 'pointer', padding: 2 }}>×</button>
                </div>
              </DarkCard>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => { setLines([...lines, { id: newId(), name: '', monthlyUsd: '' }]); setDirty(true); }}
                className="mono"
                style={{ background: 'none', border: `1px solid ${dimWhite(.2)}`, borderRadius: 7, color: dimWhite(.6), fontSize: 9.5, letterSpacing: '.06em', padding: '5px 11px', cursor: 'pointer' }}
              >+ ADD A LINE</button>
              {dirty && <Btn size="sm" variant="forest" onClick={() => void save()} disabled={saving}>{saving ? '…' : 'Save'}</Btn>}
              {saveNote && <span style={{ fontSize: 10.5, color: saveNote === 'Saved.' ? 'var(--forest)' : 'var(--terracotta)' }}>{saveNote}</span>}
            </div>
            <DarkCard style={{ padding: '12px 15px', marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span className="caps" style={{ color: dimWhite(.5), fontSize: 9 }}>All subscriptions</span>
                <span className="serif-num" style={{ fontSize: 24, color: '#fff' }}>{money(flatTotal)}<span className="mono" style={{ fontSize: 10, color: dimWhite(.5) }}>/MO</span></span>
              </div>
            </DarkCard>
          </div>
        </div>
      </div>
    </SurfaceShell>
  );
}
