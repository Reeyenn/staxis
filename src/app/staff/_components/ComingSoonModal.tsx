// ComingSoonModal — friendly empty-state for the staff-side actions that
// aren't wired up yet (time-off requests, open-shift pickup, swap offers)
// and the manager-side "Publish week" / "Copy last week" buttons.
//
// The design ships these as live affordances, but the underlying tables and
// workflows are out of scope for this pass (Path A — visual first). Rather
// than hide the buttons, we surface them and tell the user what to do
// instead. This sets expectations and lets us measure interest before
// building the backend.

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { T, fonts, Btn } from './_tokens';

export type ComingSoonKind =
  | 'request-time-off'
  | 'pickup-shift'
  | 'swap-shift'
  | 'publish-week'
  | 'copy-last-week'
  | 'cell-edit';

const COPY: Record<ComingSoonKind, { title: string; body: string }> = {
  'request-time-off': {
    title: 'Time-off requests are coming soon',
    body:  "We're building this. For now, text your manager directly.",
  },
  'pickup-shift': {
    title: 'Open-shift pickup is coming soon',
    body:  "We're building this. For now, your manager will SMS you when shifts open up.",
  },
  'swap-shift': {
    title: 'Shift swaps are coming soon',
    body:  "We're building this. For now, ask your manager to swap on your behalf.",
  },
  'publish-week': {
    title: 'Week publishing is coming soon',
    body:  'For now, send tomorrow’s texts from Housekeeping → Schedule.',
  },
  'copy-last-week': {
    title: 'Copy-last-week is coming soon',
    body:  'For now, send tomorrow’s texts from Housekeeping → Schedule.',
  },
  'cell-edit': {
    title: 'Cell editing is coming soon',
    body:  'For now, edit tomorrow’s crew from Housekeeping → Schedule. The week grid is read-only.',
  },
};

const COPY_ES: Record<ComingSoonKind, { title: string; body: string }> = {
  'request-time-off': {
    title: 'Las solicitudes de tiempo libre llegarán pronto',
    body:  'Lo estamos construyendo. Por ahora, escribe directamente a tu gerente.',
  },
  'pickup-shift': {
    title: 'La toma de turnos abiertos llegará pronto',
    body:  'Lo estamos construyendo. Por ahora, tu gerente te enviará un SMS cuando se abran turnos.',
  },
  'swap-shift': {
    title: 'Los intercambios de turno llegarán pronto',
    body:  'Lo estamos construyendo. Por ahora, pídele a tu gerente que haga el cambio por ti.',
  },
  'publish-week': {
    title: 'La publicación de la semana llegará pronto',
    body:  'Por ahora, envía los mensajes de mañana desde Limpieza → Horario.',
  },
  'copy-last-week': {
    title: 'Copiar la semana pasada llegará pronto',
    body:  'Por ahora, envía los mensajes de mañana desde Limpieza → Horario.',
  },
  'cell-edit': {
    title: 'La edición de celdas llegará pronto',
    body:  'Por ahora, edita el equipo de mañana desde Limpieza → Horario. La cuadrícula semanal es de solo lectura.',
  },
};

export function ComingSoonModal({
  kind, onClose,
}: {
  kind: ComingSoonKind | null;
  onClose: () => void;
}) {
  const { lang } = useLang();
  if (!kind) return null;
  const { title, body } = (lang === 'es' ? COPY_ES : COPY)[kind];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.paper, borderRadius: 18,
          padding: '28px 30px 24px',
          maxWidth: 420, width: '100%',
          boxShadow: '0 24px 60px -8px rgba(31,42,32,0.24), 0 0 0 1px rgba(31,35,28,0.04)',
        }}
      >
        <h2 style={{
          margin: 0,
          fontFamily: fonts.sans, fontSize: 18,
          color: T.ink, letterSpacing: '-0.02em', lineHeight: 1.25, fontWeight: 600,
        }}>{title}</h2>
        <p style={{
          margin: '14px 0 22px',
          fontFamily: fonts.sans, fontSize: 14, color: T.ink2, lineHeight: 1.55,
        }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn variant="primary" size="md" onClick={onClose}>{lang === 'es' ? 'Entendido' : 'Got it'}</Btn>
        </div>
      </div>
    </div>
  );
}
