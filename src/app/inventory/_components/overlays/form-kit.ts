// Shared form primitives for the inventory overlays.
//
// Three overlays each hand-rolled the same input style (identical shape,
// different size numbers) and the same type-time numeric guard; two more
// carried byte-identical banner() copies. This module is the one place those
// live now. Values are exact ports — do not "normalize" the sizes.

import type React from 'react';
import { bannerStyle } from '@/app/_components/ui/toast-core';
import { T, fonts } from '../tokens';

/** Accept only an empty string or a non-negative decimal in progress.
 *  Blocks "-5", "abc", "NaN", scientific notation at type-time so a saved
 *  number can never be negative or non-finite. */
export const numGuard = (v: string): boolean => v === '' || /^\d*\.?\d*$/.test(v);

/** Whole-number variant (lead days). */
export const intGuard = (v: string): boolean => v === '' || /^\d+$/.test(v);

const input = (
  height: number,
  padX: number,
  radius: number,
  fontSize: number,
): React.CSSProperties => ({
  width: '100%',
  height,
  padding: `0 ${padX}px`,
  borderRadius: radius,
  boxSizing: 'border-box',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans,
  fontSize,
  color: T.ink,
  outline: 'none',
});

/** ScanInvoiceSheet's `inputSm`. */
export const inputSm = input(36, 12, 9, 13.5);
/** OrderingSettingsPanel's `inputStyle`. */
export const inputMd = input(38, 12, 9, 13);
/** AddItemSheet's `inputStyle`. */
export const inputLg = input(40, 14, 10, 14);

/** Inline notice strip (OrdersPanel / OrderingSettingsPanel — previously two
 *  byte-identical local banner() copies). bannerStyle (F7) was parameterized
 *  from this exact style; the arguments below reproduce it byte-for-byte. */
export function banner(color: string): React.CSSProperties {
  return bannerStyle({
    background: T.paper,
    borderColor: color,
    color: T.ink,
    fontFamily: fonts.sans,
  });
}
