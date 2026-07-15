'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Download,
  Loader2,
  MoreVertical,
  Share,
  SquarePlus,
  Smartphone,
  X,
} from 'lucide-react';
import { useInstallStaxis } from '@/contexts/InstallStaxisContext';
import {
  IOS_INSTALL_STEPS,
  isAndroidInstallPlatform,
} from '@/lib/pwa-install';
import styles from './InstallStaxisCard.module.css';

export interface InstallStaxisCardProps {
  onDismiss?: () => void;
  compact?: boolean;
  appearance?: 'light' | 'dark';
}

interface InstallStepProps {
  icon: ReactNode;
  title: string;
  detail?: string;
  number?: number;
}

function InstallStep({ icon, title, detail, number }: InstallStepProps) {
  const numbered = number !== undefined;

  return (
    <li
      className={`${styles.step} ${numbered ? styles.numberedStep : ''}`}
    >
      {numbered ? (
        <span className={styles.stepNumber} aria-hidden="true">
          {number}
        </span>
      ) : null}
      <span className={styles.stepIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.stepCopy}>
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
    </li>
  );
}

function IosInstallSteps() {
  return (
    <ol
      className={styles.steps}
      role="list"
      aria-label="Install Staxis in Safari in three steps"
    >
      <InstallStep
        number={IOS_INSTALL_STEPS[0].number}
        icon={<Share size={18} strokeWidth={2} />}
        title={IOS_INSTALL_STEPS[0].label}
      />
      <InstallStep
        number={IOS_INSTALL_STEPS[1].number}
        icon={<SquarePlus size={18} strokeWidth={2} />}
        title={IOS_INSTALL_STEPS[1].label}
      />
      <InstallStep
        number={IOS_INSTALL_STEPS[2].number}
        icon={<span className={styles.addAction}>Add</span>}
        title={IOS_INSTALL_STEPS[2].label}
      />
    </ol>
  );
}

export function InstallStaxisCard({
  onDismiss,
  compact = false,
  appearance = 'light',
}: InstallStaxisCardProps) {
  const { platform, installed, canPrompt, install, copyInstallUrl } =
    useInstallStaxis();
  const titleId = useId();
  const [installing, setInstalling] = useState(false);
  const [copyState, setCopyState] = useState<
    'idle' | 'copying' | 'copied' | 'failed'
  >('idle');
  const [status, setStatus] = useState('');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setStatus('');

    const outcome = await install();
    if (outcome === 'accepted') {
      setStatus('Installation started. Follow the browser confirmation.');
    } else if (outcome === 'dismissed') {
      setStatus('Install was canceled. You can try again any time.');
    } else if (outcome === 'installed') {
      setStatus('Staxis is already installed.');
    } else {
      setStatus('Use the browser steps below to finish installing.');
    }
    setInstalling(false);
  };

  const handleCopy = async () => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    setStatus('');

    const copied = await copyInstallUrl();
    setCopyState(copied ? 'copied' : 'failed');
    setStatus(
      copied
        ? 'Copied. Open Safari and paste the link.'
        : 'Open this page in Safari instead.',
    );

    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState('idle'), 3000);
  };

  const isIosSafari = platform === 'ios-safari';
  const isIosNonSafari = platform === 'ios-non-safari';
  const isAndroid = isAndroidInstallPlatform(platform);
  const promptAvailable = canPrompt && !isIosSafari && !isIosNonSafari;

  let eyebrow = 'Install Staxis';
  let title = 'Keep Staxis one tap away';
  let description =
    'Add Staxis to this device for a faster, full-screen app experience.';
  let icon: ReactNode = <Download size={22} strokeWidth={2} />;

  if (installed) {
    eyebrow = 'Ready to use';
    title = 'Staxis is installed';
    description = 'Open it from this device’s home screen or app launcher.';
    icon = <Check size={22} strokeWidth={2.2} />;
  } else if (isIosSafari) {
    eyebrow = 'Install on iPhone';
    title = 'Add Staxis to your Home Screen';
    description = 'In Safari, do these 3 steps:';
    icon = <Smartphone size={22} strokeWidth={2} />;
  } else if (isIosNonSafari) {
    eyebrow = 'Install on iPhone';
    title = 'Open Staxis in Safari';
    description = 'Copy this link. Open Safari and paste it.';
    icon = <Smartphone size={22} strokeWidth={2} />;
  } else if (promptAvailable && isAndroid) {
    eyebrow = 'Install on Android';
    title = 'Add Staxis to this phone';
    description =
      'Install the web app for quick access without searching for this page.';
    icon = <Smartphone size={22} strokeWidth={2} />;
  } else if (promptAvailable && platform === 'desktop') {
    eyebrow = 'Install on desktop';
    title = 'Add Staxis to this computer';
    description =
      'Open Staxis like a desktop app from your dock, taskbar, or launcher.';
  } else if (isAndroid) {
    eyebrow = 'Install on Android';
    title = 'Add Staxis to this phone';
    icon = <Smartphone size={22} strokeWidth={2} />;
  } else if (platform === 'desktop') {
    eyebrow = 'Install on desktop';
    title = 'Add Staxis to this computer';
  }

  return (
    <article
      className={`${styles.card} ${compact ? styles.compact : ''} ${
        installed ? styles.installed : ''
      } ${appearance === 'dark' ? styles.darkAppearance : ''}`}
      aria-labelledby={titleId}
      aria-busy={installing || copyState === 'copying'}
    >
      {onDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss install Staxis"
        >
          <X size={18} aria-hidden="true" />
        </button>
      ) : null}

      <div className={styles.header}>
        <span className={styles.brandIcon} aria-hidden="true">
          {icon}
        </span>
        <span className={styles.headingCopy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        </span>
      </div>

      <p className={styles.description}>{description}</p>

      {installed ? (
        <div className={styles.successMessage} role="status">
          <Check size={17} aria-hidden="true" />
          <span>No setup needed on this device.</span>
        </div>
      ) : null}

      {!installed && isIosSafari ? (
        <IosInstallSteps />
      ) : null}

      {!installed && isIosNonSafari ? (
        <>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleCopy}
            disabled={copyState === 'copying'}
          >
            {copyState === 'copying' ? (
              <Loader2 className={styles.spinner} size={18} aria-hidden="true" />
            ) : copyState === 'copied' ? (
              <Check size={18} aria-hidden="true" />
            ) : (
              <Copy size={18} aria-hidden="true" />
            )}
            {copyState === 'copying'
              ? 'Copying…'
              : copyState === 'copied'
                ? 'Link copied'
                : 'Copy link'}
          </button>
          <p className={styles.stepsLabel}>Then in Safari:</p>
          <IosInstallSteps />
        </>
      ) : null}

      {!installed && promptAvailable ? (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleInstall}
          disabled={installing}
        >
          {installing ? (
            <Loader2 className={styles.spinner} size={18} aria-hidden="true" />
          ) : (
            <Download size={18} aria-hidden="true" />
          )}
          {installing ? 'Opening installer…' : 'Install Staxis'}
        </button>
      ) : null}

      {!installed && !promptAvailable && isAndroid ? (
        <ol className={styles.steps}>
          <InstallStep
            icon={<MoreVertical size={18} />}
            title="Open the browser menu"
            detail="Tap the three-dot menu in Chrome or Samsung Internet."
          />
          <InstallStep
            icon={<Download size={18} />}
            title="Choose Install app"
            detail="It may also appear as Add to Home screen."
          />
        </ol>
      ) : null}

      {!installed && !promptAvailable && platform === 'desktop' ? (
        <ol className={styles.steps}>
          <InstallStep
            icon={<Download size={18} />}
            title="Find the install option"
            detail="Use the install icon in the address bar or open the browser menu."
          />
          <InstallStep
            icon={<Check size={18} />}
            title="Confirm Install"
            detail="Staxis will appear in your dock, taskbar, or app launcher."
          />
        </ol>
      ) : null}

      {!installed && !promptAvailable && platform === 'other' ? (
        <ol className={styles.steps}>
          <InstallStep
            icon={<MoreVertical size={18} />}
            title="Open your browser menu"
            detail="Look for Install app or Add to Home screen."
          />
        </ol>
      ) : null}

      {status ? (
        <p className={styles.status} role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
    </article>
  );
}
