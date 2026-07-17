'use client';

import React from 'react';

// Shared visual shell for the whole onboarding flow — /signin, /signin/verify,
// /signin/forgot, /signin/reset and /signup all render through this so the
// experience is identical end to end (warm animated mesh, paper grain, a
// frosted-glass card, the chevron mark + Instrument Serif "Staxis" lockup).
//
// This is a PURELY visual shell. Every page keeps its own auth logic and
// passes its form/content as children — nothing here touches sign-in,
// OTP, password-reset or join-code behaviour.

// Snow chevron mark (locked logo, 64x64 viewBox — matches the global Header).
export function ChevronMark({ size = 32, color = '#1A1F1B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30"
        stroke={color} strokeWidth={4.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Caramel accent shared across all auth screens.
export const AUTH_LINK = '#8C6A33';

export const authLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: '#5C625C',
};

export const authLinkStyle: React.CSSProperties = {
  fontSize: 12, color: AUTH_LINK, textDecoration: 'none',
};

export const authBackLinkStyle: React.CSSProperties = {
  display: 'block', textAlign: 'center', marginTop: 6,
  fontSize: 13, color: '#5C625C', textDecoration: 'none',
};

// Uppercase 11px form label.
export function AuthLabel({ children }: { children: React.ReactNode }) {
  return <label style={authLabelStyle}>{children}</label>;
}

// Terracotta error pill, matched to the warm palette.
export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 13, color: '#B85C3D',
      background: 'rgba(184,92,61,0.10)',
      border: '1px solid rgba(184,92,61,0.25)',
      borderRadius: 10, padding: '10px 12px', margin: 0,
    }}>
      {children}
    </p>
  );
}

// Translucent panel for "reset link sent" / "link expired" / "done" states.
export function AuthPanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.6)',
      border: '1px solid rgba(31,35,28,0.10)',
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
    <div style={{
      position: 'relative', minHeight: '100dvh', overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-geist), sans-serif', background: '#F2EFE8',
      padding: '32px 24px',
    }}>
      <style>{`
        @keyframes si-d1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(120px,80px) scale(1.1)}}
        @keyframes si-d2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-100px,60px) scale(1.15)}}
        @keyframes si-d3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(80px,-90px) scale(1.05)}}
        @keyframes si-d4{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-90px,-70px) scale(1.12)}}
        @keyframes si-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        .si-rise{animation:si-rise .8s cubic-bezier(0.05,0.7,0.1,1) both}
        .si-d-1{animation-delay:.1s}.si-d-2{animation-delay:.2s}.si-d-3{animation-delay:.3s}
        .si-input{height:48px;border-radius:12px;background:rgba(255,255,255,0.7);border:1px solid rgba(31,35,28,0.1);padding:0 14px;font-size:15px;color:#1F231C;font-family:inherit;outline:none;width:100%;box-sizing:border-box;transition:border-color .18s,box-shadow .18s,background .18s}
        .si-input::placeholder{color:#9A9E96}
        .si-input:focus{border-color:#C99644;box-shadow:0 0 0 4px rgba(201,150,68,0.16);background:#fff}
        .si-input:disabled{opacity:.6}
        .si-btn{width:100%;height:50px;border-radius:12px;border:none;font-size:15px;font-weight:600;font-family:inherit;color:#fff;display:flex;align-items:center;justify-content:center;transition:transform .12s,filter .18s}
        .si-btn-on{background:#C99644;cursor:pointer;box-shadow:0 10px 24px -8px rgba(201,150,68,0.55)}
        .si-btn-on:hover{filter:brightness(1.05)}
        .si-btn-on:active{transform:scale(.98)}
        .si-btn-off{background:rgba(201,150,68,0.45);cursor:not-allowed}
        @media (prefers-reduced-motion: reduce){.si-blob{animation:none!important}.si-rise{animation:none!important}}
      `}</style>

      {/* Warm animated mesh — sage / caramel / warm / soft purple */}
      <div className="si-blob" style={{ position: 'absolute', top: '-10%', left: '-5%', width: 680, height: 680, background: 'radial-gradient(circle, rgba(201,150,68,0.5) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d1 26s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', bottom: '-15%', left: '10%', width: 720, height: 720, background: 'radial-gradient(circle, rgba(158,183,166,0.55) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d2 30s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', top: '5%', right: '-8%', width: 640, height: 640, background: 'radial-gradient(circle, rgba(184,92,61,0.45) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d3 28s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', bottom: '0%', right: '5%', width: 560, height: 560, background: 'radial-gradient(circle, rgba(123,106,151,0.35) 0%, transparent 62%)', filter: 'blur(60px)', animation: 'si-d4 32s ease-in-out infinite', pointerEvents: 'none' }} />

      {/* Paper grain */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.05, mixBlendMode: 'multiply', pointerEvents: 'none' }} aria-hidden="true">
        <filter id="si-noise"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" /></filter>
        <rect width="100%" height="100%" filter="url(#si-noise)" />
      </svg>

      {/* Frosted-glass card */}
      <div className="si-rise si-d-1" style={{
        position: 'relative', width: '100%', maxWidth,
        background: 'rgba(255,255,255,0.55)',
        backdropFilter: 'blur(28px) saturate(150%)', WebkitBackdropFilter: 'blur(28px) saturate(150%)',
        border: '1px solid rgba(255,255,255,0.7)', borderRadius: 24,
        padding: '40px 34px',
        boxShadow: '0 30px 70px -30px rgba(31,35,28,0.35), 0 1px 0 rgba(255,255,255,0.8) inset',
      }}>

        {/* Logo lockup */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 }}>
          <ChevronMark size={32} color="#1A1F1B" />
          <h1 style={{ fontFamily: 'var(--font-instrument-serif), Georgia, serif', fontSize: 42, lineHeight: 1, fontWeight: 400, color: '#1F231C', marginTop: 10, letterSpacing: '-0.01em' }}>
            Staxis
          </h1>
          {subtitle && (
            <p style={{ fontSize: 13.5, color: '#5C625C', marginTop: 6, textAlign: 'center', lineHeight: 1.5 }}>
              {subtitle}
            </p>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
