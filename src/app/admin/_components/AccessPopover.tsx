'use client';

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound } from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';

import aiStyles from './AIControlCenter.module.css';
import styles from './AccessModal.module.css';
import { AccessSurface } from './studio/surfaces/AccessSurface';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0
      && !element.hidden
      && element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface AccessPopoverProps {
  /** Test seam only. Production always uses the authenticated request helper. */
  request?: typeof fetchWithAuth;
}

export function AccessPopover({ request = fetchWithAuth }: AccessPopoverProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  React.useEffect(() => { setMounted(true); }, []);

  useLayoutEffect(() => {
    if (!open) return;

    const returnTarget = triggerRef.current;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    const previousOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.dataset.accessScrollLocked = 'true';

    const backgroundStates = Array.from(document.body.children).flatMap((element) => {
      if (!(element instanceof HTMLElement)
          || element === scrimRef.current
          || element.contains(scrimRef.current)) return [];
      const state = {
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      };
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
      return [state];
    });

    const focusFrame = requestAnimationFrame(() => {
      (closeRef.current ?? dialogRef.current)?.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
      document.documentElement.style.overscrollBehavior = previousOverscroll;
      delete document.body.dataset.accessScrollLocked;
      backgroundStates.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
        window.scrollTo(scrollX, scrollY);
      }
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [close, open]);

  const overlay = open ? (
    <div
      ref={scrimRef}
      className={styles.scrim}
      data-access-modal-backdrop
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        id="access-modal-dialog"
        className={styles.dialog}
        data-access-modal-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-modal-title"
        aria-describedby="access-modal-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <AccessSurface onClose={close} closeButtonRef={closeRef} request={request} />
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={aiStyles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'access-modal-dialog' : undefined}
        title="Open access settings"
      >
        <KeyRound className={aiStyles.triggerIcon} size={15} aria-hidden="true" />
        <span className={aiStyles.triggerText}>Access</span>
      </button>
      {mounted && overlay ? createPortal(overlay, document.body) : null}
    </>
  );
}
