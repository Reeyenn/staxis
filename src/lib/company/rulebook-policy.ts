// ─── Reading a company rule as STRUCTURE, not prose ────────────────────────
//
// Pure functions only. No database, no `server-only`: the confirm route, the
// React panel and the tests all import the SAME rules, so what the confirmer is
// shown ("Any order over $500 → needs VP approval. Right?") is by construction
// the same thing that gets stored and later routed on.
//
// WHY THIS FILE IS DETERMINISTIC AND NOT A MODEL CALL
// The model already ran once, at intake, to turn a paragraph into candidate
// facts. It does not run again here. A router that re-reads English on every
// card is a router whose answer can change while nobody edited anything — and
// the thing being decided is who has to sign for money. So the sentence is read
// exactly once, by regex, in front of a human who confirms or rejects the
// reading, and the ANSWER is what gets stored.
//
// The bar for every pattern below: it either matches unambiguously or it
// returns null. A null means "this is prose, file it as prose" — a fact with no
// structured reading is a completely normal outcome and the common one. Guessing
// would be the failure mode, not silence.

// ─── The rulebook's five shelves ───────────────────────────────────────────
// Deliberately NOT the hotel Knows buckets (rooms / people / rhythm / vendors /
// guests). A company book is not a hotel book: nobody writes "the third-floor
// ice machine" at company level, and everybody writes "orders over $500".

export const COMPANY_CATEGORIES = ['standards', 'money', 'vendors', 'people', 'guests'] as const;
export type CompanyCategory = (typeof COMPANY_CATEGORIES)[number];

export const DEFAULT_COMPANY_CATEGORY: CompanyCategory = 'standards';

export function isCompanyCategory(value: unknown): value is CompanyCategory {
  return typeof value === 'string' && (COMPANY_CATEGORIES as readonly string[]).includes(value);
}

export function coerceCompanyCategory(value: unknown): CompanyCategory {
  if (typeof value !== 'string') return DEFAULT_COMPANY_CATEGORY;
  const normalized = value.trim().toLowerCase();
  return isCompanyCategory(normalized) ? normalized : DEFAULT_COMPANY_CATEGORY;
}

export interface Bilingual { en: string; es: string }

export const COMPANY_CATEGORY_LABELS: Record<CompanyCategory, { title: Bilingual; hint: Bilingual }> = {
  standards: {
    title: { en: 'How we run hotels', es: 'Cómo operamos los hoteles' },
    hint: {
      en: 'The standards every hotel in the company follows',
      es: 'Los estándares que sigue cada hotel de la empresa',
    },
  },
  money: {
    title: { en: 'Money & approvals', es: 'Dinero y aprobaciones' },
    hint: {
      en: 'What needs a signature, and whose',
      es: 'Qué necesita una firma, y de quién',
    },
  },
  vendors: {
    title: { en: 'Vendors', es: 'Proveedores' },
    hint: { en: 'Who the company buys from', es: 'A quién le compra la empresa' },
  },
  people: {
    title: { en: 'People', es: 'Personal' },
    hint: { en: 'Hiring, staffing and pay rules', es: 'Reglas de contratación, personal y pago' },
  },
  guests: {
    title: { en: 'Guests', es: 'Huéspedes' },
    hint: { en: 'Company-wide guest policy', es: 'Política de huéspedes de toda la empresa' },
  },
};

// ─── Authority rules ───────────────────────────────────────────────────────

export const AUTHORITY_ACTION_KINDS = [
  'purchase_order', 'invoice', 'expense', 'capital_project', 'refund', 'comp', 'contract',
] as const;
export type AuthorityActionKind = (typeof AUTHORITY_ACTION_KINDS)[number];

export const AUTHORITY_APPROVER_ROLES = ['owner', 'vp', 'finance', 'general_manager'] as const;
export type AuthorityApproverRole = (typeof AUTHORITY_APPROVER_ROLES)[number];

export function isAuthorityActionKind(value: unknown): value is AuthorityActionKind {
  return typeof value === 'string' && (AUTHORITY_ACTION_KINDS as readonly string[]).includes(value);
}

export function isAuthorityApproverRole(value: unknown): value is AuthorityApproverRole {
  return typeof value === 'string' && (AUTHORITY_APPROVER_ROLES as readonly string[]).includes(value);
}

export interface AuthorityReading {
  actionKind: AuthorityActionKind;
  /** The boundary, in cents. Never a float — this decides signatures. */
  thresholdCents: number;
  /**
   * false — "over $500": approval starts ABOVE the boundary ($500.00 is fine).
   * true  — "$500 or more": approval starts AT the boundary.
   * A $500.00 order is exactly where the two disagree, which is why the company
   * gets to say which one it meant instead of us picking.
   */
  thresholdInclusive: boolean;
  approverRole: AuthorityApproverRole;
}

/** Longest phrase first, so "purchase order" is never read as "order" alone. */
const ACTION_PATTERNS: ReadonlyArray<readonly [AuthorityActionKind, RegExp]> = [
  ['capital_project', /\b(capital (?:expenditure|expense|project|spend)s?|cap[- ]?ex|renovations?|remodels?)\b/i],
  ['purchase_order', /\b(purchase orders?|p\.?o\.?s?\b|orders?|purchases?|purchasing|supply orders?)\b/i],
  ['invoice', /\b(invoices?|bills?)\b/i],
  ['expense', /\b(expenses?|expense reports?|reimbursements?|spend(?:ing)?)\b/i],
  ['refund', /\b(refunds?)\b/i],
  ['comp', /\b(comps?|comped|complimentary (?:rooms?|nights?|stays?))\b/i],
  ['contract', /\b(contracts?|agreements?|leases?)\b/i],
];

const APPROVER_PATTERNS: ReadonlyArray<readonly [AuthorityApproverRole, RegExp]> = [
  ['general_manager', /\b(general managers?|gms?)\b/i],
  ['vp', /\b(vps?|v\.p\.|vice presidents?|regional (?:managers?|directors?)?|regionals?)\b/i],
  ['finance', /\b(finance|controllers?|accounting|cfos?)\b/i],
  ['owner', /\b(owners?|ownership|principals?)\b/i],
];

/** The verb that makes a sentence an AUTHORITY rule rather than a description. */
const APPROVAL_VERB = /\b(approv\w*|sign[-\s]?offs?|signs? off|signatures?|authoriz\w*|permission)\b/i;

/**
 * `over $500` / `above $2,500` / `more than $5k` — exclusive.
 * `$500 or more` / `at least $500` / `$500+` — inclusive.
 */
const EXCLUSIVE_AMOUNT =
  /\b(?:over|above|more than|greater than|exceed(?:ing|s)?|beyond)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b|thousand\b)?/i;
const INCLUSIVE_AMOUNT =
  /\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b|thousand\b)?\s*(?:\+|or (?:more|above|higher|over))\b|\b(?:at least|starting at|from)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b|thousand\b)?/i;

function amountToCents(raw: string, multiplier: string | undefined): number | null {
  const cleaned = raw.replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  const scaled = multiplier ? value * 1000 : value;
  // Half-cent rounding on a value that came from a human typing dollars; the
  // regex allows at most two decimals, so this only ever fixes float dust.
  const cents = Math.round(scaled * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 1_000_000_000) return null;
  return cents;
}

/**
 * Read an approval requirement out of a confirmed company fact.
 *
 * Returns null unless ALL FOUR are present and unambiguous: an approval verb, a
 * money boundary, an action kind, and an approver. Three-quarters of a rule is
 * not a rule — a sentence like "orders over $500 are unusual for us" must never
 * become a gate on somebody's purchase order.
 */
export function readAuthorityRule(content: string): AuthorityReading | null {
  const text = String(content ?? '');
  if (!text.trim()) return null;
  if (!APPROVAL_VERB.test(text)) return null;

  let thresholdCents: number | null = null;
  let thresholdInclusive = false;

  const inclusive = INCLUSIVE_AMOUNT.exec(text);
  const exclusive = EXCLUSIVE_AMOUNT.exec(text);
  // "over $500" wins a tie: it is the far more common phrasing and the
  // inclusive pattern's bare `$500+` arm can otherwise catch a stray plus sign.
  if (exclusive) {
    thresholdCents = amountToCents(exclusive[1], exclusive[2]);
    thresholdInclusive = false;
  } else if (inclusive) {
    const digits = inclusive[1] ?? inclusive[3];
    const multiplier = inclusive[2] ?? inclusive[4];
    thresholdCents = amountToCents(digits, multiplier);
    thresholdInclusive = true;
  }
  if (thresholdCents === null) return null;

  let actionKind: AuthorityActionKind | null = null;
  for (const [kind, pattern] of ACTION_PATTERNS) {
    if (pattern.test(text)) { actionKind = kind; break; }
  }
  if (!actionKind) return null;

  let approverRole: AuthorityApproverRole | null = null;
  for (const [role, pattern] of APPROVER_PATTERNS) {
    if (pattern.test(text)) { approverRole = role; break; }
  }
  if (!approverRole) return null;

  return { actionKind, thresholdCents, thresholdInclusive, approverRole };
}

const ACTION_LABELS: Record<AuthorityActionKind, Bilingual> = {
  purchase_order: { en: 'order', es: 'pedido' },
  invoice: { en: 'invoice', es: 'factura' },
  expense: { en: 'expense', es: 'gasto' },
  capital_project: { en: 'capital project', es: 'proyecto de capital' },
  refund: { en: 'refund', es: 'reembolso' },
  comp: { en: 'comp', es: 'cortesía' },
  contract: { en: 'contract', es: 'contrato' },
};

const APPROVER_LABELS: Record<AuthorityApproverRole, Bilingual> = {
  owner: { en: 'the owner', es: 'El propietario' },
  vp: { en: 'the VP', es: 'El supervisor regional' },
  finance: { en: 'finance', es: 'Finanzas' },
  general_manager: { en: 'the GM', es: 'El gerente' },
};

/** Dollars with no cents when it is a round amount — "$500", "$1,250.50". */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The sentence the confirmer is shown BEFORE the rule is frozen. This is the
 * whole safety story for the structured reading: a human sees exactly what will
 * be stored, in their own language, and says yes or fixes the fact.
 */
export function describeAuthorityRule(rule: AuthorityReading, lang: 'en' | 'es'): string {
  const action = ACTION_LABELS[rule.actionKind][lang];
  const approver = APPROVER_LABELS[rule.approverRole][lang];
  const amount = formatCents(rule.thresholdCents);
  if (lang === 'es') {
    // Subject-first on purpose. "la aprobación de " + "el propietario" reads as
    // "de el propietario" — Spanish contracts that to "del", and building the
    // contraction per label is one more thing to get wrong for four roles in
    // two genders. Putting the approver at the front sidesteps it entirely.
    const boundary = rule.thresholdInclusive ? `de ${amount} o más` : `de más de ${amount}`;
    return `${approver} debe aprobar cualquier ${action} ${boundary}.`;
  }
  const boundary = rule.thresholdInclusive ? `of ${amount} or more` : `over ${amount}`;
  return `Any ${action} ${boundary} needs approval from ${approver}.`;
}

// ─── Comparable settings ───────────────────────────────────────────────────
//
// THE SCOPE THE FOUNDER DREW, AND WHY IT IS THIS NARROW.
//
// A company fact and a hotel may disagree in a hundred ways. Exactly one of
// them is safe to say out loud: when the company book pins a value that Staxis
// ALSO stores, per hotel, as a structured setting — and the two numbers differ.
// Then the line is arithmetic, and it is a quiet FYI, never an enforcement.
//
// Everything else is out:
//   • no scanning free text for disagreement between two prose facts;
//   • no claims about the physical world ("the company says Ecolab but this
//     hotel is using someone else") — Staxis cannot see what is in the closet;
//   • no flag when the hotel simply has not configured the setting. Absence is
//     not a contradiction, and saying it is would turn a brand-new hotel's
//     empty setup into a wall of company-policy violations.
//
// A NOTE ON GUEST CHECKOUT TIME, since it is the obvious example: Staxis does
// not store a per-hotel guest checkout time today. `checkout_minutes` is how
// long a checkout CLEAN takes, which is a different fact. So a company line
// "checkout is 11" files as prose and is never flagged. When a per-hotel
// checkout time exists, it becomes one more entry in the table below and
// nothing else changes.

export const COMPARABLE_POLICY_KEYS = [
  'housekeeping_start_time',
  'checkout_clean_minutes',
  'stayover_clean_minutes',
] as const;
export type ComparablePolicyKey = (typeof COMPARABLE_POLICY_KEYS)[number];

export function isComparablePolicyKey(value: unknown): value is ComparablePolicyKey {
  return typeof value === 'string' && (COMPARABLE_POLICY_KEYS as readonly string[]).includes(value);
}

export interface PolicyReading {
  key: ComparablePolicyKey;
  /** Canonical form: "HH:MM" for a time, a plain integer string for minutes. */
  value: string;
}

/** Carries its own Spanish article so both sentences below read naturally. */
const POLICY_LABELS: Record<ComparablePolicyKey, Bilingual> = {
  housekeeping_start_time: { en: 'housekeeping start time', es: 'la hora de inicio de limpieza' },
  checkout_clean_minutes: { en: 'minutes for a checkout clean', es: 'los minutos para limpiar una salida' },
  stayover_clean_minutes: { en: 'minutes for a stayover clean', es: 'los minutos para limpiar una estancia' },
};

/** "8", "8am", "8:30 pm", "08:00" → "HH:MM" 24-hour. null when unreadable. */
export function normalizeClockTime(hourRaw: string, minuteRaw: string | undefined, meridiem: string | undefined): string | null {
  let hour = Number.parseInt(hourRaw, 10);
  const minute = minuteRaw === undefined ? 0 : Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  const mer = meridiem?.toLowerCase().replace(/[.\s]/g, '');
  if (mer === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (hour !== 12) hour += 12;
  } else if (mer === 'am') {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const HOUSEKEEPING_START =
  /\bhousekeep\w*\b[^.]{0,40}?\b(?:starts?|begins?|start time|shift starts?)\b[^.]{0,15}?\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
const CHECKOUT_MINUTES =
  /\b(?:check[-\s]?outs?|departures?)\b[^.]{0,40}?\b(\d{1,3})\s*(?:minutes?|mins?\b)/i;
const STAYOVER_MINUTES =
  /\bstay[-\s]?overs?\b[^.]{0,40}?\b(\d{1,3})\s*(?:minutes?|mins?\b)/i;

/**
 * Read a comparable SETTING out of a confirmed company fact. Same bar as the
 * authority reader: unambiguous or null.
 */
export function readPolicyValue(content: string): PolicyReading | null {
  const text = String(content ?? '');
  if (!text.trim()) return null;

  const hk = HOUSEKEEPING_START.exec(text);
  if (hk) {
    const value = normalizeClockTime(hk[1], hk[2], hk[3]);
    if (value) return { key: 'housekeeping_start_time', value };
  }

  const checkout = CHECKOUT_MINUTES.exec(text);
  if (checkout) {
    const minutes = Number.parseInt(checkout[1], 10);
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 480) {
      return { key: 'checkout_clean_minutes', value: String(minutes) };
    }
  }

  const stayover = STAYOVER_MINUTES.exec(text);
  if (stayover) {
    const minutes = Number.parseInt(stayover[1], 10);
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 480) {
      return { key: 'stayover_clean_minutes', value: String(minutes) };
    }
  }

  return null;
}

/** The confirmer's read-back for a settings fact. */
export function describePolicyValue(reading: PolicyReading, lang: 'en' | 'es'): string {
  const label = POLICY_LABELS[reading.key][lang];
  return lang === 'es'
    ? `La empresa fija ${label} en ${reading.value}.`
    : `The company sets the ${label} to ${reading.value}.`;
}

// ─── Contradictions ────────────────────────────────────────────────────────

/** One hotel's structured settings, already read out of `properties`. */
export interface HotelSettingSnapshot {
  propertyId: string;
  propertyName: string;
  /** Only the keys the hotel has actually configured. Missing = not set. */
  values: Partial<Record<ComparablePolicyKey, string>>;
}

export interface SettingContradiction {
  propertyId: string;
  propertyName: string;
  key: ComparablePolicyKey;
  companyValue: string;
  hotelValue: string;
  factId: string;
  line: Bilingual;
}

/**
 * Every place a company fact's structured value and a hotel's configured value
 * disagree. Pure — the caller supplies both sides.
 *
 * Absence is never a contradiction: a hotel with no configured value for a key
 * contributes nothing, which is the difference between an FYI and a nag.
 */
export function findSettingContradictions(
  facts: ReadonlyArray<{ id: string; policyKey: string | null; policyValue: string | null }>,
  hotels: readonly HotelSettingSnapshot[],
): SettingContradiction[] {
  const out: SettingContradiction[] = [];
  for (const fact of facts) {
    if (!isComparablePolicyKey(fact.policyKey) || !fact.policyValue) continue;
    const key = fact.policyKey;
    for (const hotel of hotels) {
      const hotelValue = hotel.values[key];
      if (hotelValue === undefined || hotelValue === null || hotelValue === '') continue;
      if (hotelValue === fact.policyValue) continue;
      out.push({
        propertyId: hotel.propertyId,
        propertyName: hotel.propertyName,
        key,
        companyValue: fact.policyValue,
        hotelValue,
        factId: fact.id,
        line: {
          en: `${hotel.propertyName}'s ${POLICY_LABELS[key].en} is set to ${hotelValue} — the company book says ${fact.policyValue}.`,
          es: `En ${hotel.propertyName}, ${POLICY_LABELS[key].es} está en ${hotelValue}: el libro de la empresa dice ${fact.policyValue}.`,
        },
      });
    }
  }
  // Deterministic order so the panel does not reshuffle between loads.
  return out.sort((a, b) => (
    a.propertyName.localeCompare(b.propertyName) || a.key.localeCompare(b.key)
  ));
}
