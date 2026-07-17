'use client';

// Access grid popover — the former Access tab, relocated per Reeyen
// (2026-07-17): a trigger on the Live-hotels header, left of the AI Control
// Center, that pops the per-hotel capability grid open as an overlay.
// Reuses the AI Control Center's trigger styling so the two read as one
// family of control-center buttons.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound } from 'lucide-react';
import { AccessSurface } from './studio/surfaces/AccessSurface';
import styles from './AIControlCenter.module.css';

export function AccessPopover() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const overlay = open ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Per-hotel access"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--ink)', overflowY: 'auto' }}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close access settings"
        title="Close access settings"
        style={{
          position: 'fixed', top: 78, right: 22, zIndex: 1001,
          width: 34, height: 34, borderRadius: 999,
          border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)',
          color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1,
        }}
      >
        ✕
      </button>
      <AccessSurface />
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Open per-hotel access"
      >
        <KeyRound className={styles.triggerIcon} size={15} aria-hidden="true" />
        <span className={styles.triggerText}>Access</span>
      </button>
      {mounted && overlay ? createPortal(overlay, document.body) : null}
    </>
  );
}
