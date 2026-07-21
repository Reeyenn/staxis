'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { T, fonts } from './tokens';
import styles from './ShelfValueWarning.module.css';

const TOOLTIP_WIDTH = 260;
const VIEWPORT_GUTTER = 8;

interface ShelfValueWarningProps {
  label: string;
  intro: string;
  listLabel: string;
  itemNames: readonly string[];
  resolution: string;
}

export function ShelfValueWarning({
  label,
  intro,
  listLabel,
  itemNames,
  resolution,
}: ShelfValueWarningProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const showTooltip = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setOpen(true);
  };

  const closeTooltipSoon = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 100);
  };

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

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
      onMouseEnter={showTooltip}
      onMouseLeave={closeTooltipSoon}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-describedby={tooltipId}
        onClick={showTooltip}
        onFocus={showTooltip}
        onBlur={closeTooltipSoon}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        style={{ borderColor: T.red, color: T.red, fontFamily: fonts.sans }}
      >
        <span aria-hidden="true">!</span>
      </button>
      {open && position && createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          className={styles.tooltip}
          onMouseEnter={showTooltip}
          onMouseLeave={closeTooltipSoon}
          style={{
            background: T.ink,
            color: T.paper,
            fontFamily: fonts.sans,
            left: position.left,
            top: position.top,
          }}
        >
          <p className={styles.intro}>{intro}</p>
          <p className={styles.listLabel}>{listLabel}</p>
          <ul className={styles.itemList}>
            {itemNames.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
          </ul>
          <p className={styles.resolution}>{resolution}</p>
        </div>,
        document.body,
      )}
    </span>
  );
}
