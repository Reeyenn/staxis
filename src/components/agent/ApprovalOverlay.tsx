'use client';

// ─── ApprovalOverlay — centered approval + result cards for AI actions ─────
//
// Renders (via a portal, above everything including the voice overlay) the
// card the user acts on when the AI proposes a data-changing action, plus the
// result-confirmation card after a decision resolves.
//
// Three surfaces, one component (shared by AskStaxisBar + /chat via
// useAgentChat):
//   • tier 'card'  — full card: summary + key fields, "Adjust" reveals inline
//                    editable fields (schema-driven), add-on checkboxes,
//                    Approve / Deny.
//   • tier 'quick' — compact card: summary + [Do it] [Cancel].
//   • result       — success (auto-dismisses) or failure (stays until closed).
//
// Only one approval card shows at a time (the queue head). Bilingual via
// useLang(). Snow design tokens + the shared staxis-* keyframes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Pencil, Send } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import type { PendingAction, ResultCard } from './approval-types';
import { EDITABLE_FIELDS } from './approval-types';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sage:     'var(--snow-sage, #9EB7A6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
  warm:     'var(--snow-warm, #B85C3D)',
};
const FONT_SANS = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";

export interface ApprovalOverlayProps {
  pendingActions: PendingAction[];
  resultCard: ResultCard | null;
  resolveAction: (
    id: string,
    decision: 'approve' | 'deny',
    opts?: { adjustedArgs?: Record<string, unknown>; addons?: string[] },
  ) => void;
  dismissResultCard: () => void;
  /** Per-card inline validation errors (keyed by pendingActionId). */
  actionErrors?: Record<string, string>;
}

export function ApprovalOverlay({ pendingActions, resultCard, resolveAction, dismissResultCard, actionErrors }: ApprovalOverlayProps) {
  const { lang } = useLang();
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => setMounted(true), []);
  const head = pendingActions[0] ?? null;
  const openKey = resultCard?.pendingActionId ?? head?.pendingActionId ?? null;

  useEffect(() => {
    if (!mounted || !openKey) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const first = dialog.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? dialog).focus();
    });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', trapFocus);
      priorFocusRef.current?.focus();
    };
  }, [mounted, openKey]);

  if (!mounted) return null;
  if (!head && !resultCard) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        background: 'rgba(20, 24, 20, 0.42)',
        backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
        animation: 'staxis-fade-in 0.18s ease-out',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={resultCard
        ? (lang === 'es' ? 'Resultado de la acción de Staxis' : 'Staxis action result')
        : (lang === 'es' ? 'Revisar acción de Staxis' : 'Review Staxis action')}
      tabIndex={-1}
      ref={dialogRef}
    >
      {/* Render priority: show a just-resolved RESULT confirmation FIRST, then
          the next queued approval card. A failure result requires an explicit
          dismissal — a queued sibling card must not hide it. Success/denial
          results auto-dismiss, so the next card surfaces right after. */}
      {resultCard ? (
        <ResultConfirmation key={resultCard.pendingActionId} card={resultCard} onDismiss={dismissResultCard} />
      ) : head ? (
        <ApprovalCard key={head.pendingActionId} action={head} resolveAction={resolveAction} inlineError={actionErrors?.[head.pendingActionId]} />
      ) : null}
    </div>,
    document.body,
  );
}

// ─── The approval card (both tiers) ────────────────────────────────────────
function ApprovalCard({
  action,
  resolveAction,
  inlineError,
}: {
  action: PendingAction;
  resolveAction: ApprovalOverlayProps['resolveAction'];
  inlineError?: string;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  // An inline validation error is always about an edit → open the Adjust panel
  // so the user lands on the field they need to fix.
  const [adjusting, setAdjusting] = useState(!!inlineError);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [checkedAddons, setCheckedAddons] = useState<Record<string, boolean>>({});

  // A late-arriving validation error (edit rejected server-side) opens Adjust.
  useEffect(() => { if (inlineError) setAdjusting(true); }, [inlineError]);

  const fields = EDITABLE_FIELDS[action.toolName] ?? [];
  const summary = es ? (action.summary.es || action.summary.en) : (action.summary.en || action.summary.es);

  const t = useMemo(() => ({
    approve: es ? 'Aprobar' : 'Approve',
    deny: es ? 'Cancelar' : 'Cancel',
    adjust: es ? 'Ajustar' : 'Adjust',
    doIt: es ? 'Hazlo' : 'Do it',
    cancel: es ? 'Cancelar' : 'Cancel',
    reviewHint: es ? 'Staxis quiere hacer esto:' : 'Staxis wants to do this:',
  }), [es]);

  const submit = (decision: 'approve' | 'deny') => {
    const adjustedArgs = Object.keys(edits).length > 0 ? edits : undefined;
    const addons = Object.entries(checkedAddons).filter(([, v]) => v).map(([k]) => k);
    resolveAction(action.pendingActionId, decision, { adjustedArgs, addons: addons.length ? addons : undefined });
  };

  // ── Quick tier: compact card ──
  if (action.tier === 'quick') {
    return (
      <div style={cardShell(320)}>
        <div style={{ ...bodyText, marginBottom: 14 }}>{summary}</div>
        {inlineError && <div style={inlineErrorStyle}>{inlineError}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={secondaryBtn} onClick={() => submit('deny')}>{t.cancel}</button>
          <button style={primaryBtn} onClick={() => submit('approve')}>
            <Check size={15} strokeWidth={2.6} /> {t.doIt}
          </button>
        </div>
      </div>
    );
  }

  // ── Card tier: full card ──
  return (
    <div style={cardShell(420)}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>
        {t.reviewHint}
      </div>
      <div style={{ ...bodyText, fontSize: 15, fontWeight: 500, marginBottom: adjusting ? 14 : 12 }}>{summary}</div>

      {adjusting && fields.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {fields.map((f) => {
            const cur = (f.key in edits ? edits[f.key] : action.args[f.key]) ?? '';
            const label = es ? f.label.es : f.label.en;
            return (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.ink3 }}>{label}</span>
                {f.kind === 'multiline' ? (
                  <textarea
                    value={String(cur)}
                    rows={3}
                    onChange={(e) => setEdits((p) => ({ ...p, [f.key]: e.target.value }))}
                    style={inputStyle}
                  />
                ) : f.kind === 'enum' ? (
                  <select
                    value={String(cur)}
                    onChange={(e) => setEdits((p) => ({ ...p, [f.key]: e.target.value }))}
                    style={inputStyle}
                  >
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.kind === 'number' ? 'number' : 'text'}
                    value={String(cur)}
                    onChange={(e) => setEdits((p) => ({ ...p, [f.key]: e.target.value }))}
                    style={inputStyle}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}

      {inlineError && <div style={{ ...inlineErrorStyle, marginBottom: 12 }}>{inlineError}</div>}

      {action.addons.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {action.addons.map((a) => (
            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, cursor: 'pointer', fontSize: 13, color: C.ink2, fontFamily: FONT_SANS }}>
              <input
                type="checkbox"
                checked={!!checkedAddons[a.id]}
                onChange={(e) => setCheckedAddons((p) => ({ ...p, [a.id]: e.target.checked }))}
                style={{ accentColor: C.sageDeep, width: 15, height: 15 }}
              />
              {a.label}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {fields.length > 0 && (
          <button
            style={ghostBtn}
            onClick={() => setAdjusting((v) => !v)}
            aria-pressed={adjusting}
          >
            <Pencil size={13} strokeWidth={2.2} /> {t.adjust}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button style={secondaryBtn} onClick={() => submit('deny')}>
          <X size={14} strokeWidth={2.4} /> {t.deny}
        </button>
        <button style={primaryBtn} onClick={() => submit('approve')}>
          <Send size={14} strokeWidth={2.4} /> {t.approve}
        </button>
      </div>
    </div>
  );
}

// ─── Result confirmation card ──────────────────────────────────────────────
function ResultConfirmation({ card, onDismiss }: { card: ResultCard; onDismiss: () => void }) {
  const { lang } = useLang();
  const es = lang === 'es';
  const success = card.ok && !card.denied;

  return (
    <div style={{ ...cardShell(360), textAlign: 'center', borderColor: success ? 'rgba(92, 122, 96, 0.28)' : card.denied ? C.rule : 'rgba(184, 92, 61, 0.28)' }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%', margin: '0 auto 12px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: success ? 'rgba(92, 122, 96, 0.12)' : card.denied ? C.ruleSoft : 'rgba(184, 92, 61, 0.10)',
        color: success ? C.sageDeep : card.denied ? C.ink3 : C.warm,
      }}>
        {success ? <Check size={20} strokeWidth={2.6} /> : <X size={20} strokeWidth={2.6} />}
      </div>
      <div style={{ ...bodyText, fontWeight: 500 }}>{card.summary}</div>
      {card.addonNotes.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: C.ink3, fontFamily: FONT_SANS }}>
          {card.addonNotes.join(' · ')}
        </div>
      )}
      {!success && card.error && (
        <div style={{ marginTop: 8, fontSize: 13, color: C.warm, fontFamily: FONT_SANS }}>{card.error}</div>
      )}
      {/* Success + denial auto-dismiss; failure stays with a close button. */}
      {!success && !card.denied && (
        <button style={{ ...secondaryBtn, marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onDismiss}>
          {es ? 'Cerrar' : 'Dismiss'}
        </button>
      )}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
function cardShell(maxWidth: number): React.CSSProperties {
  return {
    width: `min(${maxWidth}px, 92vw)`,
    background: C.bg,
    border: `1px solid ${C.rule}`,
    borderRadius: 16,
    padding: 18,
    boxShadow: '0 24px 60px -20px rgba(20, 30, 20, 0.35), 0 4px 12px -6px rgba(20, 30, 20, 0.2)',
    fontFamily: FONT_SANS,
    animation: 'staxis-pop-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  };
}
const bodyText: React.CSSProperties = { fontFamily: FONT_SANS, fontSize: 14, lineHeight: 1.5, color: C.ink, wordBreak: 'break-word' };
const inlineErrorStyle: React.CSSProperties = {
  fontFamily: FONT_SANS, fontSize: 12.5, lineHeight: 1.4, color: C.warm,
  background: 'rgba(184, 92, 61, 0.08)', border: '1px solid rgba(184, 92, 61, 0.22)',
  borderRadius: 8, padding: '7px 10px', marginBottom: 10, wordBreak: 'break-word',
};
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', resize: 'vertical',
  padding: '8px 10px', fontFamily: FONT_SANS, fontSize: 13.5, color: C.ink,
  background: C.bg, border: `1px solid ${C.rule}`, borderRadius: 8,
};
const baseBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 44, padding: '9px 14px', borderRadius: 10, fontFamily: FONT_SANS, fontSize: 13.5, fontWeight: 600,
  cursor: 'pointer', border: '1px solid transparent', transition: 'filter 0.14s, background 0.14s',
};
const primaryBtn: React.CSSProperties = { ...baseBtn, background: 'var(--staxis-approval-primary, #1F231C)', color: 'var(--staxis-approval-on-primary, #FFFFFF)', flex: 1 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: C.ruleSoft, color: C.ink2, border: `1px solid ${C.rule}` };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: 'transparent', color: C.ink2, padding: '9px 10px' };
