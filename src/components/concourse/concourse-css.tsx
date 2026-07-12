'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Concourse shell — shared styles (design handoff "Concourse", winning
// iteration 10a). One floating pill bar holds ALL navigation; a centered
// hub with the glowing Ask bar and live department tiles is the landing
// screen; section pages slide in below the same bar.
//
// All classes are prefixed cx- and injected via <CxStyle/> (same pattern as
// AskStaxisBar's scoped ASX_CSS — plain global CSS imports are restricted to
// the root layout in the App Router, and these need :hover/keyframes that
// inline styles can't express). Tokens mirror the Snow palette exactly —
// see the handoff README for the locked values.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

export function CxStyle() {
  return <style dangerouslySetInnerHTML={{ __html: CX_CSS }} />;
}

const SPRING = 'cubic-bezier(.22,1,.36,1)';

const CX_CSS = `
.cx-font{font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}

@keyframes cx-breathe{
  0%,100%{box-shadow:0 0 0 0 rgba(158,183,166,.55),0 0 28px rgba(158,183,166,.5);}
  50%{box-shadow:0 0 0 14px rgba(158,183,166,0),0 0 46px rgba(201,150,68,.45);}
}
@keyframes cx-sparkspin{0%,100%{transform:rotate(0) scale(1);}50%{transform:rotate(12deg) scale(1.12);}}
@keyframes cx-blinkdot{0%,100%{opacity:1;}50%{opacity:.15;}}
@keyframes cx-swap{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;}}
.cx-swap{animation:cx-swap .5s ${SPRING};}

/* ── Pill bar ── */
.cx-barwrap{display:flex;padding:18px 16px 0;position:sticky;top:18px;z-index:40;
  overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
.cx-barwrap::-webkit-scrollbar{display:none;}
.cx-bar{display:flex;align-items:center;gap:8px;margin:0 auto;flex-shrink:0;
  background:rgba(255,255,255,.85);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border:1px solid rgba(255,255,255,.95);border-radius:999px;padding:7px 9px;
  box-shadow:0 18px 44px -24px rgba(31,42,32,.4);}
.cx-bar,.cx-bar *{box-sizing:border-box;}
.cx-logo{display:grid;place-items:center;width:36px;height:36px;border-radius:999px;cursor:pointer;
  border:none;background:transparent;flex-shrink:0;padding:0;}
.cx-logo:hover{background:rgba(31,35,28,.05);}
.cx-divider{width:1px;height:20px;background:rgba(31,35,28,.09);flex-shrink:0;}
.cx-pill{display:flex;align-items:center;height:36px;padding:0 9px;border-radius:999px;
  border:none;background:transparent;cursor:pointer;color:#5C625C;white-space:nowrap;flex-shrink:0;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  transition:all .3s ${SPRING};}
/* Label slides open on hover (and stays open on the active page). */
.cx-pill .cx-lab{display:inline-block;max-width:0;opacity:0;overflow:hidden;margin-left:0;
  font-size:12px;font-weight:600;
  transition:max-width .3s ${SPRING},opacity .25s ease,margin-left .3s ${SPRING};}
.cx-pill.cx-active{padding:0 13px;background:#3E5C48;color:#fff;box-shadow:0 8px 18px -8px rgba(62,92,72,.55);}
.cx-pill.cx-active .cx-lab{max-width:160px;opacity:1;margin-left:7px;}
/* Hover takeover: the hovered pill gets the full green pull-out… */
.cx-pill:hover{padding:0 13px;background:#3E5C48;color:#fff;box-shadow:0 8px 18px -8px rgba(62,92,72,.55);}
.cx-pill:hover .cx-lab{max-width:160px;opacity:1;margin-left:7px;}
/* …and the page you're actually ON hands the spotlight over: its label
   retracts and the solid green drops to a quiet sage wash — still clearly
   marked as "you are here" while another pill is being previewed. */
.cx-bar:has(.cx-pill:not(.cx-active):hover) .cx-pill.cx-active:not(:hover){
  padding:0 9px;background:rgba(158,183,166,.3);color:#3E5C48;box-shadow:none;}
.cx-bar:has(.cx-pill:not(.cx-active):hover) .cx-pill.cx-active:not(:hover) .cx-lab{
  max-width:0;opacity:0;margin-left:0;}
.cx-badge{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:8.5px;font-weight:700;
  color:#fff;background:#B85C3D;border-radius:999px;padding:1.5px 6px;line-height:1.4;margin-left:7px;}
.cx-pill.cx-active .cx-badge,.cx-pill:hover .cx-badge{color:#3E5C48;background:#FBE3B8;}
.cx-bar:has(.cx-pill:not(.cx-active):hover) .cx-pill.cx-active:not(:hover) .cx-badge{color:#fff;background:#B85C3D;}
.cx-seg{display:flex;background:rgba(31,35,28,.05);border-radius:999px;padding:2.5px;flex-shrink:0;}
.cx-seg button{height:26px;padding:0 12px;border:none;border-radius:999px;cursor:pointer;
  font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;font-weight:600;
  letter-spacing:.05em;color:#8A9187;background:transparent;transition:all .2s;}
.cx-seg button.cx-on{color:#fff;background:#1F231C;}
.cx-gear{width:32px;height:32px;border-radius:50%;border:none;background:transparent;cursor:pointer;
  display:grid;place-items:center;color:#5C625C;flex-shrink:0;padding:0;}
.cx-gear:hover{background:rgba(31,35,28,.06);}
.cx-gear.cx-on{background:rgba(158,183,166,.25);color:#3E5C48;}
.cx-avatarbtn{width:32px;height:32px;border-radius:50%;background:#1F231C;color:#fff;display:grid;
  place-items:center;font-size:12px;font-weight:600;border:none;cursor:pointer;flex-shrink:0;padding:0;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}

/* Dropdown card under the avatar */
.cx-menu{position:absolute;right:0;top:calc(100% + 10px);background:#fff;
  border:1px solid rgba(31,35,28,.09);border-radius:14px;min-width:230px;overflow:hidden;z-index:50;
  box-shadow:0 18px 44px -20px rgba(31,42,32,.35);text-align:left;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-menu-head{padding:12px 16px;border-bottom:1px solid rgba(31,35,28,.08);}
.cx-menu-name{font-size:13px;font-weight:600;color:#1F231C;}
.cx-menu-role{font-size:11px;color:#5C625C;margin-top:2px;}
.cx-menu-eyebrow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;
  letter-spacing:.14em;text-transform:uppercase;color:#A6ABA6;padding:9px 16px 3px;}
.cx-menu-item{width:100%;padding:9px 16px;text-align:left;background:transparent;color:#1F231C;
  font-size:13px;cursor:pointer;border:none;display:flex;align-items:center;gap:8px;
  font-family:inherit;}
.cx-menu-item:hover{background:rgba(31,35,28,.04);}
.cx-menu-item.cx-on{background:rgba(158,183,166,.12);color:#356B4C;font-weight:600;}
.cx-menu-item.cx-danger{color:#B85C3D;border-top:1px solid rgba(31,35,28,.08);}

/* ── Home hub ── */
.cx-hub{max-width:1010px;margin:0 auto;padding:32px 40px 44px;text-align:center;width:100%;box-sizing:border-box;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-greet{font-family:var(--font-fraunces),Georgia,serif;font-style:italic;font-weight:400;
  font-size:clamp(26px,4.5vw,35px);color:#1F231C;letter-spacing:-0.01em;}
.cx-dateline{font-size:12.5px;color:#8A9187;margin-top:5px;}
.cx-ask{margin:24px auto 0;max-width:650px;display:flex;align-items:center;gap:11px;background:#fff;
  border:1px solid rgba(92,122,96,.28);border-radius:999px;padding:7px 8px 7px 20px;
  animation:cx-breathe 4.2s ease-in-out infinite;}
.cx-ask .cx-spark{color:#5C7A60;font-size:16px;line-height:1;animation:cx-sparkspin 3.5s ease-in-out infinite;flex-shrink:0;}
.cx-ask input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:#1F231C;height:38px;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;}
.cx-ask input::placeholder{color:#A6ABA6;}
.cx-talk{height:38px;padding:0 17px;border-radius:999px;border:none;background:#3E5C48;color:#fff;
  cursor:pointer;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;flex-shrink:0;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-talk:hover{filter:brightness(1.08);}

.cx-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-top:30px;}
.cx-tile{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:18px;padding:15px 15px 13px;
  cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;text-align:left;min-width:0;
  box-shadow:0 6px 16px -14px rgba(31,42,32,.35);transform:translateY(0);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  transition:background .55s ${SPRING},border-color .55s ${SPRING},box-shadow .55s ${SPRING},transform .55s ${SPRING};}
.cx-tile:hover{background:rgba(158,183,166,.16);border-color:rgba(92,122,96,.45);
  box-shadow:0 18px 36px -20px rgba(62,92,72,.5);transform:translateY(-5px);}
.cx-tile.cx-hot{background:rgba(158,183,166,.14);border-color:rgba(92,122,96,.35);}
.cx-tile-top{display:flex;align-items:center;justify-content:space-between;width:100%;}
.cx-chip{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#5C625C;
  background:rgba(31,35,28,.05);transition:background .55s ${SPRING},color .55s ${SPRING};}
.cx-tile:hover .cx-chip,.cx-tile.cx-hot .cx-chip{color:#3E5C48;background:rgba(92,122,96,.16);}
.cx-dot{width:8px;height:8px;border-radius:50%;background:#5C7A60;flex-shrink:0;}
.cx-dot.cx-warn{background:#C99644;animation:cx-blinkdot 2.2s ease-in-out infinite;}
.cx-dot.cx-bad{background:#B85C3D;animation:cx-blinkdot 2.2s ease-in-out infinite;}
.cx-dot.cx-mut{background:#A6ABA6;}
.cx-tile-lab{font-size:14.5px;font-weight:600;color:#1F231C;margin-top:13px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:100%;}
.cx-tile-status{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;color:#8A9187;
  margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;
  transition:color .55s ${SPRING};}
.cx-tile-status.cx-warn{color:#C99644;}
.cx-tile-status.cx-bad{color:#B85C3D;}
.cx-tile:hover .cx-tile-status.cx-ok{color:#5C7A60;}

/* ── Section-page chrome ── */
.cx-homebtn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 15px;border-radius:999px;
  border:1px solid rgba(31,35,28,.11);background:#fff;color:#5C625C;font-size:12.5px;font-weight:600;
  cursor:pointer;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-homebtn:hover{color:#1F231C;}
.cx-page{max-width:880px;margin:0 auto;padding:22px 24px 130px;width:100%;box-sizing:border-box;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-ptitle{font-size:26px;font-weight:600;color:#1F231C;letter-spacing:-0.02em;margin-top:18px;}
.cx-psub{font-size:13px;color:#5C625C;margin-top:4px;}
.cx-stats{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap;}
.cx-stat{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:14px;padding:14px 18px;min-width:150px;}
.cx-stat-k{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#A6ABA6;}
.cx-stat-row{display:flex;align-items:baseline;gap:7px;margin-top:6px;}
.cx-stat-v{font-size:23px;font-weight:600;color:#1F231C;}
.cx-stat-d{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;}
.cx-stat-d.cx-ok{color:#356B4C;}.cx-stat-d.cx-warn{color:#8C6A33;}.cx-stat-d.cx-bad{color:#B85C3D;}
.cx-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:22px;overflow:hidden;}
.cx-rowi{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 18px;
  border-bottom:1px solid rgba(31,35,28,.05);}
.cx-rowi:last-child{border-bottom:none;}
.cx-rowi-t{font-size:13.5px;font-weight:600;color:#1F231C;}
.cx-rowi-s{font-size:12px;color:#A6ABA6;margin-top:2px;}
.cx-bdg{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;white-space:nowrap;flex-shrink:0;}
.cx-bdg.cx-ok{color:#356B4C;background:rgba(53,107,76,.10);}
.cx-bdg.cx-warn{color:#8C6A33;background:rgba(201,150,68,.14);}
.cx-bdg.cx-bad{color:#B85C3D;background:rgba(184,92,61,.10);}
.cx-bdg.cx-mut{color:#5C625C;background:rgba(31,35,28,.06);}

/* ── Staxis decision cards ── */
.cx-dec{display:flex;gap:14px;align-items:flex-start;background:#fff;border:1px solid rgba(31,35,28,.09);
  border-radius:16px;padding:16px 18px;box-shadow:0 8px 22px -16px rgba(31,42,32,.25);
  transition:opacity .3s,border-color .3s;margin-top:12px;}
.cx-dec.cx-done{opacity:.55;border-color:rgba(53,107,76,.4);}
.cx-dchip{width:36px;height:36px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;}
.cx-dchip.cx-sage{color:#5C7A60;background:rgba(158,183,166,.2);}
.cx-dchip.cx-rust{color:#B85C3D;background:rgba(184,92,61,.12);}
.cx-dchip.cx-caramel{color:#8C6A33;background:rgba(201,150,68,.16);}
.cx-dec-eyebrow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;
  letter-spacing:.14em;text-transform:uppercase;color:#A6ABA6;}
.cx-dec-t{font-size:14.5px;font-weight:600;color:#1F231C;margin-top:3px;}
.cx-dec-s{font-size:12.5px;color:#5C625C;margin-top:3px;line-height:1.5;}
.cx-okbtn{height:34px;padding:0 16px;border-radius:999px;border:none;cursor:pointer;font-size:12.5px;
  font-weight:600;color:#fff;background:#5C7A60;transition:background .25s;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-okbtn.cx-done{background:#356B4C;}
.cx-nobtn{height:34px;padding:0 14px;border-radius:999px;border:1px solid rgba(31,35,28,.14);cursor:pointer;
  font-size:12.5px;font-weight:500;color:#5C625C;background:transparent;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}

/* ── Demo-only bottom capsule (the real app's capsule is the live AskStaxisBar) ── */
.cx-capsulewrap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:30;
  width:min(520px,calc(100vw - 24px));}
.cx-capsule{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.9);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(92,122,96,.25);
  border-radius:999px;padding:6px 8px 6px 17px;animation:cx-breathe 4.2s ease-in-out infinite;}
.cx-capsule .cx-spark{color:#5C7A60;font-size:14px;line-height:1;flex-shrink:0;}
.cx-capsule input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:#1F231C;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;}
.cx-capsule input::placeholder{color:#A6ABA6;}
.cx-capsule .cx-talk{height:30px;padding:0 14px;font-size:12px;}

@media (max-width:760px){
  .cx-board{grid-template-columns:repeat(2,minmax(0,1fr));}
  .cx-hub{padding:24px 16px 40px;}
  .cx-page{padding:18px 16px 130px;}
  .cx-barwrap{padding:12px 12px 0;top:12px;}
}

/* Reduced motion: drop the looping decorative animations, keep one-shot entrances. */
@media (prefers-reduced-motion: reduce){
  .cx-ask,.cx-capsule{animation:none;}
  .cx-ask .cx-spark,.cx-dot.cx-warn,.cx-dot.cx-bad{animation:none;}
}
`;
