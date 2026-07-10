'use client';

import React from 'react';
import { LanguageMenu } from '@/components/i18n/LanguageMenu';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

// Shared visual shell for the whole onboarding flow — /signin, /signin/verify,
// /signin/forgot, /signin/reset and /signup all render through this component.
// It remains purely presentational: auth, OTP, password-reset and join-code
// behaviour stay owned by the individual pages.

// Snow chevron mark (locked logo, 64x64 viewBox — matches the global Header).
export function ChevronMark({ size = 32, color = '#1A1F1B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30"
        stroke={color} strokeWidth={4.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Caramel accent shared across all auth screens. Keep these string exports for
// older auth pages that use them directly in inline styles.
export const AUTH_ACCENT = '#C99644';
export const AUTH_LINK = '#8C6A33';

// These exported objects are part of the auth-page API. CSS-variable values let
// the same helpers follow the shared light/dark theme without changing callers.
export const authLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 650, letterSpacing: '0.09em',
  textTransform: 'uppercase', color: 'var(--si-muted, #5C625C)',
};

export const authLinkStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--si-link, #8C6A33)', textDecoration: 'none',
};

export const authBackLinkStyle: React.CSSProperties = {
  display: 'block', textAlign: 'center', marginTop: 6,
  fontSize: 13, color: 'var(--si-link, #8C6A33)', textDecoration: 'none',
};

// Uppercase 11px form label.
export function AuthLabel({ children }: { children: React.ReactNode }) {
  return <label className="si-label" style={authLabelStyle}>{children}</label>;
}

// Terracotta error panel, matched to the warm palette.
export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p className="si-error" role="alert" style={{
      fontSize: 13, color: 'var(--si-error, #B85C3D)',
      background: 'var(--si-error-bg, rgba(184,92,61,0.10))',
      border: '1px solid var(--si-error-border, rgba(184,92,61,0.25))',
      borderRadius: 12, padding: '11px 12px', margin: 0, lineHeight: 1.45,
    }}>
      {children}
    </p>
  );
}

// Translucent panel for "reset link sent" / "link expired" / "done" states.
export function AuthPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="si-panel" style={{
      background: 'var(--si-panel-soft, rgba(255,255,255,0.6))',
      border: '1px solid var(--si-border, rgba(31,35,28,0.10))',
      borderRadius: 16, padding: '24px 20px', textAlign: 'center',
    }}>
      {children}
    </div>
  );
}

export default function AuthShell({
  subtitle,
  children,
  maxWidth = 404,
}: {
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  return (
    <main className="si-shell">
      <style>{AUTH_SHELL_CSS}</style>

      {/* Controls stay visible on every auth step, including long signup forms. */}
      <div className="si-controls" aria-label="Display and language controls">
        <div className="si-language">
          <LanguageMenu />
        </div>
        <ThemeToggle />
      </div>

      {/* Atmospheric layer: restrained depth, operational grid and slow motion. */}
      <div className="si-atmosphere" aria-hidden="true">
        <div className="si-grid" />
        <div className="si-orbit si-orbit-1" />
        <div className="si-orbit si-orbit-2" />
        <div className="si-blob si-blob-1" />
        <div className="si-blob si-blob-2" />
        <div className="si-blob si-blob-3" />
        <div className="si-beam" />
        <svg className="si-grain" aria-hidden="true">
          <filter id="si-noise">
            <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch" />
          </filter>
          <rect width="100%" height="100%" filter="url(#si-noise)" />
        </svg>
      </div>

      <section className="si-card si-rise si-d-1" style={{ maxWidth }} aria-label="Staxis account access">
        <div className="si-card-shine" aria-hidden="true" />

        {/* Logo lockup */}
        <header className="si-brand">
          <div className="si-brand-mark">
            <ChevronMark size={34} color="currentColor" />
            <span className="si-brand-pulse" aria-hidden="true" />
          </div>
          <h1>Staxis</h1>
          {subtitle && <p className="si-subtitle">{subtitle}</p>}
        </header>

        <div className="si-content">
          {children}
        </div>
      </section>
    </main>
  );
}

const AUTH_SHELL_CSS = `
  .si-shell {
    --si-text: var(--snow-ink, #1f231c);
    --si-muted: var(--snow-ink2, #5c625c);
    --si-subtle: var(--snow-ink3, #8a9187);
    --si-accent: var(--snow-caramel, #c99644);
    --si-accent-strong: var(--snow-caramel-deep, #8c6a33);
    --si-link: var(--snow-caramel-deep, #8c6a33);
    --si-error: var(--snow-warm, #b85c3d);
    --si-border: var(--snow-rule, rgba(31,35,28,.1));
    --si-border-soft: var(--snow-rule-soft, rgba(31,35,28,.05));
    --si-canvas: color-mix(in srgb, var(--snow-bg, #fff) 86%, var(--snow-sage, #9eb7a6));
    --si-canvas-deep: color-mix(in srgb, var(--snow-bg, #fff) 82%, var(--primary, #364262));
    --si-panel: color-mix(in srgb, var(--snow-bg, #fff) 78%, transparent);
    --si-panel-solid: color-mix(in srgb, var(--snow-bg, #fff) 94%, var(--snow-sage, #9eb7a6));
    --si-panel-soft: color-mix(in srgb, var(--snow-bg, #fff) 68%, transparent);
    --si-input-bg: color-mix(in srgb, var(--snow-bg, #fff) 76%, transparent);
    --si-control-bg: color-mix(in srgb, var(--snow-bg, #fff) 80%, transparent);
    --si-focus: color-mix(in srgb, var(--si-accent) 30%, transparent);
    --si-error-bg: color-mix(in srgb, var(--si-error) 11%, transparent);
    --si-error-border: color-mix(in srgb, var(--si-error) 32%, transparent);

    position: relative;
    isolation: isolate;
    min-height: 100dvh;
    width: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(92px, calc(72px + env(safe-area-inset-top, 0px))) 24px 40px;
    font-family: var(--font-geist), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--si-text);
    background:
      radial-gradient(circle at 12% 12%, color-mix(in srgb, var(--snow-caramel, #c99644) 18%, transparent), transparent 34%),
      radial-gradient(circle at 88% 84%, color-mix(in srgb, var(--snow-sage, #9eb7a6) 24%, transparent), transparent 38%),
      linear-gradient(145deg, var(--si-canvas), var(--si-canvas-deep));
    transition: background-color 300ms cubic-bezier(.2,0,0,1), color 200ms cubic-bezier(.2,0,0,1);
  }

  .si-controls {
    position: fixed;
    top: max(16px, env(safe-area-inset-top, 0px));
    right: max(16px, env(safe-area-inset-right, 0px));
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    border: 1px solid var(--si-border);
    border-radius: 16px;
    background: var(--si-control-bg);
    box-shadow: 0 12px 35px -24px color-mix(in srgb, var(--si-text) 42%, transparent);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
  }

  .si-language {
    min-height: 44px;
    display: flex;
    align-items: center;
    border-radius: 12px;
  }
  .si-language > div > button { min-height: 44px; }
  .si-controls .stx-theme-toggle {
    background: transparent;
    border-color: transparent;
  }
  .si-controls .stx-theme-toggle:hover { background: var(--si-border-soft); }

  .si-atmosphere,
  .si-grid,
  .si-grain {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .si-atmosphere { z-index: -1; overflow: hidden; }
  .si-grid {
    opacity: .45;
    background-image:
      linear-gradient(color-mix(in srgb, var(--si-text) 5%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--si-text) 5%, transparent) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at center, black 12%, transparent 78%);
    -webkit-mask-image: radial-gradient(ellipse at center, black 12%, transparent 78%);
  }
  .si-grain { opacity: .026; mix-blend-mode: overlay; }

  .si-orbit {
    position: absolute;
    border: 1px solid color-mix(in srgb, var(--si-text) 8%, transparent);
    border-radius: 50%;
    transform: rotate(-12deg);
  }
  .si-orbit::after {
    content: "";
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--si-accent);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--si-accent) 12%, transparent);
  }
  .si-orbit-1 { width: 760px; height: 330px; left: -260px; top: 8%; }
  .si-orbit-1::after { right: 15%; top: 7%; }
  .si-orbit-2 { width: 620px; height: 620px; right: -330px; bottom: -280px; }
  .si-orbit-2::after { left: 10%; top: 24%; }

  .si-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(72px);
    opacity: .34;
    will-change: transform;
  }
  .si-blob-1 {
    width: min(46vw, 680px);
    height: min(46vw, 680px);
    top: -22%;
    left: -8%;
    background: var(--snow-caramel, #c99644);
    animation: si-d1 24s ease-in-out infinite;
  }
  .si-blob-2 {
    width: min(48vw, 720px);
    height: min(48vw, 720px);
    right: -12%;
    bottom: -24%;
    background: var(--snow-sage, #9eb7a6);
    animation: si-d2 28s ease-in-out infinite;
  }
  .si-blob-3 {
    width: min(30vw, 440px);
    height: min(30vw, 440px);
    top: 24%;
    right: 16%;
    opacity: .18;
    background: var(--snow-purple, #7b6a97);
    animation: si-d3 31s ease-in-out infinite;
  }
  .si-beam {
    position: absolute;
    width: 36vw;
    min-width: 340px;
    height: 160vh;
    left: 50%;
    top: -28%;
    opacity: .12;
    transform: translateX(-50%) rotate(24deg);
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--snow-bg, #fff) 90%, transparent), transparent);
    animation: si-beam 14s cubic-bezier(.2,0,0,1) infinite alternate;
  }

  @keyframes si-d1 {
    0%,100% { transform: translate3d(0,0,0) scale(1); }
    50% { transform: translate3d(10vw,7vh,0) scale(1.08); }
  }
  @keyframes si-d2 {
    0%,100% { transform: translate3d(0,0,0) scale(1); }
    50% { transform: translate3d(-9vw,-5vh,0) scale(1.1); }
  }
  @keyframes si-d3 {
    0%,100% { transform: translate3d(0,0,0) scale(.96); }
    50% { transform: translate3d(-5vw,6vh,0) scale(1.08); }
  }
  @keyframes si-beam {
    from { transform: translateX(-58%) rotate(24deg); }
    to { transform: translateX(-42%) rotate(24deg); }
  }
  @keyframes si-rise {
    from { opacity: 0; transform: translateY(18px) scale(.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes si-mark-pulse {
    0%, 100% { opacity: .55; transform: scale(.82); }
    50% { opacity: 1; transform: scale(1); }
  }

  .si-rise { animation: si-rise 520ms cubic-bezier(.05,.7,.1,1) both; }
  .si-d-1 { animation-delay: 60ms; }
  .si-d-2 { animation-delay: 130ms; }
  .si-d-3 { animation-delay: 200ms; }

  .si-card {
    position: relative;
    z-index: 2;
    width: 100%;
    overflow: hidden;
    padding: 38px 34px 34px;
    border: 1px solid color-mix(in srgb, var(--si-text) 11%, transparent);
    border-radius: 26px;
    background: var(--si-panel);
    box-shadow:
      0 34px 80px -42px color-mix(in srgb, var(--si-text) 54%, transparent),
      0 1px 0 color-mix(in srgb, var(--snow-bg, #fff) 70%, transparent) inset;
    backdrop-filter: blur(30px) saturate(155%);
    -webkit-backdrop-filter: blur(30px) saturate(155%);
  }
  .si-card-shine {
    position: absolute;
    inset: 0 0 auto;
    height: 1px;
    background: linear-gradient(90deg, transparent 6%, color-mix(in srgb, var(--si-accent) 58%, transparent), transparent 94%);
    opacity: .75;
  }

  .si-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 28px;
    text-align: center;
  }
  .si-brand-mark {
    position: relative;
    width: 54px;
    height: 54px;
    display: grid;
    place-items: center;
    color: var(--si-text);
    border: 1px solid var(--si-border);
    border-radius: 17px;
    background: var(--si-panel-soft);
    box-shadow: 0 12px 30px -20px color-mix(in srgb, var(--si-text) 50%, transparent);
  }
  .si-brand-pulse {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--si-accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--si-accent) 14%, transparent);
    animation: si-mark-pulse 2.8s ease-in-out infinite;
  }
  .si-brand h1 {
    margin: 13px 0 0;
    color: var(--si-text);
    font-family: var(--font-instrument-serif), Georgia, serif;
    font-size: clamp(39px, 7vw, 44px);
    font-weight: 400;
    line-height: .98;
    letter-spacing: -.025em;
  }
  .si-subtitle {
    max-width: 310px;
    margin: 8px 0 0;
    color: var(--si-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .si-content { position: relative; }

  .si-label { display: inline-block; color: var(--si-muted) !important; }
  .si-input {
    width: 100%;
    height: 50px;
    box-sizing: border-box;
    padding: 0 14px;
    border: 1px solid var(--si-border);
    border-radius: 12px;
    outline: none;
    background: var(--si-input-bg);
    color: var(--si-text);
    font-family: inherit;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.2;
    caret-color: var(--si-accent);
    transition:
      border-color 180ms cubic-bezier(.2,0,0,1),
      box-shadow 180ms cubic-bezier(.2,0,0,1),
      background-color 180ms cubic-bezier(.2,0,0,1);
  }
  .si-input::placeholder { color: var(--si-subtle); opacity: .86; }
  .si-input:hover:not(:disabled) { border-color: color-mix(in srgb, var(--si-text) 24%, transparent); }
  .si-input:focus-visible {
    border-color: var(--si-accent);
    background: var(--si-panel-solid);
    box-shadow: 0 0 0 4px var(--si-focus);
  }
  .si-input:disabled { opacity: .52; cursor: not-allowed; }
  .si-input:-webkit-autofill,
  .si-input:-webkit-autofill:hover,
  .si-input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--si-text);
    box-shadow: 0 0 0 1000px var(--si-panel-solid) inset;
    caret-color: var(--si-text);
  }

  .si-btn {
    width: 100%;
    min-height: 50px;
    padding: 0 22px;
    border: none;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: inherit;
    font-size: 15px;
    font-weight: 650;
    line-height: 1;
    color: #1f231c;
    transition:
      transform 150ms cubic-bezier(.2,0,0,1),
      box-shadow 180ms cubic-bezier(.2,0,0,1),
      filter 180ms cubic-bezier(.2,0,0,1);
  }
  .si-btn-on {
    cursor: pointer;
    background: var(--si-accent);
    box-shadow: 0 14px 30px -15px color-mix(in srgb, var(--si-accent) 80%, transparent);
  }
  @media (hover: hover) {
    .si-btn-on:hover {
      filter: brightness(1.05) saturate(1.04);
      box-shadow: 0 18px 34px -16px color-mix(in srgb, var(--si-accent) 88%, transparent);
      transform: translateY(-1px);
    }
  }
  .si-btn-on:active { transform: scale(.985); }
  .si-btn:focus-visible { outline: 3px solid var(--si-focus); outline-offset: 2px; }
  .si-btn-off {
    cursor: not-allowed;
    color: rgba(31, 35, 28, .58);
    background: color-mix(in srgb, var(--si-accent) 42%, var(--si-panel-solid));
    box-shadow: none;
  }

  .si-panel { color: var(--si-text); }
  .si-error { color: var(--si-error) !important; }
  .si-card button:not(.si-btn):not(.stx-theme-toggle) { min-height: 44px; }
  .si-card label:not(.si-label) { min-height: 44px; }
  .si-card a:focus-visible {
    border-radius: 5px;
    outline: 3px solid var(--si-focus);
    outline-offset: 3px;
  }

  /* Several legacy auth pages still set light-theme text colors inline. These
     narrow overrides keep that existing content readable on the dark card. */
  .dark .si-card p:not(.si-error) { color: var(--si-muted) !important; }
  .dark .si-card p strong { color: var(--si-text) !important; }
  .dark .si-card a { color: var(--si-link) !important; }

  @media (max-width: 600px) {
    .si-shell {
      align-items: flex-start;
      padding:
        max(82px, calc(68px + env(safe-area-inset-top, 0px)))
        14px
        max(24px, env(safe-area-inset-bottom, 0px));
    }
    .si-controls {
      top: max(10px, env(safe-area-inset-top, 0px));
      right: max(10px, env(safe-area-inset-right, 0px));
    }
    .si-card { padding: 30px 20px 24px; border-radius: 22px; }
    .si-brand { margin-bottom: 24px; }
    .si-brand-mark { width: 50px; height: 50px; border-radius: 15px; }
    .si-blob { filter: blur(52px); opacity: .28; }
    .si-blob-1 { width: 80vw; height: 80vw; }
    .si-blob-2 { width: 92vw; height: 92vw; }
    .si-blob-3 { display: none; }
    .si-orbit-1 { left: -470px; }
    .si-orbit-2 { right: -480px; }
  }

  @media (max-width: 380px) {
    .si-controls .stx-theme-toggle { width: 44px; padding: 0; }
    .si-controls .stx-theme-toggle > span:last-child { display: none; }
    .si-language > div > button { padding-left: 8px !important; padding-right: 8px !important; }
  }

  @media (max-height: 700px) and (min-width: 601px) {
    .si-shell { align-items: flex-start; padding-top: 82px; }
    .si-card { padding-top: 28px; padding-bottom: 28px; }
    .si-brand { margin-bottom: 22px; }
  }

  @media (prefers-contrast: more) {
    .si-card,
    .si-input,
    .si-controls { border-color: color-mix(in srgb, var(--si-text) 42%, transparent); }
  }

  @media (prefers-reduced-motion: reduce) {
    .si-shell,
    .si-card,
    .si-input,
    .si-btn,
    .si-controls .stx-theme-toggle {
      scroll-behavior: auto !important;
      animation: none !important;
      transition: none !important;
    }
    .si-blob,
    .si-beam,
    .si-brand-pulse,
    .si-rise {
      animation: none !important;
      transform: none !important;
    }
  }
`;
