'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import {
  PortfolioActionControl,
  PortfolioProgress,
  PortfolioStatusChip,
} from './PortfolioPrimitives';
import type {
  PortfolioAction,
  PortfolioProgressData,
  PortfolioStatus,
  PortfolioTone,
} from './types';

export interface PortfolioStatusSignal {
  id: string;
  label: string;
  value: string;
  tone?: PortfolioTone;
}

export interface PortfolioStatusCardProps {
  eyebrow: string;
  title: string;
  description?: string;
  asOfLabel?: string;
  status?: PortfolioStatus | null;
  signals?: readonly PortfolioStatusSignal[];
  progress?: PortfolioProgressData;
  action: PortfolioAction;
}

/** A concise, evidence-labelled route into Staxis; never computes a score. */
export function PortfolioStatusCard({
  eyebrow,
  title,
  description,
  asOfLabel,
  status,
  signals = [],
  progress,
  action,
}: PortfolioStatusCardProps) {
  const titleId = React.useId();
  return (
    <article className={`${styles.themeScope} ${styles.statusCard}`} aria-labelledby={titleId}>
      <div className={styles.statusCardMark} aria-hidden="true"><Sparkles size={20} /></div>
      <div className={styles.statusCardBody}>
        <div className={styles.statusCardHeading}>
          <div>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          {status ? <PortfolioStatusChip status={status} /> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {signals.length > 0 ? (
          <dl className={styles.signalList}>
            {signals.map((signal) => (
              <div key={signal.id} data-tone={signal.tone ?? 'neutral'}>
                <dt>{signal.label}</dt>
                <dd>{signal.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {progress ? <PortfolioProgress progress={progress} /> : null}
        {asOfLabel ? <span className={styles.asOfLabel}>{asOfLabel}</span> : null}
      </div>
      <PortfolioActionControl action={action} className={styles.primaryAction} />
    </article>
  );
}
