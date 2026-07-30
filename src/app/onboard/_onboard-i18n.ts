/**
 * English-only strings for the user-facing copy added to the
 * onboarding wizard (Step 1 welcome, Step 3 verify-email recovery, and the
 * optional hotel context step). Co-located with the page to avoid touching the
 * large shared translations file. The Lang input remains compatible with the
 * existing caller, while this project intentionally returns English for both
 * accepted legacy values.
 *
 * Scope: only the strings introduced by the 2026-06-26 onboarding hardening
 * pass. The rest of the wizard's pre-existing copy is unchanged.
 *
 */

type Lang = 'en' | 'es';

const STRINGS = {
  en: {
    // Step 1 — welcome
    welcomeSteps:
      "We'll help you create your account, confirm the hotel details, and share anything Staxis should know. It only takes a few minutes.",

    // Step 5 — tell Staxis about your hotel (optional, skippable)
    contextTitle: 'Anything we should know? (optional)',
    contextBody:
      'Tell Staxis about your hotel in your own words: how things run, who to call, what keeps breaking. One or two sentences is plenty. You can skip this and do it any time from the Staxis tab.',
    contextPlaceholder:
      'e.g. Breakfast runs 6–9. Ace Plumbing handles anything with water. The third-floor ice machine fails every summer.',
    contextSkip: 'Skip for now',
    contextSubmit: 'Add this →',
    contextSubmitting: 'Reading…',
    contextFailed:
      "Staxis couldn't read that just now. You can skip and add it later from the Staxis tab.",
    contextNote:
      'Whatever you write becomes a short list of facts you review and confirm later: nothing is treated as certain until you say so.',

    // Step 3 — verify-email recovery (tab was closed, session lost)
    resumeTitle: 'You already started setting up',
    resumeBody:
      'It looks like your account is already created. Sign in with the email and password you chose to pick up right where you left off.',
    resumeSignInBtn: 'Sign in to continue →',
    sessionExpiredError:
      'Your sign-up link expired. Sign in with the email and password you chose to continue.',

    // Safe review navigation for the auth-locked early steps
    backToAccount: 'Back to account',
    backToWelcome: 'Back to welcome',
    accountReadyTitle: 'Your account is ready',
    accountReadyBody:
      'Your Staxis account has already been created. You can review this step without restarting your signup.',
    accountEmailLabel: 'Account email',
    continueToVerify: 'Continue to verify email →',
    continueSetup: 'Continue setup →',
    beginArrow: 'Begin →',
    continueArrow: 'Continue →',
    startingEllipsis: 'Starting…',
    continuingEllipsis: 'Continuing…',
  },

};

export type OnboardStrings = (typeof STRINGS)['en'];

export function ot(lang: Lang): OnboardStrings {
  return STRINGS['en'] ?? STRINGS.en;
}
