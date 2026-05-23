/**
 * MFA detection + trusted-device click + paused-auth state.
 *
 * Plan v4 architecture decision #6: handle MFA gracefully without
 * trying to automate the actual code entry. Two halves:
 *
 *   1. PROACTIVE — before submitting MFA, click any "remember this
 *      device" / "trust this browser" / "keep me signed in" checkbox.
 *      Most modern PMSes have one; once checked + saved into the
 *      long-lived session, the browser doesn't get prompted for MFA
 *      again for 30-90 days.
 *
 *   2. REACTIVE — when an MFA prompt actually appears (initial setup or
 *      trust token expired), pause the hotel and surface a manual
 *      re-login UI. Reeyen handles the code entry; cua-service waits
 *      for the storageState to be updated and resumes.
 *
 * The trusted-device selectors come from the knowledge file
 * (login.trustDeviceSelectors). Common patterns are pre-seeded as
 * defaults so the click works even on a fresh PMS without bespoke
 * mapping.
 *
 * Storage state: when Reeyen completes the manual re-login, the new
 * Playwright storageState gets pushed back into Supabase
 * (scraper_session table — reused from existing scraper) and the
 * session-driver picks up the fresh cookies on its next boot/restart.
 */

import type { Page } from 'playwright';
import { log } from './log.js';
import { supabase } from './supabase.js';

/**
 * Default trust-device selectors. Tried in order. Knowledge file can
 * override / extend via login.trustDeviceSelectors.
 *
 * Each selector pattern matches common phrasings across PMS login flows:
 * Mews, Cloudbeds, OnQ, OPERA, etc. observed in screenshots.
 */
const DEFAULT_TRUST_DEVICE_SELECTORS = [
  'input[type="checkbox"][name*="trust"]',
  'input[type="checkbox"][name*="remember"]',
  'input[type="checkbox"][id*="trust"]',
  'input[type="checkbox"][id*="remember"]',
  // Label-based fallbacks for accessible markup.
  'label:has-text("Remember this device") input[type="checkbox"]',
  'label:has-text("Trust this browser") input[type="checkbox"]',
  'label:has-text("Keep me signed in") input[type="checkbox"]',
  'label:has-text("Don\'t ask again") input[type="checkbox"]',
  // ARIA-labelled buttons that toggle a "trust" state.
  'button[aria-label*="trust" i]',
  'button[aria-label*="remember" i]',
];

/**
 * Detection patterns for MFA prompts. If ANY match appears in the page
 * during login, we treat the login as an MFA challenge.
 *
 * These match the on-screen text/labels for the most common MFA flows.
 */
const MFA_PROMPT_SELECTORS = [
  'input[name*="otp" i]',
  'input[name*="mfa" i]',
  'input[name*="2fa" i]',
  'input[name*="verification" i]',
  'input[name*="code" i][maxlength="6"]',
  'input[name*="code" i][maxlength="4"]',
  // Text-based detection — pages that show "Enter the 6-digit code"
  // without a dedicated input name.
  'text=/enter the (6|four|six)[ -]digit code/i',
  'text=/verification code/i',
  'text=/security code/i',
  'text=/two-factor/i',
  'text=/multi-factor/i',
];

/**
 * Try to click any trust-device checkbox visible on the current page.
 * Best-effort: a failure (no matching element, click intercepted, etc.)
 * is logged and ignored — the login can still proceed without trust.
 *
 * Called by the session-driver during the login step sequence, right
 * before the step that submits the MFA code (or the password if no MFA).
 */
export async function clickTrustDeviceIfPresent(
  page: Page,
  knowledgeFileSelectors: string[] = [],
): Promise<{ clicked: boolean; selector: string | null }> {
  const selectors = [...knowledgeFileSelectors, ...DEFAULT_TRUST_DEVICE_SELECTORS];

  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      const visible = await element.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;

      // For checkboxes, only click if not already checked.
      try {
        const isChecked = await element.isChecked({ timeout: 200 });
        if (isChecked) {
          log.info('mfa-handler: trust device already checked', { selector });
          return { clicked: false, selector };
        }
      } catch {
        // Not a checkbox or isChecked failed — proceed to click.
      }

      await element.click({ timeout: 2000 });
      log.info('mfa-handler: trust device clicked', { selector });
      return { clicked: true, selector };
    } catch (err) {
      log.warn('mfa-handler: trust device click failed for selector', {
        selector,
        err: err instanceof Error ? err.message : String(err),
      });
      // Try the next selector.
    }
  }

  log.info('mfa-handler: no trust-device element found on page');
  return { clicked: false, selector: null };
}

/**
 * Detect whether the current page is showing an MFA prompt. Returns the
 * matching selector for diagnostics (logged when pausing the hotel).
 */
export async function detectMfaPrompt(page: Page): Promise<{ mfa: boolean; selector: string | null }> {
  for (const selector of MFA_PROMPT_SELECTORS) {
    try {
      const element = page.locator(selector).first();
      const visible = await element.isVisible({ timeout: 300 }).catch(() => false);
      if (visible) {
        return { mfa: true, selector };
      }
    } catch {
      // Selector syntax error or transient — keep trying.
    }
  }
  return { mfa: false, selector: null };
}

/**
 * Pause the hotel because an MFA prompt was hit. Sets
 * property_sessions.status='paused_mfa' with a paused_reason that
 * surfaces in admin UI and doctor.
 *
 * The session-driver should NOT continue with the login flow after
 * this — it should release the page and wait for Reeyen to complete
 * manual re-login (which updates scraper_session in Supabase).
 */
export async function pauseForMfa(args: {
  propertyId: string;
  detectedSelector: string | null;
  loginUrl: string;
}): Promise<void> {
  const reason = `MFA prompt detected${args.detectedSelector ? ` (selector: ${args.detectedSelector})` : ''}. Manual re-login required at /admin/mfa-resume/${args.propertyId}.`;

  const { error } = await supabase
    .from('property_sessions')
    .update({
      status: 'paused_mfa',
      paused_reason: reason,
      paused_until: null,
    })
    .eq('property_id', args.propertyId);

  if (error) {
    log.error('mfa-handler: failed to mark paused_mfa', {
      propertyId: args.propertyId,
      err: error,
    });
    return;
  }

  log.warn('mfa-handler: hotel paused for MFA', {
    propertyId: args.propertyId,
    detectedSelector: args.detectedSelector,
    loginUrl: args.loginUrl,
  });
}

/**
 * Called after Reeyen completes manual re-login + uploads the fresh
 * storageState. Flips status back to 'starting' so the supervisor
 * boots a new session-driver with the new credentials.
 */
export async function resumeAfterManualLogin(propertyId: string): Promise<void> {
  const { error } = await supabase
    .from('property_sessions')
    .update({
      status: 'starting',
      paused_reason: null,
      paused_until: null,
    })
    .eq('property_id', propertyId)
    .eq('status', 'paused_mfa');

  if (error) {
    log.error('mfa-handler: failed to resume after manual login', {
      propertyId,
      err: error,
    });
    return;
  }

  log.info('mfa-handler: hotel resumed after manual MFA re-login', { propertyId });
}
