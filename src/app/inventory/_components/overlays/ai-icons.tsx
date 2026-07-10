// Line-art icons for the AI report's visual guide (stroke = currentColor,
// no fills). Extracted verbatim from AiReportSheet.tsx.

import React from 'react';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconClipboard() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <rect x={6} y={5} width={18} height={21} rx={2.5} />
      <rect x={11} y={2.5} width={8} height={5} rx={1.5} />
      <line x1={10.5} y1={13} x2={19.5} y2={13} />
      <line x1={10.5} y1={17.5} x2={19.5} y2={17.5} />
      <line x1={10.5} y1={22} x2={16} y2={22} />
    </svg>
  );
}

export function IconGauge() {
  // Occupancy %: a half-dial with the needle high.
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <path d="M4 21 A11 11 0 0 1 26 21" />
      <line x1={15} y1={21} x2={21.5} y2={12.5} />
      <circle cx={15} cy={21} r={1.6} fill="currentColor" stroke="none" />
      <line x1={6} y1={16.5} x2={8} y2={17.8} />
      <line x1={15} y1={10} x2={15} y2={12.4} />
      <line x1={24} y1={16.5} x2={22} y2={17.8} />
    </svg>
  );
}

export function IconTag() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <path d="M4 13 L13.5 3.5 L26 3.5 L26 16 L16.5 25.5 C15.5 26.5, 14 26.5, 13 25.5 L4 16.5 C3 15.5, 3 14, 4 13 Z" />
      <circle cx={20.5} cy={9} r={2} />
    </svg>
  );
}

export function IconCount() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <rect x={4} y={6} width={22} height={18} rx={2.5} />
      <line x1={4} y1={12} x2={26} y2={12} />
      <path d="M9 17.5 L11 19.5 L14.5 15.5" />
      <line x1={18} y1={18} x2={22} y2={18} />
    </svg>
  );
}

export function IconCompare() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <line x1={15} y1={4} x2={15} y2={26} />
      <path d="M8 9 C5.5 9, 4 11, 4 13 C4 15, 5.5 17, 8 17 C10.5 17, 12 15, 12 13 C12 11, 10.5 9, 8 9 Z" />
      <path d="M22 13 C19.5 13, 18 15, 18 17 C18 19, 19.5 21, 22 21 C24.5 21, 26 19, 26 17 C26 15, 24.5 13, 22 13 Z" />
    </svg>
  );
}

export function IconGrade() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <circle cx={15} cy={15} r={11} />
      <path d="M10 15.5 L13.5 19 L20 11.5" />
    </svg>
  );
}

export function IconBadge() {
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <circle cx={15} cy={12} r={7.5} />
      <path d="M11 18.5 L9 27 L15 23.5 L21 27 L19 18.5" />
      <path d="M12.2 12 L14.2 14 L18 9.8" />
    </svg>
  );
}

export function IconShield() {
  // "It can't order anything": the inventory stays behind this shield —
  // the AI never places orders or changes numbers on its own.
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <path d="M15 3.5 L25 7 C25 16, 21.5 23, 15 26.5 C8.5 23, 5 16, 5 7 Z" />
      <line x1={11} y1={12} x2={19} y2={12} />
      <line x1={11} y1={16.5} x2={16.5} y2={16.5} />
    </svg>
  );
}

export function IconMagnify() {
  // "Every miss gets caught": each count inspects the last prediction.
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" {...stroke}>
      <circle cx={13} cy={12.5} r={7.5} />
      <line x1={18.5} y1={18} x2={26} y2={25.5} />
      <path d="M9.8 12.8 L12.2 15.2 L16.5 10" />
    </svg>
  );
}
