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

/**
 * The /feed page's own chrome — the day header, the timeline spine, the ink
 * cards, and the right rail.
 *
 * Separate from CX_CSS because it is one screen's design language rather than
 * the shell's: every class is `fx-`, and nothing outside `/feed` loads it.
 * Values come from the 2026-08-01 handoff (design_handoff_staxis_feed/README.md)
 * and are FINAL — colours, radii, shadows and type sizes are not to be rounded
 * to a nearby token.
 */
export function FeedStyle() {
  return <style dangerouslySetInnerHTML={{ __html: FEED_CSS }} />;
}

const SPRING = 'cubic-bezier(.22,1,.36,1)';

const CX_CSS = `
.cx-font{font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}

@keyframes cx-breathe{
  0%,100%{box-shadow:0 0 0 0 rgba(158,183,166,.26),0 0 12px rgba(158,183,166,.2);}
  50%{box-shadow:0 0 0 6px rgba(158,183,166,0),0 0 20px rgba(201,150,68,.14);}
}
@keyframes cx-sparkspin{0%,100%{transform:rotate(0) scale(1);}50%{transform:rotate(12deg) scale(1.12);}}
@keyframes cx-blinkdot{0%,100%{opacity:1;}50%{opacity:.15;}}
/* Route transition: a quick calm fade. The old .5s slide-up replayed a
   whole-page "pop" on every tab switch — with per-page entrances on top it
   read as the UI re-loading itself. */
@keyframes cx-swap{from{opacity:0;}to{opacity:1;}}
.cx-swap{animation:cx-swap .22s ease;}
.staxis-app-shell{--staxis-app-background:radial-gradient(ellipse 1000px 500px at 50% 0%,#FFFFFF 0%,#F5F7F4 100%);}

/* ── Pill bar ── */
.cx-barwrap{display:flex;padding:18px 16px 0;position:sticky;top:18px;z-index:40;
  overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
.cx-barwrap::-webkit-scrollbar{display:none;}
/* Keep the bar centered; margin collapses on overflow so it still scrolls
   from the left on mobile. */
.cx-barcluster{margin:0 auto;display:flex;align-items:center;gap:10px;flex-shrink:0;}
.cx-bar{display:flex;align-items:center;gap:3px;margin:0 auto;flex-shrink:0;
  background:rgba(255,255,255,.85);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border:1px solid rgba(255,255,255,.95);border-radius:999px;padding:7px 9px;
  box-shadow:0 18px 44px -24px rgba(31,42,32,.4);}
.cx-bar,.cx-bar *{box-sizing:border-box;}
.cx-logo{display:grid;place-items:center;width:36px;height:36px;border-radius:999px;cursor:pointer;
  border:none;background:transparent;flex-shrink:0;padding:0;}
.cx-logo:hover{background:rgba(31,35,28,.05);}
.cx-divider{width:1px;height:20px;background:rgba(31,35,28,.09);flex-shrink:0;margin:0 5px;}
.cx-pill{display:flex;align-items:center;height:36px;padding:0 9px;border-radius:999px;
  border:none;background:transparent;cursor:pointer;color:#5C625C;white-space:nowrap;flex-shrink:0;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  /* leave = soft release: slower fade, tiny linger so a sweep leaves a gentle
     trail instead of hard on/off flashing */
  transition:background .45s ease .05s,color .45s ease .05s,box-shadow .45s ease .05s;}
/* Label opens on hover (and stays open on the active page or contextual Home).
   The 0fr→1fr grid trick animates to the label's NATURAL width — no
   max-width dead zone, so the motion has no end-of-track snap. */
.cx-pill .cx-labw{display:grid;grid-template-columns:0fr;opacity:0;
  transition:grid-template-columns .5s ${SPRING} .05s,opacity .32s ease .05s;}
.cx-pill .cx-lab{min-width:0;overflow:hidden;white-space:nowrap;display:block;
  padding:0 4px 0 7px;font-size:12px;font-weight:600;}
.cx-pill.cx-active{background:#3E5C48;color:#fff;box-shadow:0 8px 18px -8px rgba(62,92,72,.55);}
.cx-pill.cx-active .cx-labw,.cx-pill.cx-context-home .cx-labw{grid-template-columns:1fr;opacity:1;}
.cx-pill.cx-utility-pill .cx-labw{grid-template-columns:1fr;opacity:1;}
.cx-pill.cx-admin-destination:not(.cx-active){color:#3E5C48;background:rgba(158,183,166,.16);}
/* Hover takeover — instant open. Pills sit edge-to-edge (bar gap 3px) so
   moving along the bar hands hover from pill to pill with no dead zone. */
.cx-pill:hover{background:#3E5C48;color:#fff;box-shadow:0 8px 18px -8px rgba(62,92,72,.55);
  transition:background .16s ease,color .16s ease,box-shadow .25s ease;}
.cx-pill:hover .cx-labw{grid-template-columns:1fr;opacity:1;
  transition:grid-template-columns .26s ${SPRING},opacity .16s ease;}
/* …and the page you're actually ON hands over: it fades to a quiet sage
   wash and its word slides closed at the same soft pace the hovered word
   opens — a width-neutral handoff, so the bar itself doesn't balloon wider
   while you preview other tabs. (Safe now that gaps are 3px and release is
   slow+delayed; the original flicker came from instant display switches
   across 8px dead zones.) */
.cx-bar:has(.cx-pill:not(.cx-active):hover) .cx-pill.cx-active:not(:hover){
  background:rgba(158,183,166,.3);color:#3E5C48;box-shadow:none;}
.cx-bar:has(.cx-pill:not(.cx-active):hover) .cx-pill.cx-active:not(:hover) .cx-labw{
  grid-template-columns:0fr;opacity:0;}
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
.cx-pill:focus-visible,.cx-gear:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cx-avatarbtn{position:relative;isolation:isolate;width:44px;height:44px;border-radius:50%;background:transparent;
  color:#fff;display:grid;place-items:center;font-size:12px;font-weight:600;border:none;cursor:pointer;
  flex-shrink:0;padding:0;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cx-avatarbtn::before{content:"";position:absolute;z-index:-1;inset:6px;border-radius:50%;background:#1F231C;}
.cx-avatarbtn:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
/* Switched sessions wear a ring in the 6px gutter the disc leaves free. Quiet
   enough to live in the bar all day, loud enough that a tab left open for an
   hour never passes for your own account. */
.cx-avatarbtn.cx-switched::after{content:"";position:absolute;z-index:-1;inset:1px;border-radius:50%;
  border:2px solid #B8863D;}

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
.cx-menu-item.cx-phone-item{margin-top:7px;border-top:1px solid rgba(31,35,28,.08);padding-top:11px;}
.cx-menu-item.cx-install-item{min-height:44px;color:#356B4C;font-weight:600;}
.cx-menu-item.cx-danger{color:#B85C3D;border-top:1px solid rgba(31,35,28,.08);}
/* ── Switch account ── */
.cx-menu-switched{padding:9px 16px;background:rgba(184,134,61,.10);color:#7A5620;
  font-size:11px;font-weight:600;border-bottom:1px solid rgba(184,134,61,.22);}
.cx-menu-item.cx-menu-return{color:#7A5620;font-weight:600;min-height:40px;}
.cx-menu-item.cx-menu-person{align-items:flex-start;padding-top:7px;padding-bottom:7px;}
.cx-menu-item.cx-menu-person svg{margin-top:2px;flex-shrink:0;}
.cx-menu-person-text{display:flex;flex-direction:column;gap:1px;min-width:0;}
.cx-menu-person-name{font-size:13px;line-height:1.25;}
.cx-menu-person-role{font-size:10px;color:#8A9187;line-height:1.3;}
.cx-menu-item.cx-menu-person.cx-on .cx-menu-person-role{color:#4C7A5E;}
.cx-menu-item:disabled{cursor:default;opacity:.65;}
.cx-menu-item.cx-menu-person.cx-on:disabled{opacity:1;}
.cx-menu-note{padding:8px 16px;font-size:11px;color:#B85C3D;
  border-top:1px solid rgba(31,35,28,.08);}

/* ── Home hub ── */
/* Reeyen wanted the whole hub a touch larger — greeting, Ask bar, Talk
   button, tiles, their numbers + icons all scale together via zoom (reflows,
   so nothing clips). Zoom scales width AND height, so the footprint grows by
   the square (1.15 → ~1.32× area, which read far bigger than "15%"). Stepped
   down to 1.049 (~1.10× area). The shared pill bar sits outside .cx-hub and
   stays one consistent size across every page. */
.cx-hub{zoom:1.049;max-width:1010px;margin:0 auto;padding:32px 40px 44px;text-align:center;width:100%;box-sizing:border-box;
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

.cx-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-top:30px;}
.cx-board.cx-board-single{grid-template-columns:minmax(220px,360px);justify-content:center;}
.cx-tile{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:18px;padding:15px 15px 13px;
  cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;text-align:left;min-width:0;
  box-shadow:0 6px 16px -14px rgba(31,42,32,.35);transform:translateY(0);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  transition:background .55s ${SPRING},border-color .55s ${SPRING},box-shadow .55s ${SPRING},transform .55s ${SPRING};}
.cx-tile:hover{background:rgba(158,183,166,.16);border-color:rgba(92,122,96,.45);
  box-shadow:0 18px 36px -20px rgba(62,92,72,.5);transform:translateY(-5px);}
.cx-tile:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cx-tile:active{transform:scale(.99);}
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

/* Management is deliberately one compact destination well below the
   operational board—not a fifth department, page section, or global
   desktop-nav item. The deliberate 8px-grid gap keeps it visually separate from
   the department tabs without making the destination itself oversized. */
.cx-management{margin-top:120px;text-align:left;}
.cx-management-link{width:fit-content;max-width:100%;min-height:52px;box-sizing:border-box;display:inline-flex;align-items:center;gap:10px;
  padding:8px 12px;border:1px solid rgba(92,122,96,.24);border-radius:12px;
  background:rgba(255,255,255,.72);color:#1F231C;text-decoration:none;text-align:left;
  -webkit-tap-highlight-color:transparent;transition:background 200ms ${SPRING},border-color 200ms ${SPRING},transform 200ms ${SPRING};}
.cx-management-icon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex-shrink:0;
  color:#3E5C48;background:rgba(92,122,96,.13);transition:background 200ms ${SPRING};}
.cx-management-title{font-size:14.5px;font-weight:600;line-height:20px;color:#1F231C;white-space:nowrap;}
.cx-management-arrow{margin-left:2px;font-size:18px;line-height:1;color:#5C7A60;flex-shrink:0;
  transition:transform 180ms ${SPRING};}
@media (hover:hover){
  .cx-management-link:hover{background:rgba(158,183,166,.13);border-color:rgba(92,122,96,.44);transform:translateY(-1px);}
  .cx-management-link:hover .cx-management-icon{background:rgba(92,122,96,.19);}
  .cx-management-link:hover .cx-management-arrow{transform:translateX(2px);}
}
.cx-management-link:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cx-management-link:active{background:rgba(158,183,166,.18);transform:scale(.995);}

/* ── Section-page chrome ── */
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

@media (min-width:761px) and (max-width:1100px){
  .cx-barwrap{padding-bottom:8px;
    -webkit-mask-image:linear-gradient(to right,transparent 0,#000 20px,#000 calc(100% - 20px),transparent 100%);
    mask-image:linear-gradient(to right,transparent 0,#000 20px,#000 calc(100% - 20px),transparent 100%);}
  .cx-pill{height:44px;}
  .cx-gear{width:44px;height:44px;}
}

@media (max-width:760px){
  .staxis-app-shell{min-height:100dvh!important;--staxis-app-background:radial-gradient(ellipse 1100px 560px at 50% -4%,#FFFFFF 0%,#F0F3EF 100%);}
  .cx-desktop-bar{display:none;}
  .cx-hub{zoom:1;margin:0;padding:14px 20px 104px;text-align:left;max-width:none;}
  .cx-greet{font-size:30px;line-height:1.08;}
  .cx-dateline{margin-top:7px;}
  .cx-ask{display:none;}
  .cx-board{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:20px;}
  .cx-tile{min-height:110px;padding:14px 14px 13px;}
  .cx-tile:hover{transform:none;}
  .cx-tile:active{transform:scale(.985);}
  .cx-tile-lab{font-size:14px;}
  .cx-tile-status{font-size:10px;}
  .cx-management{margin-top:80px;}
  .cx-management-link{min-height:48px;padding:7px 10px;gap:9px;}
  .cx-management-icon{width:32px;height:32px;}
  .cx-page{padding:18px 16px 130px;}
}

/* Reduced motion: drop the looping decorative animations, keep one-shot entrances. */
@media (prefers-reduced-motion: reduce){
  .cx-swap{animation:none;}
  .cx-pill,.cx-pill .cx-labw,.cx-gear{transition:none;}
  .cx-tile{transition:none;}
  .cx-management-link,.cx-management-icon,.cx-management-arrow{transition:none;}
  .cx-management-link:hover,.cx-management-link:active,.cx-management-link:hover .cx-management-arrow{transform:none;}
  .cx-ask,.cx-capsule{animation:none;}
  .cx-ask .cx-spark,.cx-dot.cx-warn,.cx-dot.cx-bad{animation:none;}
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// /feed — the Staxis page
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exported for the one thing a test can honestly check about a stylesheet:
 * that every class a component NAMES is a class this file DEFINES. The
 * 2026-08-01 redesign deleted `.sl-sw` while the log book popup still asked
 * for it, and the switch silently lost its layout. That is a no-runtime
 * invariant, so it is guarded as one. See feed-logbook-merge.client.test.tsx.
 */
export const FEED_CSS_FOR_TEST_ONLY = (): string => FEED_CSS;

const FEED_CSS = `
@keyframes fx-sweep{0%{transform:translateX(-120%);}100%{transform:translateX(320%);}}
@keyframes fx-pulsering{
  0%{box-shadow:0 0 0 0 rgba(92,122,96,.45);}
  70%{box-shadow:0 0 0 9px rgba(92,122,96,0);}
  100%{box-shadow:0 0 0 0 rgba(92,122,96,0);}
}
@keyframes fx-fade{from{opacity:0;}to{opacity:1;}}

/* The page's own wash. Scoped with :has so no other section's background moves. */
.staxis-app-shell:has(.fx-page){
  --staxis-app-background:radial-gradient(ellipse 1100px 560px at 50% 0%,#FFFFFF 0%,#F4F6F2 100%);
}

.fx-page{max-width:1260px;margin:0 auto;padding:30px 24px 260px;width:100%;box-sizing:border-box;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;color:#1F231C;}
.fx-page *{box-sizing:border-box;}

/* ── Region 1: the day header ── */
.fx-head{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;flex-wrap:wrap;}
.fx-day{font-family:var(--font-fraunces),Georgia,serif;font-style:italic;font-weight:400;font-size:42px;
  line-height:1;color:#1F231C;letter-spacing:-.02em;}
.fx-context{font-size:13.5px;color:#8A9187;margin-top:8px;}
.fx-headr{display:flex;flex-direction:column;gap:9px;align-items:flex-end;}
.fx-cal{display:flex;align-items:center;gap:8px;}
.fx-step{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;
  border:1px solid rgba(31,35,28,.11);background:#fff;color:#5C625C;cursor:pointer;padding:0;
  transition:background .16s ease,border-color .16s ease;}
.fx-step:hover{background:#F4F6F2;border-color:rgba(31,35,28,.2);}
.fx-range{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#A6ABA6;white-space:nowrap;}
.fx-vrule{width:1px;height:20px;background:rgba(31,35,28,.1);margin:0 3px;flex-shrink:0;}
.fx-month{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;
  border:1px solid rgba(31,35,28,.12);background:#fff;color:#5C625C;font-size:12.5px;font-weight:500;
  cursor:pointer;font-family:inherit;transition:background .16s ease,border-color .16s ease;}
.fx-month:hover,.fx-month[aria-expanded="true"]{background:#F1F5F0;border-color:rgba(62,92,72,.34);color:#3E5C48;}
.fx-step:focus-visible,.fx-month:focus-visible,.fx-wd:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}

/* ── Everything / Just mine ──────────────────────────────────────────────
   The ONE narrowing on this list, and it is built to look like the smallest
   thing on the screen. Two words in a single hairline capsule, sitting with the
   other day controls rather than over the list: it is about which rows are
   shown, not about any of them. Quiet when idle means the resting state is the
   same grey as the range label beside it, and only the ON side goes sage. */
.fx-seg{display:inline-flex;align-items:center;height:30px;padding:2px;border-radius:9px;
  border:1px solid rgba(31,35,28,.12);background:#fff;gap:2px;}
.fx-segb{border:none;background:transparent;border-radius:7px;height:24px;padding:0 10px;
  font-family:inherit;font-size:12px;font-weight:500;color:#8A9187;cursor:pointer;white-space:nowrap;
  transition:background .16s ease,color .16s ease;}
.fx-segb:hover:not([aria-pressed="true"]){color:#5C625C;background:rgba(31,35,28,.04);}
.fx-segb[aria-pressed="true"]{background:#F1F5F0;color:#3E5C48;font-weight:600;}
.fx-segb:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}

/* Week strip */
.fx-week{display:flex;gap:6px;}
.fx-wd{width:64px;padding:8px 0 9px;border-radius:12px;background:#fff;border:1px solid rgba(31,35,28,.08);
  display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;font-family:inherit;
  transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;}
.fx-wd:hover{transform:translateY(-1px);box-shadow:0 10px 20px -16px rgba(31,42,32,.7);}
.fx-wdk{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;color:#A6ABA6;}
.fx-wdn{font-size:16px;font-weight:600;color:#1F231C;line-height:1;}
.fx-wd.fx-past .fx-wdn{color:#5C625C;}
.fx-wdots{display:flex;gap:3px;height:5px;align-items:center;}
.fx-wdot{width:5px;height:5px;border-radius:50%;background:#5C7A60;}
.fx-wdot.fx-late{background:#B85C3D;}
.fx-wdot.fx-ev{background:#4B8C9E;}
.fx-wdot.fx-gone{background:#C9CFC8;}
.fx-wd.fx-notable{border-color:rgba(201,150,68,.4);}
.fx-wd.fx-today{background:#3E5C48;border-color:#3E5C48;box-shadow:0 12px 24px -14px rgba(62,92,72,.9);}
.fx-wd.fx-today .fx-wdk{color:rgba(255,255,255,.62);}
.fx-wd.fx-today .fx-wdn{color:#fff;}
.fx-wd.fx-today .fx-wdot{background:#fff;}
.fx-wd.fx-today .fx-wdot.fx-late{background:#E8A87C;}
.fx-wd.fx-sel:not(.fx-today){border-color:#5C7A60;background:#F1F5F0;}

/* ── The two lanes ── */
.fx-body{display:grid;grid-template-columns:1fr 330px;gap:32px;align-items:start;margin-top:30px;}
.fx-lane{position:relative;min-width:0;}
.fx-spine{position:absolute;left:16px;top:8px;bottom:24px;width:1px;pointer-events:none;
  background:linear-gradient(to bottom,rgba(31,35,28,.14),rgba(31,35,28,.14) 72%,rgba(31,35,28,.04));}

/* ── Region 2: one entry on the spine ── */
.fx-entry{display:grid;grid-template-columns:32px 1fr;align-items:center;margin-top:10px;position:relative;}
/* The spine is the lane's first child, so the first ENTRY is the one after it. */
.fx-spine + .fx-entry{margin-top:0;}
.fx-entry.fx-ink{align-items:start;margin-top:12px;}
.fx-mark{display:grid;place-items:center;}
.fx-entry.fx-ink .fx-mark{padding-top:22px;}
.fx-slot{margin-left:14px;min-width:0;}

/* Markers — three shapes, and that is the whole vocabulary.
   The 4px ring is what punches the marker through the spine line. */
.fx-m-diamond{width:13px;height:13px;background:#1F231C;transform:rotate(45deg);border-radius:2px;
  box-shadow:0 0 0 4px #F6F8F4;}
.fx-m-open{width:14px;height:14px;border-radius:50%;border:1.8px solid #9EB7A6;background:#F6F8F4;
  box-shadow:0 0 0 4px #F6F8F4;}
.fx-m-open.fx-late{border-color:#B85C3D;}
.fx-m-event{width:11px;height:11px;border-radius:3px;background:#4B8C9E;box-shadow:0 0 0 4px #F6F8F4;}
.fx-m-add{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;
  background:rgba(92,122,96,.16);color:#3E5C48;font-size:12px;line-height:1;box-shadow:0 0 0 4px #F6F8F4;}
.fx-m-tick{width:7px;height:7px;border-radius:50%;background:rgba(31,35,28,.2);box-shadow:0 0 0 4px #F6F8F4;}

/* Entry D — the "Earlier today" divider */
.fx-entry.fx-divider{margin-top:26px;}
.fx-div{display:flex;align-items:center;gap:12px;}
.fx-divl{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;letter-spacing:.2em;
  text-transform:uppercase;color:#A6ABA6;white-space:nowrap;}
.fx-divr{flex:1;height:1px;background:rgba(31,35,28,.09);}

/* Entry A — a to-do you owe */
.fx-row{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid rgba(31,35,28,.09);
  border-radius:13px;padding:12px 18px;box-shadow:0 10px 24px -24px rgba(31,42,32,.9);
  transition:transform 160ms ease,box-shadow 160ms ease;}
.fx-row:hover{transform:translateY(-1px);box-shadow:0 14px 30px -22px rgba(31,42,32,.9);}
.fx-row.fx-late{border-color:rgba(184,92,61,.28);}
/* Arrived since this person last looked. A dot, no word and no second colour:
   sage is already what this page means by "yours", and somebody who never
   notices the dot has lost nothing at all. */
.fx-new{display:inline-block;width:6px;height:6px;border-radius:50%;background:#5C7A60;
  margin-right:7px;vertical-align:middle;flex-shrink:0;}
.fx-rowt{font-size:14.5px;font-weight:600;color:#1F231C;min-width:0;}
.fx-rowm{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:#A6ABA6;white-space:nowrap;}
.fx-rowm.fx-late{color:#8E432B;}
.fx-rowa{margin-left:auto;display:flex;gap:7px;align-items:center;flex-shrink:0;}
.fx-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;
  border:1px solid rgba(31,35,28,.13);background:#fff;color:#5C625C;font-size:12.5px;font-weight:500;
  cursor:pointer;white-space:nowrap;font-family:inherit;text-decoration:none;
  transition:background .16s ease,border-color .16s ease;}
.fx-btn:hover:not(:disabled){background:#F4F6F2;border-color:rgba(31,35,28,.2);}
.fx-btn:disabled{opacity:.5;cursor:default;}
.fx-btn:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-btn.fx-primary{background:#3E5C48;border-color:#3E5C48;color:#fff;font-weight:600;padding:0 14px;
  box-shadow:0 10px 20px -12px rgba(62,92,72,.9);}
.fx-btn.fx-primary:hover:not(:disabled){background:#334E3C;border-color:#334E3C;}
.fx-btn.fx-quiet{border-color:transparent;background:transparent;padding:0 6px;}
.fx-btn.fx-quiet:hover:not(:disabled){background:rgba(31,35,28,.05);border-color:transparent;}
.fx-btn.fx-danger{color:#B85C3D;}

/* Entry B — a hotel event */
.fx-row.fx-event{background:rgba(75,140,158,.07);border-color:rgba(75,140,158,.24);box-shadow:none;}
.fx-row.fx-event .fx-rowt{font-weight:500;}
.fx-row.fx-event .fx-rowm{color:#4B8C9E;}

/* ── Entry C — the composer ──────────────────────────────────────────────
   ONE ROW that accepts a plain sentence. It is the same object as a to-do row
   and reuses .fx-row's geometry, because what you are adding and what you have
   added should not be two different species. It never becomes a modal and never
   becomes a card inside a card: when it needs buttons, this same row grows
   downward.

   THERE IS NO ADD BUTTON. Enter is the only commit, in every state, and the
   mono hint sits where the button would have been. (Design handoff
   "Add a to-do", direction 2a. An earlier direction put an Add button at the
   foot of a panel; it made the row read as a form with a submit step, and it
   sat below the fold of the row itself.)

   CARAMEL means lifted out of the sentence, SAGE means chosen by tapping. That
   split is the only place this control distinguishes "understood" from
   "chosen", and it is never explained in words. Somebody who does not notice it
   loses nothing. */
.fx-comp{background:#fff;border:1px solid rgba(31,35,28,.09);border-radius:13px;padding:12px 18px;
  box-shadow:0 10px 24px -24px rgba(31,42,32,.9);width:100%;
  transition:border-color .16s ease,box-shadow .16s ease;}
/* Focused, or holding text, or holding an open button row. */
.fx-comp.fx-on{border-color:rgba(92,122,96,.4);}
.fx-compline{display:flex;align-items:center;gap:14px;min-width:0;}
.fx-comptitle{flex:1;min-width:0;border:none;background:transparent;font-size:14.5px;font-weight:600;
  color:#1F231C;font-family:inherit;padding:0;}
.fx-comptitle:focus{outline:none;}
.fx-comptitle::placeholder{color:#A6ABA6;font-size:14px;font-weight:400;}
/* Speech is an input method, not a mode: the words land in the same field, so
   the field simply reads as speech while it is being spoken into. */
.fx-comptitle.fx-live{font-size:14px;font-weight:400;color:#5C625C;}

/* The three words. Always present, always answered. */
.fx-compw{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12.5px;flex-wrap:wrap;}
.fx-compdot{color:#C9CFC8;}
.fx-compword{border:none;background:transparent;padding:0 0 1px;font-family:inherit;font-size:12.5px;
  color:#A6ABA6;cursor:pointer;border-bottom:1px dotted rgba(31,35,28,.25);white-space:nowrap;
  display:inline-flex;align-items:center;gap:5px;transition:background .16s ease,border-color .16s ease;}
.fx-compword:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-compword.fx-lift{color:#1F231C;font-weight:600;background:rgba(201,150,68,.18);
  border-bottom:1.5px solid rgba(201,150,68,.7);border-radius:4px;padding:2px 6px;}
.fx-compword.fx-pick{color:#1F231C;font-weight:600;background:rgba(158,183,166,.28);
  border-bottom:1.5px solid rgba(92,122,96,.55);border-radius:4px;padding:2px 6px;}

.fx-comprule{width:1px;height:18px;background:rgba(31,35,28,.1);flex-shrink:0;}
.fx-compkey{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#A6ABA6;white-space:nowrap;}
.fx-compmic{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;border:none;
  background:transparent;color:#8A9187;cursor:pointer;padding:0;flex-shrink:0;
  transition:background .16s ease,color .16s ease;}
.fx-compmic:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-compmic.fx-rec{width:30px;height:30px;border-radius:50%;background:#3E5C48;color:#fff;
  box-shadow:0 0 0 4px rgba(92,122,96,.18);}
.fx-compmeter{display:flex;align-items:flex-end;gap:2.5px;height:16px;flex-shrink:0;}
.fx-compbar{width:2.5px;border-radius:2px;background:#5C7A60;animation:fx-level 900ms ease-in-out infinite;}
.fx-compbar:nth-child(1){height:6px;animation-delay:0ms;}
.fx-compbar:nth-child(2){height:14px;animation-delay:110ms;}
.fx-compbar:nth-child(3){height:9px;animation-delay:220ms;}
.fx-compbar:nth-child(4){height:16px;animation-delay:330ms;}
.fx-compbar:nth-child(5){height:7px;background:#9EB7A6;animation-delay:440ms;}
@keyframes fx-level{0%,100%{transform:scaleY(.55);}50%{transform:scaleY(1);}}

/* One row of buttons, opened by tapping one word. Only that word's row. */
.fx-compopen{margin-top:13px;padding-top:13px;border-top:1px solid rgba(31,35,28,.07);
  display:flex;flex-direction:column;gap:10px;}
.fx-comprow{display:flex;align-items:flex-start;gap:14px;}
.fx-complab{width:52px;flex:0 0 52px;padding-top:8px;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#A6ABA6;}
.fx-compopts{display:flex;gap:6px;flex-wrap:wrap;min-width:0;}
/* The REPEAT line. One line, scrolled sideways, never reflowed: the row is a
   sentence read left to right, and a cadence list that wraps to three rows
   turns the composer back into the form it exists instead of. */
.fx-compopts.fx-compscroll{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:2px;}
.fx-compopts.fx-compscroll::-webkit-scrollbar{display:none;}
.fx-compopts.fx-compscroll > *{flex-shrink:0;}
/* The blank at the end of it: a chip that CONTAINS the number rather than one
   that opens somewhere to type it. */
.fx-compevery{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;border-radius:9px;
  border:1px dashed rgba(31,35,28,.22);background:#fff;color:#5C625C;font-size:12.5px;white-space:nowrap;}
.fx-compevery.fx-sel{border-style:solid;border-color:#3E5C48;background:#3E5C48;color:#fff;font-weight:600;}
.fx-compnum{width:2.6em;min-width:0;border:none;background:transparent;padding:0;text-align:center;
  font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:12.5px;color:inherit;
  border-bottom:1px solid currentColor;}
.fx-compnum:focus{outline:none;}
.fx-compnum::placeholder{color:currentColor;opacity:.55;}
.fx-compevery.fx-sel .fx-compnum{font-weight:600;}
/* The "Other" chip. A pointer at the sentence, so it never wears fx-sel. */
.fx-compb.fx-compother{border-style:dashed;color:#8A9187;}
.fx-compb.fx-compother:hover:not(:disabled){color:#5C625C;}
/* A quiet line under a row of buttons, in the buttons' own column. */
.fx-comphint{font-size:11.5px;color:#8A9187;line-height:1.5;min-width:0;padding-top:2px;}
.fx-compb{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;
  border:1px solid rgba(31,35,28,.12);background:#fff;color:#5C625C;font-size:12.5px;font-family:inherit;
  cursor:pointer;white-space:nowrap;transition:background .16s ease,border-color .16s ease;}
.fx-compb:hover:not(:disabled){background:#F4F6F2;border-color:rgba(31,35,28,.2);}
.fx-compb:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-compb:disabled{opacity:.5;cursor:default;}
.fx-compb.fx-sel{background:#3E5C48;border-color:#3E5C48;color:#fff;font-weight:600;}
.fx-compb.fx-sel:hover:not(:disabled){background:#3E5C48;border-color:#3E5C48;}
/* "Pick a day" carries the native date input, which cannot be styled to match
   the row and does not need to be: the button is the control a person sees. */
.fx-compday{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}
.fx-compdaywrap{position:relative;display:inline-flex;}

/* The question. A short line and two answers, both of which are correct. */
.fx-compask{display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:12px;
  border-top:1px solid rgba(31,35,28,.07);flex-wrap:wrap;}
.fx-compaskt{font-size:12.5px;color:#8C6A33;}
.fx-compaskb{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:9px;
  border:1px solid rgba(201,150,68,.6);background:#fff;color:#1F231C;font-size:12.5px;font-weight:500;
  font-family:inherit;cursor:pointer;white-space:nowrap;box-shadow:0 0 0 3px rgba(201,150,68,.14);
  transition:background .16s ease;}
.fx-compaskb:hover:not(:disabled){background:#FDF7EC;}
.fx-compaskb:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-compaskn{margin-left:auto;font-size:11.5px;color:#8A9187;}

/* The foot: the housekeeping line, and the mono hint where Add would have been.
   Only when the WHO row is open, or when all three are. */
.fx-compfoot{display:flex;align-items:center;gap:14px;margin-top:13px;padding-top:12px;
  border-top:1px solid rgba(31,35,28,.07);flex-wrap:wrap;}
.fx-compfootl{font-size:11.5px;color:#8A9187;line-height:1.5;}
.fx-compfoot .fx-compkey{margin-left:auto;}

/* The quiet lines under the row. Never inside it: they are about what just
   happened, not about what is being typed. */
.fx-compnote{font-size:11.5px;color:#8A9187;line-height:1.5;margin-top:8px;margin-left:18px;}
.fx-compnote.fx-warm{color:#8C6A33;}
.fx-err{margin-top:9px;border-radius:10px;padding:8px 11px;font-size:12.5px;line-height:1.5;
  background:rgba(184,92,61,.10);color:#8E432B;}
.fx-reason{margin-top:9px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;width:100%;}
.fx-input{flex:1;min-width:190px;height:30px;padding:0 11px;border-radius:9px;font-size:12.5px;
  border:1px solid rgba(31,35,28,.16);background:#fff;color:#1F231C;font-family:inherit;}
.fx-input:focus{outline:2px solid #3E5C48;outline-offset:1px;}
/* A row that has grown a reason box stops being one line. */
.fx-row.fx-open{flex-wrap:wrap;align-items:flex-start;}

/* Entry E/F — the ink card. Everything Staxis says is dark. */
.fx-ink-card{background:#1F231C;border-radius:18px;padding:19px 22px;position:relative;overflow:hidden;
  box-shadow:0 20px 44px -34px rgba(31,42,32,.95);transition:transform 160ms ease,box-shadow 160ms ease;}
.fx-ink-card:hover{transform:translateY(-1px);box-shadow:0 26px 52px -32px rgba(31,42,32,.95);}
.fx-ink-card.fx-focused{box-shadow:0 0 0 3px rgba(158,183,166,.5),0 20px 44px -34px rgba(31,42,32,.95);}
.fx-scan{position:absolute;top:0;left:0;width:40%;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(158,183,166,.9),transparent);
  animation:fx-sweep 5.5s linear infinite;}
.fx-scan.fx-slow{animation-duration:6s;}
.fx-inkhead{display:flex;align-items:center;gap:11px;flex-wrap:wrap;}
.fx-badge{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#9EB7A6;white-space:nowrap;}
.fx-cat{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#7E8A7F;}
.fx-stamp{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#6E786F;}
.fx-money{margin-left:auto;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:18px;
  font-weight:600;color:#fff;letter-spacing:-.02em;white-space:nowrap;}
.fx-tally{margin-left:auto;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#7E8A7F;}
.fx-headline{font-size:18.5px;font-weight:600;color:#fff;letter-spacing:-.02em;margin-top:10px;
  line-height:1.35;text-wrap:pretty;}
.fx-prov{font-size:13px;color:#B9C0B8;margin-top:7px;line-height:1.55;}
.fx-prov .fx-hintw{color:#7E8A7F;}
.fx-sugg{margin-top:14px;border-radius:12px;border:1px solid rgba(158,183,166,.28);
  background:rgba(158,183,166,.1);padding:13px 15px;display:flex;align-items:center;gap:12px;}
.fx-suggi{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;flex-shrink:0;
  background:rgba(158,183,166,.22);color:#9EB7A6;animation:fx-pulsering 3s ease-out infinite;}
.fx-suggt{font-size:13px;line-height:1.5;color:#EDF1EC;}
/* The question over the buttons. Only present when a model wrote one, so the
   card's spacing when it is absent is byte-identical to what shipped. */
.fx-inkq{font-size:13.5px;color:#EDF1EC;margin-top:14px;line-height:1.5;}
.fx-inkacts{display:flex;align-items:center;gap:9px;margin-top:16px;flex-wrap:wrap;position:relative;}
.fx-ib{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:10px;
  border:none;background:rgba(255,255,255,.09);color:#fff;font-size:13px;font-weight:500;cursor:pointer;
  white-space:nowrap;font-family:inherit;transition:background .16s ease;}
.fx-ib:hover:not(:disabled){background:rgba(255,255,255,.16);}
.fx-ib:disabled{opacity:.55;cursor:default;}
.fx-ib:focus-visible{outline:2px solid #9EB7A6;outline-offset:2px;}
.fx-ib.fx-go{background:#9EB7A6;color:#1F231C;font-weight:700;padding:0 16px;}
.fx-ib.fx-go:hover:not(:disabled){background:#B0C6B7;}
.fx-ib.fx-link{background:transparent;color:#B9C0B8;padding:0 13px;gap:7px;text-decoration:none;}
.fx-ib.fx-link:hover:not(:disabled){background:rgba(255,255,255,.07);color:#EDF1EC;}
.fx-ib.fx-more{margin-left:auto;width:36px;padding:0;justify-content:center;color:#B9C0B8;font-size:16px;
  letter-spacing:.08em;}
.fx-ib.fx-warn{color:#E8A87C;}
/* ── The card's overflow menu ──────────────────────────────────────────────
   FIXED, and drawn from a portal on the document body. It used to be
   position:absolute inside .fx-ink-card, whose own rule is overflow:hidden, so
   it opened below the last row of the card, into space the card does not have,
   and was clipped to a sliver under the following card. No z-index could have
   saved it: overflow clips descendants whatever their stacking order, and the
   card's hover transform makes it a containing block for fixed children too.
   The fix is to stop being its descendant. Coordinates: placeCardMenu. */
.fx-menu{position:fixed;z-index:60;min-width:206px;overflow-y:auto;overscroll-behavior:contain;
  background:#2A2F27;border:1px solid rgba(255,255,255,.12);border-radius:12px;
  box-shadow:0 22px 44px -22px rgba(0,0,0,.75);}
/* The way out that is not one of the menu's own items. Transparent, and under
   the menu, so the first click anywhere else closes it and nothing else. */
.fx-menu-scrim{position:fixed;inset:0;z-index:59;background:transparent;border:none;
  padding:0;cursor:default;}
.fx-menu button{display:block;width:100%;text-align:left;padding:10px 14px;border:none;background:transparent;
  color:#EDF1EC;font-size:12.5px;font-family:inherit;cursor:pointer;}
.fx-menu button:hover:not(:disabled){background:rgba(255,255,255,.08);}
.fx-menu button.fx-danger{color:#E8A87C;}
.fx-menu button:disabled{opacity:.5;cursor:default;}
.fx-sure{font-size:12.5px;color:#E8A87C;align-self:center;}
/* Panels that open inside an ink card: the receipt, the offer, the outcome. */
.fx-inkbox{margin-top:12px;border-radius:12px;border:1px solid rgba(255,255,255,.11);
  background:rgba(255,255,255,.05);padding:11px 14px;}
.fx-inkrow{display:flex;justify-content:space-between;gap:14px;padding:4px 0;font-size:12.5px;
  border-bottom:1px solid rgba(255,255,255,.07);}
.fx-inkrow:last-child{border-bottom:none;}
.fx-inkk{color:#7E8A7F;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.06em;}
.fx-inkv{color:#EDF1EC;text-align:right;word-break:break-word;min-width:0;}
.fx-inkfoot{font-size:10.5px;color:#6E786F;margin-top:8px;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.fx-inknote{margin-top:12px;border-radius:12px;padding:11px 14px;font-size:12.5px;line-height:1.5;}
.fx-inknote.fx-ok{background:rgba(158,183,166,.14);color:#CFDCD1;}
.fx-inknote.fx-hold{background:rgba(201,150,68,.16);color:#E3C589;}
.fx-inknote.fx-bad{background:rgba(184,92,61,.18);color:#E8A87C;}

/* Entry F — the morning brief's own bits */
.fx-brief{font-family:var(--font-fraunces),Georgia,serif;font-style:italic;font-size:25px;line-height:1.2;
  color:#fff;margin-top:11px;letter-spacing:-.01em;}
button.fx-brief{display:block;background:none;border:none;padding:0;text-align:left;cursor:pointer;
  text-decoration:underline;text-decoration-color:rgba(158,183,166,.45);text-underline-offset:5px;}
button.fx-brief:hover{text-decoration-color:#9EB7A6;}
button.fx-brief:focus-visible{outline:2px solid #9EB7A6;outline-offset:3px;border-radius:4px;}
.fx-bchips{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}
.fx-bchip{display:inline-flex;align-items:center;gap:8px;height:31px;padding:0 12px;border-radius:9px;
  background:rgba(255,255,255,.08);color:#9EB7A6;font-size:12.5px;font-weight:500;border:none;
  font-family:inherit;text-align:left;}
button.fx-bchip{cursor:pointer;transition:background .16s ease;}
button.fx-bchip:hover{background:rgba(255,255,255,.15);}
button.fx-bchip:focus-visible{outline:2px solid #9EB7A6;outline-offset:2px;}
.fx-bchip.fx-flag{color:#E3C589;}
.fx-bdot{width:5px;height:5px;border-radius:50%;background:#9EB7A6;flex-shrink:0;}
.fx-bchip.fx-flag .fx-bdot{background:#C99644;}

/* ── Region 3: the right rail ── */
.fx-rail{display:flex;flex-direction:column;gap:14px;min-width:0;}
.fx-life-panel{background:#fff;border:1px solid rgba(31,35,28,.09);border-radius:18px;padding:15px 18px;
  box-shadow:0 16px 36px -30px rgba(31,42,32,.7);min-width:0;}
.fx-life-provenance{display:flex;gap:9px;flex-wrap:wrap;margin-top:9px;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:9.5px;letter-spacing:.03em;color:#A6ABA6;line-height:1.4;}
.fx-life-provenance span+span{padding-left:9px;border-left:1px solid rgba(31,35,28,.1);}
.fx-life-status,.fx-life-empty,.fx-life-error,.fx-life-stale{font-size:12.5px;line-height:1.55;margin:12px 0 0;}
.fx-life-status,.fx-life-empty{color:#5C625C;}
.fx-life-error{color:#8E432B;background:rgba(184,92,61,.10);border-radius:10px;padding:9px 11px;}
.fx-life-stale{color:#8C6A33;background:rgba(201,150,68,.13);border-radius:10px;padding:9px 11px;}
.fx-life-items{display:flex;flex-direction:column;gap:10px;margin-top:13px;max-height:min(720px,calc(100dvh - 190px));overflow:auto;
  padding-right:2px;scrollbar-width:thin;}
.fx-life-item{border:1px solid rgba(31,35,28,.08);border-radius:13px;padding:13px 14px;background:#FAFBF9;}
.fx-life-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}
.fx-life-eyebrow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.12em;
  text-transform:uppercase;color:#3E5C48;font-weight:700;}
.fx-life-title{font-size:14px;line-height:1.35;font-weight:600;color:#1F231C;margin:4px 0 0;}
.fx-life-entity{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.04em;color:#8A9187;
  text-align:right;max-width:42%;overflow-wrap:anywhere;}
.fx-life-summary{font-size:12.5px;line-height:1.5;color:#5C625C;margin:7px 0 0;}
.fx-life-states{display:flex;gap:4px;list-style:none;margin:12px 0 0;padding:0;align-items:flex-start;flex-wrap:wrap;}
.fx-life-state{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:8.5px;line-height:1.35;letter-spacing:.02em;color:#A6ABA6;}
.fx-life-state:not(:last-child)::after{content:'→';color:#C9CFC8;margin-left:1px;}
.fx-life-dot{width:6px;height:6px;border-radius:50%;background:#C9CFC8;flex-shrink:0;}
.fx-life-state-on{color:#3E5C48;font-weight:600;}
.fx-life-state-on .fx-life-dot{background:#5C7A60;}
.fx-life-terminal{color:#8C6A33;}
.fx-life-state-terminal{color:#8C6A33;font-weight:600;}
.fx-life-state-terminal .fx-life-dot{background:#C99644;}
.fx-life-facts{display:grid;grid-template-columns:1fr;gap:5px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(31,35,28,.07);
  font-size:11.5px;line-height:1.45;color:#5C625C;}
.fx-life-fact,.fx-life-action-line{display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px;align-items:start;}
.fx-life-key{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#8A9187;}
.fx-life-action{display:flex;flex-direction:column;gap:6px;margin-top:11px;padding:10px 11px;border-radius:10px;
  background:rgba(158,183,166,.12);font-size:11.5px;line-height:1.45;color:#3E5C48;}
.fx-life-owner{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px solid rgba(31,35,28,.07);
  font-size:11.5px;line-height:1.45;color:#5C625C;}
.fx-life-owner>span+span{padding-left:10px;border-left:1px solid rgba(31,35,28,.1);}
.fx-life-link{color:#3E5C48;font-weight:600;text-decoration:none;border-bottom:1px solid rgba(62,92,72,.3);}
.fx-life-link:hover{border-bottom-color:#3E5C48;}
.fx-life-link:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;border-radius:3px;}
.fx-life-note{font-size:11.5px;line-height:1.45;color:#8C6A33;margin:10px 0 0;}
.fx-life-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid rgba(31,35,28,.07);
  font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.03em;color:#A6ABA6;}
.fx-knows{display:flex;align-items:center;gap:13px;background:#fff;border:1px solid rgba(62,92,72,.3);
  border-radius:16px;padding:15px 18px;box-shadow:0 16px 34px -28px rgba(31,42,32,.85);width:100%;
  text-align:left;cursor:pointer;font-family:inherit;transition:transform 160ms ease,box-shadow 160ms ease;}
.fx-knows:hover{transform:translateY(-1px);box-shadow:0 22px 40px -26px rgba(31,42,32,.85);}
.fx-knows:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-knowsi{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;flex-shrink:0;
  background:rgba(92,122,96,.16);color:#3E5C48;}
.fx-knowsgo{margin-left:auto;display:grid;place-items:center;width:28px;height:28px;border-radius:9px;
  background:rgba(31,35,28,.05);color:#5C7A60;flex-shrink:0;}
.fx-panel{background:#fff;border:1px solid rgba(31,35,28,.09);border-radius:18px;padding:15px 18px;
  box-shadow:0 16px 36px -30px rgba(31,42,32,.7);}
.fx-ptop{display:flex;align-items:center;gap:9px;}
.fx-pt{font-size:14.5px;font-weight:600;color:#1F231C;}
.fx-ps{font-size:11.5px;color:#8A9187;margin-top:2px;}
.fx-count{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;
  background:rgba(92,122,96,.14);font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;
  font-weight:600;color:#3E5C48;white-space:nowrap;}
.fx-tally-r{margin-left:auto;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;
  color:#A6ABA6;white-space:nowrap;}
.fx-report{font-size:13px;color:#3E5C48;line-height:1.55;margin-top:10px;}
.fx-report + .fx-report{margin-top:4px;}
.fx-quote{font-size:12.5px;color:#8E432B;line-height:1.5;margin-top:3px;}
.fx-plain{font-size:13px;color:#5C625C;line-height:1.55;margin-top:10px;}
.fx-more-link{display:inline-flex;align-items:center;gap:5px;margin-top:12px;font-size:12.5px;
  font-weight:600;color:#3E5C48;background:none;border:none;padding:0;cursor:pointer;font-family:inherit;}
.fx-more-link:hover{text-decoration:underline;text-underline-offset:3px;}
.fx-more-link:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;border-radius:4px;}
.fx-log{display:flex;gap:9px;align-items:baseline;margin-top:11px;}
.fx-log + .fx-log{margin-top:7px;}
.fx-logt{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#A6ABA6;flex-shrink:0;}
.fx-logb{font-size:13px;color:#1F231C;line-height:1.45;min-width:0;}
.fx-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px;
  padding-top:12px;border-top:1px solid rgba(31,35,28,.07);}
.fx-footl{font-size:12.5px;color:#5C625C;}
.fx-sw{width:34px;height:20px;border-radius:999px;background:rgba(31,35,28,.16);position:relative;
  flex-shrink:0;border:none;cursor:pointer;padding:0;transition:background .2s ease;}
.fx-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .2s ease;}
.fx-sw[aria-checked="true"]{background:#5C7A60;}
.fx-sw[aria-checked="true"]::after{transform:translateX(14px);}
.fx-sw:disabled{opacity:.55;cursor:default;}
.fx-sw:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}

/* ── The month overlay ──
   It used to be a 388px popover hanging off the Month button, which is a
   thumbnail of a calendar rather than one anybody can pick a range on, and
   "Add event" closed it outright. It is now a proper card over the page, wide
   enough to hold the month AND the panel that puts something in it. */
.fx-monthover{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:61;
  width:min(1020px,calc(100vw - 40px));max-height:min(860px,calc(100dvh - 56px));background:#fff;
  display:flex;flex-direction:column;border:1px solid rgba(31,35,28,.1);border-radius:18px;overflow:hidden;
  box-shadow:0 30px 60px -30px rgba(31,42,32,.55);animation:fx-riseover .18s ease;}
.fx-monthbody{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:18px 22px 24px;}
.fx-headr{position:relative;}
/* The count beside "Show more". Mono, so it reads as a tally and not a word. */
.fx-morec{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#A6ABA6;
  font-weight:400;}

/* ── The log book popup ──
   Header and footer only; the pane inside brings its own. Type roles follow
   the page: Geist for the title, Geist Mono for the tally. */
.fx-lbhead{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;flex-shrink:0;
  border-bottom:1px solid rgba(31,35,28,.08);}
.fx-lbt{font-size:16px;font-weight:600;color:#1F231C;letter-spacing:-.01em;}
.fx-lbhead .fx-tally-r{margin-left:auto;}
.fx-lbfoot{padding:12px 20px 16px;flex-shrink:0;border-top:1px solid rgba(31,35,28,.07);}
.fx-lbfoot .fx-foot{margin-top:0;padding-top:0;border-top:none;}

/* ── What Staxis knows ──
   A CENTRED overlay, not a right-hand drawer. It is a place you look at, not a
   sidebar you work beside, and it now wears the same card the month grid does:
   white, 18px radius, one hairline, one deep soft shadow, one short fade. The
   page stays mounted behind it either way, which was always the point. */
.fx-scrim{position:fixed;inset:0;z-index:60;background:rgba(20,26,20,.34);border:none;padding:0;
  animation:fx-fade .18s ease;cursor:pointer;}
.fx-drawer{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:61;
  width:min(620px,calc(100vw - 40px));max-height:min(760px,calc(100dvh - 64px));background:#fff;
  display:flex;flex-direction:column;border:1px solid rgba(31,35,28,.1);border-radius:18px;overflow:hidden;
  box-shadow:0 30px 60px -30px rgba(31,42,32,.55);
  animation:fx-riseover .18s ease;}
@keyframes fx-riseover{from{opacity:0;transform:translate(-50%,calc(-50% + 10px));}
  to{opacity:1;transform:translate(-50%,-50%);}}
.fx-drawerhead{display:flex;align-items:center;gap:12px;padding:20px 22px;flex-shrink:0;
  border-bottom:1px solid rgba(31,35,28,.08);}
.fx-draweri{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;flex-shrink:0;
  background:rgba(92,122,96,.16);color:#3E5C48;}
.fx-drawert{font-size:16px;font-weight:600;color:#1F231C;letter-spacing:-.01em;}
.fx-drawers{font-size:12px;color:#8A9187;margin-top:2px;}
.fx-drawerx{margin-left:auto;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;
  background:rgba(31,35,28,.05);color:#5C625C;border:none;cursor:pointer;flex-shrink:0;}
.fx-drawerx:hover{background:rgba(31,35,28,.1);}
.fx-drawerx:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fx-drawerbody{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;}
/* Knows was written as a full page. Inside the drawer it is one column. */
.fx-drawerbody .cx-page{max-width:none;padding:0 22px 26px;}

@media (max-width:1180px){
  .fx-body{grid-template-columns:1fr;}
  .fx-rail{flex-direction:row;flex-wrap:wrap;}
  .fx-rail > *{flex:1;min-width:280px;}
}
/* ── The phone ───────────────────────────────────────────────────────────
   Everything below 760px is somebody holding the hotel in one hand. The
   rules here are not a shrink of the desktop screen, they are the four
   things a phone actually changes:

     1. NOTHING MAY BE WIDER THAN THE WINDOW. Every row on this page is a
        flex line of nowrap parts (a mono clock, a range label, a segmented
        control, seven day cards, nine cadence chips). A flex item's
        automatic minimum is its CONTENT, so each of those quietly refused
        to shrink and pushed the whole document sideways: 375px of phone
        holding 452px of page. A zero minimum on the boxes and a capped
        width on the scrollers is what makes the window the boundary again.
     2. A SIDEWAYS LIST HAS TO SCROLL SIDEWAYS. The week strip and the
        cadence line already say overflow-x auto, which does nothing at all
        while an ancestor is letting them be their full width. Once they
        are clamped they scroll, so they also claim the horizontal swipe
        and carry a soft fade so the edge says there is more.
     3. A ROW IS A STACK, NOT A LINE. Title, then the clock, then the
        buttons. Squeezing all three onto one 343px line left titles
        wrapping one word per line beside a mono stamp that would not.
     4. A FINGER IS NOT A CURSOR. Anything you press is at least 40px, and
        anything you type into is at least 16px so iOS does not zoom the
        page on focus and leave it zoomed. */
@media (max-width:760px){
  .fx-page{padding:18px 16px calc(200px + env(safe-area-inset-bottom));}
  .fx-head{align-items:flex-start;min-width:0;}
  .fx-day{font-size:34px;}
  .fx-headr{align-items:stretch;width:100%;min-width:0;max-width:100%;}
  /* The day controls wrap instead of running off the edge. */
  .fx-cal{flex-wrap:wrap;row-gap:9px;min-width:0;max-width:100%;}
  .fx-cal .fx-vrule{display:none;}
  .fx-seg{margin-left:auto;}
  .fx-week{overflow-x:auto;scrollbar-width:none;padding-bottom:2px;
    max-width:100%;align-self:stretch;touch-action:pan-x;overscroll-behavior-x:contain;
    -webkit-mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent 100%);
    mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent 100%);}
  .fx-week::-webkit-scrollbar{display:none;}
  .fx-wd{width:56px;flex-shrink:0;}

  /* One row of work, stacked. */
  .fx-row{flex-wrap:wrap;gap:9px 12px;}
  .fx-rowm{white-space:normal;}
  .fx-rowa{margin-left:0;flex-wrap:wrap;width:100%;}

  /* The sentence keeps the line; its three words drop underneath it. */
  .fx-compline{flex-wrap:wrap;gap:10px 12px;}
  .fx-comptitle{flex:1 1 140px;min-width:0;font-size:16px;min-height:40px;}
  .fx-comptitle::placeholder{font-size:16px;}
  .fx-comptitle.fx-live{font-size:16px;}
  .fx-compw{margin-left:0;order:1;flex:1 0 100%;font-size:13px;}
  .fx-complab{width:100%;flex:0 0 auto;padding-top:0;}
  .fx-comprow{flex-direction:column;align-items:stretch;gap:6px;min-width:0;}
  .fx-compopts{max-width:100%;min-width:0;}
  .fx-compopts.fx-compscroll{align-self:stretch;touch-action:pan-x;overscroll-behavior-x:contain;
    -webkit-mask-image:linear-gradient(to right,#000 calc(100% - 26px),transparent 100%);
    mask-image:linear-gradient(to right,#000 calc(100% - 26px),transparent 100%);}
  .fx-input{font-size:16px;height:40px;}
  .fx-compnum{font-size:16px;}

  /* A finger, not a cursor. */
  .fx-btn{height:40px;padding:0 14px;font-size:13.5px;}
  .fx-btn.fx-primary{padding:0 16px;}
  .fx-btn.fx-quiet{padding:0 10px;}
  .fx-step{width:40px;height:40px;}
  .fx-month{height:40px;padding:0 14px;font-size:13.5px;}
  .fx-seg{height:44px;padding:2px;}
  .fx-segb{height:40px;padding:0 12px;font-size:13px;}
  .fx-compb,.fx-compevery,.fx-compaskb{height:40px;font-size:13.5px;}
  .fx-compmic{width:40px;height:40px;}
  .fx-compmic.fx-rec{width:40px;height:40px;}
  .fx-compnum{height:32px;}
  .fx-compday{font-size:16px;}
  .fx-compword{min-height:40px;min-width:44px;justify-content:center;padding:0 8px;}
  .fx-compword.fx-lift,.fx-compword.fx-pick{padding:0 9px;}
  .fx-drawerx{width:40px;height:40px;}
  .fx-more-link{min-height:40px;}
  .fx-ib{height:40px;}
  .fx-life-panel{padding:14px 15px;}
  .fx-life-items{max-height:none;overflow:visible;padding-right:0;}
  .fx-life-fact,.fx-life-action-line{grid-template-columns:68px minmax(0,1fr);}
  .fx-life-link{display:inline-flex;align-items:center;min-height:40px;}
  .fx-sw{width:44px;height:26px;}
  .fx-sw::after{width:22px;height:22px;}
  .fx-sw[aria-checked="true"]::after{transform:translateX(18px);}

  /* Popups take the window, and stop short of the home indicator. */
  .fx-monthover,.fx-drawer{width:calc(100vw - 20px);max-height:calc(100dvh - 32px);}
  .fx-monthbody{padding:16px 16px calc(24px + env(safe-area-inset-bottom));}
  .fx-drawerhead{padding:14px 16px;}
  .fx-drawerbody .cx-page{padding:0 16px calc(26px + env(safe-area-inset-bottom));}
  .fx-lbfoot{padding-bottom:calc(16px + env(safe-area-inset-bottom));}
}

@media (prefers-reduced-motion: reduce){
  .fx-scan,.fx-suggi{animation:none;}
  .fx-scrim,.fx-drawer,.fx-monthover{animation:none;}
  .fx-row,.fx-ink-card,.fx-knows,.fx-wd{transition:none;}
  .fx-row:hover,.fx-ink-card:hover,.fx-knows:hover,.fx-wd:hover{transform:none;}
  .fx-life-link{transition:none;}
  /* The level meter freezes at rest rather than stopping mid-bounce, and
     nothing in the composer transitions. */
  .fx-compbar{animation:none;transform:none;}
  .fx-comp,.fx-compword,.fx-compb,.fx-compmic,.fx-compaskb{transition:none;}
}
`;
