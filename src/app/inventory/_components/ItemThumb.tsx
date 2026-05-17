'use client';

import React from 'react';
import { catColor, T, type InvCat } from './tokens';

// 13 hand-picked CSS abstract shapes. Each item picks one in `thumbKindFor`.
// Pure CSS — no emoji, no SVG illustration. Matches inventory-shared.jsx.
export type ThumbKind =
  | 'towel' | 'sheet' | 'tp' | 'bottle' | 'soap' | 'jug'
  | 'filter' | 'bulb' | 'battery' | 'tool'
  | 'coffee' | 'packet' | 'napkin' | 'dot';

interface ItemThumbProps {
  thumb: ThumbKind;
  cat: InvCat;
  size?: number;
  style?: React.CSSProperties;
}

export function ItemThumb({ thumb, cat, size = 44, style }: ItemThumbProps) {
  const c = catColor[cat] ?? T.ink2;
  const inner = renderInner(thumb, c);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        flexShrink: 0,
        background: T.bg,
        border: `1px solid ${T.rule}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        ...style,
      }}
    >
      {inner}
    </span>
  );
}

function renderInner(thumb: ThumbKind, c: string): React.ReactNode {
  switch (thumb) {
    case 'towel':
      return <span style={{ width: '58%', height: '66%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: 3 }} />;
    case 'sheet':
      return <span style={{ width: '64%', height: '48%', background: c + '22', border: `1.5px solid ${c}`, borderRadius: 2, transform: 'rotate(-6deg)' }} />;
    case 'tp':
      return <span style={{ width: '56%', height: '56%', background: c + '22', border: `1.5px solid ${c}`, borderRadius: '50%', boxShadow: `inset 0 0 0 6px ${c}11` }} />;
    case 'bottle':
      return <span style={{ width: '24%', height: '70%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '4px 4px 6px 6px' }} />;
    case 'soap':
      return <span style={{ width: '62%', height: '34%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '10px' }} />;
    case 'jug':
      return (
        <span style={{ width: '46%', height: '62%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '4px 4px 8px 8px', position: 'relative' }}>
          <span style={{ position: 'absolute', top: -4, right: -4, width: 8, height: 8, background: c, borderRadius: 2 }} />
        </span>
      );
    case 'filter':
      return <span style={{ width: '68%', height: '48%', background: `repeating-linear-gradient(90deg, ${c}55 0 3px, transparent 3px 6px)`, border: `1.5px solid ${c}`, borderRadius: 2 }} />;
    case 'bulb':
      return <span style={{ width: '40%', height: '56%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '50% 50% 30% 30%' }} />;
    case 'battery':
      return (
        <span style={{ width: '30%', height: '62%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: 3, position: 'relative' }}>
          <span style={{ position: 'absolute', top: -3, left: '25%', right: '25%', height: 3, background: c, borderRadius: 1 }} />
        </span>
      );
    case 'tool':
      return <span style={{ width: '14%', height: '70%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '30% 30% 4px 4px' }} />;
    case 'coffee':
      return <span style={{ width: '48%', height: '52%', background: c + '33', border: `1.5px solid ${c}`, borderRadius: '4px 4px 22px 22px' }} />;
    case 'packet':
      return <span style={{ width: '46%', height: '58%', background: c + '22', border: `1.5px dashed ${c}`, borderRadius: 2 }} />;
    case 'napkin':
      return <span style={{ width: '52%', height: '52%', background: c + '22', border: `1.5px solid ${c}`, transform: 'rotate(45deg)', borderRadius: 2 }} />;
    case 'dot':
    default:
      return <span style={{ width: '48%', height: '48%', background: c + '33', borderRadius: '50%' }} />;
  }
}

// Pick a thumb kind from an item name + category. Pure heuristic — keeps the
// UI varied without requiring a new DB column.
export function thumbKindFor(name: string, cat: InvCat): ThumbKind {
  const n = (name || '').toLowerCase();
  if (cat === 'breakfast') {
    if (/coffee|tea|espresso|pod/.test(n)) return 'coffee';
    if (/water|juice|milk|drink|beverage/.test(n)) return 'bottle';
    if (/packet|sugar|cream|sweetener|salt|pepper/.test(n)) return 'packet';
    if (/napkin|paper|plate|cup|utensil/.test(n)) return 'napkin';
    return 'coffee';
  }
  if (cat === 'maintenance') {
    if (/filter|hvac|air/.test(n)) return 'filter';
    if (/bulb|light|lamp|led/.test(n)) return 'bulb';
    if (/battery|batteries/.test(n)) return 'battery';
    return 'tool';
  }
  // housekeeping
  if (/towel|washcloth|rag/.test(n)) return 'towel';
  if (/sheet|pillow|duvet|linen|bedding/.test(n)) return 'sheet';
  if (/toilet|tissue|paper|kleenex/.test(n)) return 'tp';
  if (/shampoo|conditioner|lotion|wash|gel/.test(n)) return 'bottle';
  if (/soap|bar/.test(n)) return 'soap';
  if (/detergent|cleaner|bleach|spray|chemical|jug/.test(n)) return 'jug';
  return 'dot';
}
