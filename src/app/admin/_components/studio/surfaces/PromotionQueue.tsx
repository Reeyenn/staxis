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

   HOW A CARD IS LAID OUT, and why. The first version printed all of that on
   the card's face — a 200-character claim, migration numbers, base-prompt
   version history — and took three minutes to decode. A queue that costs three
   minutes a card is a queue nobody works, and an unworked queue is the same
   outcome as no privacy review at all. So the face of a card now carries five
   things and stops: who wrote it, what it says (cut to two lines), a drawn
   hotel-only → same-system → every-hotel journey, how many hotels it touches,
   and one line saying whether it is his call yet. Everything else — the full
   claim, the evidence, the provenance, the version archaeology, the hotel
   names, the exact wording — is folded into Details, not dropped. Nothing on a
   card is ever deleted; auditability is the point of the queue.

   This is presentation only. `blockedReasons` still decides whether Approve is
   live, exactly as before; `lockReason` is the same verdict said in one
   sentence, and both come from the server so the browser never re-derives a
   rule.

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
  /** `claim` cut to two lines. The full claim is still on `claim`, and the
   *  card shows it under Details whenever this differs. */
  headline: string;
  headlineTruncated: boolean;
  originLabel: string;
  journey: { from: string; to: string };
  /** One plain sentence. Empty exactly when `blockedReasons` is empty. */
  lockReason: string;
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

// ── The glanceable half of every card ─────────────────────────────────────
//
// Everything below the summary is one click away. Everything IN it has to
// land in about ten seconds without being read word by word, which is why the
// tier journey is drawn rather than described.

const CHIP: React.CSSProperties = {
  display: 'inline-block', padding: '3px 9px', borderRadius: 999,
  fontSize: 10.5, fontWeight: 600, lineHeight: 1.35, whiteSpace: 'nowrap',
};

const ACCENT = {
  gold: { bg: 'rgba(201,154,46,.14)', br: 'rgba(201,154,46,.34)', fg: 'var(--gold)' },
  forest: { bg: 'rgba(60,156,104,.14)', br: 'rgba(60,156,104,.34)', fg: 'var(--forest)' },
} as const;

type Accent = keyof typeof ACCENT;

/** Where a piece of knowledge lives now → where it is asking to go. The arrow
 *  is decoration; the group carries the whole sentence for a screen reader. */
export function TierJourney({ from, to, tone = 'gold' }: { from: string; to: string; tone?: Accent }) {
  const a = ACCENT[tone];
  return (
    <div
      role="group"
      aria-label={`Moving from ${from} to ${to}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}
    >
      <span style={{ ...CHIP, background: 'transparent', border: `1px solid ${dimWhite(.16)}`, color: dimWhite(.55) }}>
        {from}
      </span>
      <span aria-hidden="true" className="mono" style={{ fontSize: 12, color: dimWhite(.3) }}>→</span>
      <span style={{ ...CHIP, background: a.bg, border: `1px solid ${a.br}`, color: a.fg }}>{to}</span>
    </div>
  );
}

function StatusLine({ tone, lead, body }: { tone: Extract<DotTone, 'gold' | 'forest'>; lead: string; body: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 8 }}>
      <Dot tone={tone} size={6} style={{ marginTop: 4 }} />
      <div style={{ fontSize: 11, lineHeight: 1.45, color: dimWhite(.66) }}>
        <span style={{ color: ACCENT[tone].fg, fontWeight: 600 }}>{lead}</span>
        {body ? ` — ${body}` : null}
      </div>
    </div>
  );
}

/**
 * The part of a card that is meant to be read at a glance: who wrote it, what
 * it says, where it is going, who it touches, and whether it is his call yet.
 *
 * Hook-free on purpose — this is the piece the tests walk.
 */
export function PromotionSummary({ p, live = false }: { p: PromotionView; live?: boolean }) {
  const locked = p.blockedReasons.length > 0;
  const hotels = `${p.blastRadius.count} hotel${p.blastRadius.count === 1 ? '' : 's'}`;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="caps" style={{ fontSize: 8.5, color: dimWhite(.38) }}>{p.originLabel}</span>
        {p.changesBehaviour && (
          <Pill tone="gold" style={{ fontSize: 8, padding: '1px 6px' }}>Changes how the AI behaves</Pill>
        )}
      </div>

      {/* Clamped in CSS as well as cut on the server: a stored claim with no
          spaces in it would defeat the server-side cut, and nothing on this
          card is allowed to overflow. */}
      <div style={{
        fontSize: 13, fontWeight: 600, color: '#fff', lineHeight: 1.4, marginTop: 4,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', overflowWrap: 'anywhere',
      }}>
        {p.headline}
      </div>

      <TierJourney from={p.journey.from} to={p.journey.to} tone={live ? 'forest' : 'gold'} />

      <div style={{ fontSize: 10.5, color: dimWhite(.4), marginTop: 7 }}>
        {live ? 'Reaches' : 'Would reach'} {hotels}
      </div>

      {live ? (
        p.expired
          ? <StatusLine tone="gold" lead="Needs a look" body="Confirm it is still true, or pull it back." />
          : <StatusLine
              tone="forest"
              lead="Live"
              body={p.daysLeft != null ? `Next check-in in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}.` : ''}
            />
      ) : locked ? (
        <StatusLine tone="gold" lead="Locked" body={p.lockReason} />
      ) : (
        <StatusLine tone="forest" lead="Your call" body="Nothing is blocking it." />
      )}
    </>
  );
}

// ── Details ───────────────────────────────────────────────────────────────
// Nothing is deleted from a card, only folded. Every line the old card showed
// on its face still exists here, which is what keeps the queue auditable.

const TOGGLE: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, marginTop: 10,
  cursor: 'pointer', color: dimWhite(.5), fontSize: 10.5,
};

const DETAILS_BOX: React.CSSProperties = {
  marginTop: 9, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10,
};

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="caps" style={{ fontSize: 8, color: dimWhite(.32) }}>{label}</div>
      <div style={{ fontSize: 11, color: dimWhite(.62), marginTop: 3, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

function reachDetail(p: PromotionView) {
  return p.blastRadius.count === 0
    ? `${p.audience} — no hotels yet.`
    : `${p.audience} — ${p.blastRadius.hotels.map((h) => h.name).join(', ')}`;
}

const WORDING: React.CSSProperties = {
  margin: '0', padding: 10, background: 'rgba(0,0,0,.3)', borderRadius: 9,
  fontSize: 10.5, color: dimWhite(.7), whiteSpace: 'pre-wrap',
  wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
};

/** The forest button variant is built for the light studio surfaces; its
 *  foreground is `--forest-deep`, which on this near-black card reads as a
 *  disabled control. Same reason the ghost buttons here already override to
 *  white — the primary action must not look switched off. */
const FOREST_ON_DARK: React.CSSProperties = { color: 'var(--forest)', borderColor: 'rgba(60,156,104,.45)' };

/**
 * Everything the face of a card folds away, in one place: the claim in full,
 * who it reaches by name, the evidence, the provenance, the background
 * paragraph, and the full blocking reasons. Nothing on a card is deleted, only
 * folded — auditability is the point of the queue — and this is the component
 * that has to keep proving it.
 *
 * The wording block arrives as `children` because it is editable on a card
 * awaiting a decision and read-only on one already live.
 *
 * Hook-free on purpose: this is the piece the tests walk.
 */
export function PromotionDetails({ p, live = false, children }: {
  p: PromotionView; live?: boolean; children?: React.ReactNode;
}) {
  const blocked = p.blockedReasons.length > 0;
  return (
    <div style={{ ...DETAILS_BOX, borderTop: `1px solid ${dimWhite(.09)}` }}>
      {p.headlineTruncated && <DetailBlock label="What it says, in full">{p.claim}</DetailBlock>}
      <DetailBlock label={live ? 'Who relied on this' : 'Who it reaches'}>{reachDetail(p)}</DetailBlock>
      <DetailBlock label="Evidence">{p.evidence}</DetailBlock>
      <DetailBlock label="Where it came from">{p.cameFrom}</DetailBlock>
      {p.isAggregate && <DetailBlock label="Note">This compares hotels against each other.</DetailBlock>}
      {p.evidenceSummary && <DetailBlock label="Background">{p.evidenceSummary}</DetailBlock>}
      {blocked && (
        <DetailBlock label="Why it is locked">
          {p.blockedReasons.map((r, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 0 : 5 }}>{r}</div>
          ))}
        </DetailBlock>
      )}
      {children}
    </div>
  );
}

// ── A card waiting for a decision ─────────────────────────────────────────
// Exported so a whole card — summary, Details, buttons — can be rendered on
// its own, without the panel's fetch, for tests and for eyeballing the states
// the live database happens not to be showing today.
export function PendingCard({ p, busy, onDecide }: {
  p: PromotionView; busy: boolean;
  onDecide: (id: string, decision: Decision, content?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.proposedContent);
  const [confirmReject, setConfirmReject] = useState(false);

  const blocked = p.blockedReasons.length > 0;
  const edited = draft !== p.proposedContent;

  return (
    <DarkCard style={{ padding: '12px 14px' }}>
      <PromotionSummary p={p} />

      <button onClick={() => setOpen((o) => !o)} style={TOGGLE}>
        {open ? '▾ Hide details' : '▸ Details'}
      </button>

      {open && (
        <PromotionDetails p={p}>
          <DetailBlock label="The exact wording">
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={10}
                style={{
                  width: '100%', padding: 10, borderRadius: 9,
                  background: 'rgba(0,0,0,.3)', color: dimWhite(.85),
                  border: `1px solid ${dimWhite(.18)}`, fontSize: 11, lineHeight: 1.5,
                  fontFamily: 'var(--mono)', resize: 'vertical',
                }}
              />
            ) : (
              <pre className="mono" style={WORDING}>{draft}</pre>
            )}
            <Btn
              size="sm" variant="ghost" disabled={busy}
              onClick={() => { if (editing) setDraft(p.proposedContent); setEditing((e) => !e); }}
              style={{ fontSize: 9.5, padding: '3px 10px', marginTop: 7, color: '#fff', borderColor: dimWhite(.25) }}
            >
              {editing ? 'Undo my edits' : 'Edit the wording'}
            </Btn>
          </DetailBlock>
        </PromotionDetails>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11, flexWrap: 'wrap' }}>
        <Btn
          size="sm"
          variant="forest"
          disabled={busy || blocked}
          onClick={() => onDecide(p.id, 'approve', edited ? draft : undefined)}
          style={{ fontSize: 9.5, padding: '3px 10px', ...FOREST_ON_DARK }}
        >
          {busy ? 'Working…' : edited ? 'Approve my edit' : 'Approve'}
        </Btn>

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
    </DarkCard>
  );
}

// ── A card that is already live ───────────────────────────────────────────
export function PromotedCard({ p, busy, onDecide }: {
  p: PromotionView; busy: boolean;
  onDecide: (id: string, decision: Decision, content?: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <DarkCard style={{ padding: '11px 13px', background: dimWhite(.05) }}>
      <PromotionSummary p={p} live />

      <div className="mono" style={{ fontSize: 9, color: dimWhite(.35), marginTop: 7 }}>
        live since {p.approvedAt ? `${age(p.approvedAt)} ago` : 'recently'}
        {p.reconfirmCount > 0 ? ` · confirmed again ${p.reconfirmCount}×` : ''}
      </div>

      <button onClick={() => setOpen((o) => !o)} style={TOGGLE}>
        {open ? '▾ Hide details' : '▸ Details'}
      </button>

      {open && (
        <PromotionDetails p={p} live>
          <DetailBlock label="The exact wording">
            <pre className="mono" style={WORDING}>{p.liveContent ?? p.proposedContent}</pre>
          </DetailBlock>
        </PromotionDetails>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11, flexWrap: 'wrap' }}>
        <Btn
          size="sm" variant={p.expired ? 'forest' : 'ghost'} disabled={busy}
          onClick={() => onDecide(p.id, 'reconfirm')}
          style={p.expired
            ? { fontSize: 9.5, padding: '3px 10px', ...FOREST_ON_DARK }
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
    </DarkCard>
  );
}
