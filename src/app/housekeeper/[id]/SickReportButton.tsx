/**
 * Sick-callout entry point for the housekeeper mobile page.
 *
 * Renders one of two states:
 *   - Active state — no callout yet today. Shows a small "I can't work today"
 *     link (or "I need to leave" if there are started rooms). Tapping opens
 *     a modal asking reason + (mid-shift only) when. On submit, POSTs to
 *     /api/housekeeper/callout.
 *   - Reverted state — callout exists for today. Shows a banner explaining
 *     the situation with an "I CAN come in" button that POSTs to
 *     /api/housekeeper/callout/revert.
 *
 * Lives in its own file so the giant housekeeper page only needs to import
 * and render one component (keeps the conflict surface small with any
 * other branches editing the housekeeper page).
 *
 * Talks to the server through service-role-backed API routes (per the
 * RLS bug class in CLAUDE.md — no direct supabase.from() calls).
 */

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { t, type Language } from '@/lib/translations';

type Reason = 'sick' | 'family' | 'personal' | 'other';
type LeaveTiming = 'now' | 'in_15_min' | 'after_current_room';

interface Props {
  pid: string;
  staffId: string;
  businessDate: string;
  language: Language;
  /** True if the housekeeper has at least one started-not-completed room
      today. Drives the "I need to leave" label + leave-timing prompt. */
  isMidShift: boolean;
  /** Notify the parent so it can refetch rooms / hide other UI as needed. */
  onCalloutChange?: () => void;
}

interface ActiveCallout {
  calloutId: string;
  reason: Reason | null;
  leaveTiming: LeaveTiming | null;
}

export function SickReportButton({
  pid, staffId, businessDate, language, isMidShift, onCalloutChange,
}: Props) {
  const [active, setActive] = useState<ActiveCallout | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reason, setReason] = useState<Reason>('sick');
  const [note, setNote] = useState('');
  const [leaveTiming, setLeaveTiming] = useState<LeaveTiming>('now');
  const [submitting, setSubmitting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read existing callout from session — there's no public read endpoint
  // for this, but the parent will pass onCalloutChange after the report
  // route POST, which re-mounts via state. For initial load we trust the
  // POST response to seed `active`; if the page reloads mid-day we fall
  // back to optimistic "no callout" (manager can still see truth).
  // A future enhancement could add a public read endpoint scoped by
  // (pid, staffId) for the housekeeper's own callout state.

  useEffect(() => {
    if (!modalOpen) {
      setError(null);
    }
  }, [modalOpen]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/housekeeper/callout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid,
          staffId,
          businessDate,
          reason,
          note: note.trim() || undefined,
          leaveTiming: isMidShift ? leaveTiming : undefined,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { calloutId: string }; error?: string }
        | null;
      if (!res.ok || !body?.ok || !body.data?.calloutId) {
        setError(body?.error ?? labels.errSubmit[language]);
        return;
      }
      setActive({
        calloutId: body.data.calloutId,
        reason,
        leaveTiming: isMidShift ? leaveTiming : null,
      });
      setModalOpen(false);
      onCalloutChange?.();
    } catch {
      setError(labels.errSubmit[language]);
    } finally {
      setSubmitting(false);
    }
  }, [pid, staffId, businessDate, reason, note, leaveTiming, isMidShift, language, onCalloutChange]);

  const revert = useCallback(async () => {
    if (!active) return;
    if (!window.confirm(labels.confirmRevert[language])) return;
    setReverting(true);
    setError(null);
    try {
      const res = await fetch('/api/housekeeper/callout/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, staffId, businessDate }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? labels.errRevert[language]);
        return;
      }
      setActive(null);
      onCalloutChange?.();
    } catch {
      setError(labels.errRevert[language]);
    } finally {
      setReverting(false);
    }
  }, [active, pid, staffId, businessDate, language, onCalloutChange]);

  // ── Active callout: show a banner + revert button ─────────────────────
  if (active) {
    return (
      <div
        style={{
          padding: '12px 14px',
          background: '#FFF4E5',
          border: '1px solid #E0A878',
          borderRadius: 12,
          marginBottom: 12,
          fontSize: 14,
          color: '#7A4D1F',
          lineHeight: 1.45,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          {labels.activeTitle[language]}
        </div>
        <div style={{ marginBottom: 10, fontSize: 13 }}>
          {labels.activeBody[language]}
        </div>
        <button
          onClick={revert}
          disabled={reverting}
          style={{
            width: '100%',
            height: 44,
            border: '1px solid #8C6A33',
            borderRadius: 999,
            background: 'white',
            color: '#8C6A33',
            fontSize: 14,
            fontWeight: 600,
            cursor: reverting ? 'not-allowed' : 'pointer',
            opacity: reverting ? 0.6 : 1,
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          {reverting
            ? labels.reverting[language]
            : labels.iCanCome[language]}
        </button>
        {error ? (
          <div style={{ marginTop: 8, fontSize: 12, color: '#A04A2C' }}>{error}</div>
        ) : null}
      </div>
    );
  }

  // ── No callout yet: show the small "I can't work" link + modal ────────
  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        style={{
          width: '100%',
          padding: '10px 14px',
          background: 'transparent',
          border: '1px dashed rgba(184,92,61,0.4)',
          borderRadius: 10,
          color: '#A04A2C',
          fontSize: 13,
          fontWeight: 500,
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: 12,
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
        }}
      >
        {isMidShift ? labels.iNeedToLeave[language] : labels.iCantWork[language]}
      </button>

      {modalOpen ? (
        <Modal onClose={() => !submitting && setModalOpen(false)}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 12 }}>
            {isMidShift ? labels.iNeedToLeave[language] : labels.iCantWork[language]}
          </h2>

          <label style={fieldLabelStyle}>{labels.reasonLabel[language]}</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as Reason)}
            disabled={submitting}
            style={fieldInputStyle}
          >
            <option value="sick">{labels.reasonSick[language]}</option>
            <option value="family">{labels.reasonFamily[language]}</option>
            <option value="personal">{labels.reasonPersonal[language]}</option>
            <option value="other">{labels.reasonOther[language]}</option>
          </select>

          {isMidShift ? (
            <>
              <label style={fieldLabelStyle}>{labels.whenLabel[language]}</label>
              <select
                value={leaveTiming}
                onChange={(e) => setLeaveTiming(e.target.value as LeaveTiming)}
                disabled={submitting}
                style={fieldInputStyle}
              >
                <option value="now">{labels.timingNow[language]}</option>
                <option value="in_15_min">{labels.timingFifteen[language]}</option>
                <option value="after_current_room">{labels.timingAfterRoom[language]}</option>
              </select>
            </>
          ) : null}

          <label style={fieldLabelStyle}>{labels.noteLabel[language]}</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            placeholder={labels.notePlaceholder[language]}
            rows={3}
            maxLength={500}
            style={{ ...fieldInputStyle, resize: 'vertical' as const, minHeight: 60 }}
          />

          {error ? (
            <div style={{ color: '#A04A2C', fontSize: 13, marginTop: 8 }}>{error}</div>
          ) : null}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              onClick={() => setModalOpen(false)}
              disabled={submitting}
              style={{
                flex: 1,
                height: 44,
                border: '1px solid rgba(0,0,0,0.15)',
                borderRadius: 999,
                background: 'white',
                color: '#1A1F1B',
                fontSize: 14,
                fontWeight: 500,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {labels.cancel[language]}
            </button>
            <button
              onClick={submit}
              disabled={submitting}
              style={{
                flex: 1,
                height: 44,
                border: 'none',
                borderRadius: 999,
                background: '#A04A2C',
                color: 'white',
                fontSize: 14,
                fontWeight: 700,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? labels.submitting[language] : labels.confirm[language]}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// silence unused-import; t may be wired later when we keyify these strings
void t;

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: '#5C625C',
  margin: '10px 0 4px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const fieldInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  border: '1px solid rgba(0,0,0,0.15)',
  borderRadius: 10,
  background: 'white',
  color: '#1A1F1B',
  boxSizing: 'border-box',
};

function Modal({
  children, onClose,
}: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          width: '100%',
          maxWidth: 480,
          borderRadius: 18,
          padding: 20,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// String table — inlined here rather than threaded through translations.ts
// because these strings only render on this one page. Keeps the translation
// surface minimal and avoids a giant diff in src/lib/translations.ts.
const labels = {
  iCantWork: { en: "I can't work today", es: 'No puedo trabajar hoy' },
  iNeedToLeave: { en: 'I need to leave', es: 'Tengo que irme' },
  iCanCome: { en: 'Actually, I CAN come in', es: 'Sí puedo venir' },
  reverting: { en: 'Undoing…', es: 'Deshaciendo…' },
  activeTitle: { en: 'You reported off today', es: 'Hoy te reportaste ausente' },
  activeBody: {
    en: 'Your rooms are being handled by the team. If this was a mistake, tap the button to undo.',
    es: 'El equipo está cubriendo tus habitaciones. Si fue un error, toca el botón para deshacer.',
  },
  reasonLabel: { en: 'Reason', es: 'Razón' },
  reasonSick: { en: 'Sick', es: 'Enferm@' },
  reasonFamily: { en: 'Family emergency', es: 'Emergencia familiar' },
  reasonPersonal: { en: 'Personal', es: 'Personal' },
  reasonOther: { en: 'Other', es: 'Otra' },
  whenLabel: { en: 'When?', es: '¿Cuándo?' },
  timingNow: { en: 'Right now', es: 'Ahora mismo' },
  timingFifteen: { en: 'In 15 minutes', es: 'En 15 minutos' },
  timingAfterRoom: { en: 'After my current room', es: 'Después de mi habitación actual' },
  noteLabel: { en: 'Anything else? (optional)', es: '¿Algo más? (opcional)' },
  notePlaceholder: {
    en: "Add a short note for your manager (optional)",
    es: 'Agrega una nota corta para tu manager (opcional)',
  },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  confirm: { en: 'Confirm', es: 'Confirmar' },
  submitting: { en: 'Sending…', es: 'Enviando…' },
  errSubmit: {
    en: "Couldn't send your callout. Check your connection and try again.",
    es: 'No se pudo enviar tu ausencia. Verifica tu conexión.',
  },
  errRevert: {
    en: "Couldn't undo. Try again or text your manager.",
    es: 'No se pudo deshacer. Inténtalo de nuevo o escribe a tu manager.',
  },
  confirmRevert: {
    en: "You'll be back on shift and your rooms will return. Continue?",
    es: 'Volverás a tu turno y tus habitaciones regresarán. ¿Continuar?',
  },
};
