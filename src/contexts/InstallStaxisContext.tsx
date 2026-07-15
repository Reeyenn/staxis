'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  createInstallUrl,
  detectInstallPlatform,
  isStandaloneMode,
  type InstallPlatform,
} from '@/lib/pwa-install';

export type InstallOutcome =
  | 'accepted'
  | 'dismissed'
  | 'unavailable'
  | 'installed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

export interface InstallStaxisContextValue {
  platform: InstallPlatform;
  installed: boolean;
  canPrompt: boolean;
  install: () => Promise<InstallOutcome>;
  copyInstallUrl: () => Promise<boolean>;
}

const InstallStaxisContext = createContext<InstallStaxisContextValue | null>(
  null,
);

function readStandaloneState(mediaQuery: MediaQueryList): boolean {
  return isStandaloneMode({
    displayModeStandalone: mediaQuery.matches,
    navigatorStandalone: Boolean(
      (navigator as NavigatorWithStandalone).standalone,
    ),
  });
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Some browsers expose clipboard but reject it outside a secure context.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.inset = '0 auto auto -9999px';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textArea.remove();
  }
}

export function InstallStaxisProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Default to desktop for SSR. The account menu is closed during hydration,
  // then the effect resolves the real device before it can be interacted with.
  const [platform, setPlatform] = useState<InstallPlatform>('desktop');
  const [installed, setInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const browserNavigator = navigator as NavigatorWithStandalone;

    setPlatform(
      detectInstallPlatform({
        userAgent: browserNavigator.userAgent,
        platform: browserNavigator.platform,
        maxTouchPoints: browserNavigator.maxTouchPoints,
      }),
    );
    setInstalled(readStandaloneState(mediaQuery));

    const handleBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      installEvent.preventDefault();
      setDeferredPrompt(installEvent);
    };
    const handleInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };
    const handleDisplayModeChange = () => {
      setInstalled(readStandaloneState(mediaQuery));
    };

    window.addEventListener(
      'beforeinstallprompt',
      handleBeforeInstallPrompt,
    );
    window.addEventListener('appinstalled', handleInstalled);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleDisplayModeChange);
    } else {
      mediaQuery.addListener(handleDisplayModeChange);
    }

    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      );
      window.removeEventListener('appinstalled', handleInstalled);
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleDisplayModeChange);
      } else {
        mediaQuery.removeListener(handleDisplayModeChange);
      }
    };
  }, []);

  const install = useCallback(async (): Promise<InstallOutcome> => {
    if (installed) return 'installed';
    if (!deferredPrompt) return 'unavailable';

    const prompt = deferredPrompt;

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setDeferredPrompt((current) => (current === prompt ? null : current));
      return choice.outcome;
    } catch {
      setDeferredPrompt((current) => (current === prompt ? null : current));
      return 'unavailable';
    }
  }, [deferredPrompt, installed]);

  const copyInstallUrl = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    return copyText(createInstallUrl(window.location.origin));
  }, []);

  const value = useMemo<InstallStaxisContextValue>(
    () => ({
      platform,
      installed,
      canPrompt: Boolean(deferredPrompt) && !installed,
      install,
      copyInstallUrl,
    }),
    [copyInstallUrl, deferredPrompt, install, installed, platform],
  );

  return (
    <InstallStaxisContext.Provider value={value}>
      {children}
    </InstallStaxisContext.Provider>
  );
}

export function useInstallStaxis(): InstallStaxisContextValue {
  const context = useContext(InstallStaxisContext);
  if (!context) {
    throw new Error(
      'useInstallStaxis must be used within an InstallStaxisProvider',
    );
  }
  return context;
}
