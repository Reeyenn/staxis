'use client';

import React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Inbox,
  ShieldAlert,
  X,
} from 'lucide-react';

import styles from './PortfolioUI.module.css';
import type {
  PortfolioAction,
  PortfolioFact,
  PortfolioProgressData,
  PortfolioStateContent,
  PortfolioStatus,
  PortfolioTone,
  PortfolioViewState,
} from './types';

export function PortfolioActionControl({
  action,
  className,
  children,
}: {
  action: PortfolioAction;
  className?: string;
  children?: React.ReactNode;
}) {
  const content = children ?? (
    <>
      <span>{action.label}</span>
      <ArrowRight size={16} aria-hidden="true" />
    </>
  );
  const classes = [styles.actionControl, className].filter(Boolean).join(' ');

  if ('href' in action && action.href) {
    if (action.disabled) {
      return (
        <button className={classes} type="button" aria-label={action.ariaLabel} disabled>
          {content}
        </button>
      );
    }
    return (
      <Link className={classes} href={action.href} aria-label={action.ariaLabel} onClick={action.onActivate}>
        {content}
      </Link>
    );
  }

  return (
    <button
      className={classes}
      type="button"
      aria-label={action.ariaLabel}
      disabled={action.disabled}
      onClick={action.onActivate}
    >
      {content}
    </button>
  );
}

export function PortfolioStatusChip({ status }: { status: PortfolioStatus }) {
  return (
    <span
      className={styles.statusChip}
      data-tone={status.tone}
      aria-label={status.ariaLabel ?? status.label}
      title={status.detail}
    >
      <span className={styles.statusDot} aria-hidden="true" />
      <span>{status.label}</span>
    </span>
  );
}

export function PortfolioFactList({ facts }: { facts: readonly PortfolioFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className={styles.factList}>
      {facts.map((fact) => (
        <div key={`${fact.label}:${fact.value}`} className={styles.fact}>
          <dt>{fact.label}</dt>
          <dd data-emphasis={fact.emphasis ? 'true' : undefined}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PortfolioProgress({ progress }: { progress: PortfolioProgressData }) {
  const max = Number.isFinite(progress.max) && progress.max > 0 ? progress.max : 1;
  const value = Number.isFinite(progress.value)
    ? Math.min(Math.max(progress.value, 0), max)
    : 0;

  return (
    <div className={styles.progressBlock} data-tone={progress.tone ?? 'info'}>
      <div className={styles.progressHeader}>
        <span>{progress.label}</span>
        <span>{progress.valueLabel}</span>
      </div>
      <progress
        className={styles.progress}
        value={value}
        max={max}
        aria-label={`${progress.label}: ${progress.valueLabel}`}
      />
    </div>
  );
}

const STATE_ICON = {
  empty: Inbox,
  error: AlertTriangle,
  unauthorized: ShieldAlert,
} as const;

export function PortfolioStatePanel({
  state,
  content,
  compact = false,
}: {
  state: Extract<PortfolioViewState, 'empty' | 'error' | 'unauthorized'>;
  content: PortfolioStateContent;
  compact?: boolean;
}) {
  const titleId = React.useId();
  const Icon = STATE_ICON[state];
  return (
    <section
      className={styles.statePanel}
      data-state={state}
      data-compact={compact ? 'true' : undefined}
      role={state === 'error' || state === 'unauthorized' ? 'alert' : 'status'}
      aria-labelledby={titleId}
    >
      <span className={styles.stateIcon} aria-hidden="true"><Icon size={22} /></span>
      <div className={styles.stateCopy}>
        <h2 id={titleId}>{content.title}</h2>
        {content.description ? <p>{content.description}</p> : null}
        {content.guidance ? <p className={styles.stateGuidance}>{content.guidance}</p> : null}
        {content.action ? (
          <PortfolioActionControl action={content.action} className={styles.secondaryAction} />
        ) : null}
      </div>
    </section>
  );
}

export function PortfolioPartialNotice({ content }: { content: PortfolioStateContent }) {
  return (
    <div className={styles.partialNotice} role="status" aria-live="polite">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{content.title}</strong>
        {content.description ? <span>{content.description}</span> : null}
      </div>
      {content.action ? (
        <PortfolioActionControl action={content.action} className={styles.noticeAction} />
      ) : null}
    </div>
  );
}

export interface PortfolioToastProps {
  tone: Extract<PortfolioTone, 'neutral' | 'positive' | 'warning' | 'critical'>;
  title: string;
  message?: string;
  dismissLabel: string;
  onDismiss: () => void;
}

export function PortfolioToast({
  tone,
  title,
  message,
  dismissLabel,
  onDismiss,
}: PortfolioToastProps) {
  const Icon = tone === 'positive' ? CheckCircle2 : tone === 'critical' ? AlertTriangle : CircleAlert;
  return (
    <div
      className={styles.toast}
      data-tone={tone}
      role={tone === 'critical' ? 'alert' : 'status'}
    >
      <Icon size={19} aria-hidden="true" />
      <div className={styles.toastCopy}>
        <strong>{title}</strong>
        {message ? <span>{message}</span> : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label={dismissLabel}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

export function PortfolioToastRegion({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.toastRegion} role="region" aria-label={label}>
      {children}
    </div>
  );
}
