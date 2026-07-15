import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstallUrl,
  detectInstallPlatform,
  isAndroidInstallPlatform,
  isIosInstallPlatform,
  isStandaloneMode,
  shouldShowMobileInstallReminder,
} from '@/lib/pwa-install';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';

describe('detectInstallPlatform', () => {
  it('detects Safari on iPhone', () => {
    assert.equal(
      detectInstallPlatform({ userAgent: IPHONE_SAFARI, platform: 'iPhone' }),
      'ios-safari',
    );
  });

  it('routes third-party iPhone browsers to the Safari handoff', () => {
    assert.equal(
      detectInstallPlatform({ userAgent: IPHONE_CHROME, platform: 'iPhone' }),
      'ios-non-safari',
    );
    assert.equal(
      detectInstallPlatform({
        userAgent: IPHONE_CHROME.replace('CriOS/126.0.6478.54', 'FxiOS/127.0'),
        platform: 'iPhone',
      }),
      'ios-non-safari',
    );
  });

  it('recognizes iPadOS when it reports a desktop Mac user agent', () => {
    assert.equal(
      detectInstallPlatform({
        userAgent: IPAD_DESKTOP_SAFARI,
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
      'ios-safari',
    );
  });

  it('does not mistake a real Mac for an iPad', () => {
    assert.equal(
      detectInstallPlatform({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
      'desktop',
    );
  });

  it('separates Chrome, Samsung Internet, and other Android browsers', () => {
    assert.equal(
      detectInstallPlatform({ userAgent: ANDROID_CHROME }),
      'android-chrome',
    );
    assert.equal(
      detectInstallPlatform({ userAgent: ANDROID_SAMSUNG }),
      'android-samsung',
    );
    assert.equal(
      detectInstallPlatform({
        userAgent:
          'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0',
      }),
      'android-other',
    );
  });

  it('uses desktop and generic-mobile fallbacks', () => {
    assert.equal(
      detectInstallPlatform({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
      }),
      'desktop',
    );
    assert.equal(
      detectInstallPlatform({ userAgent: 'ExampleBrowser/1.0 Mobile' }),
      'other',
    );
  });
});

describe('standalone and platform helpers', () => {
  it('accepts either standards-based or iOS standalone state', () => {
    assert.equal(isStandaloneMode({}), false);
    assert.equal(isStandaloneMode({ displayModeStandalone: true }), true);
    assert.equal(isStandaloneMode({ navigatorStandalone: true }), true);
  });

  it('groups mobile platform variants', () => {
    assert.equal(isIosInstallPlatform('ios-safari'), true);
    assert.equal(isIosInstallPlatform('desktop'), false);
    assert.equal(isAndroidInstallPlatform('android-samsung'), true);
    assert.equal(isAndroidInstallPlatform('other'), false);
  });

  it('keeps the reminder mobile-only until installation succeeds', () => {
    assert.equal(shouldShowMobileInstallReminder('ios-safari', false), true);
    assert.equal(shouldShowMobileInstallReminder('ios-non-safari', false), true);
    assert.equal(shouldShowMobileInstallReminder('android-chrome', false), true);
    assert.equal(shouldShowMobileInstallReminder('android-samsung', false), true);
    assert.equal(shouldShowMobileInstallReminder('other', false), true);
    assert.equal(shouldShowMobileInstallReminder('desktop', false), false);
    assert.equal(shouldShowMobileInstallReminder('ios-safari', true), false);
    assert.equal(shouldShowMobileInstallReminder('android-chrome', true), false);
  });
});

describe('createInstallUrl', () => {
  it('always targets the stable /home install start page', () => {
    assert.equal(createInstallUrl('https://staxis.example'), 'https://staxis.example/home');
    assert.equal(
      createInstallUrl('https://staxis.example/current/path'),
      'https://staxis.example/home',
    );
  });

  it('falls back to a relative path for an invalid origin', () => {
    assert.equal(createInstallUrl('not an origin'), '/home');
  });
});
