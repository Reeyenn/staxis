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
      'Our assistant is reading through your system: arrivals, departures, room status and more. This usually takes a few minutes; you can keep this page open.',
    // mfa
    mfaTitle: 'Completing a security check…',
    mfaBody:
      'Your PMS asked us to confirm a security step. This can take a few minutes. Nothing needed from you.',
    // done (outcome-specific)
    doneTitleAuto: 'Your PMS is connected and live.',
    // feat/cua-partial-promotion (founder-gated) — the robot learned SOME
    // feeds; the map is PARKED for a human Promote click, NOT live yet.
    // Honest: never imply data is flowing, never hide what it got.
    doneTitlePartial: "The robot's first map of your PMS is ready. A quick review before it goes live.",
    doneTitlePark: "We've learned your PMS. Putting on the finishing touches.",
    doneTitleQuarantine: "We've learned your PMS.",
    doneBodyAuto: "Everything's set. Your live data is already flowing.",
    doneBodyPartial:
      "The robot learned some of your feeds but not all of them. The breakdown below shows exactly what it found. Nothing is live yet: our team reviews the result and switches it on, usually within a day. Once it's on, the learned feeds flow immediately, and anything still missing shows an honest “still learning” note in the app while we keep retrying it automatically every day.",
    doneBodyPark:
      "You're all set to keep going. We'll finish wiring up the last details in the background.",
    doneBodyQuarantine:
      "Our team is double-checking a couple of feeds before everything goes live. We'll email you. You can keep going now.",
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
    continueBtn: 'Looks good, continue →',
    continuePlain: 'Continue →',
    checkAgainBtn: 'Check again',
    reenterLoginBtn: 'Re-enter login →',
    reenterError: "Couldn't go back just now. Tap to try again.",
    continueError: "Couldn't save just now. Tap to try again.",
    // taking-longer-than-expected (client timeout — robot quiet for a while)
    slowTitle: 'This is taking longer than usual',
    slowBody:
      "Your system can take a few minutes to read, and we're still working on it in the background. This page will update on its own when it's ready. If you think the login details were wrong, you can re-enter them.",
    // cost-cap pause (honest — auto-resumes overnight)
    pausedTitle: 'Paused for now, picking back up tonight',
    pausedBody:
      "We've hit today's safe usage limit while reading your system, so we've paused. It resumes automatically overnight and finishes on its own. Nothing needed from you. You can close this page and come back later, or check again now.",
    // failed
    failTitle: "We couldn't finish connecting",
    failLogin:
      "We couldn't log into your PMS. Please double-check the username and password you entered.",
    failLoginUrl:
      "We couldn't reach your PMS login page. The web address may be off. Double-check the PMS login URL.",
    failStopped: "Setup was paused. Reach out and we'll pick it back up.",
    failGeneric:
      'Something went wrong while connecting to your PMS. Our team has been notified and will reach out.',
  },

};

export type MappingStrings = (typeof STRINGS)['en'];

export function mt(lang: Lang): MappingStrings {
  return STRINGS['en'] ?? STRINGS.en;
}

/**
 * Curated, customer-friendly milestone checklist for the learning phase.
 * The mapper broadcasts English progress labels on `mapping:{jobId}`; we
 * NEVER render those raw strings. Instead each broadcast label is matched by
 * keyword to one of these milestones, which advances our own checklist and
 * progress bar.
 *
 * Keyword sets are mutually non-overlapping across milestones, so the first
 * match is the correct one regardless of order.
 */
export interface Milestone {
  key: string;
  en: string;
  /** lowercase keywords; matched via substring against the lowercased label */
  kw: string[];
}

export const MILESTONES: Milestone[] = [
  { key: 'login', en: 'Signing in securely',  kw: ['login', 'logging', 'signing', 'url ok', 'starting', 'start'] },
  { key: 'rooms', en: 'Reading room status',  kw: ['housekeeping', 'room status', 'room'] },
  { key: 'arrivals', en: "Finding today's arrivals",  kw: ['arrival'] },
  { key: 'departures', en: "Finding today's departures",  kw: ['departure'] },
  { key: 'maintenance', en: 'Checking maintenance & work orders',  kw: ['work order', 'maintenance'] },
  { key: 'revenue', en: 'Reading the daily revenue summary',  kw: ['revenue summary', 'daily revenue'] },
  { key: 'rates', en: 'Finding rates & availability',  kw: ['rate', 'inventory', 'availab'] },
  { key: 'channels', en: 'Reviewing booking channels',  kw: ['channel'] },
  { key: 'guests', en: 'Looking at guest profiles',  kw: ['guest'] },
  { key: 'forecast', en: 'Reading the occupancy forecast',  kw: ['forecast'] },
  { key: 'groups', en: 'Finding group bookings',  kw: ['group', 'block'] },
  { key: 'lostfound', en: 'Finding the lost & found log',  kw: ['lost'] },
  { key: 'activity', en: 'Reviewing the activity log',  kw: ['audit', 'activity'] },
  { key: 'finalizing', en: 'Saving what it learned',  kw: ['recipe saved', 'extraction', 'finishing', 'saving', 'done', 'complete'] },
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
  return m.en;
}
