'use client';

import React from 'react';
import { Building2, Check, Hotel, Search, X } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import {
  PortfolioFactList,
  PortfolioPartialNotice,
  PortfolioStatePanel,
  PortfolioStatusChip,
} from './PortfolioPrimitives';
import { ScopeChooserSkeleton } from './PortfolioSkeletons';
import type {
  PortfolioScopeOption,
  PortfolioStateContent,
  PortfolioTextFilter,
  PortfolioViewState,
} from './types';

export interface ScopeChooserProps {
  variant: 'page' | 'dialog';
  open?: boolean;
  eyebrow?: string;
  title: string;
  description?: string;
  choices: readonly PortfolioScopeOption[];
  selectedId?: string | null;
  onSelect: (choice: PortfolioScopeOption) => void;
  onClose?: () => void;
  closeLabel?: string;
  search?: PortfolioTextFilter;
  state?: PortfolioViewState;
  stateContent?: PortfolioStateContent;
  loadingLabel?: string;
}

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden') && element.tabIndex >= 0);
}

export function ScopeChooser({
  variant,
  open = true,
  eyebrow,
  title,
  description,
  choices,
  selectedId,
  onSelect,
  onClose,
  closeLabel,
  search,
  state = 'ready',
  stateContent,
  loadingLabel = title,
}: ScopeChooserProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const panelRef = React.useRef<HTMLElement | null>(null);
  const choiceRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const selectedVisible = choices.some((choice) => choice.id === selectedId);
  const [activeId, setActiveId] = React.useState<string | null>(() => (
    selectedVisible ? selectedId ?? null : choices[0]?.id ?? null
  ));
  const previousSelectedIdRef = React.useRef(selectedId);
  const preferredFocusIdRef = React.useRef<string | null>(null);
  const dialogWasOpenRef = React.useRef(false);

  const activeVisible = choices.some((choice) => choice.id === activeId);
  const selectedOrFirstId = selectedVisible ? selectedId ?? null : choices[0]?.id ?? null;
  const dialogOpening = variant === 'dialog' && open && !dialogWasOpenRef.current;
  const renderedActiveId = dialogOpening
    ? selectedOrFirstId
    : activeVisible
    ? activeId
    : selectedVisible
      ? selectedId ?? null
      : choices[0]?.id ?? null;
  preferredFocusIdRef.current = renderedActiveId;

  React.useEffect(() => {
    const opening = variant === 'dialog' && open && !dialogWasOpenRef.current;
    dialogWasOpenRef.current = variant === 'dialog' && open;
    if (opening) setActiveId(selectedOrFirstId);
  }, [open, selectedOrFirstId, variant]);

  React.useEffect(() => {
    const selectedIdChanged = previousSelectedIdRef.current !== selectedId;
    previousSelectedIdRef.current = selectedId;
    setActiveId((currentId) => {
      if (selectedIdChanged && selectedVisible) return selectedId ?? null;
      if (choices.some((choice) => choice.id === currentId)) return currentId;
      return selectedVisible ? selectedId ?? null : choices[0]?.id ?? null;
    });
  }, [choices, selectedId, selectedVisible]);

  React.useEffect(() => {
    if (variant !== 'dialog' || !open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferredChoice = choiceRefs.current.get(preferredFocusIdRef.current ?? '');
      const target = preferredChoice ?? focusableWithin(panel)[0] ?? panel;
      // Native focus scrolling keeps a selected company below a long list's
      // fold visible. `preventScroll` here could open with focus offscreen.
      target.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [open, variant]);

  if (variant === 'dialog' && !open) return null;

  const moveChoiceFocus = (
    currentId: string,
    delta: number | 'first' | 'last',
  ) => {
    if (choices.length === 0) return;
    const current = Math.max(0, choices.findIndex((choice) => choice.id === currentId));
    const nextIndex = delta === 'first'
      ? 0
      : delta === 'last'
        ? choices.length - 1
        : (current + delta + choices.length) % choices.length;
    const nextChoice = choices[nextIndex];
    setActiveId(nextChoice.id);
    choiceRefs.current.get(nextChoice.id)?.focus();
  };

  const activateChoice = (choice: PortfolioScopeOption) => {
    setActiveId(choice.id);
    onSelect(choice);
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (variant !== 'dialog') return;
    if (event.key === 'Escape' && onClose) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = focusableWithin(panelRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === panelRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const content = (
    <section
      ref={panelRef}
      className={`${styles.themeScope} ${styles.scopeChooser}`}
      data-variant={variant}
      role={variant === 'dialog' ? 'dialog' : undefined}
      aria-modal={variant === 'dialog' ? 'true' : undefined}
      tabIndex={variant === 'dialog' ? -1 : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={handlePanelKeyDown}
    >
      <header className={styles.scopeHeader}>
        <div>
          {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
          <h1 id={titleId}>{title}</h1>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        {variant === 'dialog' && onClose ? (
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label={closeLabel ?? `Close ${title}`}
          >
            <X size={19} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {search ? (
        <label className={`${styles.fieldLabel} ${styles.scopeSearch}`}>
          <span>{search.label}</span>
          <span className={styles.inputShell}>
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={search.value}
              placeholder={search.placeholder}
              onChange={(event) => search.onChange(event.target.value)}
            />
          </span>
        </label>
      ) : null}

      {state === 'partial' && stateContent ? <PortfolioPartialNotice content={stateContent} /> : null}
      {state === 'loading' ? <ScopeChooserSkeleton label={loadingLabel} /> : null}
      {(state === 'empty' || state === 'error' || state === 'unauthorized') && stateContent ? (
        <PortfolioStatePanel state={state} content={stateContent} />
      ) : null}
      {(state === 'ready' || state === 'partial') && choices.length > 0 ? (
        <div className={styles.scopeOptions} role="radiogroup" aria-label={title}>
          {choices.map((choice) => {
            const selected = choice.id === renderedActiveId;
            const Icon = choice.kind === 'portfolio' ? Building2 : Hotel;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                key={choice.id}
                ref={(node) => {
                  if (node) choiceRefs.current.set(choice.id, node);
                  else choiceRefs.current.delete(choice.id);
                }}
                className={styles.scopeOption}
                data-selected={selected ? 'true' : undefined}
                onClick={() => activateChoice(choice)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    moveChoiceFocus(choice.id, 1);
                  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    moveChoiceFocus(choice.id, -1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    moveChoiceFocus(choice.id, 'first');
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    moveChoiceFocus(choice.id, 'last');
                  } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (!event.repeat) activateChoice(choice);
                  }
                }}
              >
                <span className={styles.scopeOptionIcon} aria-hidden="true"><Icon size={20} /></span>
                <span className={styles.scopeOptionBody}>
                  <span className={styles.scopeOptionTopline}>
                    <span className={styles.eyebrow}>{choice.eyebrow}</span>
                    {choice.status ? <PortfolioStatusChip status={choice.status} /> : null}
                  </span>
                  <strong>{choice.name}</strong>
                  <span className={styles.secondaryLabel}>{choice.secondaryLabel}</span>
                  {choice.facts && choice.facts.length > 0 ? <PortfolioFactList facts={choice.facts} /> : null}
                </span>
                <span className={styles.scopeCheck} aria-hidden="true">{selected ? <Check size={17} /> : null}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );

  if (variant === 'page') return <div className={`${styles.themeScope} ${styles.scopePage}`}>{content}</div>;
  return (
    <div
      className={styles.scopeScrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {content}
    </div>
  );
}
