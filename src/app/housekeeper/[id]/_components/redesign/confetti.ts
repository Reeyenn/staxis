// DOM-particle confetti burst (canvas-free) — ported from the Claude Design
// handoff. Appends absolutely-positioned particles to the nearest
// [data-confetti-host] ancestor, animates them out, then removes them.
//
// Respects prefers-reduced-motion: skips the burst entirely so it never
// distracts a housekeeper who has motion reduced for accessibility.

import { TOK } from './tokens';

export function confettiBurst(
  originEl: HTMLElement | null,
  opts: { colors?: string[]; count?: number } = {},
): void {
  if (!originEl || typeof window === 'undefined') return;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  } catch {
    // matchMedia unavailable — proceed
  }

  const colors = opts.colors || [TOK.green, '#86EFAC', TOK.amber, TOK.navy, '#fff'];
  const count = opts.count || 28;
  const rect = originEl.getBoundingClientRect();
  const host = (originEl.closest('[data-confetti-host]') as HTMLElement) || originEl;
  const hostRect = host.getBoundingClientRect();
  const cx = rect.left - hostRect.left + rect.width / 2;
  const cy = rect.top - hostRect.top + rect.height / 2;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const sz = 5 + Math.random() * 7;
    const ang = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 90;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 30;
    p.style.cssText =
      `position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;` +
      `border-radius:${Math.random() > 0.5 ? '50%' : '2px'};background:${colors[i % colors.length]};` +
      `pointer-events:none;z-index:9999;opacity:1;will-change:transform,opacity;`;
    host.appendChild(p);
    p
      .animate(
        [
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
          {
            transform: `translate(${dx}px,${dy + 120}px) rotate(${Math.random() * 540}deg) scale(0.4)`,
            opacity: 0,
          },
        ],
        { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' },
      ).onfinish = () => p.remove();
  }
}
