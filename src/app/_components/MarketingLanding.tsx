'use client';

/**
 * Marketing landing page for getstaxis.com.
 *
 * Self-contained: all styles live in the <style> block below, no shared app
 * CSS beyond the font variables set in the root layout (Fraunces / Geist /
 * Geist Mono). The SMS-compliance content the Twilio review needs (program
 * description, opt-in, contact, address) is preserved in the footer and via
 * the /consent, /privacy, /terms links — do not remove it.
 */

import Link from 'next/link';
import { useEffect, useRef, useState, useCallback } from 'react';

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
  { time: '6:02 AM', icon: '✓', text: 'Maria confirmed for today — “¡Sí!”', tone: 'ok' },
  { time: '6:03 AM', icon: '⚡', text: 'Housekeeping board built — 31 rooms assigned', tone: 'ok' },
  { time: '6:07 AM', icon: '▲', text: 'Towels at 28% of par — reorder drafted', tone: 'warn' },
  { time: '6:11 AM', icon: '⚡', text: 'Room 118 AC ticket → assigned to maintenance', tone: 'info' },
  { time: '6:14 AM', icon: '✓', text: 'Room 204 flipped dirty → clean, inspection queued', tone: 'ok' },
  { time: '6:18 AM', icon: '◉', text: 'Occupancy tonight projected 84% — staffing holds', tone: 'info' },
  { time: '6:22 AM', icon: '✓', text: 'Late checkout on 312 — cleaner resequenced', tone: 'ok' },
  { time: '6:25 AM', icon: '▲', text: 'Breakfast bar coffee running low — flagged', tone: 'warn' },
  { time: '6:29 AM', icon: '✓', text: 'All 5 property feeds healthy — next read in 30s', tone: 'ok' },
];

const ROOM_COUNT = 28;

/* ------------------------------------------------------------------ */

export default function MarketingLanding() {
  const [feed, setFeed] = useState<FeedItem[]>(FEED_SCRIPT.slice(0, 4));
  const feedIdx = useRef(4);
  const rootRef = useRef<HTMLDivElement>(null);
  const beamRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);

  /* ticking ops feed */
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = setInterval(() => {
      setFeed((prev) => {
        const next = FEED_SCRIPT[feedIdx.current % FEED_SCRIPT.length];
        feedIdx.current += 1;
        return [next, ...prev].slice(0, 5);
      });
    }, 2600);
    return () => clearInterval(id);
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

  /* scroll-driven beam in "how it works" */
  useEffect(() => {
    const onScroll = () => {
      const steps = stepsRef.current;
      const beam = beamRef.current;
      if (!steps || !beam) return;
      const r = steps.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh * 0.75 - r.top) / r.height));
      beam.style.transform = `scaleY(${p})`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* cursor glow on feature cards */
  const onCardMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, []);

  /* nav backdrop on scroll */
  useEffect(() => {
    const nav = rootRef.current?.querySelector('.nav');
    const onScroll = () => {
      if (!nav) return;
      if (window.scrollY > 24) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="mkt" ref={rootRef}>
      <style>{CSS}</style>

      {/* atmosphere */}
      <div className="sky" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
        <div className="stars" />
        <div className="gridlines" />
      </div>
      <div className="grain" aria-hidden="true" />

      {/* ---------------- nav ---------------- */}
      <nav className="nav">
        <Link className="brand" href="/">
          <span className="brand-mark">S</span>
          <span className="brand-name">Staxis</span>
        </Link>
        <div className="nav-links">
          <a href="#platform">Platform</a>
          <a href="#how">How it works</a>
          <a href="#contact">Contact</a>
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
            Staxis is an AI that watches your hotel around the clock — reading your
            property systems every 30 seconds and turning what it sees into cleaning
            schedules, work orders, and supply reorders. No new software to learn.
            No IT project.
          </p>
          <div className="cta-row rise" style={{ animationDelay: '.55s' }}>
            <a className="btn btn-solid btn-lg" href="#contact">Request a demo</a>
            <a className="btn btn-ghost btn-lg" href="#how">See how it works<span className="arrow">→</span></a>
          </div>
          <div className="hero-meta rise" style={{ animationDelay: '.68s' }}>
            Built for limited-service hotels · 50–150 rooms · English + Español
          </div>
        </div>

        {/* live ops console */}
        <div className="console rise" style={{ animationDelay: '.35s' }} aria-hidden="true">
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
                <div key={`${f.time}-${f.text}`} className={`feed-item tone-${f.tone} ${i === 0 ? 'fresh' : ''}`}>
                  <span className="feed-time">{f.time}</span>
                  <span className="feed-icon">{f.icon}</span>
                  <span className="feed-text">{f.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="console-foot">
            <span>5 FEEDS HEALTHY</span>
            <span className="foot-sep">·</span>
            <span>NEXT READ 00:30</span>
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

      {/* ---------------- platform ---------------- */}
      <section className="section" id="platform">
        <div className="kicker rv">ONE PLATFORM</div>
        <h2 className="rv">
          Everything your front desk juggles,<br />
          <em>handled in one place.</em>
        </h2>
        <p className="section-lede rv">
          The whiteboard, the group texts, the clipboards, the sticky notes on the
          back-office monitor — Staxis replaces all of it with one system your whole
          team can use from any phone.
        </p>

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
              body: 'Broken AC, leaky faucet, burnt-out bulb — logged in seconds, assigned automatically, and tracked until the room is back in service.',
            },
            {
              icon: '📦',
              title: 'Inventory that reorders itself',
              body: 'Staxis learns how fast your hotel burns through towels, soap, and coffee — and drafts the reorder before you run out.',
            },
            {
              icon: '👁️',
              title: 'Watches your PMS 24/7',
              body: 'An AI robot reads arrivals, departures, and room status from the property system you already use — every 30 seconds, day and night.',
            },
            {
              icon: '🎙️',
              title: 'A copilot you can talk to',
              body: 'Ask “who’s cleaning 204?” or “what came in overnight?” out loud and get an answer — no menus, no training.',
            },
            {
              icon: '🌎',
              title: 'Bilingual by default',
              body: 'Every screen and every text message works in English and Spanish, so your whole team is on the same page.',
            },
          ].map((c, i) => (
            <div className="card rv" key={c.title} style={{ transitionDelay: `${i * 60}ms` }} onMouseMove={onCardMove}>
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
          <em>It just watches — like your best manager.</em>
        </h2>

        <div className="steps" ref={stepsRef}>
          <div className="beam"><div className="beam-fill" ref={beamRef} /></div>
          {[
            {
              n: '01',
              title: 'Connect in an afternoon',
              body: 'Staxis signs into the hotel software you already run — the same way a person would. Nothing to install, nothing to migrate, no vendor calls.',
            },
            {
              n: '02',
              title: 'It watches, around the clock',
              body: 'Every 30 seconds it reads arrivals, departures, room status, housekeeping, and work orders — and keeps a live picture of your whole property.',
            },
            {
              n: '03',
              title: 'Your hotel starts running itself',
              body: 'Schedules go out by text. Work orders get assigned. Supplies get reordered. You open one dashboard and see everything already handled.',
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
          <div className="stat-n"><span data-count="30" data-suffix="s">0s</span></div>
          <div className="stat-l">between reads of your property system</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="24" data-suffix="/7">0/7</span></div>
          <div className="stat-l">always watching — nights, weekends, holidays</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="2">0</span></div>
          <div className="stat-l">languages, every screen and every text</div>
        </div>
        <div className="stat">
          <div className="stat-n"><span data-count="1">0</span></div>
          <div className="stat-l">platform instead of five tools and a whiteboard</div>
        </div>
      </section>

      {/* ---------------- statement ---------------- */}
      <section className="statement">
        <p className="rv">
          Built for the hotels the big platforms forgot — <em>limited-service properties
          run by lean teams</em>, where the owner still answers the front desk phone.
        </p>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="cta-panel rv" id="contact">
        <div className="cta-inner">
          <div className="kicker">SEE IT ON YOUR HOTEL</div>
          <h2>Watch Staxis run <em>your</em> property.</h2>
          <p>
            A 20-minute walkthrough with the founder, on your own hotel’s data.
            No contract, no setup fee to look.
          </p>
          <div className="cta-row">
            <a className="btn btn-solid btn-lg" href="mailto:rp@reeyenpatel.com?subject=Staxis%20demo%20request">
              Request a demo
            </a>
            <a className="btn btn-ghost btn-lg" href="/signin">Sign in</a>
          </div>
          <div className="cta-mail">or email <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a> — we reply within two business days</div>
        </div>
      </section>

      {/* ---------------- footer ---------------- */}
      <footer className="footer">
        <div className="foot-grid">
          <div className="foot-brand">
            <div className="brand">
              <span className="brand-mark">S</span>
              <span className="brand-name">Staxis</span>
            </div>
            <p>
              AI operations platform for limited-service hotels. Operated by Reeyen
              Patel (sole proprietor) · 2215 Rio Grande St, Austin, TX 78705, United
              States · <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>
            </p>
          </div>
          <div className="foot-col">
            <div className="foot-h">Product</div>
            <a href="#platform">Platform</a>
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
          property that employs them — never marketing. Consent is collected verbally
          at hire using a published script; one message per day per employee; reply
          STOP at any time to opt out. Full details at <a href="/consent">/consent</a>.
        </div>
        <div className="foot-legal">© 2026 Staxis · Austin, Texas</div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

const CSS = `
.mkt {
  --ink: #07080c;
  --ink-2: #0b0d13;
  --panel: rgba(255,255,255,.028);
  --line: rgba(255,255,255,.09);
  --line-soft: rgba(255,255,255,.055);
  --cream: #f3efe6;
  --muted: #9aa0ac;
  --dim: #6b7078;
  --amber: #f5a524;
  --amber-hi: #ffc555;
  --green: #4ade80;
  --serif: var(--font-fraunces), Georgia, serif;
  --sans: var(--font-geist), -apple-system, sans-serif;
  --mono: var(--font-geist-mono), ui-monospace, monospace;

  position: relative;
  background: var(--ink);
  color: var(--cream);
  font-family: var(--sans);
  line-height: 1.6;
  overflow-x: clip;
  min-height: 100vh;
}
.mkt *, .mkt *::before, .mkt *::after { box-sizing: border-box; }
.mkt a { color: inherit; text-decoration: none; }
.mkt h1, .mkt h2, .mkt h3, .mkt p { margin: 0; }

/* ---------- atmosphere ---------- */
.sky { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
.orb { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .5; }
.orb-a { width: 60vw; height: 60vw; top: -28vw; right: -18vw;
  background: radial-gradient(circle, rgba(245,165,36,.16), transparent 65%);
  animation: drift 26s ease-in-out infinite alternate; }
.orb-b { width: 50vw; height: 50vw; top: 30vh; left: -22vw;
  background: radial-gradient(circle, rgba(70,86,220,.14), transparent 65%);
  animation: drift 32s ease-in-out infinite alternate-reverse; }
.orb-c { width: 40vw; height: 40vw; bottom: -20vw; right: 10vw;
  background: radial-gradient(circle, rgba(245,165,36,.08), transparent 65%);
  animation: drift 38s ease-in-out infinite alternate; }
@keyframes drift {
  from { transform: translate3d(0,0,0) scale(1); }
  to   { transform: translate3d(4vw,3vh,0) scale(1.12); }
}
.stars { position: absolute; inset: 0; opacity: .5;
  background-image:
    radial-gradient(1px 1px at 12% 22%, rgba(255,255,255,.5), transparent),
    radial-gradient(1px 1px at 38% 8%,  rgba(255,255,255,.35), transparent),
    radial-gradient(1.5px 1.5px at 61% 31%, rgba(255,255,255,.4), transparent),
    radial-gradient(1px 1px at 83% 12%, rgba(255,255,255,.45), transparent),
    radial-gradient(1px 1px at 71% 64%, rgba(255,255,255,.25), transparent),
    radial-gradient(1.5px 1.5px at 24% 74%, rgba(255,255,255,.3), transparent),
    radial-gradient(1px 1px at 47% 51%, rgba(255,255,255,.3), transparent),
    radial-gradient(1px 1px at 92% 43%, rgba(255,255,255,.35), transparent);
  animation: twinkle 7s ease-in-out infinite alternate; }
@keyframes twinkle { from { opacity: .28; } to { opacity: .6; } }
.gridlines { position: absolute; inset: 0; opacity: .35;
  background-image:
    linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
  background-size: 72px 72px;
  mask-image: radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%); }
.grain { position: fixed; inset: 0; z-index: 50; pointer-events: none; opacity: .05;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E"); }

/* ---------- nav ---------- */
.nav { position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px clamp(20px, 4vw, 48px);
  transition: background .35s ease, border-color .35s ease, padding .35s ease;
  border-bottom: 1px solid transparent; }
.nav.scrolled { background: rgba(7,8,12,.72); backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px); border-bottom-color: var(--line-soft); padding-top: 12px; padding-bottom: 12px; }
.brand { display: inline-flex; align-items: center; gap: 10px; }
.brand-mark { width: 30px; height: 30px; border-radius: 8px; display: inline-flex;
  align-items: center; justify-content: center; font-weight: 800; font-size: 15px;
  color: #000; background: linear-gradient(135deg, var(--amber-hi), var(--amber));
  box-shadow: 0 0 18px rgba(245,165,36,.35); }
.brand-name { font-weight: 700; letter-spacing: -.02em; font-size: 17px; }
.nav-links { display: flex; align-items: center; gap: clamp(10px, 2vw, 26px); font-size: 14px; }
.nav-links > a:not(.btn) { color: var(--muted); transition: color .2s; }
.nav-links > a:not(.btn):hover { color: var(--cream); }
@media (max-width: 760px) { .nav-links > a:not(.btn) { display: none; } }
@media (max-width: 480px) {
  .nav .brand-name { display: none; }
  .nav .btn { padding: 8px 14px; font-size: 13px; }
}

/* ---------- buttons ---------- */
.btn { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px;
  font-weight: 600; font-size: 14px; padding: 9px 20px; white-space: nowrap;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease; }
.btn-lg { padding: 14px 30px; font-size: 15px; }
.btn-solid { background: linear-gradient(135deg, var(--amber-hi), var(--amber));
  color: #201502; box-shadow: 0 4px 24px rgba(245,165,36,.28); }
.btn-solid:hover { transform: translateY(-2px); box-shadow: 0 8px 34px rgba(245,165,36,.45); }
.btn-ghost { border: 1px solid var(--line); color: var(--cream); background: rgba(255,255,255,.02); }
.btn-ghost:hover { border-color: rgba(255,255,255,.25); background: rgba(255,255,255,.05); transform: translateY(-2px); }
.btn .arrow { transition: transform .18s ease; }
.btn:hover .arrow { transform: translateX(4px); }

/* ---------- hero ---------- */
.hero { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(130px, 18vh, 190px) clamp(20px, 4vw, 48px) 60px;
  display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr);
  gap: clamp(32px, 5vw, 72px); align-items: center; }
@media (max-width: 980px) { .hero { grid-template-columns: 1fr; padding-top: 120px; } }

.pill { display: inline-flex; align-items: center; gap: 9px; font-family: var(--mono);
  font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px; padding: 7px 16px;
  background: rgba(255,255,255,.02); margin-bottom: 28px; }
.pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green);
  box-shadow: 0 0 0 0 rgba(74,222,128,.55); animation: pulse 2.2s infinite; flex: none; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,.55); }
  70% { box-shadow: 0 0 0 9px rgba(74,222,128,0); }
  100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
}

.hero h1 { font-family: var(--serif); font-weight: 380;
  font-size: clamp(46px, 6.6vw, 88px); line-height: 1.04; letter-spacing: -.015em; }
.hero h1 .line { display: block; overflow: hidden; padding-bottom: .08em; margin-bottom: -.08em; }
.hero h1 .w { display: inline-block; transform: translateY(110%);
  animation: wordrise .9s cubic-bezier(.19,1,.22,1) forwards; }
@keyframes wordrise { to { transform: translateY(0); } }
.hero h1 em, .mkt h2 em, .statement em { font-style: italic; }
.shimmer { background: linear-gradient(100deg, var(--amber-hi) 20%, #fff 40%, var(--amber) 60%);
  background-size: 220% 100%; -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: shimmer 5.5s ease-in-out infinite; }
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
.console { border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
  background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015));
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.2),
    0 0 90px rgba(245,165,36,.06);
  transform: perspective(1400px) rotateY(-4deg) rotateX(1.5deg);
  transition: transform .6s cubic-bezier(.19,1,.22,1); }
.console:hover { transform: perspective(1400px) rotateY(0deg) rotateX(0deg); }
@media (max-width: 980px) { .console { transform: none; } }
.console-head { display: flex; align-items: center; gap: 7px; padding: 13px 16px;
  border-bottom: 1px solid var(--line-soft); }
.console-head .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dot.r { background: #ff5f57; } .dot.y { background: #febc2e; } .dot.g { background: #28c840; }
.console-title { margin-left: 10px; font-family: var(--mono); font-size: 10.5px;
  letter-spacing: .16em; color: var(--dim); }
.console-live { margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; color: var(--green); }
.console-body { padding: 16px; display: grid; gap: 14px; }
.room-board { display: grid; grid-template-columns: repeat(14, 1fr); gap: 6px; }
@media (max-width: 480px) { .room-board { grid-template-columns: repeat(10, 1fr); } }
.room { aspect-ratio: 1; border-radius: 4px; background: rgba(255,255,255,.07);
  animation: roomcycle 9s steps(1) infinite; }
@keyframes roomcycle {
  0%   { background: rgba(74,222,128,.5); }
  33%  { background: rgba(245,165,36,.55); }
  55%  { background: rgba(255,255,255,.09); }
  78%  { background: rgba(96,140,255,.5); }
  100% { background: rgba(74,222,128,.5); }
}
.feed { display: flex; flex-direction: column; gap: 7px; min-height: 172px; }
.feed-item { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px;
  padding: 8px 11px; border-radius: 9px; border: 1px solid var(--line-soft);
  background: rgba(255,255,255,.02); color: var(--muted); }
.feed-item.fresh { animation: feedin .5s cubic-bezier(.19,1,.22,1); }
@keyframes feedin { from { opacity: 0; transform: translateY(-9px); } to { opacity: 1; transform: none; } }
.feed-time { font-family: var(--mono); font-size: 10px; color: var(--dim); flex: none; width: 52px; }
.feed-icon { flex: none; }
.tone-ok .feed-icon { color: var(--green); }
.tone-warn .feed-icon { color: var(--amber); }
.tone-info .feed-icon { color: #8fa8ff; }
.feed-text { color: #c9cdd6; }
.console-foot { display: flex; gap: 10px; padding: 11px 16px; border-top: 1px solid var(--line-soft);
  font-family: var(--mono); font-size: 10px; letter-spacing: .14em; color: var(--dim); }
.foot-sep { color: rgba(255,255,255,.15); }

/* ---------- marquee ---------- */
.marquee { position: relative; z-index: 1; overflow: hidden; padding: 22px 0;
  border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft);
  mask-image: linear-gradient(90deg, transparent, black 12%, black 88%, transparent); }
.marquee-track { display: flex; width: max-content; animation: scroll 34s linear infinite; }
.marquee:hover .marquee-track { animation-play-state: paused; }
@keyframes scroll { to { transform: translateX(-50%); } }
.marquee-set { display: flex; align-items: center; gap: 34px; padding-right: 34px; }
.marquee-set span { font-family: var(--mono); font-size: 12px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--dim); white-space: nowrap; }
.marquee-set i { color: var(--amber); font-style: normal; font-size: 10px; }

/* ---------- sections ---------- */
.section { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(90px, 12vh, 150px) clamp(20px, 4vw, 48px) 0; }
.kicker { font-family: var(--mono); font-size: 11.5px; letter-spacing: .22em;
  color: var(--amber); margin-bottom: 20px; }
.mkt h2 { font-family: var(--serif); font-weight: 380;
  font-size: clamp(32px, 4.2vw, 56px); line-height: 1.12; letter-spacing: -.01em; }
.section-lede { margin-top: 22px; max-width: 60ch; color: var(--muted);
  font-size: clamp(15px, 1.3vw, 17px); }

/* reveals */
.rv { opacity: 0; transform: translateY(28px);
  transition: opacity .9s cubic-bezier(.19,1,.22,1), transform .9s cubic-bezier(.19,1,.22,1); }
.rv.in { opacity: 1; transform: none; }

/* ---------- cards ---------- */
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 56px; }
@media (max-width: 980px) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .cards { grid-template-columns: 1fr; } }
.card { position: relative; border: 1px solid var(--line-soft); border-radius: 16px;
  padding: 28px 26px; background: var(--panel); overflow: hidden;
  transition: border-color .3s ease, transform .3s ease, opacity .9s cubic-bezier(.19,1,.22,1); }
.card::before { content: ''; position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(340px circle at var(--mx, 50%) var(--my, 50%),
    rgba(245,165,36,.10), transparent 65%);
  transition: opacity .35s ease; pointer-events: none; }
.card:hover { border-color: rgba(245,165,36,.28); transform: translateY(-4px); }
.card:hover::before { opacity: 1; }
.card-icon { font-size: 26px; margin-bottom: 18px; filter: grayscale(.15); }
.card h3 { font-size: 16.5px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 10px; }
.card p { font-size: 14px; color: var(--muted); }

/* ---------- steps ---------- */
.steps { position: relative; margin-top: 64px; padding-left: 46px;
  display: flex; flex-direction: column; gap: 54px; max-width: 760px; }
.beam { position: absolute; left: 15px; top: 8px; bottom: 8px; width: 2px;
  background: rgba(255,255,255,.07); border-radius: 2px; overflow: hidden; }
.beam-fill { width: 100%; height: 100%; transform-origin: top; transform: scaleY(0);
  background: linear-gradient(180deg, var(--amber-hi), var(--amber) 60%, rgba(245,165,36,.2));
  box-shadow: 0 0 16px rgba(245,165,36,.5); transition: transform .2s linear; }
.step { position: relative; }
.step-n { position: absolute; left: -46px; top: 2px; width: 32px; height: 32px;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: 10.5px; color: var(--amber);
  border: 1px solid rgba(245,165,36,.4); background: var(--ink);
  box-shadow: 0 0 14px rgba(245,165,36,.18); }
.step h3 { font-family: var(--serif); font-weight: 420; font-size: clamp(21px, 2.4vw, 27px);
  letter-spacing: -.01em; margin-bottom: 10px; }
.step p { color: var(--muted); font-size: 15px; max-width: 56ch; }

/* ---------- stats ---------- */
.stats { position: relative; z-index: 1; max-width: 1240px;
  margin: clamp(90px, 12vh, 150px) auto 0; padding: 0 clamp(20px, 4vw, 48px);
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
@media (max-width: 900px) { .stats { grid-template-columns: repeat(2, 1fr); } }
.stat { border-top: 1px solid var(--line); padding-top: 22px; }
.stat-n { font-family: var(--serif); font-style: italic; font-weight: 380;
  font-size: clamp(44px, 5vw, 68px); line-height: 1; color: var(--amber);
  text-shadow: 0 0 34px rgba(245,165,36,.25); }
.stat-l { margin-top: 12px; font-size: 13px; color: var(--muted); max-width: 24ch; }

/* ---------- statement ---------- */
.statement { position: relative; z-index: 1; max-width: 980px; margin: 0 auto;
  padding: clamp(110px, 15vh, 180px) clamp(20px, 4vw, 48px) 0; text-align: center; }
.statement p { font-family: var(--serif); font-weight: 380;
  font-size: clamp(26px, 3.4vw, 44px); line-height: 1.28; color: var(--cream); }
.statement em { color: var(--amber-hi); }

/* ---------- CTA ---------- */
.cta-panel { position: relative; z-index: 1; max-width: 1240px;
  margin: clamp(100px, 14vh, 170px) auto 0; padding: 0 clamp(20px, 4vw, 48px); }
.cta-inner { position: relative; overflow: hidden; text-align: center;
  border: 1px solid var(--line); border-radius: 24px;
  padding: clamp(56px, 8vw, 96px) clamp(24px, 5vw, 64px);
  background:
    radial-gradient(60% 120% at 50% 0%, rgba(245,165,36,.12), transparent 70%),
    linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.01)); }
.cta-inner .cta-row { justify-content: center; }
.cta-inner h2 { margin-bottom: 18px; }
.cta-inner p { color: var(--muted); max-width: 46ch; margin: 0 auto 8px; }
.cta-mail { margin-top: 26px; font-size: 13px; color: var(--dim); }
.cta-mail a { color: var(--amber); }
.cta-mail a:hover { color: var(--amber-hi); }

/* ---------- footer ---------- */
.footer { position: relative; z-index: 1; max-width: 1240px; margin: 0 auto;
  padding: clamp(80px, 10vh, 120px) clamp(20px, 4vw, 48px) 48px; }
.foot-grid { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 40px;
  padding-bottom: 40px; border-bottom: 1px solid var(--line-soft); }
@media (max-width: 760px) { .foot-grid { grid-template-columns: 1fr; } }
.foot-brand p { margin-top: 16px; font-size: 13px; color: var(--dim); max-width: 44ch; }
.foot-brand a { color: var(--muted); }
.foot-brand a:hover { color: var(--cream); }
.foot-col { display: flex; flex-direction: column; gap: 10px; }
.foot-h { font-family: var(--mono); font-size: 11px; letter-spacing: .18em;
  text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
.foot-col a { font-size: 14px; color: var(--muted); transition: color .2s; }
.foot-col a:hover { color: var(--cream); }
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
}
`;
