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
import { useEffect, useRef, useState, useCallback } from 'react';

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
  { id: 'dashboard', label: 'Dashboard', x: 10, y: 16, dir: 'up-left', tabs: ['Overview'] },
  { id: 'financials', label: 'Financials', x: 48, y: 4, dir: 'up', tabs: ['Checkbook', 'Budget', 'CapEx'] },
  { id: 'housekeeping', label: 'Housekeeping', x: 82, y: 14, dir: 'up-right', tabs: ['Rooms', 'Schedule', 'Quality', 'Deep Clean'] },
  { id: 'maintenance', label: 'Maintenance', x: 8, y: 58, dir: 'left', tabs: ['Work Orders', 'Preventive', 'Equipment'] },
  { id: 'inventory', label: 'Inventory', x: 86, y: 56, dir: 'right', tabs: ['Inventory'] },
  { id: 'staff', label: 'Staff', x: 18, y: 90, dir: 'down-left', tabs: ['Schedule', 'Directory', 'Recognition'] },
  { id: 'communications', label: 'Communications', x: 72, y: 90, dir: 'down-right', tabs: ['Messages', 'Log Book', 'Calendar'] },
] as const;

const ROOM_STATUSES = ['ok', 'dirty', 'ok', 'occ', 'ok', 'dirty', 'insp', 'ok', 'occ', 'ok', 'dirty', 'ok', 'ok', 'insp', 'occ', 'ok', 'dirty', 'ok'];

/* Mini live page inside each orbit popup, per page + sub-tab. */
function ChipDemo({ id, sub }: { id: string; sub: number }) {
  if (id === 'dashboard') {
    return (
      <div className="ap">
        <div className="ap-statrow">
          <div className="ap-card ap-stat"><div className="ap-ring" /><div><b>84%</b><span>occupied tonight</span></div></div>
          <div className="ap-card ap-stat"><b>42<i>in</i>38<i>out</i></b><span>arrivals &amp; departures</span></div>
        </div>
        <div className="ap-h">ROOMS RIGHT NOW</div>
        <div className="ap-roomgrid">
          {ROOM_STATUSES.map((s, i) => (<span className={`ap-room r-${s}`} key={i}>{101 + i}</span>))}
        </div>
        <div className="ap-legend"><i className="r-ok" />Clean<i className="r-dirty" />Needs cleaning<i className="r-insp" />Inspect<i className="r-occ" />Occupied</div>
        <div className="ap-h">ATTENTION</div>
        <div className="ap-card ap-need"><span className="ti-dot warn" />Towels below par<span className="ap-btn">Open</span></div>
        <div className="ap-card ap-need"><span className="ti-dot info" />2 late checkouts today<span className="ap-btn">View</span></div>
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
        <div className="ap-h">CHECKBOOK</div>
        {[['Jul 3', 'Linen supplier', '-$214', ''], ['Jul 2', 'Payroll run', '-$4,180', ''], ['Jul 1', 'OTA payout', '+$6,940', 'good'], ['Jun 30', 'Coffee vendor', '-$86', '']].map(([d, payee, amt, c]) => (
          <div className="ap-feedrow" key={payee as string}>
            <span>{d}</span>{payee}
            <b className={`ap-amt ${c ? 't-good' : ''}`}>{amt}</b>
          </div>
        ))}
        <div className="ap-card ap-stat"><b>$23.40</b><span>cost per occupied room</span></div>
        <div className="ap-note">Every dollar in and out, logged for you. No spreadsheet.</div>
      </div>
    );
  }
  if (id === 'housekeeping') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="ap-h">TUESDAY BOARD · 31 ROOMS</div>
          {[['MG', 'Maria', 8, 12], ['AR', 'Ana', 6, 10], ['LT', 'Luis', 5, 9]].map(([ini, name, done, total]) => (
            <div className="ap-card ap-cleaner" key={name as string}>
              <span className="ap-avatar">{ini}</span>
              <div className="ap-cl-mid"><b>{name}</b><div className="ap-bar"><i style={{ width: `${(Number(done) / Number(total)) * 100}%` }} /></div></div>
              <span className="ap-cl-count">{done}/{total}</span>
            </div>
          ))}
          <div className="ap-note">Built from who confirmed by text. Re-sorts as guests check out.</div>
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-h">QUALITY · INSPECTIONS</div>
          <div className="ap-done"><span className="de-check">✓</span>204 · passed inspection</div>
          <div className="ap-done"><span className="de-check">✓</span>211 · passed inspection</div>
          <div className="ap-card ap-need"><span className="ti-dot warn" />118 · needs recheck<span className="ap-btn">Assign</span></div>
          <div className="ap-note">Every clean gets checked before the room goes back on sale.</div>
        </div>
      );
    }
    if (sub === 3) {
      return (
        <div className="ap">
          <div className="ap-h">DEEP CLEANS</div>
          {[['204', 'carpet + vents', 'Overdue', 'crit'], ['117', 'full turn', 'Due soon', 'low'], ['305', 'mattress flip', 'Fresh', 'good']].map(([r, w, st, c]) => (
            <div className="ap-card ap-stock" key={r as string}>
              <b style={{ width: 34 }}>{r}</b>
              <div className="ap-wo-mid">{w}</div>
              <span className={`ap-pct t-${c}`} style={{ width: 'auto' }}>{st}</span>
            </div>
          ))}
          <div className="ap-note">Cadence per room. Staxis schedules them into slow days.</div>
        </div>
      );
    }
    return (
      <div className="ap">
        <div className="ap-roomgrid">
          {ROOM_STATUSES.map((s, i) => (<span className={`ap-room r-${s}`} key={i}>{101 + i}</span>))}
        </div>
        <div className="ap-legend"><i className="r-ok" />Clean<i className="r-dirty" />Needs cleaning<i className="r-insp" />Inspect<i className="r-occ" />Occupied</div>
        <div className="ap-note">Statuses flip live as the robot reads your property system.</div>
      </div>
    );
  }
  if (id === 'maintenance') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="ap-h">PREVENTIVE</div>
          <div className="ap-done"><span className="de-check">✓</span>Filter changes · floors 1–2 · done</div>
          <div className="ap-done"><span className="de-check">✓</span>Water heater check · scheduled</div>
          <div className="ap-card ap-need"><span className="ti-dot warn" />PTAC deep service due<span className="ap-btn">Schedule</span></div>
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-h">EQUIPMENT</div>
          {[['Water heater', 'OK', 'good'], ['AC unit · 118', 'Attention', 'crit'], ['Boiler', 'OK', 'good'], ['Elevator', 'Service due', 'low']].map(([n, st, c]) => (
            <div className="ap-card ap-stock" key={n as string}>
              <b>{n}</b>
              <span className={`ap-pct t-${c}`} style={{ width: 'auto', marginLeft: 'auto' }}>{st}</span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="ap">
        <div className="ap-h">WORK ORDERS</div>
        {[['118', 'AC not cooling', 'In progress', 'prog', 'Luis'], ['204', 'Shower drip', 'Open', 'open', 'Unassigned'], ['312', 'Hallway bulb out', 'Fixed', 'done', 'Luis']].map(([room, what, status, cls, who]) => (
          <div className="ap-card ap-wo" key={what as string}>
            <b>{room}</b>
            <div className="ap-wo-mid">{what}<span>{who}</span></div>
            <span className={`ap-pill p-${cls}`}>{status}</span>
          </div>
        ))}
        <div className="ap-note">Logged in seconds, assigned automatically, tracked to done.</div>
      </div>
    );
  }
  if (id === 'inventory') {
    /* the real inventory is one screen: a stock list plus a rail of
       actions (count, scan, reorder, orders, reports, history, AI,
       budgets, settings) */
    return (
      <div className="ap">
        <div className="ap-rail">
          {['Start Count', 'Scan Invoice', 'Reorder List', 'Orders', 'Reports', 'History', 'AI Helper', 'Budgets', 'Ordering Settings'].map((r) => (
            <span className="ap-railbtn" key={r}>{r}</span>
          ))}
        </div>
        <div className="ap-card ap-reorder"><span className="ti-dot warn" />Towel reorder drafted · $214 · under budget ✓<span className="ap-btn">Approve</span></div>
        <div className="ap-h">STOCK</div>
        {[['Towels', 28, 'crit'], ['Soap & amenities', 54, 'low'], ['Coffee', 81, 'good'], ['Sheets', 72, 'good'], ['Cleaning supplies', 43, 'low']].map(([name, pct, cls]) => (
          <div className="ap-card ap-stock" key={name as string}>
            <b>{name}</b>
            <div className="ap-bar big"><i className={`f-${cls}`} style={{ width: `${pct}%` }} /></div>
            <span className={`ap-pct t-${cls}`}>{pct}%</span>
          </div>
        ))}
        <div className="ap-note">Staxis learns how fast each item burns and drafts the reorder first.</div>
      </div>
    );
  }
  if (id === 'staff') {
    if (sub === 1) {
      return (
        <div className="ap">
          <div className="ap-h">DIRECTORY</div>
          {[['MG', 'Maria', 'Housekeeping', 'ES'], ['AR', 'Ana', 'Housekeeping', 'ES'], ['LT', 'Luis', 'Maintenance', 'EN'], ['JD', 'Jade', 'Front desk', 'EN']].map(([ini, name, role, lang]) => (
            <div className="ap-card ap-person" key={name as string}>
              <span className="ap-avatar">{ini}</span>
              <div className="ap-cl-mid"><b>{name}</b><span className="ap-role">{role}</span></div>
              <span className="ap-lang">{lang}</span>
            </div>
          ))}
        </div>
      );
    }
    if (sub === 2) {
      return (
        <div className="ap">
          <div className="ap-h">RECOGNITION</div>
          <div className="ap-card ap-need"><span className="ti-dot ok" />Maria · 12 perfect inspections in a row ⭐</div>
          <div className="ap-card ap-need"><span className="ti-dot ok" />Luis · fastest work-order month yet 🔧</div>
          <div className="ap-done"><span className="de-check">✓</span>Kudos go out by text, in their language</div>
        </div>
      );
    }
    return (
      <div className="ap">
        <div className="ap-h">SCHEDULE · TOMORROW&rsquo;S CREW</div>
        {[['MG', 'Maria', 'Confirmed ✓', 'ES'], ['AR', 'Ana', 'Confirmed ✓', 'ES'], ['LT', 'Luis', 'Confirmed ✓', 'EN'], ['JD', 'Jade', 'Waiting…', 'EN']].map(([ini, name, st, lang]) => (
          <div className="ap-card ap-person" key={name as string}>
            <span className="ap-avatar">{ini}</span>
            <div className="ap-cl-mid"><b>{name}</b></div>
            <span className={`ap-conf ${String(st).startsWith('Confirmed') ? 'yes' : ''}`}>{st}</span>
            <span className="ap-lang">{lang}</span>
          </div>
        ))}
        <div className="ap-note">One text per day, in each person&rsquo;s language. Replies build the schedule.</div>
      </div>
    );
  }
  /* communications */
  if (sub === 1) {
    return (
      <div className="ap">
        <div className="ap-h">LOG BOOK · WRITES ITSELF</div>
        {[['7:12 AM', 'Late checkout on 312 approved'], ['7:04 AM', 'Towel reorder drafted'], ['6:41 AM', 'AC ticket assigned to Luis'], ['6:03 AM', 'Board built, 31 rooms']].map(([t, txt]) => (
          <div className="ap-feedrow" key={txt as string}><span>{t}</span>{txt}</div>
        ))}
      </div>
    );
  }
  if (sub === 2) {
    return (
      <div className="ap">
        <div className="ap-h">CALENDAR</div>
        {[['Wed', 'Deep clean · 204'], ['Thu', 'Linen delivery expected'], ['Fri', 'Fire panel inspection'], ['Sat', 'Sold out night · 100%']].map(([d, ev]) => (
          <div className="ap-feedrow" key={ev as string}><span>{d}</span>{ev}</div>
        ))}
      </div>
    );
  }
  return (
    <div className="ap">
      <div className="ap-h">CHANNELS</div>
      <div className="ap-done"><span className="de-check">✓</span># announcements · new schedule posted</div>
      <div className="ap-done"><span className="de-check">✓</span># housekeeping · 3 new</div>
      <div className="ap-h">MESSAGES</div>
      <div className="ap-msg them">Room 204 lista ✓</div>
      <div className="ap-msg me">Gracias Maria! 118 next please</div>
      <div className="ap-msg them">Ok voy 👍</div>
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
  const beamRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
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

  /* scroll: beam fill, top progress bar, nav state */
  useEffect(() => {
    const nav = rootRef.current?.querySelector('.nav');
    const onScroll = () => {
      const steps = stepsRef.current;
      const beam = beamRef.current;
      if (steps && beam) {
        const r = steps.getBoundingClientRect();
        const vh = window.innerHeight;
        const p = Math.min(1, Math.max(0, (vh * 0.75 - r.top) / r.height));
        beam.style.transform = `scaleY(${p})`;
      }
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

  /* cursor glow + 3d tilt on feature cards */
  const onCardMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    el.style.setProperty('--mx', `${x}px`);
    el.style.setProperty('--my', `${y}px`);
    el.style.setProperty('--ry', `${((x / r.width) - 0.5) * 6}deg`);
    el.style.setProperty('--rx', `${(0.5 - (y / r.height)) * 6}deg`);
  }, []);
  const onCardLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
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
          <a href="#how">How it works</a>
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
            <span className="line"><span className="w" style={{ animationDelay: '.10s' }}>The&nbsp;hotel</span></span>
            <span className="line"><span className="w" style={{ animationDelay: '.22s' }}>that&nbsp;<em className="shimmer">runs&nbsp;itself.</em></span></span>
          </h1>
          <p className="lede rise" style={{ animationDelay: '.42s' }}>
            Staxis is an AI that runs your hotel&rsquo;s operations. It watches your
            property systems around the clock, handles the busywork, and comes to
            you only when something needs a person.
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
      <section className="section" id="onepage">
        <div className="kicker rv">ONE PAGE</div>
        <h2 className="rv">One page <em>runs the hotel.</em></h2>
        <p className="section-lede rv">
          Everything that needs you lands in one place. Every other page is still
          one tap away when you want to look deeper.
        </p>

        <div className="orbit rv" aria-hidden="true">
          <svg className="orbit-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
            {ORBIT_PAGES.map((p) => (
              <line key={p.label} x1="50" y1="50" x2={p.x} y2={p.y} />
            ))}
          </svg>
          {ORBIT_PAGES.map((p, i) => (
            <span
              key={p.label}
              className="orbit-chip"
              style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${i * 0.7}s` }}
            >
              {p.label}
              <span className={`chip-pop pop-${p.dir}`}>
                <span className="cp-head">
                  <span className="cp-brand"><ChevronMark size={13} color="#fff" /></span>
                  <b>{p.label}</b>
                  <i>LIVE DEMO · SCROLLS</i>
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
          <div className="today">
            <div className="today-head">
              <ChevronMark size={18} />
              <span>Today</span>
              <span className="today-count">NEEDS YOU · 3</span>
            </div>
            <div className="today-item"><span className="ti-dot warn" />Approve the towel reorder</div>
            <div className="today-item"><span className="ti-dot info" />Confirm tomorrow&rsquo;s cleaning crew</div>
            <div className="today-item"><span className="ti-dot warn" />One work order needs a decision</div>
            <div className="today-rest"><span className="ti-dot ok" />Everything else: already handled</div>
          </div>
        </div>
      </section>

      {/* ---------------- every benefit ---------------- */}
      <section className="section" id="benefits">
        <div className="kicker rv">EVERYTHING IT HANDLES</div>
        <h2 className="rv">Every corner of the hotel, <em>handled.</em></h2>

        <div className="bens">
          {[
            'Housekeeping boards built every morning',
            'Staff texted in English or Spanish',
            'Live room status, all day',
            'Work orders assigned and tracked to done',
            'Inventory counted for you',
            'Reorders drafted before you run out',
            'Budgets checked on every order',
            'Labor costs tracked daily',
            'A log book that writes itself',
            'Guest complaints followed to the end',
            'Financials without the spreadsheet',
            'A voice copilot you can talk to',
            'Daily schedules confirmed by text',
            'Your property system watched day and night',
            'One page for everything that needs you',
          ].map((b, i) => (
            <div
              className="ben rv"
              key={b}
              style={{ transitionDelay: `${i * 50}ms` }}
              onMouseMove={onCardMove}
              onMouseLeave={onCardLeave}
            >
              <span className="ben-check">✓</span>
              {b}
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- the journey ---------------- */}
      <section className="section" id="how">
        <div className="kicker rv">THE JOURNEY</div>
        <h2 className="rv">Day one to <em>the dream.</em></h2>

        <div className="steps" ref={stepsRef}>
          <div className="beam"><div className="beam-fill" ref={beamRef} /></div>
          {[
            {
              n: '01',
              when: 'Day one',
              title: 'Connect',
              body: 'Staxis signs into the hotel software you already run, the same way a person would. Nothing to install, no vendor calls, no IT project.',
              dream: false,
            },
            {
              n: '02',
              when: 'Week one',
              title: 'It learns your hotel',
              body: 'It watches around the clock: rooms, arrivals, supplies, work orders. The busywork starts disappearing.',
              dream: false,
            },
            {
              n: '03',
              when: 'Month one',
              title: 'You stop chasing',
              body: 'Boards build themselves. Texts go out. Reorders draft themselves. Your day becomes a handful of taps.',
              dream: false,
            },
            {
              n: '✦',
              when: 'Every morning after',
              title: 'Coffee in hand, you open one page. The hotel already ran itself overnight.',
              body: '',
              dream: true,
            },
          ].map((s) => (
            <div className={`step rv ${s.dream ? 'dream' : ''}`} key={s.n}>
              <div className="step-n">{s.n}</div>
              <div className="step-body">
                <div className="step-when">{s.when}</div>
                <h3>{s.title}</h3>
                {s.body && <p>{s.body}</p>}
              </div>
            </div>
          ))}
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
            <a href="#how">How it works</a>
            <a href="/signin">Sign in</a>
          </div>
          <div className="foot-col">
            <div className="foot-h">Legal &amp; SMS</div>
            <a href="/consent">SMS Consent</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
          </div>
        </div>
        <div className="foot-sms">
          Staxis sends operational scheduling SMS to hotel employees on behalf of the
          property that employs them, never marketing. Consent is collected verbally
          at hire using a published script. One message per day per employee, and
          employees can reply STOP at any time to opt out. Full details at{' '}
          <a href="/consent">/consent</a>.
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
.orbit { position: relative; margin: 70px auto 0; max-width: 920px; height: 540px; }
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
.cp-tabs { display: flex; flex-wrap: wrap; gap: 5px; padding: 9px 12px;
  border-bottom: 1px solid var(--rule-soft); background: #fff; flex: none;
  position: relative; }
.cp-tab { font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--dim); background: #FAFAF7;
  border: 1px solid var(--rule-soft); border-radius: 999px; padding: 6px 11px;
  cursor: pointer; transition: all .2s ease; }
.cp-tab:hover { color: var(--ink); }
.cp-tab.on { color: var(--ink); background: var(--sage-dim);
  border-color: rgba(92,122,96,.4); }
.cp-body { display: block; height: 300px; overflow-y: auto; padding: 14px;
  background: #F7F8F5; position: relative; border-radius: 0 0 16px 16px;
  animation: pagein .4s cubic-bezier(.19,1,.22,1); }
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

.pop-left { right: calc(100% - 30px); top: 50%;
  transform: translateY(-50%) scale(.5); transform-origin: right center; }
.orbit-chip:hover .pop-left { transform: translateY(-50%) scale(1); }
.pop-right { left: calc(100% - 30px); top: 50%;
  transform: translateY(-50%) scale(.5); transform-origin: left center; }
.orbit-chip:hover .pop-right { transform: translateY(-50%) scale(1); }

@media (max-width: 1500px) {
  .pop-left { right: calc(50% - 40px); left: auto; top: calc(100% + 10px);
    bottom: auto; transform: scale(.5); transform-origin: calc(100% - 40px) top; }
  .orbit-chip:hover .pop-left { transform: scale(1); }
  .pop-right { left: calc(50% - 40px); right: auto; top: calc(100% + 10px);
    transform: scale(.5); transform-origin: 40px top; }
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
.foot-sms { margin-top: 32px; font-size: 12px; color: var(--dim); max-width: 88ch; line-height: 1.7; }
.foot-sms a { color: var(--muted); text-decoration: underline; }
.foot-legal { margin-top: 24px; font-family: var(--mono); font-size: 11px;
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
