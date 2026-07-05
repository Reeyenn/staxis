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

/* One page — the app's real pages, orbiting */
const ORBIT_PAGES = [
  { label: 'Dashboard', x: 10, y: 16 },
  { label: 'Financials', x: 48, y: 4 },
  { label: 'Housekeeping', x: 82, y: 14 },
  { label: 'Maintenance', x: 5, y: 58 },
  { label: 'Inventory', x: 87, y: 56 },
  { label: 'Staff', x: 18, y: 90 },
  { label: 'Communications', x: 72, y: 90 },
];

/* ------------------------------------------------------------------ */

export default function MarketingLanding() {
  const [feed, setFeed] = useState<Array<FeedItem & { id: number }>>(
    () => FEED_SCRIPT.slice(0, 4).map((f, i) => ({ ...f, id: i })).reverse()
  );
  const feedIdx = useRef(4);
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

  /* animated counters */
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll<HTMLElement>('[data-count]') ?? [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          io.unobserve(el);
          const target = Number(el.dataset.count || '0');
          const suffix = el.dataset.suffix || '';
          const dur = 1400;
          let start: number | null = null;
          const tick = (ts: number) => {
            if (start === null) start = ts;
            const p = Math.min(1, (ts - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = `${Math.round(target * eased)}${suffix}`;
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.6 }
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

      {/* ---------------- the old way ---------------- */}
      <section className="section" id="story">
        <div className="kicker rv">HOW IT&rsquo;S ALWAYS BEEN</div>
        <h2 className="rv">You go <em>find</em> the work.</h2>
        <p className="section-lede rv">Take one thing. Towels.</p>

        <div className="oldway rv">
          {OLD_STEPS.map((s, i) => (
            <span key={s.text} className="chore-wrap" style={{ transitionDelay: `${i * 130}ms` }}>
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
        <p className="oldway-caption rv" style={{ transitionDelay: '1.3s' }}>
          Nine steps to stay stocked on <em>towels</em>. Now every supply, every
          room, every shift, every work order. That&rsquo;s the job.
        </p>
      </section>

      {/* ---------------- the staxis way ---------------- */}
      <section className="section stx-way">
        <div className="kicker rv">HOW IT SHOULD BE</div>
        <h2 className="rv">The work comes <em>to you.</em></h2>

        <div className="notif-stage rv" ref={notifRef}>
          <div className="notif-halo" aria-hidden="true" />
          <div className={`notif ${notifStage}`}>
            <div className="notif-head">
              <span className="notif-logo"><ChevronMark size={16} color="#fff" /></span>
              <span className="notif-app">Staxis</span>
              <span className="notif-time">6:07 AM</span>
            </div>
            <p className="notif-body">
              Towels are running low. I counted, checked the budget, and drafted
              the reorder.
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
        <p className="stxway-caption rv">
          One tap. Staxis did the walking, the counting, and the math. It only
          brings you the decision.
        </p>
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

      {/* ---------------- go deeper ---------------- */}
      <section className="section">
        <div className="kicker rv">WHEN YOU WANT TO LOOK</div>
        <h2 className="rv">Every corner of the hotel,<br /><em>in depth.</em></h2>

        <div className="cards">
          {[
            {
              icon: '🧺',
              title: 'Housekeeping, scheduled for you',
              body: 'Staxis texts each housekeeper the night before, builds the morning board from who said yes, and re-sorts it live as guests check out.',
            },
            {
              icon: '🔧',
              title: 'Maintenance that keeps up',
              body: 'Broken AC, leaky faucet, burnt-out bulb. Logged in seconds, assigned automatically, and tracked until the room is back in service.',
            },
            {
              icon: '📦',
              title: 'Inventory that reorders itself',
              body: 'Staxis learns how fast your hotel goes through towels, soap, and coffee, and drafts the reorder before you run out.',
            },
            {
              icon: '👁️',
              title: 'Watches your property system',
              body: 'An AI robot reads arrivals, departures, and room status from the software you already use. Day and night, without being asked.',
            },
            {
              icon: '🎙️',
              title: 'A copilot you can talk to',
              body: 'Ask “who’s cleaning 204?” or “what came in overnight?” out loud and get an answer. No menus, no training.',
            },
            {
              icon: '🌎',
              title: 'Bilingual by default',
              body: 'Every screen and every text message works in English and Spanish, so your whole team is on the same page.',
            },
          ].map((c, i) => (
            <div
              className="card rv"
              key={c.title}
              style={{ transitionDelay: `${i * 60}ms` }}
              onMouseMove={onCardMove}
              onMouseLeave={onCardLeave}
            >
              <div className="card-icon">{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- how it works ---------------- */}
      <section className="section" id="how">
        <div className="kicker rv">HOW IT WORKS</div>
        <h2 className="rv">
          No integrations. No IT project.<br />
          <em>It just watches, like your best manager.</em>
        </h2>

        <div className="steps" ref={stepsRef}>
          <div className="beam"><div className="beam-fill" ref={beamRef} /></div>
          {[
            {
              n: '01',
              title: 'Connect in an afternoon',
              body: 'Staxis signs into the hotel software you already run, the same way a person would. Nothing to install, nothing to migrate, no vendor calls.',
            },
            {
              n: '02',
              title: 'It watches, around the clock',
              body: 'Day and night it reads arrivals, departures, room status, housekeeping, and work orders, and keeps a live picture of your whole property.',
            },
            {
              n: '03',
              title: 'Your hotel starts running itself',
              body: 'Schedules go out by text. Work orders get assigned. Supplies get reordered. You open one page and see everything already handled.',
            },
          ].map((s) => (
            <div className="step rv" key={s.n}>
              <div className="step-n">{s.n}</div>
              <div className="step-body">
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- stats ---------------- */}
      <section className="stats rv">
        <div className="stat">
          <div className="stat-n"><span data-count="24" data-suffix="/7">0/7</span></div>
          <div className="stat-l">always watching. Nights, weekends, holidays</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="2">0</span></div>
          <div className="stat-l">languages, every screen and every text</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="1">0</span></div>
          <div className="stat-l">page that brings the work to you</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="0">0</span></div>
          <div className="stat-l">new systems for your team to learn</div>
        </div>
      </section>

      {/* ---------------- statement ---------------- */}
      <section className="statement">
        <p className="rv">
          Built for the hotels the big platforms forgot. <em>Limited and
          select-service properties run by lean teams</em>, where the owner still
          answers the front desk phone.
        </p>
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

/* ---------- the old way ---------- */
.oldway { margin-top: 54px; display: flex; flex-wrap: wrap; align-items: center;
  gap: 12px 6px; max-width: 900px; }
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
.oldway-caption { margin-top: 34px; max-width: 54ch; color: var(--muted);
  font-size: clamp(15px, 1.3vw, 17px); }
.oldway-caption em { font-style: italic; color: var(--warm); }

/* ---------- the staxis way ---------- */
.stx-way h2 em { color: var(--sage-deep); }
.notif-stage { position: relative; margin-top: 60px; display: flex; justify-content: center; }
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
.stxway-caption { margin-top: 40px; text-align: center; color: var(--muted);
  font-size: clamp(15px, 1.3vw, 17px); max-width: 54ch;
  margin-left: auto; margin-right: auto; }

/* ---------- one page (orbit) ---------- */
.orbit { position: relative; margin: 70px auto 0; max-width: 920px; height: 540px; }
.orbit-lines { position: absolute; inset: 0; width: 100%; height: 100%; }
.orbit-lines line { stroke: rgba(92,122,96,.3); stroke-width: .35;
  stroke-dasharray: 2 2.4; animation: march 2.4s linear infinite; }
@keyframes march { to { stroke-dashoffset: -8.8; } }
.orbit-chip { position: absolute; transform: translate(-50%, -50%);
  font-family: var(--mono); font-size: 11.5px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-soft); white-space: nowrap;
  background: #fff; border: 1px solid var(--rule); border-radius: 999px;
  padding: 9px 16px; box-shadow: 0 6px 18px rgba(31,35,28,.08);
  animation: chipfloat 6s ease-in-out infinite; }
@keyframes chipfloat {
  0%,100% { margin-top: 0; }
  50% { margin-top: -9px; }
}
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
  .orbit-chip { position: static; transform: none; }
  .today { position: static; transform: none; width: 100%; max-width: 420px;
    flex: none; order: -1; margin-bottom: 12px; }
}

/* ---------- cards ---------- */
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 56px;
  perspective: 1400px; }
@media (max-width: 980px) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .cards { grid-template-columns: 1fr; } }
.card { position: relative; border: 1px solid var(--rule); border-radius: 16px;
  padding: 28px 26px; background: #fff; overflow: hidden;
  transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
  transition: border-color .3s ease, transform .25s ease, box-shadow .3s ease,
    opacity .9s cubic-bezier(.19,1,.22,1); }
.card.rv:not(.in) { transform: translateY(28px); }
.card::before { content: ''; position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(340px circle at var(--mx, 50%) var(--my, 50%),
    var(--caramel-dim), transparent 65%);
  transition: opacity .35s ease; pointer-events: none; }
.card:hover { border-color: var(--sage); box-shadow: 0 18px 44px rgba(31,35,28,.10); }
.card:hover::before { opacity: 1; }
.card-icon { font-size: 26px; margin-bottom: 18px; display: inline-block; }
.card:hover .card-icon { animation: wiggle .6s ease; }
@keyframes wiggle {
  0%,100% { transform: rotate(0deg) scale(1); }
  25% { transform: rotate(-10deg) scale(1.15); }
  60% { transform: rotate(8deg) scale(1.1); }
}
.card h3 { font-size: 16.5px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 10px; }
.card p { font-size: 14px; color: var(--muted); }

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
.step h3 { font-family: var(--serif); font-weight: 400; font-size: clamp(23px, 2.6vw, 30px);
  letter-spacing: -.005em; margin-bottom: 10px; }
.step p { color: var(--muted); font-size: 15px; max-width: 56ch; }

/* ---------- stats ---------- */
.stats { position: relative; z-index: 1; max-width: 1240px;
  margin: clamp(90px, 12vh, 150px) auto 0; padding: 0 clamp(20px, 4vw, 48px);
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
@media (max-width: 900px) { .stats { grid-template-columns: repeat(2, 1fr); } }
.stat { position: relative; padding-top: 22px; }
.stat::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: var(--rule); }
.stat::after { content: ''; position: absolute; top: 0; left: 0; width: 0; height: 2px;
  background: linear-gradient(90deg, var(--sage-deep), var(--caramel));
  transition: width 1.2s cubic-bezier(.19,1,.22,1) .3s; }
.stats.in .stat::after { width: 100%; }
.stat-n { font-family: var(--serif); font-style: italic; font-weight: 400;
  font-size: clamp(48px, 5.5vw, 76px); line-height: 1; }
.stat-n span { background: linear-gradient(120deg, var(--sage-deep), var(--caramel-deep));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.stat-l { margin-top: 12px; font-size: 13px; color: var(--muted); max-width: 24ch; }

/* ---------- statement ---------- */
.statement { position: relative; z-index: 1; max-width: 980px; margin: 0 auto;
  padding: clamp(110px, 15vh, 180px) clamp(20px, 4vw, 48px) 0; text-align: center; }
.statement p { font-family: var(--serif); font-weight: 400;
  font-size: clamp(28px, 3.6vw, 48px); line-height: 1.24; color: var(--ink); }
.statement em { color: var(--caramel-deep); }

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
