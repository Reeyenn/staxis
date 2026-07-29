'use client';

import React from 'react';
import { ArrowLeft, Building2, ChevronsUpDown, Hotel } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import { PortfolioActionControl } from './PortfolioPrimitives';
import type { PortfolioAction, PortfolioScopeKind } from './types';

export interface PortfolioReturnControlProps {
  action: PortfolioAction;
}

export function PortfolioReturnControl({ action }: PortfolioReturnControlProps) {
  return (
    <PortfolioActionControl action={action} className={styles.returnControl}>
      <ArrowLeft size={16} aria-hidden="true" />
      <span>{action.label}</span>
    </PortfolioActionControl>
  );
}

export interface ContextBannerProps {
  kind: PortfolioScopeKind;
  contextLabel: string;
  scopeName: string;
  secondaryLabel?: string;
  returnAction?: PortfolioAction;
  switchAction?: PortfolioAction;
}

/** Explicitly names whether the reader is in Company or Property scope. */
export function ContextBanner({
  kind,
  contextLabel,
  scopeName,
  secondaryLabel,
  returnAction,
  switchAction,
}: ContextBannerProps) {
  const Icon = kind === 'portfolio' ? Building2 : Hotel;
  return (
    <div className={`${styles.themeScope} ${styles.contextRail}`} data-context-kind={kind}>
      {returnAction ? <PortfolioReturnControl action={returnAction} /> : null}
      <div className={styles.contextBanner}>
        <span className={styles.contextIcon} aria-hidden="true"><Icon size={18} /></span>
        <div className={styles.contextCopy}>
          <span className={styles.contextLabel}>{contextLabel}</span>
          <strong>{scopeName}</strong>
          {secondaryLabel ? <span className={styles.contextSecondary}>{secondaryLabel}</span> : null}
        </div>
        {switchAction ? (
          <PortfolioActionControl action={switchAction} className={styles.switchControl}>
            <ChevronsUpDown size={16} aria-hidden="true" />
            <span>{switchAction.label}</span>
          </PortfolioActionControl>
        ) : null}
      </div>
    </div>
  );
}
