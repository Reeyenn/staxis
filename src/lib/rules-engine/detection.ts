/**
 * Heuristic detectors that turn free-text PMS fields (`notes`,
 * `special_requests`, `package_name`, `rate_code`) into engine signals
 * (is_vip, has_pet, eco_stay_opt_in, language, etc.).
 *
 * Why heuristic: the PMS doesn't expose typed flags for most of these.
 * The CUA worker captures the raw text; the engine looks for keyword
 * patterns. Case-insensitive matching, word-boundary aware where it
 * matters (so "rate" inside "celebrate" doesn't trigger anything).
 *
 * When a new keyword surfaces (e.g. "executive guest" used as a VIP
 * marker at a new property), add it here, not in individual rules.
 * Keeping detection centralized means rules stay small and the
 * keyword set is one grep away.
 */

const VIP_LOYALTY_TIERS = new Set([
  'platinum',
  'diamond',
  'titanium',
  'ambassador',
  'black',
  'chairman',
  'icon',
]);

/** All loyalty tiers we recognize when scanning free-text. Order matters
 *  for the case where a reservation note mentions multiple — the first
 *  match wins (most-specific to least, top → bottom). */
const LOYALTY_TIER_LABELS: string[] = [
  'Chairman',
  'Icon',
  'Ambassador',
  'Black',
  'Titanium',
  'Diamond',
  'Platinum',
  'Gold',
  'Silver',
  'Bronze',
];

const VIP_KEYWORDS = [
  'vip',
  'v.i.p',
  'platinum guest',
  'diamond guest',
  'executive guest',
  'owner stay',
  'gm hold',
  'celebrity',
];

// Short, ambiguous tokens are matched as WHOLE WORDS — a bare substring 'pet'
// hits the very common housekeeping word 'carpet' (also 'trumpet'), 'dog' hits
// 'watchdog', and 'cat' hits 'located'. 'esa' is deliberately omitted: it is a
// common Spanish word ("esa habitación") that would false-fire on bilingual
// notes; genuine ESA cases are caught by 'emotional support' below.
const PET_WORD_RX = /\b(?:pets?|dogs?|cats?)\b/i;
// Unambiguous multi-word markers, matched as plain substrings.
const PET_SUBSTRINGS = ['service animal', 'service dog', 'emotional support', 'kennel'];

const ECO_KEYWORDS = [
  'eco stay',
  'eco-stay',
  'no daily clean',
  // Was 'no service' — far too broad. It flipped eco-stay (which downgrades a
  // room to a 5-min visual check) on any incidental "no service" mention
  // ("cell has no service in 210", "ice machine no service"). Use specific
  // housekeeping opt-out phrases instead.
  'no housekeeping',
  'decline service',
  'skip clean',
  'skip cleaning',
  'green choice',
  'make a green choice',
  'opted out of housekeeping',
  'do not service',
];

const HONEYMOON_KEYWORDS = ['honeymoon', 'honey moon', 'just married', 'newlywed'];
const ANNIVERSARY_KEYWORDS = ['anniversary'];

const EARLY_CHECKIN_KEYWORDS = ['early check', 'early checkin', 'early arrival'];

const BABY_COT_KEYWORDS = ['baby cot', 'crib', 'cot for baby', 'infant bed', 'pack n play'];
const EXTRA_BED_KEYWORDS = ['extra bed', 'rollaway', 'roll-away', 'additional bed'];

const LANGUAGE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /spanish[- ]?speak|habla\s+espa|prefer(?:s|red)?\s+spanish/i, label: 'Spanish-speaking' },
  { pattern: /french[- ]?speak|prefer(?:s|red)?\s+french/i, label: 'French-speaking' },
  { pattern: /mandarin|chinese[- ]?speak|prefer(?:s|red)?\s+chinese/i, label: 'Mandarin-speaking' },
  { pattern: /tagalog|filipino[- ]?speak/i, label: 'Tagalog-speaking' },
];

function flat(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ').toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function detectLoyaltyTier(input: {
  notes?: string | null;
  special_requests?: string | null;
  rate_code?: string | null;
  package_name?: string | null;
}): string | null {
  const text = flat(input.notes, input.special_requests, input.rate_code, input.package_name);
  if (!text) return null;
  for (const tier of LOYALTY_TIER_LABELS) {
    if (text.includes(tier.toLowerCase())) return tier;
  }
  return null;
}

export function detectIsVip(input: {
  loyalty_tier?: string | null;
  notes?: string | null;
  special_requests?: string | null;
  rate_code?: string | null;
  package_name?: string | null;
}): boolean {
  const tier = (input.loyalty_tier ?? '').trim().toLowerCase();
  if (tier && VIP_LOYALTY_TIERS.has(tier)) return true;
  const text = flat(input.notes, input.special_requests, input.rate_code, input.package_name);
  return containsAny(text, VIP_KEYWORDS);
}

export function detectHasPet(input: {
  notes?: string | null;
  special_requests?: string | null;
  rate_code?: string | null;
  package_name?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests, input.rate_code, input.package_name);
  return PET_WORD_RX.test(text) || containsAny(text, PET_SUBSTRINGS);
}

export function detectEcoStay(input: {
  notes?: string | null;
  special_requests?: string | null;
  package_name?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests, input.package_name);
  return containsAny(text, ECO_KEYWORDS);
}

export function detectHoneymoon(input: {
  notes?: string | null;
  special_requests?: string | null;
  rate_code?: string | null;
  package_name?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests, input.rate_code, input.package_name);
  return containsAny(text, HONEYMOON_KEYWORDS);
}

export function detectAnniversary(input: {
  notes?: string | null;
  special_requests?: string | null;
  rate_code?: string | null;
  package_name?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests, input.rate_code, input.package_name);
  return containsAny(text, ANNIVERSARY_KEYWORDS);
}

export function detectEarlyCheckinRequest(input: {
  notes?: string | null;
  special_requests?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests);
  return containsAny(text, EARLY_CHECKIN_KEYWORDS);
}

export function detectBabyCot(input: {
  notes?: string | null;
  special_requests?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests);
  return containsAny(text, BABY_COT_KEYWORDS);
}

export function detectExtraBed(input: {
  notes?: string | null;
  special_requests?: string | null;
}): boolean {
  const text = flat(input.notes, input.special_requests);
  return containsAny(text, EXTRA_BED_KEYWORDS);
}

export function detectLanguage(input: {
  notes?: string | null;
  special_requests?: string | null;
  dietary_needs?: string | null;
  accessibility_needs?: string | null;
}): string | null {
  const text = flat(
    input.notes,
    input.special_requests,
    input.dietary_needs,
    input.accessibility_needs,
  );
  for (const { pattern, label } of LANGUAGE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}
