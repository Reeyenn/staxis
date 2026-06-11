/**
 * Bilingual (EN + ES) strings for the onboarding wizard's step 7
 * ("Learning your PMS"). Co-located with the page — the same pattern
 * financials/_components/fin-i18n.ts and lost-and-found use — rather than
 * added to the 2,483-line global translations.ts that every parallel
 * feature edits (co-locating avoids a merge conflict while staying fully
 * lang-driven via useLang()).
 *
 * Scope is the mapping step ONLY. The other 8 wizard steps stay as-is.
 *
 * Strings with `{pms}` / `{n}` / `{occ}` / `{total}` / `{when}` placeholders
 * are interpolated by the component (plain .replace, keeps every value a
 * string so the type stays simple).
 */

type Lang = 'en' | 'es';

const STRINGS = {
  en: {
    // preparing
    preparingTitle: 'Getting your PMS ready…',
    preparingBody: "We're warming up the connection. This only takes a moment.",
    // learning
    learningTitle: 'Learning your {pms}…',
    learningBody:
      'Our assistant is reading through your system — arrivals, departures, room status and more. This usually takes a few minutes; you can keep this page open.',
    // mfa
    mfaTitle: 'Completing a security check…',
    mfaBody:
      'Your PMS asked us to confirm a security step. This can take a few minutes — nothing needed from you.',
    // done (outcome-specific)
    doneTitleAuto: 'Your PMS is connected and live.',
    // feat/cua-partial-promotion (founder-gated) — the robot learned SOME
    // feeds; the map is PARKED for a human Promote click, NOT live yet.
    // Honest: never imply data is flowing, never hide what it got.
    doneTitlePartial: "The robot's first map of your PMS is ready — a quick review before it goes live.",
    doneTitlePark: "We've learned your PMS — putting on the finishing touches.",
    doneTitleQuarantine: "We've learned your PMS.",
    doneBodyAuto: "Everything's set — your live data is already flowing.",
    doneBodyPartial:
      "The robot learned some of your feeds but not all of them — the breakdown below shows exactly what it found. Nothing is live yet: our team reviews the result and switches it on, usually within a day. Once it's on, the learned feeds flow immediately, and anything still missing shows an honest “still learning” note in the app while we keep retrying it automatically every day.",
    doneBodyPark:
      "You're all set to keep going. We'll finish wiring up the last details in the background.",
    doneBodyQuarantine:
      "Our team is double-checking a couple of feeds before everything goes live — we'll email you. You can keep going now.",
    // found-it summary
    foundFeeds: 'We learned {n} feeds from your {pms}:',
    foundFeedsNoCount: "Here's what we found in your {pms}:",
    // live numbers
    numbersHeading: 'Live numbers it just read',
    numbersCaption: 'Straight from your PMS{when}. Compare these to your dashboard to spot-check.',
    numbersNone: 'Live room counts will appear on your dashboard shortly.',
    statOccupancy: 'Occupancy',
    statArrivals: 'Arrivals today',
    statDepartures: 'Departures today',
    statGuests: 'Guests in-house',
    roomsOfTotal: '{occ} of {total} rooms',
    andMore: '+ {n} more',
    // buttons
    continueBtn: 'Looks good — continue →',
    continuePlain: 'Continue →',
    checkAgainBtn: 'Check again',
    continueError: "Couldn't save just now — tap to try again.",
    // failed
    failTitle: "We couldn't finish connecting",
    failLogin:
      "We couldn't log into your PMS — please double-check the username and password you entered.",
    failLoginUrl:
      "We couldn't reach your PMS login page — the web address may be off. Double-check the PMS login URL.",
    failStopped: "Setup was paused. Reach out and we'll pick it back up.",
    failGeneric:
      'Something went wrong while connecting to your PMS. Our team has been notified and will reach out.',
  },
  es: {
    preparingTitle: 'Preparando tu sistema…',
    preparingBody: 'Estamos preparando la conexión. Solo toma un momento.',
    learningTitle: 'Aprendiendo tu {pms}…',
    learningBody:
      'Nuestro asistente está leyendo tu sistema — llegadas, salidas, estado de habitaciones y más. Esto suele tomar unos minutos; puedes dejar esta página abierta.',
    mfaTitle: 'Completando una verificación de seguridad…',
    mfaBody:
      'Tu sistema pidió confirmar un paso de seguridad. Puede tomar unos minutos — no necesitas hacer nada.',
    doneTitleAuto: 'Tu sistema está conectado y activo.',
    doneTitlePartial: 'El primer mapa de tu sistema está listo — una revisión rápida antes de activarlo.',
    doneTitlePark: 'Aprendimos tu sistema — dando los toques finales.',
    doneTitleQuarantine: 'Aprendimos tu sistema.',
    doneBodyAuto: 'Todo listo — tus datos en vivo ya están fluyendo.',
    doneBodyPartial:
      'El robot aprendió algunas de tus fuentes pero no todas — el desglose abajo muestra exactamente qué encontró. Nada está en vivo todavía: nuestro equipo revisa el resultado y lo activa, normalmente en menos de un día. Una vez activo, las fuentes aprendidas fluyen de inmediato, y lo que falte mostrará una nota honesta de “aún aprendiendo” en la app mientras lo reintentamos automáticamente cada día.',
    doneBodyPark:
      'Puedes continuar. Terminaremos de conectar los últimos detalles en segundo plano.',
    doneBodyQuarantine:
      'Nuestro equipo está revisando un par de fuentes antes de activar todo — te enviaremos un correo. Puedes continuar.',
    foundFeeds: 'Aprendimos {n} fuentes de tu {pms}:',
    foundFeedsNoCount: 'Esto es lo que encontramos en tu {pms}:',
    numbersHeading: 'Números en vivo que acaba de leer',
    numbersCaption: 'Directo de tu sistema{when}. Compáralos con tu panel para verificar.',
    numbersNone: 'Los conteos de habitaciones aparecerán en tu panel en breve.',
    statOccupancy: 'Ocupación',
    statArrivals: 'Llegadas hoy',
    statDepartures: 'Salidas hoy',
    statGuests: 'Huéspedes en casa',
    roomsOfTotal: '{occ} de {total} habitaciones',
    andMore: '+ {n} más',
    continueBtn: 'Se ve bien — continuar →',
    continuePlain: 'Continuar →',
    checkAgainBtn: 'Revisar de nuevo',
    continueError: 'No se pudo guardar — toca para reintentar.',
    failTitle: 'No pudimos terminar la conexión',
    failLogin:
      'No pudimos iniciar sesión en tu sistema — verifica el usuario y la contraseña que ingresaste.',
    failLoginUrl:
      'No pudimos abrir la página de inicio de sesión — la dirección web puede estar mal. Verifica la URL de inicio de sesión.',
    failStopped: 'La configuración se pausó. Contáctanos y la retomamos.',
    failGeneric:
      'Algo salió mal al conectar con tu sistema. Nuestro equipo fue notificado y se comunicará contigo.',
  },
};

export type MappingStrings = (typeof STRINGS)['en'];

export function mt(lang: Lang): MappingStrings {
  return STRINGS[lang] ?? STRINGS.en;
}

/**
 * Curated, customer-friendly milestone checklist for the learning phase.
 * The mapper broadcasts English progress labels on `mapping:{jobId}`; we
 * NEVER render those raw strings (keeps ES clean + guarantees no raw
 * robot-action text leaks). Instead each broadcast label is matched by
 * keyword to one of these milestones, which advances our own bilingual
 * checklist + the progress bar.
 *
 * Keyword sets are mutually non-overlapping across milestones, so the first
 * match is the correct one regardless of order.
 */
export interface Milestone {
  key: string;
  en: string;
  es: string;
  /** lowercase keywords; matched via substring against the lowercased label */
  kw: string[];
}

export const MILESTONES: Milestone[] = [
  { key: 'login', en: 'Signing in securely', es: 'Iniciando sesión de forma segura', kw: ['login', 'logging', 'signing', 'url ok', 'starting', 'start'] },
  { key: 'rooms', en: 'Reading room status', es: 'Leyendo el estado de las habitaciones', kw: ['housekeeping', 'room status', 'room'] },
  { key: 'arrivals', en: "Finding today's arrivals", es: 'Encontrando las llegadas de hoy', kw: ['arrival'] },
  { key: 'departures', en: "Finding today's departures", es: 'Encontrando las salidas de hoy', kw: ['departure'] },
  { key: 'maintenance', en: 'Checking maintenance & work orders', es: 'Revisando mantenimiento y órdenes de trabajo', kw: ['work order', 'maintenance'] },
  { key: 'revenue', en: 'Reading the daily revenue summary', es: 'Leyendo el resumen de ingresos del día', kw: ['revenue summary', 'daily revenue'] },
  { key: 'rates', en: 'Finding rates & availability', es: 'Encontrando tarifas y disponibilidad', kw: ['rate', 'inventory', 'availab'] },
  { key: 'channels', en: 'Reviewing booking channels', es: 'Revisando canales de reserva', kw: ['channel'] },
  { key: 'guests', en: 'Looking at guest profiles', es: 'Revisando perfiles de huéspedes', kw: ['guest'] },
  { key: 'forecast', en: 'Reading the occupancy forecast', es: 'Leyendo el pronóstico de ocupación', kw: ['forecast'] },
  { key: 'groups', en: 'Finding group bookings', es: 'Encontrando reservas de grupo', kw: ['group', 'block'] },
  { key: 'lostfound', en: 'Finding the lost & found log', es: 'Encontrando el registro de objetos perdidos', kw: ['lost'] },
  { key: 'activity', en: 'Reviewing the activity log', es: 'Revisando el registro de actividad', kw: ['audit', 'activity'] },
  { key: 'finalizing', en: 'Saving what it learned', es: 'Guardando lo aprendido', kw: ['recipe saved', 'extraction', 'finishing', 'saving', 'done', 'complete'] },
];

/** Match a broadcast label to a milestone index, or -1 if unrecognized. */
export function milestoneIndexForLabel(label: string): number {
  const l = label.toLowerCase();
  for (let i = 0; i < MILESTONES.length; i++) {
    if (MILESTONES[i].kw.some((k) => l.includes(k))) return i;
  }
  return -1;
}

export function milestoneLabel(m: Milestone, lang: Lang): string {
  return lang === 'es' ? m.es : m.en;
}
