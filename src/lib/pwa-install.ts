export const INSTALL_START_PATH = '/home';

export type InstallPlatform =
  | 'ios-safari'
  | 'ios-non-safari'
  | 'android-chrome'
  | 'android-samsung'
  | 'android-other'
  | 'desktop'
  | 'other';

export interface InstallPlatformInput {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface StandaloneModeInput {
  displayModeStandalone?: boolean;
  navigatorStandalone?: boolean;
}

const IOS_DEVICE_PATTERN = /iPad|iPhone|iPod/i;
const MOBILE_PATTERN = /Mobi|Mobile|Tablet/i;
const IOS_NON_SAFARI_PATTERN =
  /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Ddg\/|GSA\/|YaBrowser|Coast\/|FBAN|FBAV|Instagram/i;
const ANDROID_CHROME_PATTERN = /(?:Chrome|Chromium)\/[\d.]+/i;
const ANDROID_NON_CHROME_PATTERN =
  /EdgA\/|OPR\/|Opera|Firefox\/|DuckDuckGo|YaBrowser|;\s*wv\)/i;

/**
 * Detects the browser family needed by the install UI. The function is pure
 * so server rendering and node tests never need browser globals.
 */
export function detectInstallPlatform({
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
}: InstallPlatformInput): InstallPlatform {
  const isIPadDesktopMode =
    /MacIntel|Macintosh/i.test(platform || userAgent) && maxTouchPoints > 1;
  const isIos = IOS_DEVICE_PATTERN.test(userAgent) || isIPadDesktopMode;

  if (isIos) {
    const isSafari =
      /Safari\//i.test(userAgent) &&
      /Version\/[\d.]+/i.test(userAgent) &&
      !IOS_NON_SAFARI_PATTERN.test(userAgent);

    return isSafari ? 'ios-safari' : 'ios-non-safari';
  }

  if (/Android/i.test(userAgent)) {
    if (/SamsungBrowser\//i.test(userAgent)) return 'android-samsung';

    if (
      ANDROID_CHROME_PATTERN.test(userAgent) &&
      !ANDROID_NON_CHROME_PATTERN.test(userAgent)
    ) {
      return 'android-chrome';
    }

    return 'android-other';
  }

  if (MOBILE_PATTERN.test(userAgent)) return 'other';
  return 'desktop';
}

/** Returns true when Staxis is already running as an installed web app. */
export function isStandaloneMode({
  displayModeStandalone = false,
  navigatorStandalone = false,
}: StandaloneModeInput): boolean {
  return displayModeStandalone || navigatorStandalone;
}

/** Builds the stable page URL copied by the install card. */
export function createInstallUrl(origin: string): string {
  try {
    return new URL(INSTALL_START_PATH, origin).toString();
  } catch {
    return INSTALL_START_PATH;
  }
}

export function isIosInstallPlatform(platform: InstallPlatform): boolean {
  return platform === 'ios-safari' || platform === 'ios-non-safari';
}

export function isAndroidInstallPlatform(platform: InstallPlatform): boolean {
  return platform.startsWith('android-');
}

/**
 * The account menu keeps the reminder available after a dismissed install.
 * Desktop has its separate phone-handoff action, so only mobile platforms
 * receive this entry and an installed app never does.
 */
export function shouldShowMobileInstallReminder(
  platform: InstallPlatform,
  installed: boolean,
): boolean {
  if (installed || platform === 'desktop') return false;
  return isIosInstallPlatform(platform) || isAndroidInstallPlatform(platform) || platform === 'other';
}
