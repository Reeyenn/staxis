'use client';

/**
 * Marketing landing page for getstaxis.com.
 *
 * Styled on the app's Snow design system (paper-white canvas, ink text,
 * sage + caramel accents, Instrument Serif display, Geist body, Geist Mono
 * labels) and the real in-app ChevronMark logo, so the marketing site and
 * the product feel like one thing.
 *
 * Narrative spine: the old way you WALK to the work (nine sticky-note
 * chores), the Staxis way the work COMES TO YOU (one notification, one
 * tap), and one page runs the hotel with every deep page an orbit away.
 *
 * Self-contained: all styles live in the <style> block below. The
 * SMS-compliance content the Twilio review needs (program description,
 * opt-in, contact, address) is preserved in the footer and via the
 * /consent, /privacy, /terms links. Do not remove it.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/* ChevronMark — the real in-app logo (src/components/layout/Header)  */
/* ------------------------------------------------------------------ */

function ChevronMark({ size = 26, color = '#1A1F1B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30"
        stroke={color}
        strokeWidth={4.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Live ops feed — deterministic script, cycles forever               */
/* ------------------------------------------------------------------ */

type FeedItem = {
  time: string;
  icon: string;
  text: string;
  tone: 'ok' | 'warn' | 'info';
};

const FEED_SCRIPT: FeedItem[] = [
  { time: '6:02 AM', icon: '◉', text: 'Read 42 arrivals + 38 departures from your PMS', tone: 'info' },
  { time: '6:02 AM', icon: '✓', text: 'Maria confirmed for today: “¡Sí!”', tone: 'ok' },
  { time: '6:03 AM', icon: '⚡', text: 'Housekeeping board built, 31 rooms assigned', tone: 'ok' },
  { time: '6:07 AM', icon: '▲', text: 'Towels running low, reorder drafted', tone: 'warn' },
  { time: '6:11 AM', icon: '⚡', text: 'Room 118 AC ticket assigned to maintenance', tone: 'info' },
  { time: '6:14 AM', icon: '✓', text: 'Room 204 flipped dirty → clean, inspection queued', tone: 'ok' },
  { time: '6:18 AM', icon: '◉', text: 'Occupancy tonight projected 84%, staffing holds', tone: 'info' },
  { time: '6:22 AM', icon: '✓', text: 'Late checkout on 312, cleaner resequenced', tone: 'ok' },
  { time: '6:25 AM', icon: '▲', text: 'Breakfast bar coffee running low, flagged', tone: 'warn' },
  { time: '6:29 AM', icon: '✓', text: 'All property feeds healthy', tone: 'ok' },
];

const ROOM_COUNT = 28;
const SPARKLES = [
  { left: '8%', delay: '0s', dur: '11s' },
  { left: '22%', delay: '3s', dur: '14s' },
  { left: '41%', delay: '6s', dur: '12s' },
  { left: '58%', delay: '1.5s', dur: '15s' },
  { left: '73%', delay: '4.5s', dur: '10s' },
  { left: '88%', delay: '7s', dur: '13s' },
];

/* The old way — nine chores, one long walk */
const OLD_STEPS = [
  { icon: '🚶', text: 'Walk to the supply closet' },
  { icon: '🔢', text: 'Count the towels' },
  { icon: '📓', text: 'Log it in the Excel sheet' },
  { icon: '🧮', text: 'Check the budget formula' },
  { icon: '😬', text: 'Make sure you’re not over' },
  { icon: '📞', text: 'Ask someone to place the order' },
  { icon: '⏳', text: 'Wait for it to arrive' },
  { icon: '📦', text: 'Count it all again' },
  { icon: '✍️', text: 'Log it. Again.' },
];

/* One page — the app's real pages, orbiting. Hover a chip and a mini
   live demo of that page blooms outward: the page's real sub-tabs
   (clickable), a scrollable body, built from what the actual app
   screens contain. */
const ORBIT_PAGES = [
  { id: 'dashboard', label: 'Dashboard', x: 10, y: 14, dir: 'up-left', tabs: ['Overview'] },
  { id: 'financials', label: 'Financials', x: 48, y: 3, dir: 'up', tabs: ['Checkbook', 'Budget', 'CapEx'] },
  { id: 'housekeeping', label: 'Housekeeping', x: 84, y: 12, dir: 'up-right', tabs: ['Rooms', 'Schedule', 'Quality', 'Deep Clean'] },
  { id: 'maintenance', label: 'Maintenance', x: 8, y: 50, dir: 'left', tabs: ['Work Orders', 'Preventive', 'Equipment'] },
  /* farther out than the rest, on purpose: it's not here yet */
  { id: 'comingsoon', label: 'Coming Soon', x: 97, y: 30, dir: 'right', tabs: ['Guest Experience'], soon: true },
  { id: 'inventory', label: 'Inventory', x: 87, y: 52, dir: 'right', tabs: ['Inventory'] },
  { id: 'staff', label: 'Staff', x: 16, y: 92, dir: 'down-left', tabs: ['Schedule', 'Directory', 'Recognition'] },
  { id: 'communications', label: 'Communications', x: 76, y: 94, dir: 'down-right', tabs: ['Messages', 'Log Book', 'Calendar'] },
] as const;

/* Mini live page inside each orbit popup, per page + sub-tab —
   each one mirrors the real app screen's layout in miniature. */
function ChipDemo({ id, sub }: { id: string; sub: number }) {
  if (id === 'comingsoon') {
    return (
      <div className="ap gx">
        {[
          ['✆', 'An AI voice agent answering every guest call, 24/7'],
          ['☾', 'After-hours bookings, never missed again'],
          ['⇄', 'Reservation changes handled automatically'],
          ['✉', 'Instant replies to guest texts and emails'],
          ['✓', 'Late checkouts and requests taken by phone'],
          ['🌎', 'Guests greeted in their own language'],
        ].map(([ic, t], i) => (
          <div className="gx-item" key={t} style={{ animationDelay: `${i * 90}ms` }}>
            <span className="gx-ic">{ic}</span>{t}
          </div>
        ))}
        <div className="ap-note">Every request lands on the same one page that runs your operations.</div>
      </div>
    );
  }
  if (id === 'dashboard') {
    return (
      <div className="ap wide">
        <div className="x-serifhead big"><em>Sunday, July 5</em></div>
        <div className="ap-cols">
          <div className="ap-card ap-ringrow" style={{ flex: 'none', flexDirection: 'column', alignItems: 'center' }}>
            <div className="x-caps" style={{ margin: 0 }}>OCCUPANCY</div>
            <div className="ap-ring big" />
            <div className="x-serifhead"><em className="t-good">84%</em></div>
          </div>
          <div className="ap-card ap-chart">
            <div className="ap-rail">
              {['Occupancy', 'Revenue', 'ADR', 'RevPAR', 'Profit'].map((k, i) => (
                <span className={`ap-railbtn ${i === 0 ? 'on' : ''}`} key={k}>{k}</span>
              ))}
            </div>
            <svg viewBox="0 0 220 60" preserveAspectRatio="none">
              <polyline points="0,44 25,40 50,42 75,32 100,35 125,24 150,28 175,18 200,22 220,14" />
              <circle cx="200" cy="22" r="3" />
            </svg>
          </div>
        </div>
        <div className="x-caps">RIGHT NOW</div>
        <div className="x-headrow x-nowrow">
          <div className="x-stat"><span>GUESTS</span><b className="t-good">42</b><span>in-house</span></div>
          <div className="x-stat"><span>ARRIVALS</span><b className="t-low">8</b><span>expected</span></div>
          <div className="x-stat"><span>DEPARTURES</span><b className="t-low">6</b><span>checking out</span></div>
          <div className="x-stat"><span>HOUSEKEEPING</span><b className="t-crit">12</b><span>rooms to clean</span></div>
          <div className="x-stat"><span>TURNOVER</span><b>34</b><span>min / room</span></div>
        </div>
        <div className="ap-card x-attention">
          <span className="x-caps" style={{ margin: 0 }}>NEEDS ATTENTION</span>
          <span className="x-spacer" />
          <b className="x-attn-badge">2</b>
        </div>
        <div className="ap-card ap-need"><span className="ti-dot warn" />2 urgent work orders<span className="ap-btn">View</span></div>
        <div className="ap-card ap-need"><span className="ti-dot warn" />Towels below par<span className="ap-btn">Open</span></div>
      </div>
    );
  }
  if (id === 'financials') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="ap-h">THIS MONTH VS BUDGET</div>
          {[['Labor', 72, 'good'], ['Supplies', 61, 'good'], ['Maintenance', 88, 'low'], ['Utilities', 54, 'good']].map(([n, p, c]) => (
            <div className="ap-card ap-stock" key={n as string}>
              <b>{n}</b><div className="ap-bar big"><i className={`f-${c}`} style={{ width: `${p}%` }} /></div>
              <span className={`ap-pct t-${c}`}>{p}%</span>
            </div>
          ))}
          <div className="ap-note">Green means under budget. Staxis flags it before it turns red.</div>
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-h">CAPEX PROJECTS</div>
          {[['PTAC replacements · floor 2', 'Planned', '$4,800', 'low'], ['Lobby refresh', 'Saving · 60%', '$12,000', 'good'], ['Parking lot reseal', 'Done ✓', '$3,200', 'good']].map(([n, st, amt, c]) => (
            <div className="ap-card ap-wo" key={n as string}>
              <div className="ap-wo-mid">{n}<span>{st}</span></div>
              <span className={`ap-pct t-${c}`} style={{ width: 'auto' }}>{amt}</span>
            </div>
          ))}
          <div className="ap-note">Big purchases planned and tracked, not scribbled on a legal pad.</div>
        </div>
      );
    }
    return (
      <div className="ap">
        <div className="x-headrow">
          <div className="x-serifhead big">Financials</div>
          <span className="x-spacer" />
          <span className="xb-light">‹</span>
          <span className="x-serifhead"><em>July 2026</em></span>
          <span className="xb-light">›</span>
        </div>
        <div className="ap-note" style={{ padding: 0, fontStyle: 'normal' }}>Your books, filled in for you.</div>
        <div className="ap-statgrid four">
          <div className="ap-cell"><b>$48.2k</b><span>REVENUE · FROM THE PMS</span></div>
          <div className="ap-cell"><b className="t-crit">$31.4k</b><span>EXPENSES</span></div>
          <div className="ap-cell"><b className="t-good">$16.8k</b><span>PROFIT</span></div>
          <div className="ap-cell"><b>35%</b><span>MARGIN</span></div>
        </div>
        <div className="x-btnrow">
          <span className="tv-mono">Month total</span><b className="x-monototal">$4,480.00</b>
          <span className="x-spacer" />
          <span className="xb-light">All departments ⌄</span>
          <span className="xb-light">📷 Scan invoice</span>
          <span className="xb-dark">+ Add expense</span>
        </div>
        {[['Jul 3', 'Linen supplier', '-$214', ''], ['Jul 2', 'Payroll run', '-$4,180', ''], ['Jul 1', 'OTA payout', '+$6,940', 'good'], ['Jun 30', 'Coffee vendor', '-$86', '']].map(([d, payee, amt, c]) => (
          <div className="ap-feedrow" key={payee as string}>
            <span>{d}</span>{payee}
            <b className={`ap-amt ${c ? 't-good' : ''}`}>{amt}</b>
          </div>
        ))}
      </div>
    );
  }
  if (id === 'housekeeping') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="x-caps">SCHEDULE · TODAY</div>
          <div className="x-headrow">
            <div className="x-serifhead"><em>Sunday</em> · Jul 5</div>
            <span className="xb-light">← Yesterday</span>
            <span className="xb-light">Today</span>
            <span className="xb-light">Tomorrow →</span>
          </div>
          <div className="ap-card x-pmsstrip">
            <div className="x-stat first"><span>LATEST PMS PULL ⚙</span><b className="sm">2m ago</b></div>
            <div className="x-stat"><span>IN HOUSE</span><b>42</b></div>
            <div className="x-stat"><span>ARRIVALS</span><b>8</b></div>
            <div className="x-stat"><span>DEPARTURES</span><b>6</b></div>
            <div className="x-stat"><span>CHECKOUTS</span><b>12</b></div>
            <div className="x-stat"><span>STAYOVERS</span><b>19</b></div>
            <div className="x-stat"><span>TOTAL TIME</span><b>310m</b></div>
            <div className="x-stat"><span>RECOMMENDED</span><b className="t-good">3 HK</b></div>
          </div>
          <div className="x-btnrow">
            <span className="xb-dark">▦ Board</span>
            <span className="xb-light">▤ Timeline</span>
            <span className="x-spacer" />
            <span className="xb-light">★ Priority</span>
            <span className="xb-light">Reset</span>
            <span className="xb-dark">↻ Auto-assign</span>
            <span className="xb-light">→ Send links</span>
          </div>
          {[['MG', 'Maria', 8, 12, ['204', '206', '210']], ['AR', 'Ana', 6, 10, ['102', '105', '107']], ['LT', 'Luis', 5, 9, ['301', '303']]].map(([ini, name, done, total, rooms]) => (
            <div className="ap-card ap-cleaner" key={name as string}>
              <span className="ap-avatar">{ini}</span>
              <div className="ap-cl-mid">
                <b>{name}</b>
                <div className="ap-bar"><i style={{ width: `${(Number(done) / Number(total)) * 100}%` }} /></div>
                <div className="ap-chips">
                  {(rooms as string[]).map((r) => (<span className="ap-chip" key={r}>{r}</span>))}
                </div>
              </div>
              <span className="ap-cl-count">{done}/{total} rooms</span>
            </div>
          ))}
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-statgrid">
            <div className="ap-cell hl"><b className="t-good">94%</b><span>PASS RATE TODAY</span></div>
            <div className="ap-cell"><b>8%</b><span>RE-CLEAN</span></div>
            <div className="ap-cell"><b>11m</b><span>AVG INSPECTION</span></div>
          </div>
          <div className="ap-h">INSPECTION QUEUE</div>
          {[['204', 'Maria · cleaned 20m ago', 'Pending', 'open'], ['118', 'Ana · cleaned 1h ago', 'Re-check', 'prog']].map(([r, who, st, c]) => (
            <div className="ap-card ap-wo" key={r as string}>
              <b>{r}</b>
              <div className="ap-wo-mid">{who}</div>
              <span className={`ap-pill p-${c}`}>{st}</span>
              <span className="ap-btn">Inspect →</span>
            </div>
          ))}
          <div className="ap-h">RECENT</div>
          <div className="ap-done"><span className="de-check">✓</span>211 · Jade · 8m · Pass</div>
          <div className="ap-done"><span className="de-check">✓</span>206 · Jade · 12m · Pass</div>
        </div>
      );
    }
    if (sub === 3) {
      return (
        <div className="ap">
          <div className="ap-statgrid four">
            <div className="ap-cell"><b className="t-crit">2</b><span>OVERDUE</span></div>
            <div className="ap-cell"><b className="t-low">3</b><span>DUE SOON</span></div>
            <div className="ap-cell"><b className="t-good">24</b><span>FRESH</span></div>
            <div className="ap-cell"><b>30d</b><span>CADENCE</span></div>
          </div>
          <div className="ap-h">OVERDUE</div>
          {[['204', '6d over par'], ['117', 'Never cleaned']].map(([r, st]) => (
            <div className="ap-card ap-wo" key={r as string}>
              <b>{r}</b>
              <div className="ap-wo-mid"><span className="t-crit">{st}</span></div>
              <span className="ap-btn">Schedule</span>
            </div>
          ))}
          <div className="ap-h">DUE SOON</div>
          <div className="ap-chips">
            <span className="ap-chip">305 · 2d</span><span className="ap-chip">312 · 4d</span><span className="ap-chip">108 · 5d</span>
          </div>
        </div>
      );
    }
    return (
      <div className="ap">
        <div className="x-headrow">
          <div className="x-serifhead big"><em className="t-crit">12</em> rooms to turn</div>
          <span className="x-spacer" />
          <div className="x-stat"><b className="t-good">16</b><span>CLEAN</span></div>
          <div className="x-stat"><b className="t-crit">12</b><span>DIRTY</span></div>
          <div className="x-stat"><b>62%</b><span>DONE</span></div>
        </div>
        <div className="ap-legendcaps">ROOM TYPE&nbsp;&nbsp;★ Arrival&nbsp;&nbsp;◐ Stayover&nbsp;&nbsp;↗ Checkout</div>
        <div className="ap-h">FLOOR 1</div>
        <div className="ap-roomcards">
          {[['101', 'CLEAN', 'ok', ''], ['102', 'DIRTY', 'dirty', '★'], ['103', 'CLEAN', 'ok', ''], ['104', 'CLEANING', 'prog', ''], ['105', 'DIRTY', 'dirty', '↗'], ['106', 'CLEAN', 'ok', '◐'], ['107', 'DIRTY', 'dirty', ''], ['108', 'CLEAN', 'ok', '']].map(([n, st, c, g]) => (
            <span className={`ap-roomcard rc-${c}`} key={n as string}>
              <b>{n}{g && <em> {g}</em>}</b><i>{st}</i>
            </span>
          ))}
        </div>
        <div className="ap-h">FLOOR 2</div>
        <div className="ap-roomcards">
          {[['201', 'CLEAN', 'ok', ''], ['204', 'DIRTY', 'dirty', '!'], ['206', 'CLEANING', 'prog', ''], ['208', 'CLEAN', 'ok', '★']].map(([n, st, c, g]) => (
            <span className={`ap-roomcard rc-${c}`} key={n as string}>
              <b>{n}{g === '!' ? <em className="rc-flag"> !</em> : g && <em> {g}</em>}</b><i>{st}</i>
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (id === 'maintenance') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="x-caps">PREVENTIVE · SCHEDULED</div>
          <div className="x-headrow">
            <div className="x-serifhead big"><em className="t-crit">2 overdue</em></div>
            <span className="x-spacer" />
            <span className="xb-light">Equipment assets</span>
            <span className="xb-dark">+ New task</span>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-warm" />OVERDUE · 1</div>
          <div className="ap-card ap-wo wo-warm">
            <div className="ap-wo-mid">Filter changes · floors 1–2<span>every 3 months</span></div>
            <b className="t-crit" style={{ width: 'auto' }}>2d over</b>
            <span className="ap-btn">Done today</span>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-car" />DUE THIS MONTH · 1</div>
          <div className="ap-card ap-wo wo-car">
            <div className="ap-wo-mid">Water heater check<span>next · Jul 18</span></div>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-sage" />UPCOMING · 2</div>
          <div className="ap-card ap-wo">
            <div className="ap-wo-mid">Gutter clearing<span>next · Aug 2</span></div>
          </div>
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="x-caps">EQUIPMENT · STOREROOM</div>
          <div className="x-headrow">
            <div className="x-serifhead big"><em className="t-crit">1 out of stock</em></div>
            <span className="x-spacer" />
            <span className="xb-dark">+ Add item</span>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-warm" />OUT · 1</div>
          <div className="ap-card ap-wo wo-warm">
            <div className="ap-wo-mid">Plunger kit<span>bin B2 · reorder at 2</span></div>
            <b style={{ width: 'auto' }}>0</b>
            <span className="ap-pill p-open">Out</span>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-car" />LOW · 1</div>
          <div className="ap-card ap-wo wo-car">
            <div className="ap-wo-mid">AC filters<span>storeroom · reorder at 6</span></div>
            <b style={{ width: 'auto' }}>4</b>
            <span className="ap-pill p-prog">Low</span>
          </div>
          <div className="ap-laneh"><i className="lane-dot ld-sage" />IN STOCK · 12</div>
          <div className="ap-card ap-wo">
            <div className="ap-wo-mid">Light bulbs<span>bin A1</span></div>
            <b style={{ width: 'auto' }}>32</b>
            <span className="ap-pill p-done">OK</span>
          </div>
        </div>
      );
    }
    /* exact mini of the real screen: 4 priority lanes side by side */
    return (
      <div className="ap wide">
        <div className="x-caps">WORK ORDERS · TODAY</div>
        <div className="x-headrow">
          <div className="x-serifhead big"><em>4 open</em> · <em className="dim-em">2 done</em></div>
          <span className="x-spacer" />
          <span className="xb-light">History (12) →</span>
          <span className="xb-dark">+ New work order</span>
        </div>
        <div className="ap-lanes">
          <div className="ap-lane">
            <div className="ap-laneh"><i className="lane-dot ld-sage" />LOW · 1</div>
            <div className="ap-card ap-wo">
              <div className="ap-wo-mid">Lobby · Door closer slow<span>Unassigned · 2d</span></div>
            </div>
          </div>
          <div className="ap-lane">
            <div className="ap-laneh"><i className="lane-dot ld-car" />NORMAL · 2</div>
            <div className="ap-card ap-wo wo-car">
              <div className="ap-wo-mid">204 · Shower drip<span>Unassigned · 4h</span></div>
            </div>
            <div className="ap-card ap-wo wo-car">
              <div className="ap-wo-mid">Hall 3 · Bulb out<span>Luis · 1d</span></div>
            </div>
          </div>
          <div className="ap-lane">
            <div className="ap-laneh"><i className="lane-dot ld-warm" />URGENT · 1</div>
            <div className="ap-card ap-wo wo-warm">
              <div className="ap-wo-mid">118 · AC not cooling<span>Luis · 2h</span></div>
            </div>
          </div>
          <div className="ap-lane">
            <div className="ap-laneh"><i className="lane-dot ld-pur" />PROFESSIONAL · 1</div>
            <div className="ap-card ap-wo wo-pur">
              <div className="ap-wo-mid">Boiler · Annual service<span>Contractor</span></div>
              <span className="ap-pill p-prog">Pro</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (id === 'inventory') {
    /* exact mini of the real screen: hero stats, DO/LOOK sidebar,
       filter tabs, 2-col item cards. Wider than the window; scroll any way. */
    return (
      <div className="ap wide">
        <div className="x-headrow x-invhero">
          <div className="x-stat"><span>STOCK HEALTH <i className="hero-dot good" /></span><b className="t-good">78%</b></div>
          <div className="x-stat"><span>ORDER NOW <i className="hero-dot crit" /></span><b>2</b></div>
          <div className="x-stat"><span>ON THE SHELF</span><b>$3,480</b></div>
          <span className="x-spacer" />
          <div className="x-stat"><span>JUL 5, 2026</span><b className="sm">Sunday</b></div>
        </div>
        <div className="ap-cols">
          <div className="ap-siderail">
            <div className="ap-h">DO</div>
            <span className="ap-railbtn block on">Start count<i className="rail-badge">16</i></span>
            <span className="ap-railbtn block teal">→ Scan invoice</span>
            <span className="ap-railbtn block">● Reorder list<i className="rail-badge">2</i></span>
            <span className="ap-railbtn block">Orders</span>
            <div className="ap-h">LOOK</div>
            <span className="ap-railbtn block">Reports</span>
            <span className="ap-railbtn block">History<i className="rail-badge">12</i></span>
            <span className="ap-railbtn block">AI Helper</span>
            <span className="ap-railbtn block">Budgets</span>
            <span className="ap-railbtn block">Ordering settings</span>
            <div className="ap-h">THIS MONTH</div>
            <div className="rail-stat"><b>$1,240</b><span>OF $2,000</span></div>
          </div>
          <div className="ap-main">
            <div className="x-btnrow">
              <span className="xb-dark">All <i className="xb-n">16</i></span>
              <span className="xb-light">General inventory <i className="xb-n">15</i></span>
              <span className="xb-light">Breakfast inventory <i className="xb-n">1</i></span>
              <span className="ap-search">Search…</span>
              <span className="xb-light">+ Add item</span>
            </div>
            <div className="ap-card ap-reorder">
              <span className="ti-dot warn" />
              <div className="ap-wo-mid">Running low<span>ORDER THESE SOON</span></div>
              <b className="x-groupnum">2</b>
              <span className="xb-dark">Count inventory</span>
            </div>
            <div className="inv-grid">
              {[['KS', 'King Sheets', 'HK · —', 48, 80, 'sets', 'good'], ['BT', 'Bath Towels', 'HK · —', 52, 200, 'units', 'crit'], ['QS', 'Queen Sheets', 'HK · —', 84, 120, 'sets', 'good'], ['P', 'Pillowcases', 'HK · —', 110, 200, 'units', 'good'], ['S', 'Shampoo', 'HK · —', 38, 150, 'bottles', 'low'], ['CP', 'Coffee Pods', 'FB · —', 162, 200, 'pods', 'good']].map(([ini, name, sub2, have, par, unit, cls]) => (
                <div className="ap-card inv-item" key={name as string}>
                  <div className="inv-top">
                    <span className="ap-avatar sq">{ini}</span>
                    <div className="ap-cl-mid"><b>{name}</b><span className="ap-role">{sub2}</span></div>
                    <span className="inv-refresh">↻</span>
                  </div>
                  <div className="ap-bar big"><i className={`f-${cls}`} style={{ width: `${(Number(have) / Number(par)) * 100}%` }} /></div>
                  <div className="inv-count">{have} / {par} {unit}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (id === 'staff') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="ap-rail">
            {['All', 'Housekeeping', 'Front desk', 'Maintenance'].map((r, i) => (
              <span className={`ap-railbtn seg ${i === 0 ? 'on' : ''}`} key={r}>{r}</span>
            ))}
          </div>
          {[['MG', 'Maria', 'Housekeeping', 'ES'], ['AR', 'Ana', 'Housekeeping', 'ES'], ['LT', 'Luis', 'Maintenance', 'EN'], ['JD', 'Jade', 'Front desk', 'EN']].map(([ini, name, role, lang]) => (
            <div className="ap-card ap-person" key={name as string}>
              <span className="ap-avatar">{ini}</span>
              <div className="ap-cl-mid"><b>{name}</b><span className="ap-role">{role}</span></div>
              <span className="ap-conf yes">Active</span>
              <span className="ap-lang">{lang}</span>
            </div>
          ))}
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-h">LEADERBOARD · 7 DAYS</div>
          {[['1', 'MG', 'Maria', '48 rooms', '↑ Fast', 'good'], ['2', 'AR', 'Ana', '41 rooms', '· On pace', ''], ['3', 'JD', 'Jade', '12 rooms', '· On pace', '']].map(([rank, ini, name, rooms, pace, c]) => (
            <div className="ap-card ap-person" key={name as string}>
              <b className="ap-rank">{rank}</b>
              <span className="ap-avatar">{ini}</span>
              <div className="ap-cl-mid"><b>{name}</b><span className="ap-role">{rooms}</span></div>
              <span className={`ap-conf ${c ? 'yes' : ''}`}>{pace}</span>
            </div>
          ))}
          <div className="ap-h">SHOUT-OUTS</div>
          <div className="ap-card ap-need"><span className="ti-dot ok" />Maria · 12 perfect inspections in a row ⭐</div>
        </div>
      );
    }
    return (
      <div className="ap wide">
        <div className="x-headrow">
          <div className="x-serifhead big"><em>Sunday,</em> Jul 5</div>
          <span className="x-caps" style={{ margin: 0 }}>TODAY</span>
          <span className="x-spacer" />
          <span className="xb-light">⎙ Print</span>
          <span className="xb-light">↩ Undo</span>
          <span className="xb-light">Fill</span>
          <span className="xb-light">‹</span>
          <span className="xb-light">›</span>
          <span className="xb-dark">Day</span>
          <span className="xb-light">Week</span>
        </div>
        <div className="ap-card x-floorstrip">
          <span className="x-caps" style={{ margin: 0 }}>ON THE FLOOR TODAY</span>
          <b className="x-groupnum">3</b>
          <span className="fl-leg"><i className="lane-dot ld-sage" />Housekeeping (2)</span>
          <span className="fl-leg"><i className="lane-dot ld-pur" />Front desk (1)</span>
          <span className="fl-leg"><i className="lane-dot ld-warm" />Maintenance (0)</span>
          <span className="x-spacer" />
          <span className="xb-light">+ Add staff</span>
        </div>
        <div className="x-timeaxis">
          {['6a', '9a', '12p', '3p', '6p', '9p'].map((t) => (<span key={t}>{t}</span>))}
        </div>
        <div className="ap-laneh"><i className="lane-dot ld-sage" />HOUSEKEEPING · 2</div>
        <div className="x-shiftlane"><span className="x-shift sage" style={{ left: '13%', width: '38%' }}>Maria · 8a–2p</span></div>
        <div className="x-shiftlane"><span className="x-shift sage" style={{ left: '13%', width: '38%' }}>Ana · 8a–2p</span></div>
        <div className="ap-laneh"><i className="lane-dot ld-pur" />FRONT DESK · 1</div>
        <div className="x-shiftlane"><span className="x-shift pur" style={{ left: '7%', width: '50%' }}>Jade · 7a–3p</span></div>
        <div className="ap-laneh"><i className="lane-dot ld-warm" />MAINTENANCE · 0</div>
        <div className="x-shiftlane empty">No one on MT yet — use + Add staff above.</div>
        <div className="ap-h">THIS WEEK · JUL 5–11</div>
        <div className="x-weekrow">
          {[['SUN · NOW', '5', true], ['MON', '6', false], ['TUE', '7', false], ['WED', '8', false], ['THU', '9', false]].map(([d, n, on]) => (
            <span className={`x-daycard ${on ? 'on' : ''}`} key={d as string}><i>{d}</i><b>{n}</b></span>
          ))}
        </div>
      </div>
    );
  }
  /* communications — exact mini of the real screen: sidebar + main pane.
     The sidebar stays; the pane swaps with the sub-tab, like the app. */
  return (
    <div className="ap wide">
      <div className="ap-cols">
        <div className="ap-siderail">
          <div className="comms-head">Communications<span>○ 3 on shift</span></div>
          <span className="ap-search">⌕ Jump to or search…</span>
          <div className="ap-catchup">✨ Catch up<span className="ap-badge">3</span></div>
          {['↩ Threads', '☰ To-do', '📖 Knowledge', '▤ Log book', '▦ Calendar', '✆ Contacts'].map((n) => (
            <span className="side-chan cnav" key={n}>{n}</span>
          ))}
          <div className="ap-h">ANNOUNCEMENTS +</div>
          <div className="side-chan">📣 Announcements<span className="ap-badge">1</span></div>
          <div className="ap-h">CHANNELS +</div>
          <div className="side-chan"># All Staff</div>
          <div className="side-chan"># Front Desk</div>
          <div className="side-chan"># Housekeeping<span className="ap-badge">3</span></div>
          <div className="side-chan"># Maintenance</div>
          <div className="ap-h">DIRECT MESSAGES +</div>
          <div className="side-chan"><span className="ap-online" />Maria</div>
          <div className="side-chan"><span className="ap-online off" />Luis</div>
        </div>
        <div className="ap-main">
          {sub === 1 ? (
            <>
              <div className="ap-h">LOG BOOK · WRITES ITSELF</div>
              {[['7:12 AM', 'Late checkout on 312 approved'], ['7:04 AM', 'Towel reorder drafted'], ['6:41 AM', 'AC ticket assigned to Luis'], ['6:03 AM', 'Board built, 31 rooms']].map(([t, txt]) => (
                <div className="ap-feedrow" key={txt as string}><span>{t}</span>{txt}</div>
              ))}
            </>
          ) : sub === 2 ? (
            <>
              <div className="ap-h">CALENDAR</div>
              {[['Wed', 'Deep clean · 204'], ['Thu', 'Linen delivery expected'], ['Fri', 'Fire panel inspection'], ['Sat', 'Sold out night · 100%']].map(([d, ev]) => (
                <div className="ap-feedrow" key={ev as string}><span>{d}</span>{ev}</div>
              ))}
            </>
          ) : (
            <>
              <div className="ap-panehead"># Housekeeping<span>4 members</span></div>
              <div className="ap-msgrow">
                <span className="ap-avatar">MG</span>
                <div className="mr-mid"><b>Maria <i>7:02 AM</i></b>Room 204 lista ✓</div>
              </div>
              <div className="ap-msgrow">
                <span className="ap-avatar">JD</span>
                <div className="mr-mid"><b>Jade <i>7:04 AM</i></b>Gracias! 118 next please 🙏</div>
              </div>
              <div className="ap-msgrow">
                <span className="ap-avatar">MG</span>
                <div className="mr-mid"><b>Maria <i>7:05 AM</i></b>Ok voy 👍</div>
              </div>
              <div className="ap-msginput">Message #housekeeping…</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function MarketingLanding() {
  const [feed, setFeed] = useState<Array<FeedItem & { id: number }>>(
    () => FEED_SCRIPT.slice(0, 4).map((f, i) => ({ ...f, id: i })).reverse()
  );
  const feedIdx = useRef(4);
  const [chipTab, setChipTab] = useState<Record<string, number>>({});
  const [notifStage, setNotifStage] = useState<'idle' | 'pressed' | 'done'>('idle');
  const notifStarted = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  /* ticking ops feed */
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = setInterval(() => {
      const idx = feedIdx.current;
      feedIdx.current += 1;
      const next = { ...FEED_SCRIPT[idx % FEED_SCRIPT.length], id: idx };
      setFeed((prev) => [next, ...prev].slice(0, 5));
    }, 2600);
    return () => clearInterval(id);
  }, []);

  /* notification approve loop: idle → pressed → done → idle */
  useEffect(() => {
    const el = notifRef.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setNotifStage('done');
      return;
    }
    let timers: ReturnType<typeof setTimeout>[] = [];
    const play = () => {
      timers.push(setTimeout(() => setNotifStage('pressed'), 1600));
      timers.push(setTimeout(() => setNotifStage('done'), 2100));
      timers.push(setTimeout(() => setNotifStage('idle'), 6400));
      timers.push(setTimeout(loop, 6900));
    };
    const loop = () => play();
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !notifStarted.current) {
          notifStarted.current = true;
          play();
        }
      },
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  /* scroll reveals */
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll('.rv') ?? [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.18 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /* scroll: top progress bar, nav state */
  useEffect(() => {
    const nav = rootRef.current?.querySelector('.nav');
    const onScroll = () => {
      const bar = progressRef.current;
      if (bar) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
      }
      if (nav) {
        if (window.scrollY > 24) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="mkt" ref={rootRef}>
      <style>{CSS}</style>

      <div className="progress" aria-hidden="true"><div className="progress-fill" ref={progressRef} /></div>

      {/* atmosphere */}
      <div className="sky" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
        <div className="dots" />
        {SPARKLES.map((s, i) => (
          <span key={i} className="spark" style={{ left: s.left, animationDelay: s.delay, animationDuration: s.dur }}>✦</span>
        ))}
      </div>
      <div className="grain" aria-hidden="true" />

      {/* ---------------- nav ---------------- */}
      <nav className="nav">
        <Link className="brand" href="/">
          <span className="brand-mark"><ChevronMark size={26} /></span>
          <span className="brand-name">Staxis</span>
        </Link>
        <div className="nav-links">
          <a href="#story">Why Staxis</a>
          <a href="#onepage">One page</a>
          <a href="#benefits">How it works</a>
          <a href="/signin" className="btn btn-ghost">Sign in</a>
          <a href="#contact" className="btn btn-solid">Request a demo</a>
        </div>
      </nav>

      {/* ---------------- hero ---------------- */}
      <header className="hero">
        <div className="hero-copy">
          <div className="pill rise" style={{ animationDelay: '.05s' }}>
            <span className="pulse-dot" />
            Live at a working hotel today
          </div>
          <h1>
            <span className="line"><span className="w" style={{ animationDelay: '.10s' }}>AI&nbsp;for</span></span>
            <span className="line"><span className="w" style={{ animationDelay: '.22s' }}><em className="shimmer">hotels.</em></span></span>
          </h1>
          <p className="lede rise" style={{ animationDelay: '.42s' }}>
            Staxis runs your hotel&rsquo;s operations today. It watches your
            property systems around the clock, handles the busywork, and comes to
            you when something needs a person. And operations is just the start.
          </p>
          <div className="cta-row rise" style={{ animationDelay: '.55s' }}>
            <a className="btn btn-solid btn-lg" href="#contact">Request a demo</a>
            <a className="btn btn-ghost btn-lg" href="#story">See why<span className="arrow">→</span></a>
          </div>
          <div className="hero-meta rise" style={{ animationDelay: '.68s' }}>
            Built for limited &amp; select-service hotels · English + Español
          </div>
        </div>

        {/* live ops console */}
        <div className="console rise" style={{ animationDelay: '.35s' }} aria-hidden="true">
          <div className="console-ring" />
          <div className="console-head">
            <span className="dot r" /><span className="dot y" /><span className="dot g" />
            <span className="console-title">STAXIS · OPS CONSOLE</span>
            <span className="console-live"><span className="pulse-dot" />WATCHING</span>
          </div>
          <div className="console-body">
            <div className="room-board">
              {Array.from({ length: ROOM_COUNT }).map((_, i) => (
                <span key={i} className="room" style={{ animationDelay: `${(i * 1.7) % 9}s` }} />
              ))}
            </div>
            <div className="feed">
              {feed.map((f, i) => (
                <div key={f.id} className={`feed-item tone-${f.tone} ${i === 0 ? 'fresh' : ''}`}>
                  <span className="feed-time">{f.time}</span>
                  <span className="feed-icon">{f.icon}</span>
                  <span className="feed-text">{f.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="console-foot">
            <span>ALL FEEDS HEALTHY</span>
            <span className="foot-sep">·</span>
            <span>ALWAYS WATCHING</span>
            <span className="foot-sep">·</span>
            <span>EN / ES</span>
          </div>
        </div>
      </header>

      {/* ---------------- marquee ---------------- */}
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((k) => (
            <div className="marquee-set" key={k}>
              <span>Housekeeping boards</span><i>✦</i>
              <span>Work orders</span><i>✦</i>
              <span>Inventory that reorders itself</span><i>✦</i>
              <span>Daily staff texts</span><i>✦</i>
              <span>Room status, live</span><i>✦</i>
              <span>Labor cost tracking</span><i>✦</i>
              <span>Voice copilot</span><i>✦</i>
              <span>Bilingual by default</span><i>✦</i>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- the difference: side by side ---------------- */}
      <section className="section" id="story">
        <div className="kicker rv">THE DIFFERENCE</div>
        <h2 className="rv">Two ways to run a hotel.</h2>

        <div className="vs rv">
          <div className="vs-col nightmare">
            <div className="vs-tag bad-tag">TODAY</div>
            <h3 className="vs-title">You go <em>find</em> the work.</h3>
            <p className="vs-sub">Take one thing. Towels.</p>
            <div className="oldway">
              {OLD_STEPS.map((s, i) => (
                <span key={s.text} className="chore-wrap">
                  <span className="chore rv" style={{ transitionDelay: `${i * 130}ms`, ['--tilt' as string]: `${((i % 3) - 1) * 2.4}deg` }}>
                    <b>{i + 1}</b>
                    <span className="chore-ic">{s.icon}</span>
                    {s.text}
                  </span>
                  {i < OLD_STEPS.length - 1 && (
                    <span className="chore-arrow rv" style={{ transitionDelay: `${i * 130 + 70}ms` }}>→</span>
                  )}
                </span>
              ))}
            </div>
            <p className="vs-caption">
              Nine steps to stay stocked on <em>towels</em>. Now every supply,
              every room, every shift, every work order. That&rsquo;s the job.
            </p>
            <div className="vs-outcomes">
              {[
                '▲ Higher labor costs',
                'Hours lost walking and checking',
                'Budget surprises at month end',
                'Nights and weekends unwatched',
              ].map((o, i) => (
                <span className="oc bad rv" key={o} style={{ transitionDelay: `${i * 110}ms` }}>{o}</span>
              ))}
            </div>
          </div>

          <div className="vs-mid" aria-hidden="true">
            <i className="vs-line" />
            <span className="vs-badge"><em>VS</em></span>
            <i className="vs-line" />
          </div>

          <div className="vs-col dreamside">
            <div className="vs-tag good-tag">WITH STAXIS</div>
            <h3 className="vs-title sage-title">The work comes <em>to you.</em></h3>
            <p className="vs-sub">Same towels.</p>
            <div className="notif-stage" ref={notifRef}>
              <div className="notif-halo" aria-hidden="true" />
              <div className={`notif ${notifStage}`}>
                <div className="notif-head">
                  <span className="notif-logo"><ChevronMark size={16} color="#fff" /></span>
                  <span className="notif-app">Staxis</span>
                  <span className="notif-time">6:07 AM</span>
                </div>
                <p className="notif-body">
                  Towels are running low. I counted, checked the budget, and
                  drafted the reorder.
                </p>
                <div className="notif-actions">
                  <button type="button" className="notif-btn" tabIndex={-1}>
                    {notifStage === 'done' ? '✓ Ordered' : 'Approve reorder'}
                  </button>
                  {notifStage === 'done' && (
                    <span className="notif-burst" aria-hidden="true">
                      <i>✦</i><i>✦</i><i>✦</i><i>✦</i><i>✦</i>
                    </span>
                  )}
                </div>
              </div>
            </div>
            <p className="vs-caption">
              One tap. Staxis did the walking, the counting, and the math. It
              only brings you the decision.
            </p>
            <div className="dream-extra">
              <div className="de-h">ALSO HANDLED, WHILE YOU SLEPT</div>
              {[
                'Tomorrow’s cleaning board built',
                'AC ticket sent to maintenance',
                'Breakfast coffee reorder drafted',
                'Every room status up to date',
              ].map((d, i) => (
                <div className="de-item rv" key={d} style={{ transitionDelay: `${300 + i * 140}ms` }}>
                  <span className="de-check">✓</span>{d}
                </div>
              ))}
            </div>
            <div className="vs-outcomes">
              {[
                '▼ Lower labor costs',
                'Hours back, every single week',
                'Budget checked before every order',
                'Watched around the clock',
              ].map((o, i) => (
                <span className="oc good rv" key={o} style={{ transitionDelay: `${i * 110}ms` }}>{o}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- one page ---------------- */}
      {/* z-index above sibling sections so hover demos from bottom chips
          paint over the next section instead of dying under it */}
      <section className="section sec-top" id="onepage">
        <div className="kicker rv">ONE PAGE</div>
        <h2 className="rv">One page <em>runs the hotel.</em></h2>
        <p className="section-lede rv">
          Everything that needs you lands in one place. Every other page is still
          one tap away when you want to look deeper.
        </p>

        <div className="orbit rv" aria-hidden="true">
          <svg className="orbit-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
            {ORBIT_PAGES.map((p) => (
              <line key={p.label} className={'soon' in p ? 'l-soon' : ''} x1="50" y1="50" x2={p.x} y2={p.y} />
            ))}
          </svg>
          {ORBIT_PAGES.map((p, i) => (
            <span
              key={p.label}
              className={`orbit-chip ${'soon' in p ? 'chip-soon' : ''}`}
              style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${i * 0.7}s` }}
            >
              {p.label}
              <span className={`chip-pop pop-${p.dir} ${'soon' in p ? 'pop-soon' : ''}`}>
                <span className="cp-head">
                  <span className="cp-brand"><ChevronMark size={13} color="#fff" /></span>
                  <b>{'soon' in p ? 'Guest Experience' : p.label}</b>
                  <i>{'soon' in p ? 'COMING SOON' : 'LIVE DEMO · SCROLLS'}</i>
                </span>
                {p.tabs.length > 1 && (
                  <span className="cp-tabs">
                    {p.tabs.map((t, ti) => (
                      <button
                        type="button"
                        key={t}
                        tabIndex={-1}
                        className={`cp-tab ${(chipTab[p.id] ?? 0) === ti ? 'on' : ''}`}
                        onClick={() => setChipTab((prev) => ({ ...prev, [p.id]: ti }))}
                      >
                        {t}
                      </button>
                    ))}
                  </span>
                )}
                <span className="cp-body" key={chipTab[p.id] ?? 0}>
                  <ChipDemo id={p.id} sub={chipTab[p.id] ?? 0} />
                </span>
              </span>
            </span>
          ))}
          {/* the center IS the app's Staxis page, exact mini, always live */}
          <div className="today stx-center">
            <span className="cp-head">
              <span className="cp-brand"><ChevronMark size={13} color="#fff" /></span>
              <b>Staxis</b>
              <i>YOUR ONE PAGE · SCROLLS</i>
            </span>
            <div className="cp-body stx-body">
              <div className="ap">
                <div className="x-headrow">
                  <span className="x-caps" style={{ margin: 0 }}>GOOD EVENING · SUNDAY, JULY 5</span>
                  <span className="x-spacer" />
                  <span className="fl-leg"><i className="lane-dot ld-sage" />78% occupancy · all shifts staffed</span>
                </div>
                <div className="ap-card stx-wrap">
                  <span className="stx-moon">☾</span>
                  <div className="ap-wo-mid">
                    <span className="x-caps" style={{ margin: 0 }}>EVENING WRAP-UP</span>
                    <b className="stx-wrap-title">Wrapping up: 6 items to clear before you go.</b>
                    <span>Tomorrow&rsquo;s crew is set · night shift briefed</span>
                  </div>
                </div>
                <div className="ap-card stx-labor">
                  <div className="ap-wo-mid">
                    <span className="x-caps" style={{ margin: 0 }}>LABOR TODAY</span>
                    <b className="stx-labor-n">$1,840 <i>/ $1,910</i></b>
                    <div className="ap-bar big"><i className="f-good" style={{ width: '96%' }} /></div>
                  </div>
                  <div className="stx-under"><b>$70</b><span>under budget</span></div>
                </div>
                <div className="x-headrow">
                  <span className="x-caps" style={{ margin: 0 }}>NEEDS YOU</span>
                  <b className="x-attn-badge dark">6</b>
                </div>
                {[
                  ['GUESTS', 'Room 207 messaged about noise, twice', 'Guest is still up. An apology + 10% off tonight is drafted and ready to send.', 'Send reply', 'rust', 'Edit', 'protects your review score', true],
                  ['STAFF', 'Maria hasn’t confirmed tomorrow', 'No reply since last night. Lupe is available as backup. Text her to be safe?', 'Text Lupe', 'dark', 'Call Maria', '↓ avoids a morning scramble', false],
                  ['HOUSEKEEPING', 'Tomorrow’s crew is ready', '86 rooms · 4 housekeepers. Board balanced by floor and checkout load.', 'Approve & send', 'dark', 'Adjust', '↓ saves ~$210 vs a flat 5-person crew', false],
                  ['INVENTORY', 'Towels run out Thursday', 'At today’s pace you’ll be short by Thursday. Order drafted: 6 cases · $310 · ABC Supply.', 'Approve order', 'dark', 'Change', '$310', false],
                ].map(([cat, title, body, act, tone, alt, note, hot]) => (
                  <div className={`ap-card stx-need ${hot ? 'hot' : ''}`} key={title as string}>
                    <span className="x-caps" style={{ margin: 0 }}>{cat}</span>
                    <b className="stx-need-title">{title}</b>
                    <span className="stx-need-body">{body}</span>
                    <div className="x-btnrow">
                      <span className={tone === 'rust' ? 'xb-rust' : 'xb-dark'}>{act}</span>
                      <span className="xb-light">{alt}</span>
                      <span className="x-spacer" />
                      <span className="stx-note">{note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- how AI runs your hotel ---------------- */}
      <section className="section" id="benefits">
        <div className="kicker rv">HOW AI RUNS YOUR HOTEL</div>
        <h2 className="rv">Three levels of AI. <em>You stay in control.</em></h2>

        <div className="tiers">
          {/* AUTONOMOUS */}
          <div className="tier tier-auto rv">
            <div className="tier-gauge"><i className="on" /><i className="on" /><i className="on" /></div>
            <h3>Autonomous</h3>
            <div className="tier-tag">It just does it.</div>
            <div className="tier-visual">
              <span className="pulse-dot" />
              <span className="tv-mono">WATCHING · 24/7</span>
              <span className="tv-line">✓ board built · 31 rooms</span>
            </div>
            {[
              'Watches your property system day and night',
              'Housekeeping boards built every morning',
              'Live room status, all day',
              'A log book that writes itself',
              'Labor costs tracked daily',
              'Staff texted in their language',
            ].map((t, i) => (
              <div className="tier-item rv" key={t} style={{ transitionDelay: `${i * 60}ms` }}>
                <span className="de-check">✓</span>{t}
              </div>
            ))}
            <div className="tier-item soon rv"><span className="rm-soon-dot">✦</span>AI voice agent answering every call, 24/7<span className="soon-pill">SOON</span></div>
            <div className="tier-item soon rv"><span className="rm-soon-dot">✦</span>Instant replies to guest texts<span className="soon-pill">SOON</span></div>
          </div>

          {/* SEMI-AUTONOMOUS */}
          <div className="tier tier-semi rv" style={{ transitionDelay: '120ms' }}>
            <div className="tier-gauge"><i className="on" /><i className="on" /><i /></div>
            <h3>Semi-autonomous</h3>
            <div className="tier-tag">It does the work, you tap approve.</div>
            <div className="tier-visual">
              <span className="ti-dot warn" />
              <span className="tv-line">Towels low · reorder drafted</span>
              <span className="tv-approve">Approve</span>
            </div>
            {[
              'Reorders drafted before you run out',
              'Budgets checked on every order',
              'Tomorrow’s crew confirmed by text',
              'Work orders that need a decision come to you',
              'Guest complaints followed to the end',
            ].map((t, i) => (
              <div className="tier-item rv" key={t} style={{ transitionDelay: `${i * 60}ms` }}>
                <span className="tier-ok semi">●</span>{t}
              </div>
            ))}
            <div className="tier-item soon rv"><span className="rm-soon-dot">✦</span>Reservation changes, with your rules<span className="soon-pill">SOON</span></div>
            <div className="tier-note">Anything touching money or people gets your yes first.</div>
          </div>

          {/* ASSISTED */}
          <div className="tier tier-assist rv" style={{ transitionDelay: '240ms' }}>
            <div className="tier-gauge"><i className="on" /><i /><i /></div>
            <h3>Assisted</h3>
            <div className="tier-tag">You ask, it helps.</div>
            <div className="tier-visual chat">
              <span className="tv-q">“Who’s cleaning 204?”</span>
              <span className="tv-a">Maria. Done in ~20 minutes.</span>
            </div>
            {[
              'A voice copilot you can talk to',
              'Scan an invoice, it logs itself',
              'Reports and financials in one tap',
              'Ask what happened overnight',
              'Every page, one tap deeper',
            ].map((t, i) => (
              <div className="tier-item rv" key={t} style={{ transitionDelay: `${i * 60}ms` }}>
                <span className="tier-ok assist">◆</span>{t}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="cta-panel rv" id="contact">
        <div className="cta-inner">
          <div className="kicker">SEE IT ON YOUR HOTEL</div>
          <h2>Watch Staxis run <em>your</em> property.</h2>
          <p>
            A walkthrough with the founder, on your own hotel&rsquo;s data.
            No contract, no setup fee to look.
          </p>
          <div className="cta-row">
            <a className="btn btn-solid btn-lg" href="mailto:rp@reeyenpatel.com?subject=Staxis%20demo%20request">
              Request a demo
            </a>
            <a className="btn btn-ghost btn-lg" href="/signin">Sign in</a>
          </div>
          <div className="cta-mail">or email <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>. We reply within two business days.</div>
        </div>
      </section>

      {/* ---------------- footer ---------------- */}
      <footer className="footer">
        <div className="foot-grid">
          <div className="foot-brand">
            <div className="brand">
              <span className="brand-mark"><ChevronMark size={26} /></span>
              <span className="brand-name">Staxis</span>
            </div>
            <p>
              AI operations platform for limited and select-service hotels. Operated
              by Reeyen Patel (sole proprietor) · 2215 Rio Grande St, Austin, TX
              78705, United States · <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>
            </p>
          </div>
          <div className="foot-col">
            <div className="foot-h">Product</div>
            <a href="#story">Why Staxis</a>
            <a href="#onepage">One page</a>
            <a href="#benefits">How it works</a>
            <a href="/signin">Sign in</a>
          </div>
          <div className="foot-col">
            <div className="foot-h">Legal &amp; SMS</div>
            <a href="/consent">SMS Consent</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
          </div>
        </div>
        <div className="foot-legal">© 2026 Staxis · Austin, Texas</div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* styles — Snow design system, light                                  */
/* ------------------------------------------------------------------ */

const CSS = `
.mkt {
  --bg: #FFFFFF;
  --bg-warm: #FBFAF7;
  --ink: #1F231C;
  --ink-soft: #3A3F38;
  --muted: #5C625C;
  --dim: #A6ABA6;
  --rule: rgba(31, 35, 28, 0.08);
  --rule-soft: rgba(31, 35, 28, 0.045);
  --sage: #9EB7A6;
  --sage-deep: #5C7A60;
  --sage-dim: rgba(92, 122, 96, 0.10);
  --caramel: #C99644;
  --caramel-deep: #8C6A33;
  --caramel-dim: rgba(201, 150, 68, 0.12);
  --warm: #B85C3D;
  --purple: #7B6A97;
  --mark: #1A1F1B;
  --serif: var(--font-instrument-serif), Georgia, serif;
  --sans: var(--font-geist), -apple-system, sans-serif;
  --mono: var(--font-geist-mono), ui-monospace, monospace;

  position: relative;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  line-height: 1.6;
  overflow-x: clip;
  min-height: 100vh;
}
.mkt *, .mkt *::before, .mkt *::after { box-sizing: border-box; }
.mkt a { color: inherit; text-decoration: none; }
.mkt h1, .mkt h2, .mkt h3, .mkt p { margin: 0; }

/* ---------- scroll progress ---------- */
.progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; }
.progress-fill { height: 100%; transform-origin: left; transform: scaleX(0);
  background: linear-gradient(90deg, var(--sage-deep), var(--caramel));
  transition: transform .1s linear; }

/* ---------- atmosphere ---------- */
.sky { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
.orb { position: absolute; border-radius: 50%; filter: blur(90px); }
.orb-a { width: 58vw; height: 58vw; top: -26vw; right: -16vw; opacity: .55;
  background: radial-gradient(circle, rgba(201,150,68,.14), transparent 65%);
  animation: drift 26s ease-in-out infinite alternate; }
.orb-b { width: 52vw; height: 52vw; top: 34vh; left: -24vw; opacity: .6;
  background: radial-gradient(circle, rgba(158,183,166,.20), transparent 65%);
  animation: drift 32s ease-in-out infinite alternate-reverse; }
.orb-c { width: 40vw; height: 40vw; bottom: -20vw; right: 8vw; opacity: .45;
  background: radial-gradient(circle, rgba(123,106,151,.10), transparent 65%);
  animation: drift 38s ease-in-out infinite alternate; }
@keyframes drift {
  from { transform: translate3d(0,0,0) scale(1); }
  to   { transform: translate3d(4vw,3vh,0) scale(1.12); }
}
.dots { position: absolute; inset: 0; opacity: .5;
  background-image: radial-gradient(rgba(31,35,28,.10) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: radial-gradient(ellipse 85% 55% at 50% 0%, black 25%, transparent 72%); }
.spark { position: absolute; bottom: -4vh; font-size: 11px; color: var(--caramel);
  opacity: 0; animation: floatup linear infinite; }
@keyframes floatup {
  0%   { transform: translateY(0) rotate(0deg) scale(.7); opacity: 0; }
  12%  { opacity: .5; }
  85%  { opacity: .25; }
  100% { transform: translateY(-108vh) rotate(200deg) scale(1.1); opacity: 0; }
}
.grain { position: fixed; inset: 0; z-index: 50; pointer-events: none; opacity: .035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E"); }

/* ---------- nav ---------- */
.nav { position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px clamp(20px, 4vw, 48px);
  transition: background .35s ease, border-color .35s ease, padding .35s ease, box-shadow .35s ease;
  border-bottom: 1px solid transparent; }
.nav.scrolled { background: rgba(255,255,255,.8); backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px); border-bottom-color: var(--rule);
  padding-top: 12px; padding-bottom: 12px; box-shadow: 0 4px 24px rgba(31,35,28,.05); }
.brand { display: inline-flex; align-items: center; gap: 7px; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center;
  animation: markfloat 5s ease-in-out infinite; }
@keyframes markfloat { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-3px) rotate(-4deg); } }
.brand-name { font-weight: 600; letter-spacing: -.02em; font-size: 18px; }
.nav-links { display: flex; align-items: center; gap: clamp(10px, 2vw, 26px); font-size: 14px; }
.nav-links > a:not(.btn) { color: var(--muted); position: relative; transition: color .2s; }
.nav-links > a:not(.btn)::after { content: ''; position: absolute; left: 0; bottom: -4px;
  width: 100%; height: 1.5px; background: var(--caramel); transform: scaleX(0);
  transform-origin: right; transition: transform .3s cubic-bezier(.19,1,.22,1); }
.nav-links > a:not(.btn):hover { color: var(--ink); }
.nav-links > a:not(.btn):hover::after { transform: scaleX(1); transform-origin: left; }
@media (max-width: 760px) { .nav-links > a:not(.btn) { display: none; } }
@media (max-width: 480px) {
  .nav .brand-name { display: none; }
  .nav .btn { padding: 8px 14px; font-size: 13px; }
}

/* ---------- buttons ---------- */
.btn { position: relative; display: inline-flex; align-items: center; gap: 8px;
  border-radius: 999px; font-weight: 600; font-size: 14px; padding: 9px 20px;
  white-space: nowrap; overflow: hidden;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease, color .18s ease; }
.btn-lg { padding: 14px 30px; font-size: 15px; }
.mkt a.btn-solid { background: var(--mark); color: #fff; box-shadow: 0 4px 18px rgba(31,35,28,.22); }
.btn-solid::before { content: ''; position: absolute; inset: 0;
  background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.22) 50%, transparent 70%);
  background-size: 250% 100%; background-position: 120% 0; transition: background-position .6s ease; }
.btn-solid:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(31,35,28,.3), 0 0 0 4px var(--caramel-dim); }
.btn-solid:hover::before { background-position: -60% 0; }
.mkt a.btn-ghost { border: 1px solid var(--rule); color: var(--ink); background: rgba(255,255,255,.5); }
.btn-ghost:hover { border-color: var(--sage-deep); background: var(--sage-dim); transform: translateY(-2px); }
.btn .arrow { transition: transform .18s ease; }
.btn:hover .arrow { transform: translateX(4px); }

/* ---------- hero ---------- */
.hero { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(130px, 18vh, 190px) clamp(20px, 4vw, 48px) 60px;
  display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr);
  gap: clamp(32px, 5vw, 72px); align-items: center; }
@media (max-width: 980px) { .hero { grid-template-columns: 1fr; padding-top: 120px; } }

.pill { display: inline-flex; align-items: center; gap: 9px; font-family: var(--mono);
  font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--sage-deep);
  border: 1px solid rgba(92,122,96,.3); border-radius: 999px; padding: 7px 16px;
  background: var(--sage-dim); margin-bottom: 28px; }
.pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sage-deep);
  box-shadow: 0 0 0 0 rgba(92,122,96,.5); animation: pulse 2.2s infinite; flex: none; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(92,122,96,.5); }
  70% { box-shadow: 0 0 0 9px rgba(92,122,96,0); }
  100% { box-shadow: 0 0 0 0 rgba(92,122,96,0); }
}

.hero h1 { font-family: var(--serif); font-weight: 400;
  font-size: clamp(50px, 7vw, 96px); line-height: 1.02; letter-spacing: -.01em; }
.hero h1 .line { display: block; overflow: hidden; padding-bottom: .08em; margin-bottom: -.08em; }
.hero h1 .w { display: inline-block; transform: translateY(110%);
  animation: wordrise .9s cubic-bezier(.19,1,.22,1) forwards; }
@keyframes wordrise { to { transform: translateY(0); } }
.hero h1 em, .mkt h2 em, .statement em { font-style: italic; }
.shimmer { background: linear-gradient(100deg, var(--caramel-deep) 20%, var(--caramel) 40%, var(--sage-deep) 65%, var(--caramel-deep) 85%);
  background-size: 220% 100%; -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: shimmer 6s ease-in-out infinite; }
@keyframes shimmer { 0%,100% { background-position: 0% 0; } 50% { background-position: 100% 0; } }

.lede { margin-top: 26px; max-width: 52ch; font-size: clamp(15.5px, 1.35vw, 17.5px);
  color: var(--muted); }
.cta-row { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 34px; }
.hero-meta { margin-top: 26px; font-family: var(--mono); font-size: 11.5px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }

.rise { opacity: 0; transform: translateY(22px);
  animation: rise .8s cubic-bezier(.19,1,.22,1) forwards; }
@keyframes rise { to { opacity: 1; transform: translateY(0); } }

/* ---------- console ---------- */
.console { position: relative; border: 1px solid var(--rule); border-radius: 18px;
  background: #fff;
  box-shadow: 0 24px 70px rgba(31,35,28,.12), 0 4px 18px rgba(31,35,28,.06);
  transform: perspective(1400px) rotateY(-4deg) rotateX(1.5deg);
  transition: transform .6s cubic-bezier(.19,1,.22,1); }
.console:hover { transform: perspective(1400px) rotateY(0deg) rotateX(0deg); }
@media (max-width: 980px) { .console { transform: none; } }
.console-ring { position: absolute; inset: -14px; border-radius: 28px; z-index: -1;
  background: conic-gradient(from 0deg, rgba(201,150,68,.0), rgba(201,150,68,.25),
    rgba(158,183,166,.25), rgba(201,150,68,.0));
  filter: blur(18px); animation: spin 14s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.console-head { display: flex; align-items: center; gap: 7px; padding: 13px 16px;
  border-bottom: 1px solid var(--rule-soft); background: var(--bg-warm);
  border-radius: 18px 18px 0 0; }
.console-head .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dot.r { background: #ff5f57; } .dot.y { background: #febc2e; } .dot.g { background: #28c840; }
.console-title { margin-left: 10px; font-family: var(--mono); font-size: 10.5px;
  letter-spacing: .16em; color: var(--dim); }
.console-live { margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; color: var(--sage-deep); }
.console-body { padding: 16px; display: grid; gap: 14px; }
.room-board { display: grid; grid-template-columns: repeat(14, 1fr); gap: 6px; }
@media (max-width: 480px) { .room-board { grid-template-columns: repeat(10, 1fr); } }
.room { aspect-ratio: 1; border-radius: 4px; background: var(--rule-soft);
  animation: roomcycle 9s steps(1) infinite; }
@keyframes roomcycle {
  0%   { background: rgba(92,122,96,.45); }
  33%  { background: rgba(201,150,68,.5); }
  55%  { background: rgba(31,35,28,.07); }
  78%  { background: rgba(123,106,151,.4); }
  100% { background: rgba(92,122,96,.45); }
}
.feed { display: flex; flex-direction: column; gap: 7px; min-height: 172px; }
.feed-item { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px;
  padding: 8px 11px; border-radius: 9px; border: 1px solid var(--rule-soft);
  background: var(--bg-warm); color: var(--muted); }
.feed-item.fresh { animation: feedin .5s cubic-bezier(.19,1,.22,1); }
@keyframes feedin { from { opacity: 0; transform: translateY(-9px); } to { opacity: 1; transform: none; } }
.feed-time { font-family: var(--mono); font-size: 10px; color: var(--dim); flex: none; width: 52px; }
.feed-icon { flex: none; }
.tone-ok .feed-icon { color: var(--sage-deep); }
.tone-warn .feed-icon { color: var(--warm); }
.tone-info .feed-icon { color: var(--purple); }
.feed-text { color: var(--ink-soft); }
.console-foot { display: flex; gap: 10px; padding: 11px 16px; border-top: 1px solid var(--rule-soft);
  font-family: var(--mono); font-size: 10px; letter-spacing: .14em; color: var(--dim); }
.foot-sep { color: var(--rule); }

/* ---------- marquee ---------- */
.marquee { position: relative; z-index: 1; overflow: hidden; padding: 22px 0;
  border-top: 1px solid var(--rule-soft); border-bottom: 1px solid var(--rule-soft);
  background: var(--bg-warm);
  mask-image: linear-gradient(90deg, transparent, black 12%, black 88%, transparent); }
.marquee-track { display: flex; width: max-content; animation: scroll 34s linear infinite; }
.marquee:hover .marquee-track { animation-play-state: paused; }
@keyframes scroll { to { transform: translateX(-50%); } }
.marquee-set { display: flex; align-items: center; gap: 34px; padding-right: 34px; }
.marquee-set span { font-family: var(--mono); font-size: 12px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.marquee-set i { color: var(--caramel); font-style: normal; font-size: 10px;
  animation: sparkspin 4s linear infinite; display: inline-block; }
@keyframes sparkspin { to { transform: rotate(360deg); } }

/* ---------- sections ---------- */
.section { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(90px, 12vh, 150px) clamp(20px, 4vw, 48px) 0; }
.section.sec-top { z-index: 5; }
.kicker { font-family: var(--mono); font-size: 11.5px; letter-spacing: .22em;
  color: var(--caramel-deep); margin-bottom: 20px; }
.mkt h2 { font-family: var(--serif); font-weight: 400;
  font-size: clamp(34px, 4.5vw, 60px); line-height: 1.1; letter-spacing: -.005em; }
.section-lede { margin-top: 22px; max-width: 60ch; color: var(--muted);
  font-size: clamp(15px, 1.3vw, 17px); }

/* reveals */
.rv { opacity: 0; transform: translateY(28px);
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1); }
.rv.in { opacity: 1; transform: none; }

/* ---------- the difference: nightmare vs dream ---------- */
.vs { display: grid; grid-template-columns: 1fr 88px 1fr; margin-top: 56px;
  align-items: stretch; }
.vs-col { border-radius: 22px; padding: clamp(26px, 3vw, 40px);
  display: flex; flex-direction: column; }
.vs-col.nightmare { border: 1px solid rgba(184,92,61,.22);
  background:
    repeating-linear-gradient(-45deg, rgba(184,92,61,.028) 0 14px, transparent 14px 28px),
    radial-gradient(120% 100% at 0% 0%, rgba(184,92,61,.07), transparent 60%),
    #FCFAF6;
  box-shadow: inset 0 0 0 1px rgba(184,92,61,.05), 0 14px 40px rgba(31,35,28,.06); }
.vs-col.dreamside { border: 1px solid rgba(92,122,96,.3);
  background:
    radial-gradient(120% 100% at 100% 0%, rgba(158,183,166,.16), transparent 60%),
    radial-gradient(100% 100% at 0% 100%, var(--caramel-dim), transparent 65%),
    #FDFEFC;
  box-shadow: 0 20px 56px rgba(92,122,96,.14), 0 0 0 6px rgba(158,183,166,.08); }
.vs-tag { align-self: flex-start; font-family: var(--mono); font-size: 10.5px;
  letter-spacing: .18em; border-radius: 999px; padding: 7px 14px; margin-bottom: 22px; }
.bad-tag { color: var(--warm); background: rgba(184,92,61,.09);
  border: 1px solid rgba(184,92,61,.3); }
.good-tag { color: var(--sage-deep); background: var(--sage-dim);
  border: 1px solid rgba(92,122,96,.35); }
.vs-title { font-family: var(--serif); font-weight: 400;
  font-size: clamp(26px, 2.8vw, 38px); line-height: 1.12; letter-spacing: -.005em; }
.vs-title em { font-style: italic; }
.sage-title em, .sage-title { color: var(--sage-deep); }
.vs-sub { margin-top: 10px; color: var(--muted); font-size: 15px; }
.vs-caption { margin-top: 28px; max-width: 54ch; color: var(--muted); font-size: 14.5px; }
.vs-caption em { font-style: italic; color: var(--warm); }
.vs-outcomes { display: flex; flex-wrap: wrap; gap: 9px; margin-top: auto;
  padding-top: 28px; }
.oc { font-size: 13px; font-weight: 600; letter-spacing: -.005em;
  border-radius: 999px; padding: 9px 16px;
  transition: transform .25s ease, box-shadow .25s ease,
    opacity .9s cubic-bezier(.19,1,.22,1); }
.oc.rv:not(.in) { transform: translateY(14px); }
.oc:hover { transform: translateY(-2px); }
.oc.bad { color: var(--warm); background: rgba(184,92,61,.09);
  border: 1px solid rgba(184,92,61,.28); }
.oc.bad:hover { box-shadow: 0 6px 16px rgba(184,92,61,.18); }
.oc.good { color: var(--sage-deep); background: rgba(92,122,96,.1);
  border: 1px solid rgba(92,122,96,.32); }
.oc.good:hover { box-shadow: 0 6px 16px rgba(92,122,96,.2); }
.vs.in .oc.good:first-child { animation: notifsettle .6s cubic-bezier(.19,1,.22,1) 1s; }
.dream-extra { margin-top: 28px; display: flex; flex-direction: column; gap: 8px; }
.de-h { font-family: var(--mono); font-size: 10px; letter-spacing: .18em;
  color: var(--dim); margin-bottom: 4px; }
.de-item { display: flex; align-items: center; gap: 10px; font-size: 13.5px;
  color: var(--ink-soft); background: rgba(255,255,255,.75);
  border: 1px solid var(--rule-soft); border-radius: 10px; padding: 10px 14px;
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1); }
.de-item.rv:not(.in) { transform: translateX(18px); }
.de-check { width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; color: var(--sage-deep);
  background: var(--sage-dim); border: 1px solid rgba(92,122,96,.3); }

/* the VS spine */
.vs-mid { display: flex; flex-direction: column; align-items: center;
  gap: 14px; padding: 10px 0; }
.vs-line { flex: 1; width: 2px; border-radius: 2px;
  background: linear-gradient(180deg, rgba(184,92,61,.45), var(--caramel), rgba(92,122,96,.55));
  transform: scaleY(0); transition: transform 1.1s cubic-bezier(.19,1,.22,1) .25s; }
.vs-mid .vs-line:first-child { transform-origin: bottom; }
.vs-mid .vs-line:last-child { transform-origin: top; }
.vs.in .vs-line { transform: scaleY(1); }
.vs-badge { position: relative; width: 68px; height: 68px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; background: #fff;
  border: 1px solid var(--rule); box-shadow: 0 12px 32px rgba(31,35,28,.14);
  opacity: 0; transform: scale(.3) rotate(-16deg);
  transition: opacity .6s cubic-bezier(.19,1,.22,1) .7s,
    transform .6s cubic-bezier(.34,1.56,.64,1) .7s; }
.vs.in .vs-badge { opacity: 1; transform: scale(1) rotate(0deg); }
.vs-badge::before { content: ''; position: absolute; inset: -7px; border-radius: 50%;
  background: conic-gradient(from 0deg, var(--warm), var(--caramel), var(--sage-deep), var(--warm));
  filter: blur(0.5px); animation: spin 7s linear infinite; z-index: -1; opacity: .8; }
.vs-badge::after { content: ''; position: absolute; inset: -2px; border-radius: 50%;
  background: #fff; z-index: -1; }
.vs-badge em { font-family: var(--serif); font-style: italic; font-size: 26px;
  color: var(--ink); letter-spacing: .02em; }
@media (max-width: 980px) {
  .vs { grid-template-columns: 1fr; row-gap: 0; }
  .vs-mid { flex-direction: row; padding: 18px 0; }
  .vs-line { width: auto; height: 2px; flex: 1;
    background: linear-gradient(90deg, rgba(184,92,61,.45), var(--caramel), rgba(92,122,96,.55)); }
  .vs-mid .vs-line:first-child { transform-origin: right; }
  .vs-mid .vs-line:last-child { transform-origin: left; }
  .vs.in .vs-line { transform: scaleX(1); }
  .vs-line { transform: scaleX(0); }
}

.oldway { margin-top: 32px; display: flex; flex-wrap: wrap; align-items: center;
  gap: 12px 6px; }
.chore-wrap { display: inline-flex; align-items: center; gap: 6px; }
.chore { display: inline-flex; align-items: center; gap: 9px;
  font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft);
  background: #FDF9EC; border: 1px solid rgba(201,150,68,.25);
  border-radius: 3px; padding: 10px 14px;
  box-shadow: 0 3px 10px rgba(31,35,28,.07), 0 1px 0 rgba(31,35,28,.04);
  rotate: var(--tilt, 0deg);
  transition: opacity .7s cubic-bezier(.19,1,.22,1), transform .7s cubic-bezier(.19,1,.22,1),
    rotate .3s ease, box-shadow .3s ease; }
.chore:nth-child(odd) { background: #F6F5F0; border-color: var(--rule); }
.chore:hover { rotate: 0deg; box-shadow: 0 8px 20px rgba(31,35,28,.12); }
.chore b { font-weight: 600; font-size: 10px; color: var(--dim);
  border: 1px solid var(--rule); border-radius: 50%; width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center; flex: none; }
.chore-ic { font-size: 15px; }
.chore-arrow { color: var(--dim); font-size: 14px; }

/* ---------- the staxis way (right column) ---------- */
.notif-stage { position: relative; margin-top: 32px; display: flex; justify-content: center; }
.notif-halo { position: absolute; width: 420px; max-width: 90%; height: 220px;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: radial-gradient(ellipse, var(--sage-dim), transparent 70%);
  filter: blur(10px); animation: halopulse 4s ease-in-out infinite; }
@keyframes halopulse { 0%,100% { opacity: .7; transform: translate(-50%,-50%) scale(1); }
  50% { opacity: 1; transform: translate(-50%,-50%) scale(1.08); } }
.notif { position: relative; width: 420px; max-width: 100%;
  background: rgba(255,255,255,.9); backdrop-filter: blur(10px);
  border: 1px solid var(--rule); border-radius: 20px; padding: 18px 20px;
  box-shadow: 0 24px 60px rgba(31,35,28,.14), 0 4px 14px rgba(31,35,28,.06);
  transition: transform .4s cubic-bezier(.19,1,.22,1); }
.notif.done { animation: notifsettle .5s cubic-bezier(.19,1,.22,1); }
@keyframes notifsettle { 0% { transform: scale(1); } 40% { transform: scale(1.025); } 100% { transform: scale(1); } }
.notif-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.notif-logo { width: 26px; height: 26px; border-radius: 7px; background: var(--mark);
  display: inline-flex; align-items: center; justify-content: center; flex: none; }
.notif-app { font-weight: 600; font-size: 13.5px; letter-spacing: -.01em; }
.notif-time { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.notif-body { font-size: 14.5px; color: var(--ink-soft); line-height: 1.55; }
.notif-actions { position: relative; margin-top: 14px; }
.notif-btn { font-family: var(--sans); font-weight: 600; font-size: 13.5px;
  border: none; cursor: default; border-radius: 999px; padding: 10px 22px;
  background: var(--sage-dim); color: var(--sage-deep);
  border: 1px solid rgba(92,122,96,.35);
  transition: background .25s ease, color .25s ease, transform .15s ease; }
.notif.pressed .notif-btn { transform: scale(.94); background: rgba(92,122,96,.25); }
.notif.done .notif-btn { background: var(--sage-deep); color: #fff; border-color: var(--sage-deep); }
.notif-burst { position: absolute; left: 60px; top: 50%; pointer-events: none; }
.notif-burst i { position: absolute; font-style: normal; font-size: 12px; color: var(--caramel);
  animation: burst .8s cubic-bezier(.19,1,.22,1) forwards; }
.notif-burst i:nth-child(1) { animation-delay: 0s;   --bx: -34px; --by: -30px; }
.notif-burst i:nth-child(2) { animation-delay: .05s; --bx: 26px;  --by: -38px; }
.notif-burst i:nth-child(3) { animation-delay: .1s;  --bx: 44px;  --by: -8px; }
.notif-burst i:nth-child(4) { animation-delay: .05s; --bx: -46px; --by: 2px; }
.notif-burst i:nth-child(5) { animation-delay: .12s; --bx: 8px;   --by: 30px; }
@keyframes burst {
  0% { transform: translate(0,0) scale(.4); opacity: 1; }
  100% { transform: translate(var(--bx), var(--by)) scale(1.1) rotate(140deg); opacity: 0; }
}

/* ---------- one page (orbit) ---------- */
.orbit { position: relative; margin: 70px auto 0; max-width: 920px; height: 620px; }
.orbit-lines { position: absolute; inset: 0; width: 100%; height: 100%; }
.orbit-lines line { stroke: rgba(92,122,96,.3); stroke-width: .35;
  stroke-dasharray: 2 2.4; animation: march 2.4s linear infinite; }
@keyframes march { to { stroke-dashoffset: -8.8; } }
.orbit-chip { position: absolute; transform: translate(-50%, -50%);
  font-family: var(--mono); font-size: 11.5px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--dim); white-space: nowrap;
  background: #FAFAF7; border: 1px solid var(--rule-soft); border-radius: 999px;
  padding: 9px 16px; box-shadow: 0 4px 12px rgba(31,35,28,.05); cursor: default;
  animation: chipfloat 6s ease-in-out infinite;
  transition: color .25s ease, background .25s ease, border-color .25s ease,
    box-shadow .25s ease; }
.orbit-chip:hover { color: var(--ink); background: #fff;
  border-color: var(--sage); box-shadow: 0 14px 34px rgba(31,35,28,.14);
  animation-play-state: paused; z-index: 5; }
@keyframes chipfloat {
  0%,100% { margin-top: 0; }
  50% { margin-top: -9px; }
}

/* hover demo — a mini live Staxis page blooming out of the chip */
.chip-pop { position: absolute; width: 380px; white-space: normal;
  text-transform: none; letter-spacing: 0; font-family: var(--sans);
  font-size: 13px; line-height: 1.5; color: var(--muted); text-align: left;
  background: #fff; border: 1px solid var(--rule); border-radius: 16px;
  box-shadow: 0 30px 70px rgba(31,35,28,.2);
  display: flex; flex-direction: column;
  opacity: 0; visibility: hidden; z-index: 6;
  transition: opacity .3s cubic-bezier(.19,1,.22,1),
    transform .4s cubic-bezier(.34,1.56,.64,1), visibility 0s .3s; }
.chip-pop::before { content: ''; position: absolute; inset: -16px; z-index: -1; }
.orbit-chip:hover .chip-pop { opacity: 1; visibility: visible;
  transition: opacity .3s cubic-bezier(.19,1,.22,1),
    transform .4s cubic-bezier(.34,1.56,.64,1), visibility 0s 0s; }
.cp-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
  border-bottom: 1px solid var(--rule-soft); background: var(--bg-warm); flex: none;
  position: relative; border-radius: 16px 16px 0 0; }
.cp-brand { width: 22px; height: 22px; border-radius: 6px; background: var(--mark);
  display: inline-flex; align-items: center; justify-content: center; flex: none; }
.cp-head b { font-weight: 600; font-size: 13.5px; color: var(--ink);
  letter-spacing: -.01em; }
.cp-head i { margin-left: auto; font-style: normal; font-family: var(--mono);
  font-size: 8.5px; letter-spacing: .16em; color: var(--dim); }
/* underline tabs, exactly like the app's sub-tab bar */
.cp-tabs { display: flex; flex-wrap: wrap; gap: 16px; padding: 0 14px;
  border-bottom: 1px solid var(--rule-soft); background: #fff; flex: none;
  position: relative; }
.cp-tab { font-family: var(--sans); font-size: 11px; font-weight: 500;
  color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent;
  padding: 9px 1px 8px; cursor: pointer; transition: color .2s ease, border-color .2s ease; }
.cp-tab:hover { color: var(--ink); }
.cp-tab.on { color: var(--ink); font-weight: 600; border-bottom-color: var(--ink); }
.cp-body { display: block; height: 300px; overflow: auto; padding: 14px;
  background: #F7F8F5; position: relative; border-radius: 0 0 16px 16px;
  animation: pagein .4s cubic-bezier(.19,1,.22,1); overscroll-behavior: contain; }
.cp-body::-webkit-scrollbar { height: 8px; }
.ap.wide { width: 620px; }
@keyframes pagein { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.cp-body::-webkit-scrollbar { width: 7px; }
.cp-body::-webkit-scrollbar-thumb { background: rgba(31,35,28,.14); border-radius: 8px; }
.cp-body::-webkit-scrollbar-track { background: transparent; }

/* Each popup blooms OUTWARD, continuing its dashed line's direction:
   top-right chip opens up-and-right, bottom-left opens down-and-left,
   side chips open sideways. Narrow-window fallbacks keep them on-screen. */
.pop-up { bottom: calc(100% + 10px); left: 50%;
  transform: translateX(-50%) scale(.5); transform-origin: center bottom; }
.orbit-chip:hover .pop-up { transform: translateX(-50%) scale(1); }

.pop-up-left, .pop-up-right, .pop-down-left, .pop-down-right {
  transform: scale(.5); }
.orbit-chip:hover .pop-up-left, .orbit-chip:hover .pop-up-right,
.orbit-chip:hover .pop-down-left, .orbit-chip:hover .pop-down-right {
  transform: scale(1); }
.pop-up-left { bottom: calc(100% + 10px); right: calc(50% - 40px);
  transform-origin: calc(100% - 40px) bottom; }
.pop-up-right { bottom: calc(100% + 10px); left: calc(50% - 40px);
  transform-origin: 40px bottom; }
.pop-down-left { top: calc(100% + 10px); right: calc(50% - 40px);
  transform-origin: calc(100% - 40px) top; }
.pop-down-right { top: calc(100% + 10px); left: calc(50% - 40px);
  transform-origin: 40px top; }

.pop-left { right: calc(100% + 12px); top: 50%;
  transform: translateY(-50%) scale(.5); transform-origin: right center; }
.orbit-chip:hover .pop-left { transform: translateY(-50%) scale(1); }
.pop-right { left: calc(100% + 12px); top: 50%;
  transform: translateY(-50%) scale(.5); transform-origin: left center; }
.orbit-chip:hover .pop-right { transform: translateY(-50%) scale(1); }

@media (max-width: 1600px) {
  .pop-left { right: auto; left: -12px; top: calc(100% + 12px);
    bottom: auto; transform: scale(.5); transform-origin: 40px top; }
  .orbit-chip:hover .pop-left { transform: scale(1); }
  .pop-right { left: auto; right: -12px; top: calc(100% + 12px);
    transform: scale(.5); transform-origin: calc(100% - 40px) top; }
  .orbit-chip:hover .pop-right { transform: scale(1); }
}
@media (max-width: 1150px) {
  .pop-up-right, .pop-down-right, .pop-right { left: auto; right: -12px;
    transform-origin: calc(100% - 40px) top; }
  .pop-up-right { transform-origin: calc(100% - 40px) bottom; }
  .pop-up-left, .pop-down-left, .pop-left { right: auto; left: -12px;
    transform-origin: 40px top; }
  .pop-up-left { transform-origin: 40px bottom; }
}

/* mock page primitives (inside popup demos) */
.ap { display: flex; flex-direction: column; gap: 7px; }
.ap-h { font-family: var(--mono); font-size: 9px; letter-spacing: .18em;
  color: var(--dim); margin: 4px 0 1px; }
.ap-card { background: #fff; border: 1px solid var(--rule-soft); border-radius: 10px;
  padding: 10px 12px; display: flex; align-items: center; gap: 9px;
  font-size: 12px; color: var(--ink-soft); }
.ap-btn { margin-left: auto; font-size: 10.5px; font-weight: 600; color: var(--sage-deep);
  background: var(--sage-dim); border: 1px solid rgba(92,122,96,.3);
  border-radius: 999px; padding: 4px 10px; flex: none; }
.ap-done { display: flex; align-items: center; gap: 8px; font-size: 11.5px;
  color: var(--muted); padding: 3px 2px; }
.ap-feedrow { display: flex; align-items: baseline; gap: 9px; font-size: 11px;
  color: var(--ink-soft); background: #fff; border: 1px solid var(--rule-soft);
  border-radius: 8px; padding: 8px 11px; }
.ap-feedrow > span { font-family: var(--mono); font-size: 9px; color: var(--dim);
  flex: none; width: 44px; }
.ap-note { font-size: 11px; color: var(--dim); font-style: italic; padding: 3px 2px; }
.ap-rail { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
.ap-railbtn { font-family: var(--mono); font-size: 8.5px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--ink-soft); background: #fff;
  border: 1px solid var(--rule); border-radius: 7px; padding: 5px 8px; }
.ap-railbtn:first-child { background: var(--mark); color: #fff; border-color: var(--mark); }
.ap-amt { margin-left: auto; font-family: var(--mono); font-size: 10.5px;
  font-weight: 600; color: var(--ink-soft); flex: none; }
.ap-statrow { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.ap-stat { gap: 10px; }
.ap-stat b { font-family: var(--serif); font-style: italic; font-weight: 400;
  font-size: 20px; color: var(--ink); line-height: 1.1; }
.ap-stat b i { font-family: var(--mono); font-style: normal; font-size: 8px;
  color: var(--dim); letter-spacing: .1em; margin: 0 5px 0 2px; }
.ap-stat span { display: block; font-size: 10px; color: var(--dim); }
.ap-ring { width: 32px; height: 32px; border-radius: 50%; flex: none;
  background: conic-gradient(var(--sage-deep) 0 84%, rgba(31,35,28,.08) 84% 100%);
  -webkit-mask: radial-gradient(circle, transparent 9px, black 10px);
  mask: radial-gradient(circle, transparent 9px, black 10px); }
.ap-roomgrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.ap-room { font-family: var(--mono); font-size: 8.5px; text-align: center;
  padding: 7px 0; border-radius: 5px; color: var(--ink-soft); }
.r-ok { background: rgba(92,122,96,.16); }
.r-dirty { background: rgba(201,150,68,.2); }
.r-insp { background: rgba(123,106,151,.16); }
.r-occ { background: rgba(31,35,28,.06); color: var(--dim); }
.ap-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 9.5px;
  color: var(--dim); align-items: center; padding: 1px 1px 0; }
.ap-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block;
  margin-right: 4px; vertical-align: -1px; }
.ap-avatar { width: 26px; height: 26px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; color: var(--sage-deep);
  background: var(--sage-dim); border: 1px solid rgba(92,122,96,.3); }
.ap-cl-mid { flex: 1; min-width: 0; }
.ap-cl-mid b { display: block; font-size: 12px; font-weight: 600; color: var(--ink); }
.ap-role { font-size: 10px; color: var(--dim); }
.ap-bar { height: 5px; border-radius: 4px; background: rgba(31,35,28,.07);
  margin-top: 5px; overflow: hidden; }
.ap-bar i { display: block; height: 100%; border-radius: 4px;
  background: var(--sage-deep); transition: width 1s cubic-bezier(.19,1,.22,1); }
.ap-bar.big { height: 7px; flex: 1; margin-top: 0; }
.f-good { background: var(--sage-deep) !important; }
.f-low { background: var(--caramel) !important; }
.f-crit { background: var(--warm) !important; }
.ap-cl-count { font-family: var(--mono); font-size: 9.5px; color: var(--dim); flex: none; }
.ap-stock b { font-size: 11.5px; font-weight: 600; width: 104px; flex: none; }
.ap-pct { font-family: var(--mono); font-size: 9.5px; flex: none; width: 32px; text-align: right; }
.t-good { color: var(--sage-deep); }
.t-low { color: var(--caramel-deep); }
.t-crit { color: var(--warm); }
.ap-wo b { font-family: var(--mono); font-size: 9.5px; color: var(--dim);
  width: 36px; flex: none; }
.ap-wo-mid { flex: 1; font-size: 12px; color: var(--ink); }
.ap-wo-mid span { display: block; font-size: 10px; color: var(--dim); }
.ap-pill { font-family: var(--mono); font-size: 8px; letter-spacing: .08em;
  border-radius: 999px; padding: 4px 9px; flex: none; }
.p-open { color: var(--caramel-deep); background: var(--caramel-dim);
  border: 1px solid rgba(201,150,68,.35); }
.p-prog { color: var(--purple); background: rgba(123,106,151,.1);
  border: 1px solid rgba(123,106,151,.3); }
.p-done { color: var(--sage-deep); background: var(--sage-dim);
  border: 1px solid rgba(92,122,96,.3); }
.ap-conf { font-size: 10px; color: var(--dim); flex: none; }
.ap-conf.yes { color: var(--sage-deep); font-weight: 600; }
.ap-lang { font-family: var(--mono); font-size: 8px; color: var(--dim);
  border: 1px solid var(--rule); border-radius: 4px; padding: 2px 5px; flex: none; }
.ap-reorder { border-color: rgba(201,150,68,.35); background: #FDFBF4; }
.ap-msg { max-width: 80%; font-size: 11.5px; padding: 8px 12px; border-radius: 12px; }
.ap-msg.them { background: #fff; border: 1px solid var(--rule-soft);
  align-self: flex-start; border-bottom-left-radius: 3px; }
.ap-msg.me { background: var(--sage-dim); border: 1px solid rgba(92,122,96,.25);
  align-self: flex-end; border-bottom-right-radius: 3px; color: var(--ink); }

/* --- mirrors of real app screens --- */
.ap-serif { font-family: var(--serif); font-size: 17px; color: var(--ink);
  letter-spacing: -.005em; }
.ap-statgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.ap-statgrid.four { grid-template-columns: repeat(4, 1fr); }
.ap-cell { background: #fff; border: 1px solid var(--rule-soft); border-radius: 8px;
  padding: 8px 10px; }
.ap-cell.hl { background: var(--sage-dim); border-color: rgba(92,122,96,.3); }
.ap-cell b { display: block; font-family: var(--serif); font-weight: 400;
  font-size: 17px; line-height: 1.1; color: var(--ink); }
.ap-cell span { display: block; font-family: var(--mono); font-size: 6.8px;
  letter-spacing: .12em; color: var(--dim); margin-top: 3px; white-space: nowrap; }
.ap-legendcaps { font-family: var(--mono); font-size: 8px; letter-spacing: .1em;
  color: var(--dim); }
.ap-roomcards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.ap-roomcard { display: flex; flex-direction: column; gap: 3px; background: #fff;
  border: 1px solid var(--rule-soft); border-left-width: 3px; border-radius: 7px;
  padding: 7px 9px; }
.ap-roomcard b { font-family: var(--mono); font-size: 10.5px; color: var(--ink); }
.ap-roomcard b em { font-style: normal; font-size: 8.5px; color: var(--caramel-deep); }
.ap-roomcard b em.rc-flag { color: var(--warm); font-weight: 700; }
.ap-roomcard i { font-style: normal; font-family: var(--mono); font-size: 6.5px;
  letter-spacing: .1em; color: var(--dim); }
.rc-ok { border-left-color: var(--sage-deep); }
.rc-dirty { border-left-color: var(--caramel); }
.rc-prog { border-left-color: var(--purple); }
.ap-laneh { display: flex; align-items: center; gap: 6px; margin: 6px 0 0;
  font-family: var(--mono); font-size: 8.5px; letter-spacing: .16em; color: var(--dim); }
.lane-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.ld-warm { background: var(--warm); } .ld-car { background: var(--caramel); }
.ld-pur { background: var(--purple); } .ld-sage { background: var(--sage-deep); }
.ap-wo.wo-warm { border-left: 3px solid var(--warm); }
.ap-wo.wo-car { border-left: 3px solid var(--caramel); }
.ap-wo.wo-pur { border-left: 3px solid var(--purple); }
.ap-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.ap-chip { font-family: var(--mono); font-size: 8.5px; color: var(--ink-soft);
  background: var(--caramel-dim); border: 1px solid rgba(201,150,68,.3);
  border-radius: 5px; padding: 2px 6px; }
.ap-days { margin-left: 2px; font-style: normal; font-family: var(--mono);
  font-size: 8.5px; color: var(--dim); flex: none; width: 40px; text-align: right; }
.ap-bal { margin-left: 8px; font-style: normal; font-family: var(--mono);
  font-size: 9px; color: var(--dim); flex: none; }
.ap-railbtn.on { background: var(--mark); color: #fff; border-color: var(--mark); }
.ap-railbtn.seg { border-radius: 999px; }
.ap-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.ap-day { text-align: center; font-family: var(--mono); font-size: 9px;
  color: var(--muted); background: #fff; border: 1px solid var(--rule-soft);
  border-radius: 6px; padding: 6px 0; }
.ap-day.on { background: var(--sage-dim); border-color: rgba(92,122,96,.35);
  color: var(--sage-deep); font-weight: 600; }
.ap-msgrow { display: flex; gap: 8px; align-items: flex-start; background: #fff;
  border: 1px solid var(--rule-soft); border-radius: 10px; padding: 9px 11px; }
.mr-mid { font-size: 11.5px; color: var(--ink-soft); line-height: 1.45; }
.mr-mid b { display: block; font-size: 11px; color: var(--ink); }
.mr-mid b i { font-style: normal; font-family: var(--mono); font-size: 8px;
  color: var(--dim); font-weight: 400; margin-left: 5px; }
.ap-badge { margin-left: auto; font-family: var(--mono); font-size: 8px;
  color: var(--sage-deep); background: var(--sage-dim);
  border: 1px solid rgba(92,122,96,.3); border-radius: 999px; padding: 2px 7px; flex: none; }
.ap-catchup { display: flex; align-items: center; gap: 8px; font-size: 12px;
  font-weight: 600; color: #fff; background: var(--sage-deep); border-radius: 9px;
  padding: 8px 12px; }
.ap-catchup .ap-badge { background: rgba(255,255,255,.2); color: #fff;
  border-color: transparent; }
.ap-chan { font-family: var(--mono); font-size: 10.5px; color: var(--ink-soft);
  padding: 9px 12px; }
.ap-online { width: 7px; height: 7px; border-radius: 50%; background: var(--sage-deep);
  flex: none; }
.ap-rank { font-family: var(--mono); font-size: 9px; color: var(--dim); flex: none; }
.ap-ringrow { gap: 14px; }
.ap-ring.big { width: 52px; height: 52px;
  background: conic-gradient(var(--ink-soft) 0 62%, var(--sage-deep) 62% 75%,
    var(--caramel) 75% 85%, var(--warm) 85% 93%, rgba(31,35,28,.08) 93% 100%);
  -webkit-mask: radial-gradient(circle, transparent 15px, black 16px);
  mask: radial-gradient(circle, transparent 15px, black 16px); }
.ap-ringlegend { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;
  font-size: 9.5px; color: var(--muted); }
.lg { display: inline-block; width: 8px; height: 8px; border-radius: 2px;
  margin-right: 5px; vertical-align: -1px; }
.l-occ { background: var(--ink-soft); } .l-arr { background: var(--sage-deep); }
.l-dep { background: var(--caramel); } .l-dirty { background: var(--warm); }

/* wide two-column replicas (scroll any direction inside the window) */
.ap-cols { display: flex; gap: 10px; align-items: stretch; }
.ap-siderail { width: 148px; flex: none; display: flex; flex-direction: column;
  gap: 6px; background: #fff; border: 1px solid var(--rule-soft);
  border-radius: 10px; padding: 10px; }
.rail-stat { padding: 2px 2px 6px; border-bottom: 1px solid var(--rule-soft); }
.rail-stat b { display: block; font-family: var(--serif); font-weight: 400;
  font-size: 15px; color: var(--ink); }
.rail-stat span { font-family: var(--mono); font-size: 6.5px; letter-spacing: .12em;
  color: var(--dim); }
.ap-railbtn.block { display: block; text-align: center; border-radius: 8px; }
.ap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.ap-search { font-family: var(--mono); font-size: 8.5px; color: var(--dim);
  background: #fff; border: 1px solid var(--rule-soft); border-radius: 999px;
  padding: 5px 10px; }
.side-chan { display: flex; align-items: center; gap: 6px; font-family: var(--mono);
  font-size: 9px; color: var(--ink-soft); padding: 4px 2px; }
.side-chan .ap-badge { margin-left: auto; }
.ap-online.off { background: var(--rule); }
.ap-panehead { display: flex; align-items: baseline; gap: 8px; font-weight: 600;
  font-size: 12px; color: var(--ink); padding-bottom: 8px;
  border-bottom: 1px solid var(--rule-soft); }
.ap-panehead span { font-size: 9.5px; font-weight: 400; color: var(--dim); }
.ap-msginput { font-size: 10.5px; color: var(--dim); background: #fff;
  border: 1px solid var(--rule); border-radius: 9px; padding: 9px 12px;
  margin-top: 4px; }
.ap-lanes { display: flex; gap: 8px; align-items: flex-start; }
.ap-lane { width: 148px; flex: none; display: flex; flex-direction: column; gap: 6px; }
.ap-lane .ap-wo { flex-wrap: wrap; }
.ap-chart { flex: 1; display: block; }
.ap-chart svg { width: 100%; height: 54px; margin-top: 8px; }
.ap-chart polyline { fill: none; stroke: var(--sage-deep); stroke-width: 1.6; }
.ap-chart circle { fill: var(--caramel); }

/* ---------- exact-mini primitives (match the real app chrome) ---------- */
.x-caps { font-family: var(--mono); font-size: 8.5px; letter-spacing: .18em;
  color: var(--muted); margin: 2px 0; }
.x-serifhead { font-family: var(--serif); font-size: 15px; color: var(--ink); }
.x-serifhead.big { font-size: 20px; }
.x-serifhead em { font-style: italic; }
.x-serifhead .dim-em, .dim-em { font-style: italic; color: var(--dim); }
.x-headrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.x-spacer { flex: 1; }
.x-btnrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.xb-dark, .xb-light { font-size: 10px; font-weight: 600; border-radius: 999px;
  padding: 6px 12px; white-space: nowrap; }
.xb-dark { background: var(--mark); color: #fff; }
.xb-light { background: #fff; color: var(--ink-soft); border: 1px solid var(--rule); }
.xb-n { font-style: normal; font-family: var(--mono); font-size: 8.5px; opacity: .7;
  margin-left: 3px; }
.x-stat { padding-right: 12px; }
.x-stat b { display: block; font-family: var(--serif); font-style: italic;
  font-weight: 400; font-size: 17px; line-height: 1.15; color: var(--ink); }
.x-stat b.sm { font-size: 12px; font-style: normal; }
.x-stat span { display: block; font-family: var(--mono); font-size: 6.8px;
  letter-spacing: .12em; color: var(--dim); white-space: nowrap; }
.x-pmsstrip { display: flex; gap: 12px; overflow-x: auto; align-items: flex-end; }
.x-pmsstrip .x-stat { border-right: 1px solid var(--rule-soft); }
.x-pmsstrip .x-stat.first { min-width: 76px; }
.hero-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
.hero-dot.good { background: var(--sage-deep); }
.hero-dot.crit { background: var(--warm); }
.x-invhero { padding: 2px 2px 6px; }
.x-groupnum { font-family: var(--serif); font-style: italic; font-weight: 400;
  font-size: 20px; color: var(--ink); margin-left: auto; margin-right: 8px; }
.x-monototal { font-family: var(--mono); font-size: 12px; font-weight: 600; }
.rail-badge { font-style: normal; font-family: var(--mono); font-size: 8px;
  float: right; background: rgba(255,255,255,.25); border-radius: 999px;
  padding: 1px 6px; }
.ap-railbtn.block .rail-badge { background: rgba(31,35,28,.08); }
.ap-railbtn.block.on .rail-badge { background: rgba(255,255,255,.25); }
.ap-railbtn.block.teal { background: rgba(96,140,255,.08);
  border-color: rgba(96,140,255,.25); color: #45618f; }
.ap-railbtn.block { text-align: left; }
.inv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.inv-item { flex-direction: column; align-items: stretch; gap: 7px; }
.inv-top { display: flex; align-items: center; gap: 8px; }
.ap-avatar.sq { border-radius: 7px; background: rgba(96,140,255,.1);
  border-color: rgba(96,140,255,.2); color: #45618f; }
.inv-refresh { margin-left: auto; color: var(--dim); font-size: 10px; }
.inv-count { font-size: 10px; color: var(--muted); }
.comms-head { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.comms-head span { display: block; font-size: 9px; font-weight: 400; color: var(--dim); }
.side-chan.cnav { font-family: var(--sans); font-size: 10.5px; }
.x-floorstrip { gap: 10px; flex-wrap: wrap; }
.fl-leg { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px;
  color: var(--muted); }
.x-timeaxis { display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 8px; color: var(--dim); padding: 0 4px; }
.x-shiftlane { position: relative; height: 22px; background: #fff;
  border: 1px solid var(--rule-soft); border-radius: 6px; }
.x-shiftlane.empty { display: flex; align-items: center; padding: 0 10px;
  font-family: var(--mono); font-size: 8.5px; color: var(--dim); height: 26px; }
.x-shift { position: absolute; top: 3px; bottom: 3px; border-radius: 4px;
  font-size: 8.5px; font-weight: 600; display: flex; align-items: center;
  padding: 0 7px; white-space: nowrap; overflow: hidden; }
.x-shift.sage { background: rgba(92,122,96,.18); color: var(--sage-deep); }
.x-shift.pur { background: rgba(123,106,151,.15); color: var(--purple); }
.x-weekrow { display: flex; gap: 6px; }
.x-daycard { background: #fff; border: 1px solid var(--rule-soft); border-radius: 9px;
  padding: 7px 10px; min-width: 52px; }
.x-daycard i { display: block; font-style: normal; font-family: var(--mono);
  font-size: 6.5px; letter-spacing: .1em; color: var(--dim); }
.x-daycard b { font-family: var(--serif); font-style: italic; font-weight: 400;
  font-size: 15px; }
.x-daycard.on { background: var(--mark); border-color: var(--mark); }
.x-daycard.on i, .x-daycard.on b { color: #fff; }
.x-nowrow { gap: 0; }
.x-nowrow .x-stat { border-right: 1px solid var(--rule-soft); padding: 0 12px; }
.x-nowrow .x-stat:first-child { padding-left: 0; }
.x-nowrow .x-stat b { font-size: 20px; }
.x-attention { background: var(--sage-dim); border-color: rgba(92,122,96,.25); }
.x-attn-badge { width: 20px; height: 20px; border-radius: 50%; background: var(--sage-deep);
  color: #fff; font-size: 10px; font-weight: 700; display: inline-flex;
  align-items: center; justify-content: center; }
.x-attn-badge.dark { background: var(--mark); }
.xb-rust { font-size: 10px; font-weight: 600; border-radius: 999px; padding: 6px 12px;
  white-space: nowrap; background: var(--warm); color: #fff; }

/* ---------- center: the Staxis page itself ---------- */
.stx-center { width: 420px; max-width: 88%; padding: 0; overflow: hidden;
  display: flex; flex-direction: column; }
.stx-center .cp-head { border-radius: 18px 18px 0 0; }
.stx-body { height: 330px; border-radius: 0 0 18px 18px; }
.stx-wrap { background: var(--bg-warm); align-items: flex-start; }
.stx-moon { font-size: 15px; flex: none; width: 26px; height: 26px; border-radius: 50%;
  background: #fff; border: 1px solid var(--rule-soft); display: inline-flex;
  align-items: center; justify-content: center; }
.stx-wrap-title { display: block; font-family: var(--serif); font-style: italic;
  font-weight: 400; font-size: 14px; color: var(--ink); margin: 3px 0 2px; }
.stx-labor { align-items: center; gap: 14px; }
.stx-labor-n { display: block; font-family: var(--mono); font-size: 15px;
  font-weight: 700; color: var(--ink); margin: 3px 0 6px; }
.stx-labor-n i { font-style: normal; font-weight: 400; font-size: 10px; color: var(--dim); }
.stx-under { text-align: right; flex: none; }
.stx-under b { display: block; font-family: var(--serif); font-style: italic;
  font-weight: 400; font-size: 19px; color: var(--sage-deep); }
.stx-under span { font-size: 9px; color: var(--dim); }
.stx-need { flex-direction: column; align-items: stretch; gap: 4px; }
.stx-need.hot { border-left: 3px solid var(--warm); }
.stx-need-title { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.stx-need-body { font-size: 11px; color: var(--muted); line-height: 1.5; }
.stx-need .x-btnrow { margin-top: 5px; }
.stx-note { font-size: 9px; color: var(--sage-deep); }
.stx-need.hot .stx-note { color: var(--warm); }

/* ---------- coming-soon chip + guest experience popup ---------- */
.orbit-chip.chip-soon { border: 1.5px dashed rgba(201,150,68,.55);
  color: var(--caramel-deep); background: #FFFDF6; }
.orbit-chip.chip-soon:hover { border-color: var(--caramel); color: var(--caramel-deep); }
.orbit-lines line.l-soon { stroke: rgba(201,150,68,.45); }
/* always open below and right-aligned so it never leaves the screen */
.chip-pop.pop-soon { left: auto; right: -8px; top: calc(100% + 12px); bottom: auto;
  transform: scale(.5); transform-origin: calc(100% - 40px) top;
  border: 1.5px dashed rgba(201,150,68,.5); }
.orbit-chip:hover .chip-pop.pop-soon { transform: scale(1); }
.pop-soon .cp-head i { color: var(--caramel-deep); }
.ap.gx { gap: 4px; padding: 4px 2px; }
.gx-item { display: flex; align-items: center; gap: 13px; font-size: 13.5px;
  color: var(--ink); padding: 7px 4px; border-bottom: 1px dashed var(--rule-soft);
  opacity: 0; animation: gxin .5s cubic-bezier(.19,1,.22,1) forwards; }
.gx-item:last-of-type { border-bottom: none; }
@keyframes gxin { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
.gx-ic { width: 28px; height: 28px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px;
  color: var(--caramel-deep); background: var(--caramel-dim);
  border: 1px dashed rgba(201,150,68,.5); }
.gx-item:first-child .gx-ic { animation: csring 2s ease-in-out infinite; }
@keyframes csring {
  0%, 100% { transform: rotate(0deg); box-shadow: 0 0 0 0 rgba(201,150,68,.3); }
  15% { transform: rotate(-12deg); }
  30% { transform: rotate(10deg); }
  45% { transform: rotate(0deg); box-shadow: 0 0 0 8px rgba(201,150,68,0); }
}

/* ---------- how AI runs your hotel (tiers) ---------- */
.tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
  margin-top: 56px; align-items: start; }
@media (max-width: 980px) { .tiers { grid-template-columns: 1fr; } }
.tier { position: relative; border-radius: 20px; padding: clamp(24px, 2.5vw, 32px);
  background: #fff; border: 1px solid var(--rule);
  display: flex; flex-direction: column; gap: 10px;
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1),
    box-shadow .3s ease; }
.tier:hover { box-shadow: 0 22px 54px rgba(31,35,28,.1); }
.tier-auto { border-top: 4px solid var(--sage-deep);
  background: radial-gradient(120% 60% at 50% 0%, var(--sage-dim), transparent 60%), #fff; }
.tier-semi { border-top: 4px solid var(--caramel);
  background: radial-gradient(120% 60% at 50% 0%, var(--caramel-dim), transparent 60%), #fff; }
.tier-assist { border-top: 4px solid var(--purple);
  background: radial-gradient(120% 60% at 50% 0%, rgba(123,106,151,.09), transparent 60%), #fff; }
.tier-gauge { display: flex; gap: 4px; margin-bottom: 4px; }
.tier-gauge i { height: 5px; flex: 1; border-radius: 4px; background: rgba(31,35,28,.08);
  transform: scaleX(0); transform-origin: left;
  transition: transform .7s cubic-bezier(.19,1,.22,1), background .3s ease; }
.tier.in .tier-gauge i { transform: scaleX(1); }
.tier.in .tier-gauge i:nth-child(2) { transition-delay: .15s; }
.tier.in .tier-gauge i:nth-child(3) { transition-delay: .3s; }
.tier-auto .tier-gauge i.on { background: var(--sage-deep); }
.tier-semi .tier-gauge i.on { background: var(--caramel); }
.tier-assist .tier-gauge i.on { background: var(--purple); }
.tier h3 { font-family: var(--serif); font-weight: 400; font-size: 24px;
  letter-spacing: -.005em; }
.tier-tag { font-style: italic; font-family: var(--serif); font-size: 14.5px;
  color: var(--muted); margin-bottom: 8px; }
.tier-visual { display: flex; align-items: center; gap: 8px; background: var(--bg-warm);
  border: 1px solid var(--rule-soft); border-radius: 11px; padding: 10px 13px;
  margin-bottom: 8px; }
.tier-visual.chat { flex-direction: column; align-items: stretch; gap: 6px; }
.tv-mono { font-family: var(--mono); font-size: 9px; letter-spacing: .14em;
  color: var(--sage-deep); }
.tv-line { font-size: 11.5px; color: var(--ink-soft); }
.tv-approve { margin-left: auto; font-size: 10.5px; font-weight: 600;
  color: var(--sage-deep); background: var(--sage-dim);
  border: 1px solid rgba(92,122,96,.35); border-radius: 999px; padding: 4px 11px;
  animation: notifsettle 4s cubic-bezier(.19,1,.22,1) infinite; }
.tv-q { font-size: 11.5px; color: var(--ink); font-weight: 600; }
.tv-a { font-size: 11.5px; color: var(--muted); padding-left: 12px;
  border-left: 2px solid rgba(123,106,151,.35); }
.tier-item { display: flex; align-items: center; gap: 10px; font-size: 13.5px;
  color: var(--ink-soft);
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1); }
.tier-item.rv:not(.in) { transform: translateX(14px); }
.tier-item.soon { color: var(--muted); }
.tier-ok { flex: none; width: 18px; text-align: center; font-size: 9px; }
.tier-ok.semi { color: var(--caramel); }
.tier-ok.assist { color: var(--purple); font-size: 8px; }
.soon-pill { margin-left: auto; font-family: var(--mono); font-size: 7.5px;
  letter-spacing: .14em; color: var(--caramel-deep); border: 1px dashed rgba(201,150,68,.5);
  border-radius: 999px; padding: 2px 7px; flex: none; }
.tier-note { margin-top: 6px; font-size: 11.5px; font-style: italic; color: var(--dim); }

/* ---------- roadmap ---------- */
.roadmap { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 56px; }
@media (max-width: 860px) { .roadmap { grid-template-columns: 1fr; } }
.rm-col { border-radius: 22px; padding: clamp(26px, 3vw, 38px);
  display: flex; flex-direction: column; gap: 10px; }
.rm-now { border: 1px solid rgba(92,122,96,.3);
  background:
    radial-gradient(120% 100% at 0% 0%, rgba(158,183,166,.14), transparent 60%),
    #FDFEFC;
  box-shadow: 0 16px 44px rgba(92,122,96,.1); }
.rm-soon { position: relative; border: 1.5px dashed rgba(201,150,68,.5);
  background:
    radial-gradient(120% 100% at 100% 0%, var(--caramel-dim), transparent 65%),
    #FFFDF8; overflow: hidden; }
.rm-soon::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: 22px;
  background: linear-gradient(100deg, transparent 35%, rgba(255,255,255,.5) 50%, transparent 65%);
  background-size: 280% 100%; animation: dreamsweep 5.5s ease-in-out infinite; }
.rm-col .vs-tag { margin-bottom: 14px; }
.soon-tag { color: var(--caramel-deep); background: var(--caramel-dim);
  border: 1px solid rgba(201,150,68,.4); }
.rm-item { display: flex; align-items: center; gap: 11px; font-size: 14.5px;
  color: var(--ink-soft);
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1); }
.rm-item.rv:not(.in) { transform: translateX(16px); }
.rm-soon-dot { width: 20px; height: 20px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--caramel-deep); background: var(--caramel-dim);
  border: 1px dashed rgba(201,150,68,.5); animation: sparkspin 8s linear infinite; }
.rm-note { margin-top: 10px; font-size: 12.5px; font-style: italic; color: var(--dim); }
.today { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 340px; max-width: 82%; background: #fff; border: 1px solid var(--rule);
  border-radius: 18px; padding: 20px;
  box-shadow: 0 28px 70px rgba(31,35,28,.14), 0 0 0 8px rgba(158,183,166,.08); }
.today-head { display: flex; align-items: center; gap: 8px; padding-bottom: 14px;
  border-bottom: 1px solid var(--rule-soft); margin-bottom: 12px;
  font-weight: 600; font-size: 15px; letter-spacing: -.01em; }
.today-count { margin-left: auto; font-family: var(--mono); font-weight: 400;
  font-size: 10px; letter-spacing: .14em; color: var(--caramel-deep);
  background: var(--caramel-dim); border-radius: 999px; padding: 4px 10px; }
.today-item, .today-rest { display: flex; align-items: center; gap: 10px;
  font-size: 13.5px; color: var(--ink-soft); padding: 8px 0; }
.today-rest { color: var(--sage-deep); border-top: 1px dashed var(--rule);
  margin-top: 8px; padding-top: 12px; }
.ti-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ti-dot.warn { background: var(--caramel); }
.ti-dot.info { background: var(--purple); }
.ti-dot.ok { background: var(--sage-deep); }
@media (max-width: 760px) {
  .orbit { height: auto; display: flex; flex-flow: row wrap; justify-content: center;
    align-items: center; gap: 14px; }
  .orbit-lines { display: none; }
  .orbit-chip { position: static; transform: none; color: var(--ink-soft); }
  .chip-pop { display: none; }
  .today { position: static; transform: none; width: 100%; max-width: 420px;
    flex: none; order: -1; margin-bottom: 12px; }
}

/* ---------- every benefit ---------- */
.bens { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px;
  margin-top: 56px; }
@media (max-width: 980px) { .bens { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 620px) { .bens { grid-template-columns: 1fr; } }
.ben { position: relative; display: flex; align-items: center; gap: 12px;
  font-size: 15px; color: var(--ink-soft); padding: 13px 16px; border-radius: 12px;
  border: 1px solid transparent; overflow: hidden;
  transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
  transition: border-color .3s ease, transform .25s ease, box-shadow .3s ease,
    background .3s ease, opacity .9s cubic-bezier(.19,1,.22,1); }
.ben.rv:not(.in) { transform: translateY(20px); }
.ben::before { content: ''; position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(240px circle at var(--mx, 50%) var(--my, 50%),
    var(--caramel-dim), transparent 65%);
  transition: opacity .35s ease; pointer-events: none; }
.ben:hover { background: #fff; border-color: var(--rule);
  box-shadow: 0 10px 26px rgba(31,35,28,.08); }
.ben:hover::before { opacity: 1; }
.ben-check { width: 22px; height: 22px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: var(--sage-deep);
  background: var(--sage-dim); border: 1px solid rgba(92,122,96,.3); }
.ben.in .ben-check { animation: checkpop .55s cubic-bezier(.19,1,.22,1); }
.ben:hover .ben-check { animation: wiggle .6s ease; }
@keyframes checkpop {
  0% { transform: scale(.3); }
  55% { transform: scale(1.25); }
  100% { transform: scale(1); }
}
@keyframes wiggle {
  0%,100% { transform: rotate(0deg) scale(1); }
  25% { transform: rotate(-10deg) scale(1.15); }
  60% { transform: rotate(8deg) scale(1.1); }
}

/* ---------- steps ---------- */
.steps { position: relative; margin-top: 64px; padding-left: 46px;
  display: flex; flex-direction: column; gap: 54px; max-width: 760px; }
.beam { position: absolute; left: 15px; top: 8px; bottom: 8px; width: 2px;
  background: var(--rule); border-radius: 2px; overflow: hidden; }
.beam-fill { width: 100%; height: 100%; transform-origin: top; transform: scaleY(0);
  background: linear-gradient(180deg, var(--sage-deep), var(--caramel) 60%, rgba(201,150,68,.25));
  box-shadow: 0 0 12px rgba(201,150,68,.5); transition: transform .2s linear; }
.step { position: relative; }
.step-n { position: absolute; left: -46px; top: 2px; width: 32px; height: 32px;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: 10.5px; color: var(--caramel-deep);
  border: 1px solid rgba(201,150,68,.5); background: #fff;
  box-shadow: 0 0 0 5px var(--caramel-dim); }
.step-when { font-family: var(--mono); font-size: 11px; letter-spacing: .2em;
  text-transform: uppercase; color: var(--caramel-deep); margin-bottom: 8px; }
.step h3 { font-family: var(--serif); font-weight: 400; font-size: clamp(23px, 2.6vw, 30px);
  letter-spacing: -.005em; margin-bottom: 10px; }
.step p { color: var(--muted); font-size: 15px; max-width: 56ch; }
.step.rv.in .step-n { background: var(--caramel); color: #fff;
  border-color: var(--caramel); transition: background .5s ease .4s, color .5s ease .4s,
  border-color .5s ease .4s; }

/* the dream — final stop */
.step.dream { padding: 26px 28px 28px; margin-left: -28px; border-radius: 20px;
  background:
    radial-gradient(120% 160% at 0% 100%, var(--caramel-dim), transparent 60%),
    radial-gradient(120% 160% at 100% 0%, var(--sage-dim), transparent 60%),
    #fff;
  border: 1px solid rgba(201,150,68,.3);
  box-shadow: 0 24px 60px rgba(31,35,28,.10); }
@media (max-width: 640px) { .step.dream { margin-left: 0; padding: 22px 20px; } }
.step.dream::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: 20px; overflow: hidden;
  background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.65) 50%, transparent 70%);
  background-size: 260% 100%; animation: dreamsweep 4.5s ease-in-out infinite; }
@keyframes dreamsweep { 0% { background-position: 130% 0; } 60%,100% { background-position: -130% 0; } }
.step.dream .step-n { left: -18px; color: #fff; background: var(--caramel);
  border-color: var(--caramel); animation: sparkspin 8s linear infinite; }
@media (max-width: 640px) { .step.dream .step-n { display: none; } }
.step.dream .step-when { color: var(--sage-deep); }
.step.dream h3 { font-style: italic; font-size: clamp(24px, 3vw, 36px);
  line-height: 1.25; color: var(--ink); max-width: 24ch; margin-bottom: 0; }

/* ---------- CTA ---------- */
.cta-panel { position: relative; z-index: 1; max-width: 1240px;
  margin: clamp(100px, 14vh, 170px) auto 0; padding: 0 clamp(20px, 4vw, 48px); }
.cta-inner { position: relative; overflow: hidden; text-align: center;
  border: 1px solid var(--rule); border-radius: 24px;
  padding: clamp(56px, 8vw, 96px) clamp(24px, 5vw, 64px);
  background:
    radial-gradient(60% 120% at 50% 0%, var(--caramel-dim), transparent 70%),
    radial-gradient(50% 100% at 15% 100%, var(--sage-dim), transparent 70%),
    var(--bg-warm); }
.cta-inner::before { content: '✦'; position: absolute; top: 26px; left: 30px;
  color: var(--caramel); font-size: 13px; animation: sparkspin 6s linear infinite; }
.cta-inner::after { content: '✦'; position: absolute; bottom: 26px; right: 30px;
  color: var(--sage-deep); font-size: 13px; animation: sparkspin 6s linear infinite reverse; }
.cta-inner .cta-row { justify-content: center; }
.cta-inner h2 { margin-bottom: 18px; }
.cta-inner p { color: var(--muted); max-width: 46ch; margin: 0 auto 8px; }
.cta-mail { margin-top: 26px; font-size: 13px; color: var(--dim); }
.cta-mail a { color: var(--caramel-deep); border-bottom: 1px solid rgba(201,150,68,.4); }
.cta-mail a:hover { color: var(--caramel); }

/* ---------- footer ---------- */
.footer { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(80px, 10vh, 120px) clamp(20px, 4vw, 48px) 48px; }
.foot-grid { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 40px;
  padding-bottom: 40px; border-bottom: 1px solid var(--rule-soft); }
@media (max-width: 760px) { .foot-grid { grid-template-columns: 1fr; } }
.foot-brand p { margin-top: 16px; font-size: 13px; color: var(--dim); max-width: 44ch; }
.foot-brand a { color: var(--muted); }
.foot-brand a:hover { color: var(--ink); }
.foot-col { display: flex; flex-direction: column; gap: 10px; }
.foot-h { font-family: var(--mono); font-size: 11px; letter-spacing: .18em;
  text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
.foot-col a { font-size: 14px; color: var(--muted); transition: color .2s; width: fit-content;
  position: relative; }
.foot-col a::after { content: ''; position: absolute; left: 0; bottom: -2px; width: 100%;
  height: 1px; background: var(--caramel); transform: scaleX(0); transform-origin: right;
  transition: transform .3s cubic-bezier(.19,1,.22,1); }
.foot-col a:hover { color: var(--ink); }
.foot-col a:hover::after { transform: scaleX(1); transform-origin: left; }
.foot-legal { margin-top: 32px; font-family: var(--mono); font-size: 11px;
  letter-spacing: .12em; color: var(--dim); }

/* ---------- reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  .mkt *, .mkt *::before, .mkt *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
  .rise, .rv, .hero h1 .w { opacity: 1; transform: none; }
  .spark { display: none; }
}
`;
