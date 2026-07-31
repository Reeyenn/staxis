'use client';

/**
 * Browser clipboard write with a selection fallback.
 *
 * Extracted from HotelTeamDialogs when the admin Add-hotel modal gained the
 * same "copy the onboarding link" affordance: an invitation whose email
 * delivery failed is only recoverable if the link can be copied, so both
 * surfaces need the identical fallback behavior rather than two drifting
 * copies of it.
 *
 * Returns false (never throws) when neither path works, so callers can show
 * "select and copy it manually" instead of implying a successful copy.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Continue to the selection fallback below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
