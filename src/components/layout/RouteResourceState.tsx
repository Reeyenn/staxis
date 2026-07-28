'use client';

import { createPortal } from 'react-dom';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import styles from './RouteResourceState.module.css';

interface RouteLoadingStateProps {
  title?: string;
  message?: string;
}

interface RouteErrorStateProps {
  title?: string;
  message?: string;
  retryLabel?: string;
  onRetry: () => void;
}

export function RouteLoadingState({
  title = 'Opening this page…',
  message = 'Getting the latest hotel information.',
}: RouteLoadingStateProps) {
  return (
    <div className={styles.frame} role="status" aria-live="polite" aria-busy="true">
      <div className={styles.card}>
        <div className={styles.copy}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.message}>{message}</p>
        </div>
        <div className={styles.progressTrack} aria-hidden="true">
          <div className={styles.progressBar} />
        </div>
      </div>
    </div>
  );
}

export function RouteErrorState({
  title = 'This page could not finish loading',
  message = 'Your hotel data was not changed. Check your connection and try again.',
  retryLabel = 'Try again',
  onRetry,
}: RouteErrorStateProps) {
  return (
    <div className={styles.frame} role="alert" aria-live="assertive">
      <div className={styles.card}>
        <div className={styles.statusRow}>
          <span className={styles.iconWrap} aria-hidden="true">
            <AlertTriangle size={20} strokeWidth={1.8} />
          </span>
          <div className={styles.copy}>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.message}>{message}</p>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={onRetry}>
            <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            {retryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NavigationFailureNotice({
  lang,
  onRetry,
  onOpenDirectly,
}: {
  lang: 'en' | 'es';
  onRetry: () => void;
  onOpenDirectly: () => void;
}) {
  const es = lang === 'es';
  return (
    <div className={styles.navigationToast} role="alert" aria-live="assertive">
      <span className={styles.iconWrap} aria-hidden="true">
        <AlertTriangle size={20} strokeWidth={1.8} />
      </span>
      <div className={styles.toastCopy}>
        <div className={styles.toastTitle}>{es ? 'La página está tardando demasiado' : 'This page is taking too long'}</div>
        <p className={styles.toastMessage}>
          {es ? 'Puedes reintentar sin perder tu página actual.' : 'You can retry without losing your current page.'}
        </p>
      </div>
      <div className={styles.toastActions}>
        <button type="button" className={styles.toastButton} onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          {es ? 'Reintentar' : 'Try again'}
        </button>
        <button type="button" className={styles.toastSecondary} onClick={onOpenDirectly}>
          <ExternalLink size={14} aria-hidden="true" />
          {es ? 'Abrir directamente' : 'Open directly'}
        </button>
      </div>
    </div>
  );
}

export function NavigationFailurePortal({
  visible,
  lang,
  onRetry,
  onOpenDirectly,
}: {
  visible: boolean;
  lang: 'en' | 'es';
  onRetry: () => void;
  onOpenDirectly: () => void;
}) {
  if (!visible || typeof document === 'undefined') return null;
  return createPortal(
    <NavigationFailureNotice
      lang={lang}
      onRetry={onRetry}
      onOpenDirectly={onOpenDirectly}
    />,
    document.body,
  );
}
