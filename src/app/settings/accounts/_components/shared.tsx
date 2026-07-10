'use client';

// Shared primitives for Settings → Account & Team, extracted verbatim from
// accounts/page.tsx in the by-concern file split (CRUD / team / invites /
// join-codes). No logic or style changes — the split is organizational.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Copy } from 'lucide-react';

import { useLang } from '@/contexts/LanguageContext';
import type { AppRole } from '@/lib/roles';

export interface AccountRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  propertyAccess: string[];
  createdAt: string | null;
}

// CopyButton — writes `value` to the clipboard and lights up loud enough
// that the user can't miss it.
//
// Reeyen explicitly called out twice that the previous "subtle green
// background + checkmark" feedback wasn't visible enough. Two changes
// here to make it unmissable:
//   1. The button itself becomes SOLID green with white "✓ Copied!" text
//      for 2 seconds, replacing the icon entirely.
//   2. A toast pill slides up at the bottom of the viewport saying
//      "Copied to clipboard" — mounted via React portal so it isn't
//      trapped inside a modal's containing block.
export function CopyButton({ value, label, small }: {
  value: string;
  label: string;
  small?: boolean;
}) {
  const { lang } = useLang();
  const [copied, setCopied] = useState(false);
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail on insecure origins (http://) or in some
      // embedded contexts. Fallback so the user still gets feedback that
      // something happened — they can long-press the text to copy.
      alert(label + ': ' + value);
    }
  };
  const Icon = copied ? Check : Copy;
  const iconSize = small ? 14 : 15;
  return (
    <>
      <button
        onClick={handleClick}
        aria-label={label}
        title={label}
        style={{
          height: small ? '32px' : '34px',
          padding: copied ? '0 12px' : (small ? '0' : '0 8px'),
          minWidth: small ? '32px' : '34px',
          borderRadius: 'var(--radius-sm)',
          background: copied ? '#22c55e' : 'transparent',
          border: `1px solid ${copied ? '#22c55e' : 'var(--border)'}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
          cursor: 'pointer',
          color: copied ? '#ffffff' : 'var(--text-muted)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px', fontWeight: 700,
          transition: 'background 140ms, color 140ms, border-color 140ms, transform 140ms',
          transform: copied ? 'scale(1.04)' : 'scale(1)',
          boxShadow: copied ? '0 4px 12px -2px rgba(34,197,94,0.35)' : 'none',
        }}
      >
        <Icon size={iconSize} strokeWidth={copied ? 3 : 2} />
        {copied && <span>{lang === 'es' ? '¡Copiado!' : 'Copied!'}</span>}
      </button>
      {copied && <CopyToast text={lang === 'es' ? 'Copiado al portapapeles' : 'Copied to clipboard'} />}
    </>
  );
}

// Portal-mounted toast pinned to the bottom-center of the viewport. We use
// a portal so the toast escapes any modal's containing block (modal has
// backdrop-filter, which would otherwise reposition fixed children).
function CopyToast({ text }: { text: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Animate in on mount.
    const id = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  if (typeof document === 'undefined') return null;
  const node = (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '32px',
        transform: `translateX(-50%) translateY(${mounted ? '0' : '12px'})`,
        opacity: mounted ? 1 : 0,
        transition: 'opacity 160ms, transform 160ms',
        background: '#22c55e',
        color: '#ffffff',
        padding: '10px 18px',
        borderRadius: '999px',
        fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '14px',
        boxShadow: '0 12px 32px -6px rgba(34,197,94,0.45), 0 4px 12px -2px rgba(0,0,0,0.15)',
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <Check size={16} strokeWidth={3} />
      {text}
    </div>
  );
  return createPortal(node, document.body);
}

export function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: '100%', maxWidth: '440px',
        background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-bright)', padding: '20px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: '13px', color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0 }}>
      {children}
    </p>
  );
}

export const labelStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 600,
  letterSpacing: '0.04em', color: 'var(--text-secondary)',
  textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
};

export const inputStyle: React.CSSProperties = {
  height: '42px', borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  padding: '0 12px',
  color: 'var(--text-primary)', fontSize: '14px',
  fontFamily: 'var(--font-sans)',
  outline: 'none', width: '100%',
};

export const subHeadingStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
  color: 'var(--text-muted)', textTransform: 'uppercase',
  fontFamily: 'var(--font-sans)',
};

export const teamBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '8px',
  background: 'var(--bg-card)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
  padding: '10px 14px', fontSize: '13px', fontWeight: 600,
  cursor: 'pointer', fontFamily: 'var(--font-sans)',
};

export const teamRowStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: '10px 12px',
  display: 'flex', alignItems: 'center', gap: '10px',
};

export const iconBtnStyle: React.CSSProperties = {
  width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
  background: 'transparent', border: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: 'var(--text-muted)',
};

export const revokeBtnStyle: React.CSSProperties = {
  width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
  background: 'transparent', border: '1px solid var(--red-border, rgba(239,68,68,0.3))',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: 'var(--red)',
};

export function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: '44px',
    borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '14px',
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
