'use client';

import React from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from '@/app/_components/ui/Modal';
import { InstallStaxisCard } from './InstallStaxisCard';
import styles from './InstallStaxisDialog.module.css';

export interface InstallStaxisDialogProps {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const INSTALL_DIALOG_THEME = {
  scrim: 'rgba(20, 25, 21, 0.42)',
  scrimFilter: 'blur(4px)',
  bg: 'transparent',
  border: 'none',
  radius: '16px',
  maxWidth: '500px',
  padding: '0',
  shadow: '0 26px 72px -22px rgba(24, 34, 27, 0.5)',
  zIndex: 1300,
} as const;

export function InstallStaxisDialog({
  open,
  onClose,
  returnFocusRef,
}: InstallStaxisDialogProps) {
  const titleId = React.useId();
  const dialogBodyRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;

    const previousFocus =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const frame = window.requestAnimationFrame(() => {
      dialogBodyRef.current
        ?.querySelector<HTMLElement>(FOCUSABLE)
        ?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      previousFocus?.focus();
    };
  }, [open, returnFocusRef]);

  const handleFocusTrap = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogBodyRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      portal
      animated={false}
      labelledBy={titleId}
      theme={INSTALL_DIALOG_THEME}
    >
      <div
        ref={dialogBodyRef}
        className={styles.dialog}
        onKeyDown={handleFocusTrap}
      >
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>
              <Download size={13} aria-hidden="true" />
              Install app
            </span>
            <h2 id={titleId}>Add Staxis to Home Screen</h2>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close install instructions"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.content}>
          <InstallStaxisCard compact />
        </div>
      </div>
    </Modal>
  );
}
