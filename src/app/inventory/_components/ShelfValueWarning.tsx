'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { T, fonts } from './tokens';
import styles from './ShelfValueWarning.module.css';

const TOOLTIP_WIDTH = 210;
const VIEWPORT_GUTTER = 8;

export function ShelfValueWarning({ label, message }: { label: string; message: string }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;

    const placeTooltip = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_GUTTER);
      const centeredLeft = rect.left + (rect.width / 2) - (TOOLTIP_WIDTH / 2);
      setPosition({
        left: Math.min(Math.max(VIEWPORT_GUTTER, centeredLeft), maxLeft),
        top: rect.bottom + 7,
      });
    };

    placeTooltip();
    window.addEventListener('resize', placeTooltip);
    window.addEventListener('scroll', placeTooltip, true);
    return () => {
      window.removeEventListener('resize', placeTooltip);
      window.removeEventListener('scroll', placeTooltip, true);
    };
  }, [open]);

  return (
    <span
      className={styles.wrapper}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-describedby={tooltipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ borderColor: T.red, color: T.red, fontFamily: fonts.sans }}
      >
        <span aria-hidden="true">!</span>
      </button>
      {open && position && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className={styles.tooltip}
          style={{
            background: T.ink,
            color: T.paper,
            fontFamily: fonts.sans,
            left: position.left,
            top: position.top,
          }}
        >
          {message}
        </span>,
        document.body,
      )}
    </span>
  );
}
