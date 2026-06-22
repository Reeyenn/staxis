// Shared design tokens + helpers for the redesigned housekeeper app
// (Claude Design handoff, June 2026).
//
// The handoff prototype hard-coded hex values; here we map them to the
// existing globals.css CSS variables where one exists, and keep the
// prototype's literal values only for the incidental surface colors that
// have no token (subtle panel greys, pill tints, etc.).
//
// Primary brand = teal (--teal #006565). "Done" = green (--green #16A34A).

import type { CSSProperties } from 'react';
import type { HousekeeperLocale } from '@/lib/translations';

export const TOK = {
  // brand (mapped to CSS vars at use-site via var(); literals kept for
  // gradients / particle colors where a JS value is needed)
  teal: '#006565',
  tealDeep: '#02615F',
  tealDeep2: '#0A7E78',
  green: '#16A34A',
  amber: '#CA8A04',
  red: '#ba1a1a',
  navy: '#364262',

  // ink scale
  ink: '#1b1c19',
  ink2: '#506071',
  ink3: '#8b8f97',

  // surfaces
  page: '#F4F5F7',
  card: '#FFFFFF',
  subtle: '#F6F7F9',
  doneBg: '#EAF7EE',
  doneBorder: '#BFE6CC',
  doneChip: '#DCFCE7',
  border: '#ECEDF0',
  borderSoft: '#EDEEF1',
  borderStrong: '#E5E7EB',
  openBorder: '#9FD6D2',

  // note panels
  mgrBg: '#FFFBEF',
  mgrBorder: '#F4E1B0',
  mgrText: '#7A5A12',
  issueBg: '#FEF2F2',
  issueBorder: '#F8C9C9',
  issueText: '#9B1C1C',

  // checklist pill
  chkBg: '#EAF4F3',
  chkBorder: '#CFE6E4',
  chkDoneBg: '#E7F6EC',

  // neutral control buttons
  ctrlBg: '#F2F3F5',
  ctrlInk: '#374151',
  ctrlInk2: '#6B7280',
  pausedBg: '#FEF3C7',
  pausedInk: '#92400E',
  pausedBorder: '#FDE68A',

  fontMono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
} as const;

// Big workflow button base (Start / Done / Resume / Stop).
export const bigBtn: CSSProperties = {
  height: 54,
  border: 'none',
  borderRadius: 15,
  fontSize: 16,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
};

// Footer control (Lunch / Report sick).
export const ctrlBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 13,
  borderRadius: 14,
  background: 'white',
  border: `1px solid ${TOK.border}`,
  fontSize: 14,
  fontWeight: 700,
  color: TOK.ink,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
};

// Fallback compact-checklist task labels by cleaning type, used only when
// the real per-type checklist template hasn't loaded yet. Mirrors the
// handoff prototype so the expanded card never looks empty.
//
// Bilingual: housekeepers are the primary Spanish-speaking users and open
// this page via an SMS link with no login. A slow/first load (template not
// yet fetched) must still show the fallback list in their language, not
// English. Keyed by locale; ht/tl/vi fall back to EN (same posture as the
// t() helper in translations.ts).
const FALLBACK_TASKS_BY_LANG: Partial<Record<HousekeeperLocale, Record<string, string[]>>> = {
  en: {
    checkout: [
      'Strip & remake beds',
      'Clean & sanitize bathroom',
      'Vacuum floors',
      'Dust all surfaces',
      'Restock amenities',
      'Empty all trash',
      'Check minibar & fridge',
      'Final walkthrough',
    ],
    stayover: [
      'Make beds',
      'Refresh towels',
      'Clean bathroom',
      'Empty trash',
      'Tidy surfaces',
      'Quick vacuum',
    ],
    vacant: ['Dust surfaces', 'Quick vacuum', 'Air out room', 'Spot check'],
  },
  es: {
    checkout: [
      'Deshacer y rehacer camas',
      'Limpiar y desinfectar el baño',
      'Aspirar pisos',
      'Quitar el polvo de las superficies',
      'Reponer amenidades',
      'Vaciar la basura',
      'Revisar minibar y refrigerador',
      'Revisión final',
    ],
    stayover: [
      'Hacer las camas',
      'Cambiar toallas',
      'Limpiar el baño',
      'Vaciar la basura',
      'Ordenar superficies',
      'Aspirado rápido',
    ],
    vacant: ['Quitar el polvo', 'Aspirado rápido', 'Ventilar la habitación', 'Revisión puntual'],
  },
};

/**
 * Fallback compact-checklist labels for a cleaning type in the housekeeper's
 * language. Unknown type → checkout list; unknown/partial locale → EN.
 */
export function fallbackTasks(type: string, lang: HousekeeperLocale = 'en'): string[] {
  const byLang = FALLBACK_TASKS_BY_LANG[lang] ?? FALLBACK_TASKS_BY_LANG.en!;
  return byLang[type] ?? byLang.checkout ?? FALLBACK_TASKS_BY_LANG.en!.checkout;
}
