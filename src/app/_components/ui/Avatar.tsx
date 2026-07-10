'use client';

// Shared Avatar — initials-in-a-circle, theme-parameterized.
//
// The four existing implementations are near-identical but NOT interchangeable,
// so this component takes hashFn + palette (or a precomputed tone) as props.
// Each area must keep its byte-identical person→color assignment:
//
//   staff/_components/_people.tsx      hashes staff ID with an index-based
//                                      charCodeAt(i) loop over an 11-tone
//                                      palette; empty-name fallback '??'.
//   housekeeping/_components/_snow.tsx hashes staff ID with a for...of
//                                      (code-point) loop over a 6-tone
//                                      palette (first 6 of staff's 11).
//   maintenance/_components/_mt-snow.tsx same loop + palette as housekeeping
//                                      but hashes the NAME, not the ID.
//   communications/_components/comms-ui.tsx no hash at all — color comes from
//                                      the department, tinted background with
//                                      colored text instead of solid + white.
//
// The two hash loops produce identical numbers for ASCII/BMP strings (UUIDs,
// typical names) but diverge on astral-plane characters (emoji etc.), and the
// palettes/keys differ regardless — hence props, no baked-in palette here.
// Originals stay untouched until each area migrates.

import React from 'react';

/**
 * Initials from a display name: first letter of first + last word, or the
 * first two characters of a single word. Uppercased. `fallback` covers the
 * empty case — existing areas differ ('?' comms, '??' staff, '' hk/mt).
 */
export function initialsOf(name: string, fallback = '?'): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The staff-area hash (index-based charCodeAt loop, h*31, |0, abs).
 * Identical to housekeeping/maintenance's for...of variant on ASCII/BMP
 * input; areas whose keys could contain astral characters should pass their
 * own hashFn to preserve exact assignment.
 */
export function hashString31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

type ToneProps =
  | {
      /** Explicit background color — wins over palette hashing. */
      tone: string;
      palette?: never;
      hashFn?: never;
      hashKey?: never;
    }
  | {
      tone?: never;
      /** The area's own avatar tone palette (never defaulted here). */
      palette: readonly string[];
      /** Hash for person→palette index. Defaults to hashString31. */
      hashFn?: (key: string) => number;
      /** What to hash: staff ID (staff/hk) or name (maintenance). Defaults to `name`. */
      hashKey?: string;
    };

export type AvatarProps = ToneProps & {
  name: string;
  size?: number;
  /** Text color on the puck. Default white (solid-tone areas). */
  color?: string;
  /** Ring color — rendered as a 2px box-shadow ring; use `style.boxShadow` for fancier stacks. */
  ring?: string | null;
  /** The area's sans font stack. */
  fontFamily?: string;
  /** Override the derived font size (default round(size * 0.36)). */
  fontSize?: number;
  /** Empty-name initials fallback ('?' by default; staff uses '??'). */
  fallbackInitials?: string;
  style?: React.CSSProperties;
};

export function Avatar({
  name,
  tone,
  palette,
  hashFn = hashString31,
  hashKey,
  size = 32,
  color = '#fff',
  ring,
  fontFamily,
  fontSize,
  fallbackInitials = '?',
  style = {},
}: AvatarProps) {
  // The ToneProps union guarantees palette exists whenever tone is absent.
  const background =
    tone ?? palette![Math.abs(hashFn(hashKey ?? name)) % palette!.length];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background,
        color,
        fontFamily,
        fontSize: fontSize ?? Math.round(size * 0.36),
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        letterSpacing: '-0.01em',
        boxShadow: ring ? `0 0 0 2px ${ring}` : 'none',
        userSelect: 'none',
        ...style,
      }}
    >
      {initialsOf(name, fallbackInitials)}
    </span>
  );
}
