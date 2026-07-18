// Shared form primitives for the inventory overlays.
//
// Three overlays each hand-rolled the same input style (identical shape,
// different size numbers) and the same type-time numeric guard; two more
// carried byte-identical banner() copies. This module is the one place those
// live now. Values are exact ports — do not "normalize" the sizes.

import type React from 'react';
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

/** Amber "this exact action is locked until retried" notice used by the count
 *  and delivery sheets (three previously byte-identical inline copies). */
export const warnBannerStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  borderRadius: 9,
  background: T.warmDim,
  color: T.warm,
  fontFamily: fonts.sans,
  fontSize: 12.5,
};

/** ScanInvoiceSheet's `inputSm`. */
export const inputSm = input(36, 12, 9, 13.5);
/** AddItemSheet's `inputStyle`. */
export const inputLg = input(40, 14, 10, 14);
