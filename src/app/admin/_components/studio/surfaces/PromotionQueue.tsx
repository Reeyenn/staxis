'use client';

/* ───────────────────────────────────────────────────────────────────────
   PANEL — Shared-knowledge approvals (Mission Control).

   Staxis AI knows things at three levels: everything it knows about EVERY
   hotel, everything true of every hotel on one property-management system,
   and everything about ONE hotel — which never leaves that hotel.

   This panel is the only place a fact moves up a level. A lesson learned at
   one hotel becoming advice given to hotels that never generated it crosses a
   privacy line, so Reeyen decides every one of them by hand. Hotels never see
   this panel and are never told their data contributed.

   NOT the hotel-side approval list. A manager approving "order towels" is a
   different queue with a different audience — the two are never merged.

   Each card has to earn a yes: what is claimed, who it would reach, how many
   hotels back it, over what stretch, and where it came from. When the evidence
   doesn't clear the bar for that level, or a requirement isn't met yet, Approve
   is switched off and the reason is written on the card.

   Approving is reversible — Pull back restores whatever was in place before.
   Rejecting is NOT: the item is never proposed again, which is why it takes a
   second click to confirm.

   Data: GET/POST /api/admin/mission/promotions (admin-only, service-role).
   Renders "not set up yet" rather than an error when the table isn't there.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Btn, Dot, Pill, age, type DotTone } from '../kit';
import { DarkCard, DarkEmpty, DarkSpinner, dimWhite } from '../surface-kit';

export interface PromotionView {
  id: string;
  topic: string;
  claim: string;
  evidenceSummary: string | null;
  proposedContent: string;
  liveContent: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'retracted';
  origin: 'learned' | 'authored';
  audience: string;
  cameFrom: string;
  evidence: string;
  supportingHotels: number;
  observations: number;
  isAggregate: boolean;
  barReason: string;
  blockedReasons: string[];
  expired: boolean;
  daysLeft: number | null;
  reconfirmCount: number;
  approvedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  blastRadius: { count: number; hotels: Array<{ id: string; name: string }> };
  changesBehaviour: boolean;
  createdAt: string;
}

interface QueuePayload {
  available: boolean;
  pending: PromotionView[];
  promoted: PromotionView[];
  counts: { pending: number; promoted: number; expired: number; needsAttention: number };
}

const EMPTY: QueuePayload = {
  available: true, pending: [], promoted: [],
  counts: { pending: 0, promoted: 0, expired: 0, needsAttention: 0 },
};

type Decision = 'approve' | 'reject' | 'retract' | 'reconfirm';

export function PromotionQueue() {
  const [payload, setPayload] = useState<QueuePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showPromoted, setShowPromoted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/admin/mission/promotions');
      const json = await res.json();
      if (json?.ok && json.data) setPayload(json.data as QueuePayload);
      else if (!json?.ok) setPayload(EMPTY);
    } catch {
      setPayload(EMPTY);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, decision: Decision, content?: string) => {
    if (busyId) return;
    setBusyId(id);
    setProblem(null);
    try {
      const res = await fetchWithAuth('/api/admin/mission/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, ...(content ? { content } : {}) }),
      });
      const json = await res.json();
      if (!json?.ok) setProblem(json?.error || 'That did not go through. Try again.');
      await load();
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusyId(null);
    }
  };

  const pending = payload?.pending ?? [];
  const promoted = payload?.promoted ?? [];
  const needs = payload?.counts.needsAttention ?? 0;

  return (
    <section style={{ minWidth: 0 }}>
      <span className="caps" style={{ color: needs > 0 ? 'var(--gold)' : dimWhite(.5) }}>
        Shared-knowledge approvals · {needs}
      </span>
      <div style={{ fontSize: 11.5, color: dimWhite(.42), marginTop: 4, lineHeight: 1.45 }}>
        Only you see this. Each one takes something one hotel taught us and offers it to hotels
        that never gave us the information.
      </div>

      {!loaded ? (
        <div style={{ padding: '28px 0', textAlign: 'center' }}><DarkSpinner size={18} /></div>
      ) : payload?.available === false ? (
        <div style={{ marginTop: 10 }}><DarkEmpty text="Not switched on for this database yet." /></div>
      ) : (
        <>
          {problem && (
            <div style={{ marginTop: 10, padding: '9px 12px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)', borderRadius: 10, color: 'var(--terracotta)', fontSize: 11.5, lineHeight: 1.45 }}>
              {problem}
            </div>
          )}

          {pending.length === 0 ? (
            <div style={{ marginTop: 10 }}><DarkEmpty text="Nothing waiting on you." /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {pending.map((p) => (
                <PendingCard key={p.id} p={p} busy={busyId === p.id} onDecide={decide} />
              ))}
            </div>
          )}

          {/* What is already shared — collapsed by default; expired items pull
              the header amber so an item that quietly aged out can't hide. */}
          {promoted.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div
                onClick={() => setShowPromoted((o) => !o)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', padding: '9px 12px', background: dimWhite(.04), border: `1px solid ${dimWhite(.1)}`, borderRadius: 10 }}
              >
                <Dot tone={payload && payload.counts.expired > 0 ? 'gold' : 'forest'} size={7} />
                <span style={{ fontSize: 12, color: '#fff' }}>
                  {promoted.length} already shared
                </span>
                {payload && payload.counts.expired > 0 && (
                  <Pill tone="gold" style={{ fontSize: 8.5, padding: '2px 6px' }}>{payload.counts.expired} need re-confirming</Pill>
                )}
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: dimWhite(.4) }}>{showPromoted ? '▾' : '▸'}</span>
              </div>
              {showPromoted && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {promoted.map((p) => (
                    <PromotedCard key={p.id} p={p} busy={busyId === p.id} onDecide={decide} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── A card waiting for a decision ─────────────────────────────────────────
function PendingCard({ p, busy, onDecide }: {
  p: PromotionView; busy: boolean;
  onDecide: (id: string, decision: Decision, content?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.proposedContent);
  const [confirmReject, setConfirmReject] = useState(false);

  const blocked = p.blockedReasons.length > 0;
  const tone: DotTone = blocked ? 'muted' : 'gold';

  return (
    <DarkCard style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Dot tone={tone} size={8} style={{ marginTop: 4 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#fff', lineHeight: 1.4 }}>{p.claim}</div>

          {/* Who it reaches + what kind of change it is. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
            <Pill tone="teal" style={{ fontSize: 8.5, padding: '2px 7px' }}>{p.audience}</Pill>
            {p.changesBehaviour && (
              <Pill tone="gold" style={{ fontSize: 8.5, padding: '2px 7px' }}>Changes how the AI behaves</Pill>
            )}
            {p.isAggregate && (
              <Pill tone="neutral" style={{ fontSize: 8.5, padding: '2px 7px' }}>Compares hotels</Pill>
            )}
          </div>

          {/* The evidence — the whole reason this is a decision and not a switch. */}
          <div style={{ fontSize: 11, color: dimWhite(.55), marginTop: 7, lineHeight: 1.5 }}>
            {p.evidence}
            <br />
            <span style={{ color: dimWhite(.42) }}>From: {p.cameFrom}</span>
            <br />
            <span style={{ color: dimWhite(.42) }}>
              Would reach {p.blastRadius.count} hotel{p.blastRadius.count === 1 ? '' : 's'}
              {p.blastRadius.count > 0 && p.blastRadius.count <= 6
                ? ` — ${p.blastRadius.hotels.map((h) => h.name).join(', ')}`
                : ''}
            </span>
          </div>

          {p.evidenceSummary && (
            <div style={{ fontSize: 11, color: dimWhite(.5), marginTop: 6, lineHeight: 1.5, fontStyle: 'italic' }}>
              {p.evidenceSummary}
            </div>
          )}

          {blocked && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(201,154,46,.10)', border: '1px solid rgba(201,154,46,.32)', borderRadius: 9 }}>
              <div className="caps" style={{ fontSize: 8.5, color: 'var(--gold)' }}>Can&apos;t approve yet</div>
              {p.blockedReasons.map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: dimWhite(.72), marginTop: 4, lineHeight: 1.45 }}>{r}</div>
              ))}
            </div>
          )}

          {/* The exact wording — hidden by default so the card stays readable. */}
          <div style={{ marginTop: 9 }}>
            <button
              onClick={() => setOpen((o) => !o)}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: dimWhite(.55), fontSize: 10.5 }}
            >
              {open ? '▾ Hide the exact wording' : '▸ See the exact wording'}
            </button>
            {open && (
              editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={10}
                  style={{
                    width: '100%', marginTop: 7, padding: 10, borderRadius: 9,
                    background: 'rgba(0,0,0,.3)', color: dimWhite(.85),
                    border: `1px solid ${dimWhite(.18)}`, fontSize: 11, lineHeight: 1.5,
                    fontFamily: 'var(--mono)', resize: 'vertical',
                  }}
                />
              ) : (
                <pre className="mono" style={{ margin: '7px 0 0', padding: 10, background: 'rgba(0,0,0,.3)', borderRadius: 9, fontSize: 10.5, color: dimWhite(.7), whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto' }}>
                  {draft}
                </pre>
              )
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn
              size="sm"
              variant="forest"
              disabled={busy || blocked}
              onClick={() => onDecide(p.id, 'approve', draft !== p.proposedContent ? draft : undefined)}
              style={{ fontSize: 9.5, padding: '3px 10px', opacity: blocked ? .45 : 1 }}
            >
              {busy ? 'Working…' : draft !== p.proposedContent ? 'Approve my edit' : 'Approve'}
            </Btn>

            {open && (
              <Btn
                size="sm" variant="ghost" disabled={busy}
                onClick={() => { if (editing) setDraft(p.proposedContent); setEditing((e) => !e); }}
                style={{ fontSize: 9.5, padding: '3px 10px', color: '#fff', borderColor: dimWhite(.25) }}
              >
                {editing ? 'Undo my edits' : 'Edit the wording'}
              </Btn>
            )}

            {/* Rejecting is permanent — it takes a second, deliberate click. */}
            {confirmReject ? (
              <>
                <span style={{ fontSize: 10.5, color: 'var(--terracotta)' }}>Never suggest this again?</span>
                <Btn
                  size="sm" variant="terracotta" disabled={busy}
                  onClick={() => onDecide(p.id, 'reject')}
                  style={{ fontSize: 9.5, padding: '3px 10px' }}
                >
                  Yes, reject for good
                </Btn>
                <Btn
                  size="sm" variant="ghost" disabled={busy}
                  onClick={() => setConfirmReject(false)}
                  style={{ fontSize: 9.5, padding: '3px 10px', color: '#fff', borderColor: dimWhite(.25) }}
                >
                  Cancel
                </Btn>
              </>
            ) : (
              <Btn
                size="sm" variant="ghost" disabled={busy}
                onClick={() => setConfirmReject(true)}
                style={{ fontSize: 9.5, padding: '3px 10px', color: '#fff', borderColor: dimWhite(.25) }}
              >
                Reject
              </Btn>
            )}

            <span className="mono" style={{ marginLeft: 'auto', fontSize: 9, color: dimWhite(.35) }}>
              waiting {age(p.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </DarkCard>
  );
}

// ── A card that is already live ───────────────────────────────────────────
function PromotedCard({ p, busy, onDecide }: {
  p: PromotionView; busy: boolean;
  onDecide: (id: string, decision: Decision, content?: string) => void;
}) {
  const [showHotels, setShowHotels] = useState(false);
  const tone: DotTone = p.expired ? 'gold' : 'forest';
  const timing = p.expired
    ? 'Past its check-in date — confirm it is still true, or pull it back.'
    : p.daysLeft != null
      ? `Needs confirming again in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}.`
      : '';

  return (
    <DarkCard style={{ padding: '11px 13px', background: dimWhite(.05) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Dot tone={tone} size={7} style={{ marginTop: 4 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#fff', lineHeight: 1.4 }}>{p.claim}</div>
          <div style={{ fontSize: 10.5, color: dimWhite(.5), marginTop: 4, lineHeight: 1.45 }}>
            {p.audience} · live since {p.approvedAt ? `${age(p.approvedAt)} ago` : 'recently'}
            {p.reconfirmCount > 0 ? ` · confirmed again ${p.reconfirmCount}×` : ''}
          </div>
          {timing && (
            <div style={{ fontSize: 10.5, color: p.expired ? 'var(--gold)' : dimWhite(.42), marginTop: 3 }}>{timing}</div>
          )}

          <button
            onClick={() => setShowHotels((o) => !o)}
            style={{ background: 'none', border: 'none', padding: 0, marginTop: 6, cursor: 'pointer', color: dimWhite(.5), fontSize: 10 }}
          >
            {showHotels ? '▾' : '▸'} {p.blastRadius.count} hotel{p.blastRadius.count === 1 ? '' : 's'} relied on this
          </button>
          {showHotels && (
            <div style={{ fontSize: 10.5, color: dimWhite(.6), marginTop: 5, lineHeight: 1.5 }}>
              {p.blastRadius.count === 0 ? 'None yet.' : p.blastRadius.hotels.map((h) => h.name).join(', ')}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
            <Btn
              size="sm" variant={p.expired ? 'forest' : 'ghost'} disabled={busy}
              onClick={() => onDecide(p.id, 'reconfirm')}
              style={p.expired
                ? { fontSize: 9.5, padding: '3px 10px' }
                : { fontSize: 9.5, padding: '3px 10px', color: '#fff', borderColor: dimWhite(.25) }}
            >
              {busy ? 'Working…' : 'Still true — keep it'}
            </Btn>
            <Btn
              size="sm" variant="ghost" disabled={busy}
              onClick={() => onDecide(p.id, 'retract')}
              style={{ fontSize: 9.5, padding: '3px 10px', color: '#fff', borderColor: dimWhite(.25) }}
            >
              Pull it back
            </Btn>
          </div>
        </div>
      </div>
    </DarkCard>
  );
}
