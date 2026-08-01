// ═══════════════════════════════════════════════════════════════════════════
// The companion's placeholder skin.
//
// DELIBERATELY PLAIN. The real visual design is being produced separately, and
// this exists so the behaviour underneath it can ship, be used and be corrected
// before anybody spends time on how it looks. Every rule below is either Snow
// palette (paper white, sage, caramel, the --snow-* variables in globals.css)
// or layout that the reskin will want anyway.
//
// WHAT THE RESKIN MAY CHANGE FREELY: colour, radius, shadow, type scale,
// motion, the shape of the dot, the shape of the card.
//
// WHAT THE RESKIN MUST KEEP, because it is behaviour wearing a CSS costume:
//
//   1. `.cmp-root` stays `position: fixed` in a corner and NEVER covers a page
//      action. On desktop it sits right of the feedback and activity slots; on
//      phones it docks ABOVE the thumb zone and above the mobile Ask FAB, which
//      is why the mobile block moves it up rather than making it smaller.
//   2. The resting state is a small dot with no animation. "Ignorable" is a
//      requirement, not a style: a pulsing dot in the corner of an operations
//      screen is a thing people learn to resent.
//   3. The has-something cue is a colour change and nothing else. No bounce, no
//      sound, no badge count. Anything that moves reads as urgent, and the
//      companion is never urgent.
//   4. Every tap target stays at least 44px. The people using this are often
//      one-handed on a phone at a desk.
//   5. `prefers-reduced-motion` keeps working.
//
// One injected style block scoped under `.cmp-*`, the same pattern as ASX_CSS
// in AskStaxisBar and TOLD_CSS on the Knows tab.
// ═══════════════════════════════════════════════════════════════════════════

export const COMPANION_CSS = `
.cmp-root{
  position:fixed;
  right:16px;
  /* Above the feedback + activity slots, clear of the Ask dock. */
  bottom:84px;
  z-index:9500;
  display:flex;
  flex-direction:column;
  align-items:flex-end;
  gap:10px;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  /* The wrapper must never eat clicks meant for the page underneath it. Only
     the dot and the card take pointer events back. */
  pointer-events:none;
}
.cmp-root > *{pointer-events:auto;}

/* ── Resting ─────────────────────────────────────────────────────────────── */
.cmp-dot{
  width:44px;height:44px;
  border-radius:999px;
  border:1px solid var(--snow-rule,rgba(31,35,28,.08));
  background:var(--snow-bg,#FFFFFF);
  box-shadow:0 2px 10px rgba(31,35,28,.10);
  cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  padding:0;
  transition:border-color .2s,box-shadow .2s;
}
.cmp-dot:hover{border-color:var(--snow-sage,#9EB7A6);box-shadow:0 3px 14px rgba(31,35,28,.14);}
.cmp-dot:focus-visible{outline:2px solid var(--snow-sage-deep,#5C7A60);outline-offset:2px;}
.cmp-mark{
  width:12px;height:12px;border-radius:999px;
  background:var(--snow-sage,#9EB7A6);
  transition:background .3s;
}
/* Has-something: a warmer mark. Colour only, on purpose. */
.cmp-dot.cmp-nudge .cmp-mark{background:var(--snow-caramel,#C99644);}
/* Asleep: drained, and it stays drained rather than retrying visibly. */
.cmp-dot.cmp-asleep{opacity:.55;}
.cmp-dot.cmp-asleep .cmp-mark{background:var(--snow-ink3,#A6ABA6);}

/* ── Speaking ────────────────────────────────────────────────────────────── */
.cmp-card{
  width:min(320px,calc(100vw - 32px));
  box-sizing:border-box;
  background:var(--snow-bg,#FFFFFF);
  border:1px solid var(--snow-rule,rgba(31,35,28,.08));
  border-radius:16px;
  padding:14px 16px;
  box-shadow:0 6px 24px rgba(31,35,28,.12);
}
.cmp-say{
  font-size:14px;line-height:1.5;
  color:var(--snow-ink,#1F231C);
  margin:0;
}
.cmp-ask{
  font-size:13.5px;line-height:1.5;
  color:var(--snow-ink2,#5C625C);
  margin:6px 0 0;
}
.cmp-eg{
  font-size:13px;line-height:1.5;
  color:var(--snow-ink2,#5C625C);
  margin:8px 0 0;
  padding:8px 10px;
  border-radius:10px;
  background:var(--snow-sage-dim,rgba(92,122,96,.10));
}
.cmp-acts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.cmp-btn{
  min-height:44px;padding:0 15px;border-radius:999px;
  font:inherit;font-size:13px;font-weight:600;
  border:1px solid var(--snow-rule,rgba(31,35,28,.14));
  background:transparent;color:var(--snow-ink2,#5C625C);
  cursor:pointer;white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background .2s,color .2s,border-color .2s;
}
.cmp-btn:hover{background:rgba(31,35,28,.05);}
.cmp-btn:focus-visible{outline:2px solid var(--snow-sage-deep,#5C7A60);outline-offset:2px;}
.cmp-btn.cmp-yes{
  background:var(--snow-sage-deep,#5C7A60);
  border-color:var(--snow-sage-deep,#5C7A60);
  color:#fff;
}
.cmp-btn.cmp-yes:hover{background:#4E6952;}
.cmp-quiet{
  background:transparent;border:none;padding:0 4px;min-height:44px;
  font:inherit;font-size:12px;color:var(--snow-ink3,#A6ABA6);
  cursor:pointer;text-decoration:underline;text-underline-offset:2px;
}
.cmp-quiet:hover{color:var(--snow-ink2,#5C625C);}
.cmp-quiet:focus-visible{outline:2px solid var(--snow-sage-deep,#5C7A60);outline-offset:2px;}

/* ── Open ────────────────────────────────────────────────────────────────── */
.cmp-panel{
  width:min(340px,calc(100vw - 32px));
  box-sizing:border-box;
  background:var(--snow-bg,#FFFFFF);
  border:1px solid var(--snow-rule,rgba(31,35,28,.08));
  border-radius:18px;
  padding:16px;
  box-shadow:0 8px 30px rgba(31,35,28,.14);
  max-height:min(70vh,560px);
  overflow-y:auto;
}
.cmp-head{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-bottom:10px;
}
.cmp-title{
  font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--snow-ink3,#A6ABA6);
}
.cmp-rows{display:flex;flex-direction:column;gap:4px;margin-top:6px;}
.cmp-row{
  min-height:44px;width:100%;box-sizing:border-box;
  display:flex;align-items:center;
  padding:0 12px;border-radius:11px;
  border:1px solid transparent;background:transparent;
  font:inherit;font-size:13.5px;color:var(--snow-ink,#1F231C);
  text-align:left;cursor:pointer;
  transition:background .2s,border-color .2s;
}
.cmp-row:hover{background:var(--snow-sage-dim,rgba(92,122,96,.10));}
.cmp-row:focus-visible{outline:2px solid var(--snow-sage-deep,#5C7A60);outline-offset:2px;}
.cmp-sep{height:1px;background:var(--snow-rule,rgba(31,35,28,.08));margin:12px 0;}

/* ── Phones ──────────────────────────────────────────────────────────────── */
/* Clear of the thumb zone AND of the Ask bar's own mobile FAB, which sits at
   the same corner. The bubble moves UP rather than shrinking: a smaller target
   on a phone is the wrong trade every time. */
@media (max-width:760px){
  .cmp-root{right:12px;bottom:150px;left:12px;align-items:flex-end;}
  .cmp-card,.cmp-panel{width:100%;}
}

@media (prefers-reduced-motion: reduce){
  .cmp-dot,.cmp-mark,.cmp-btn,.cmp-row{transition:none;}
}
`;
