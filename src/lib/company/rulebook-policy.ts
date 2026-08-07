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

// Company roles became Owner + Regional Manager in 0464. `finance` is gone as a
// word anybody can hold, so it is gone as a word anybody can be asked to sign.
// Stored rules that said `finance` (and `vp`) are converted to
// `regional_manager` by that migration, because the same humans still sign.
export const AUTHORITY_APPROVER_ROLES = [
  'owner', 'regional_manager', 'general_manager',
] as const;
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

/**
 * ⚠ ORDER IN THIS LIST DECIDES NOTHING. It used to, and that was a live bug.
 *
 * "Any capital project over $5,000 requires owner approval, not VP approval."
 * was stored — and rendered back to the person confirming it — as "needs
 * approval from the VP", because the matcher walked this list and `vp` came
 * before `owner`. The sentence was on a real company's screen saying the
 * opposite of what the company wrote. The worst version of the same bug is not
 * cosmetic: a role named in a NEGATIVE clause could unlock a card its author
 * meant to lock.
 *
 * `readApproverCandidates` below matches by POSITION IN THE SENTENCE, skips
 * anything a negation excluded, and refuses to pick when two roles genuinely
 * survive. This array is now only a vocabulary — the patterns, not a priority.
 */
// `finance` deliberately has NO pattern any more. The role no longer exists, and
// the safe answer to "invoices over $1,000 need finance approval" is to read no
// approver at all — which files the sentence as prose — rather than to quietly
// store a DIFFERENT role than the one the company wrote. Guessing is the failure
// mode here, not silence. The company can rewrite the sentence naming a job that
// exists. The VP words stay as aliases for `regional_manager` because that is
// still what plenty of companies call the person.
const APPROVER_PATTERNS: ReadonlyArray<readonly [AuthorityApproverRole, RegExp]> = [
  ['general_manager', /\b(general managers?|gms?)\b/gi],
  ['regional_manager', /\b(vps?|v\.p\.|vice presidents?|regional (?:managers?|directors?)?|regionals?)\b/gi],
  ['owner', /\b(owners?|ownership|principals?)\b/gi],
];

/** The verb that makes a sentence an AUTHORITY rule rather than a description. */
const APPROVAL_VERB = /\b(approv\w*|sign[-\s]?offs?|signs? off|signatures?|authoriz\w*|permission)\b/i;

/** Same vocabulary, scanning form — used to find every approval word's position. */
const APPROVAL_VERB_ALL = /\b(approv\w*|sign[-\s]?offs?|signs? off|signatures?|authoriz\w*|permission)\b/gi;

// ─── Who approves: position, negation, and the refusal to guess ─────────────

/**
 * A clause boundary. Negation does not reach across one.
 *
 * The comma matters and is the whole reason this exists: "requires owner
 * approval, not VP approval" is two clauses, and the "not" belongs to the
 * second one only. Without the boundary the negation would either swallow both
 * roles or neither.
 */
const CLAUSE_BOUNDARY = /[.;,:—–()]|\bbut\b|\bwhile\b|\bwhereas\b|\balthough\b/gi;

/**
 * Words that EXCLUDE the role that follows them.
 *
 * Tight on purpose — same doctrine as everything else in this file: a cue that
 * fires on honest phrasing is worse than a cue that misses, because a miss
 * lands on the ambiguity path (which asks a human) and a false fire silently
 * drops the real approver.
 *
 * `without` is deliberately ABSENT and it is the sharpest edge here: "no new
 * housekeeper may be hired without the regional office meeting the candidate"
 * REQUIRES the regional office. "Without X" means X is mandatory, not excluded,
 * and treating it as a negation would invert every sentence written that way.
 */
const NEGATION_CUE = new RegExp(
  String.raw`\b(?:not|never|no|n't|instead\s+of|rather\s+than|no\s+longer|other\s+than|excluding|except(?:\s+for)?)\s+`
  + String.raw`(?:the\s+|a\s+|an\s+|any\s+)?`
  + String.raw`(?:required?\s+|requires?\s+|need(?:s|ed)?\s+|necessary\s+|just\s+|only\s+)?$`,
  'i',
);

/**
 * The other half of negation: it can follow the role instead of preceding it.
 *
 * "…needs owner approval; the VP never approves these" names the VP right next
 * to an approval word, so without this the sentence reads as two roles bound to
 * approval and lands on the ambiguity path — asking a human about a sentence
 * that is perfectly clear.
 */
const NEGATION_CUE_AFTER = new RegExp(
  String.raw`^\s*(?:does\s+not|do\s+not|doesn't|don't|never|is\s+not|are\s+not|isn't|aren't|need\s+not|cannot|can't)\b`,
  'i',
);

/**
 * How close a role has to sit to an approval word to count as BOUND to it.
 *
 * 24 characters is "approval from the ___" with room to spare, and comfortably
 * short of a different clause. It is the difference between a role the sentence
 * puts the signature on and a role the sentence merely mentions: "The GM handles
 * routine orders. Any order over $500 needs owner approval." names two roles and
 * binds one.
 */
const APPROVAL_BINDING_CHARS = 24;

interface ApproverHit {
  role: AuthorityApproverRole;
  /** Where the role word starts. Sentence order, not list order. */
  index: number;
  /** Distance to the nearest approval word. Infinity when there is none. */
  distanceToApproval: number;
  negated: boolean;
}

/** End of the clause containing `index`. */
function clauseEnd(text: string, index: number): number {
  CLAUSE_BOUNDARY.lastIndex = 0;
  for (let m = CLAUSE_BOUNDARY.exec(text); m; m = CLAUSE_BOUNDARY.exec(text)) {
    if (m.index > index) return m.index;
  }
  return text.length;
}

/** Start of the clause containing `index`. */
function clauseStart(text: string, index: number): number {
  let start = 0;
  CLAUSE_BOUNDARY.lastIndex = 0;
  for (let m = CLAUSE_BOUNDARY.exec(text); m; m = CLAUSE_BOUNDARY.exec(text)) {
    if (m.index >= index) break;
    start = m.index + m[0].length;
  }
  return start;
}

function approvalWordPositions(text: string): number[] {
  const out: number[] = [];
  APPROVAL_VERB_ALL.lastIndex = 0;
  for (let m = APPROVAL_VERB_ALL.exec(text); m; m = APPROVAL_VERB_ALL.exec(text)) {
    out.push(m.index);
  }
  return out;
}

export interface ApproverCandidates {
  /** The role to store, or null when there is none or more than one survives. */
  picked: AuthorityApproverRole | null;
  /** Every role the sentence names and does not exclude, in sentence order. */
  surviving: AuthorityApproverRole[];
  /** True when two or more roles survived and the sentence does not choose. */
  ambiguous: boolean;
}

/**
 * Which role this sentence puts the signature on.
 *
 * THREE rules, in this order, and each one exists because of a sentence a real
 * company wrote:
 *
 *   1. NEGATION EXCLUDES. "…requires owner approval, not VP approval" names two
 *      roles and means one. A role sitting behind `not` / `instead of` /
 *      `rather than` in its own clause is dropped before anything is compared.
 *   2. NEAREST TO THE APPROVAL WORD WINS. Not first-in-a-hardcoded-list, and
 *      not first-in-the-sentence either: "the GM handles ordering; anything over
 *      $500 needs owner approval" names the GM first and binds the signature to
 *      the owner. Ties break toward the earlier position, which is the reading
 *      order a person uses.
 *   3. WHEN TWO SURVIVE AT THE SAME DISTANCE, REFUSE. `picked` is null and
 *      `ambiguous` is true, and the confirm step shows both candidates and
 *      stores no rule until a human names one. An unstored rule gates nothing
 *      and is safe; a wrong rule gates money.
 */
export function readApproverCandidates(content: string): ApproverCandidates {
  const text = String(content ?? '');
  const approvals = approvalWordPositions(text);

  const hits: ApproverHit[] = [];
  for (const [role, pattern] of APPROVER_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const index = m.index;
      const before = text.slice(clauseStart(text, index), index);
      const after = text.slice(index + m[0].length, clauseEnd(text, index + m[0].length));
      const distances = approvals.map((at) => Math.abs(at - index));
      hits.push({
        role,
        index,
        distanceToApproval: distances.length > 0 ? Math.min(...distances) : Infinity,
        negated: NEGATION_CUE.test(before) || NEGATION_CUE_AFTER.test(after),
      });
      // Zero-width guard: every pattern above consumes at least one character,
      // but a future edit that adds an optional-only alternative would spin here.
      if (m[0].length === 0) pattern.lastIndex += 1;
    }
  }

  // A role is excluded when EVERY mention of it is negated. One clean mention is
  // enough to keep it: "the owner approves it; the VP does not" names the owner
  // positively and the VP only negatively.
  const byRole = new Map<AuthorityApproverRole, ApproverHit[]>();
  for (const hit of hits) {
    const list = byRole.get(hit.role) ?? [];
    list.push(hit);
    byRole.set(hit.role, list);
  }

  const best: ApproverHit[] = [];
  for (const [, list] of byRole) {
    const clean = list.filter((h) => !h.negated);
    if (clean.length === 0) continue;
    best.push(clean.reduce((a, b) => (
      b.distanceToApproval < a.distanceToApproval
      || (b.distanceToApproval === a.distanceToApproval && b.index < a.index)
        ? b
        : a
    )));
  }

  best.sort((a, b) => a.index - b.index);
  const surviving = best.map((h) => h.role);
  if (surviving.length === 0) return { picked: null, surviving: [], ambiguous: false };
  if (surviving.length === 1) return { picked: surviving[0], surviving, ambiguous: false };

  // Which of them the sentence actually puts the signature ON.
  const bound = best.filter((h) => h.distanceToApproval <= APPROVAL_BINDING_CHARS);
  if (bound.length === 1) return { picked: bound[0].role, surviving, ambiguous: false };
  if (bound.length === 0) {
    // Several roles, none of them next to an approval word. Nearest wins — this
    // is the weakest reading in the file, and it only ever runs on a sentence
    // that mentions two roles and binds neither, which is prose.
    const nearest = best.reduce((a, b) => (b.distanceToApproval < a.distanceToApproval ? b : a));
    const tied = best.filter((h) => h.distanceToApproval === nearest.distanceToApproval);
    return tied.length === 1
      ? { picked: nearest.role, surviving, ambiguous: false }
      : { picked: null, surviving, ambiguous: true };
  }
  // Two or more roles, each bound to an approval word: "…needs owner approval or
  // VP approval". Picking by a few characters of proximity would be a coin flip
  // wearing an algorithm, and the thing being decided is who signs for money.
  return { picked: null, surviving, ambiguous: true };
}

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
 * What a sentence turns out to be.
 *
 *   rule       everything present and one approver. Storable.
 *   ambiguous  everything present EXCEPT that two roles both survive. The
 *              confirm step shows both and stores no rule.
 *   none       not an authority sentence at all. The common outcome, and a
 *              completely normal one — it files as prose.
 */
export type AuthorityRead =
  | { kind: 'rule'; rule: AuthorityReading }
  | {
    kind: 'ambiguous';
    /** Both (or all) roles the sentence names without excluding. */
    candidates: AuthorityApproverRole[];
    actionKind: AuthorityActionKind;
    thresholdCents: number;
    thresholdInclusive: boolean;
  }
  | { kind: 'none' };

/**
 * Read an approval requirement out of a company fact — the full answer.
 *
 * Returns `none` unless ALL FOUR are present: an approval verb, a money
 * boundary, an action kind, and an approver. Three-quarters of a rule is not a
 * rule — "orders over $500 are unusual for us" must never become a gate on
 * somebody's purchase order.
 *
 * Returns `ambiguous` when the sentence names two roles and does not choose
 * between them. That is a REFUSAL, not a failure: the confirm step puts both in
 * front of the human and nothing is frozen until they name one.
 */
export function readAuthority(content: string): AuthorityRead {
  const text = String(content ?? '');
  if (!text.trim()) return { kind: 'none' };
  if (!APPROVAL_VERB.test(text)) return { kind: 'none' };

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
  if (thresholdCents === null) return { kind: 'none' };

  let actionKind: AuthorityActionKind | null = null;
  for (const [kind, pattern] of ACTION_PATTERNS) {
    if (pattern.test(text)) { actionKind = kind; break; }
  }
  if (!actionKind) return { kind: 'none' };

  const approver = readApproverCandidates(text);
  if (approver.picked) {
    return {
      kind: 'rule',
      rule: { actionKind, thresholdCents, thresholdInclusive, approverRole: approver.picked },
    };
  }
  if (approver.ambiguous) {
    return {
      kind: 'ambiguous',
      candidates: approver.surviving,
      actionKind,
      thresholdCents,
      thresholdInclusive,
    };
  }
  return { kind: 'none' };
}

/**
 * The storable reading, or null.
 *
 * An AMBIGUOUS sentence reads as null here on purpose, and that is the safety
 * property: `applyStructuredReading` (rulebook.ts) freezes a rule when this
 * returns one and RETIRES any existing rule when it returns null, so a sentence
 * naming two roles ends up gating nothing at all rather than gating on a guess.
 * Callers that need to explain the refusal to a human use `readAuthority`.
 */
export function readAuthorityRule(content: string): AuthorityReading | null {
  const read = readAuthority(content);
  return read.kind === 'rule' ? read.rule : null;
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
  regional_manager: { en: 'the regional manager', es: 'the regional manager' },
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

/**
 * The same roles, spelled for the MIDDLE of a sentence.
 *
 * APPROVER_LABELS is capitalised for the subject-first Spanish read-back ("El
 * propietario debe aprobar…"), and lower-casing it wholesale turned "the VP"
 * into "the vp" on screen. An acronym is not a word you can case-fold, so the
 * two positions get two spellings instead of one plus a transformation.
 */
const APPROVER_LABELS_MID: Record<AuthorityApproverRole, Bilingual> = {
  owner: { en: 'the owner', es: 'el propietario' },
  regional_manager: { en: 'the regional manager', es: 'the regional manager' },
  general_manager: { en: 'the GM', es: 'el gerente' },
};

/** "the owner or the VP" / "el propietario o el supervisor regional". */
function listApprovers(roles: readonly AuthorityApproverRole[], lang: 'en' | 'es'): string {
  const words = roles.map((role) => APPROVER_LABELS_MID[role][lang]);
  if (words.length <= 1) return words[0] ?? '';
  const joiner = lang === 'es' ? ' o ' : ' or ';
  return `${words.slice(0, -1).join(', ')}${joiner}${words[words.length - 1]}`;
}

/**
 * What the confirmer is shown when the sentence names two approvers.
 *
 * It says three things, and all three are load-bearing: which roles it saw,
 * that NOTHING is being enforced, and what to do about it. The alternative — a
 * silent null, which is what the old code produced for these sentences — left a
 * company believing it had written a rule it had not, which is the same failure
 * as a wrong rule with a longer fuse.
 */
export function describeAmbiguousAuthority(
  read: Extract<AuthorityRead, { kind: 'ambiguous' }>,
  lang: 'en' | 'es',
): string {
  const action = ACTION_LABELS[read.actionKind][lang];
  const amount = formatCents(read.thresholdCents);
  const who = listApprovers(read.candidates, lang);
  // "cualquier" and "any" rather than an indefinite article, for the same reason
  // describeAuthorityRule is subject-first: the labels are two genders in Spanish
  // ("un factura" was on screen) and two articles in English ("a order"), and
  // carrying a gender per label is one more thing to get wrong for seven kinds.
  if (lang === 'es') {
    const boundary = read.thresholdInclusive ? `de ${amount} o más` : `de más de ${amount}`;
    return `Esta línea nombra más de un aprobador: ${who}. Staxis no puede saber quién debe `
      + `aprobar cualquier ${action} ${boundary}, así que no aplicará ninguna regla de aprobación. `
      + 'Edita la línea para nombrar a uno.';
  }
  const boundary = read.thresholdInclusive ? `of ${amount} or more` : `over ${amount}`;
  return `This line names more than one approver: ${who}. Staxis cannot tell which of them has to `
    + `approve any ${action} ${boundary}, so it will not enforce an approval rule. `
    + 'Edit the line to name one.';
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

// ═══════════════════════════════════════════════════════════════════════════
// NEAR-DUPLICATES — the same rule, said again in different words.
//
// The topic slug is the dedupe key, and it works: restate a policy and the
// extraction lands on the same slug, the RPC sees a CONFIRMED fact already owns
// it, and the write is skipped. That is the hotel Knows behaviour and the
// company book inherits it.
//
// What it does NOT catch is a restatement the model slugged differently. Live,
// on the demo company, with both lines in the book at once:
//
//   chemical_vendor    (confirmed)  "All our hotels use Ecolab for chemicals."
//   chemical_supplier  (unreviewed) "All Gulf Coast properties exclusively use
//                                    Ecolab chemicals."
//
// One policy, two rows, and a VP with no way to tell which one the copilot
// follows. So the confirm step compares the CONTENT as well as the slug, and
// when a confirmed fact already covers the same ground it offers to UPDATE that
// line rather than add a second one.
//
// ─── WHY IT OFFERS AND DOES NOT BLOCK ─────────────────────────────────────
// This is a heuristic over English, and a heuristic that silently swallows a
// genuinely new rule is far worse than one that asks. So a match produces a
// CHOICE — update the line you have, or keep both — and the cost of a false
// positive is one extra tap. `Keep both` is a real answer, not a trap door.
// ═══════════════════════════════════════════════════════════════════════════

/** Words that carry no subject. Both languages, because the book is bilingual. */
const CONTENT_STOPWORDS = new Set([
  'a', 'an', 'the', 'all', 'any', 'every', 'our', 'your', 'their', 'this', 'that', 'these',
  'those', 'is', 'are', 'be', 'been', 'must', 'may', 'can', 'will', 'shall', 'should',
  'and', 'or', 'but', 'for', 'of', 'in', 'on', 'at', 'to', 'from', 'with', 'without',
  'we', 'it', 'its', 'no', 'not', 'only', 'always', 'never', 'each', 'per',
  'hotel', 'hotels', 'property', 'properties', 'company',
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'o', 'en', 'con', 'sin',
  'es', 'son', 'debe', 'deben', 'puede', 'pueden', 'todo', 'todos', 'toda', 'todas',
  'cada', 'nuestro', 'nuestros', 'su', 'sus', 'hotel', 'hoteles', 'propiedad', 'propiedades',
]);

/** Content words, folded. Accents dropped so "químicos" matches "quimicos". */
export function contentTokens(text: string): Set<string> {
  const folded = String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const out = new Set<string>();
  for (const token of folded.split(/[^a-z0-9]+/)) {
    if (!token || token.length < 3) continue;
    if (CONTENT_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** Dice coefficient — 1.0 identical, 0 nothing in common. */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * How alike two lines must read before Staxis will ask. 0.5 is "half the
 * subject words are the same", which the Ecolab pair clears (0.55) and which
 * "housekeeping starts at 7am" vs "checkout rooms take 30 minutes" does not
 * come close to (0.17) despite both being housekeeping standards.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.5;

/**
 * …AND at least this many substantial words in common. The similarity score
 * alone can be flattered by two very short lines; a shared "ecolab" and
 * "chemicals" is what makes the match a real observation rather than arithmetic.
 */
export const NEAR_DUPLICATE_SHARED_WORDS = 2;
const SUBSTANTIAL_WORD_CHARS = 4;

export interface RulebookLine {
  id: string;
  topic: string;
  content: string;
}

export interface NearDuplicate {
  /** The CONFIRMED fact that already covers this ground. */
  existing: RulebookLine;
  similarity: number;
  /** The words the two lines share, for the sentence the screen shows. */
  sharedWords: string[];
}

/**
 * The confirmed fact this line restates, or null.
 *
 * `confirmed` is only ever the CONFIRMED half of the book: an unreviewed line
 * matching another unreviewed line is two drafts, and asking a human to
 * reconcile two things neither of which is policy yet is noise. The confirmed
 * fact wins, which is the same precedence the topic-slug path already has.
 */
export function findNearDuplicate(
  candidate: Pick<RulebookLine, 'id' | 'content'>,
  confirmed: readonly RulebookLine[],
): NearDuplicate | null {
  const mine = contentTokens(candidate.content);
  if (mine.size === 0) return null;

  let best: NearDuplicate | null = null;
  for (const other of confirmed) {
    if (other.id === candidate.id) continue;
    const theirs = contentTokens(other.content);
    const similarity = tokenSimilarity(mine, theirs);
    if (similarity < NEAR_DUPLICATE_SIMILARITY) continue;

    const shared = [...mine]
      .filter((t) => theirs.has(t) && t.length >= SUBSTANTIAL_WORD_CHARS)
      .sort();
    if (shared.length < NEAR_DUPLICATE_SHARED_WORDS) continue;

    if (!best || similarity > best.similarity) {
      best = { existing: other, similarity, sharedWords: shared };
    }
  }
  return best;
}

/** The sentence over the two buttons. Names the line it found, verbatim. */
export function describeNearDuplicate(match: NearDuplicate, lang: 'en' | 'es'): string {
  return lang === 'es'
    ? `Tu libro ya dice: «${match.existing.content}» ¿Actualizar esa línea con estas palabras, o conservar las dos?`
    : `Your book already says: “${match.existing.content}” Update that line with these words, or keep both?`;
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
          en: `${hotel.propertyName}'s ${POLICY_LABELS[key].en} is set to ${hotelValue}. The company book says ${fact.policyValue}.`,
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
