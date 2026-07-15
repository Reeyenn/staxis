/**
 * Bilingual (EN + ES) strings for the NEW user-facing copy added to the
 * onboarding wizard's non-mapping steps (Step 1 welcome, Step 3 verify-email
 * recovery, Step 5 Connect-PMS picker). Co-located with the page — same
 * pattern as _mapping-i18n.ts — to keep these strings lang-driven via
 * useLang() without touching the 2,400-line global translations.ts that every
 * parallel feature edits.
 *
 * Scope: only the strings introduced by the 2026-06-26 onboarding hardening
 * pass. The rest of the wizard's pre-existing copy is unchanged.
 *
 * ES is NOT type-checked against `OnboardStrings` (the type is derived from
 * `en`), so every key added to `en` MUST be mirrored into `es` by hand.
 */

type Lang = 'en' | 'es';

const STRINGS = {
  en: {
    // Step 1 — welcome (step-count copy; wizard is 8 steps, "services" removed)
    welcomeSteps:
      "We'll walk you through 8 quick steps — creating your account, your hotel details, connecting your booking system, and adding your team. Takes about 10 minutes.",

    // Step 5 — Connect PMS picker
    pmsLabel: 'Your booking system (PMS) *',
    pmsSelectPlaceholder: '— Select your booking system —',
    pmsRequired: 'Please pick your booking system.',
    pmsOtherLabel: "What's your booking system called? *",
    pmsOtherPlaceholder: 'e.g. Maestro, RMS, innRoad…',
    pmsOtherHint: "We'll set it up for you — just tell us the name.",
    pmsOtherRequired: 'Please type the name of your booking system.',

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
  },
  es: {
    welcomeSteps:
      'Te guiaremos en 8 pasos rápidos — crear tu cuenta, los datos de tu hotel, conectar tu sistema de reservas y agregar a tu equipo. Toma unos 10 minutos.',

    pmsLabel: 'Tu sistema de reservas (PMS) *',
    pmsSelectPlaceholder: '— Selecciona tu sistema de reservas —',
    pmsRequired: 'Por favor elige tu sistema de reservas.',
    pmsOtherLabel: '¿Cómo se llama tu sistema de reservas? *',
    pmsOtherPlaceholder: 'p. ej. Maestro, RMS, innRoad…',
    pmsOtherHint: 'Nosotros lo configuramos por ti — solo dinos el nombre.',
    pmsOtherRequired: 'Por favor escribe el nombre de tu sistema de reservas.',

    resumeTitle: 'Ya empezaste la configuración',
    resumeBody:
      'Parece que tu cuenta ya está creada. Inicia sesión con el correo y la contraseña que elegiste para continuar donde lo dejaste.',
    resumeSignInBtn: 'Iniciar sesión para continuar →',
    sessionExpiredError:
      'Tu enlace de registro expiró. Inicia sesión con el correo y la contraseña que elegiste para continuar.',

    backToAccount: 'Volver a la cuenta',
    backToWelcome: 'Volver a la bienvenida',
    accountReadyTitle: 'Tu cuenta está lista',
    accountReadyBody:
      'Tu cuenta de Staxis ya fue creada. Puedes revisar este paso sin reiniciar tu registro.',
    accountEmailLabel: 'Correo de la cuenta',
    continueToVerify: 'Continuar para verificar el correo →',
    continueSetup: 'Continuar configuración →',
  },
};

export type OnboardStrings = (typeof STRINGS)['en'];

export function ot(lang: Lang): OnboardStrings {
  return STRINGS[lang] ?? STRINGS.en;
}
