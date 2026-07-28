import { canonicalize, stableFingerprint, type CanonicalValue } from './canonical';
import type { PropertyProfileSnapshot } from './profile';
import { MANAGEMENT_PATTERN_OBSERVATION_VERSION } from './versions';

export type DenominatorKind =
  | 'occupied_rooms'
  | 'rooms_sold'
  | 'available_rooms'
  | 'room_nights'
  | 'guests'
  | 'labor_hours'
  | 'revenue_minor'
  | 'transactions';

export interface ObservationWindowInput {
  readonly kind: 'business_dates' | 'instant_range';
  readonly localStartDate: string;
  readonly localEndDate: string;
  readonly timeZone: string;
  /** Inclusive instant at which source coverage begins. */
  readonly utcStart: string;
  /** Exclusive instant at which source coverage ends. */
  readonly utcEnd: string;
}

export interface ObservationWindow extends ObservationWindowInput {
  readonly utcStart: string;
  readonly utcEnd: string;
  readonly timeZone: string;
  readonly businessDateCutoffHour: number | null;
  readonly businessDateCutoffProvenanceFingerprint: string | null;
  readonly fingerprint: string;
}

export interface ObservationSourceInput {
  readonly queryId: string;
  readonly queryVersion: string;
  readonly sourceRevision: string;
  readonly extractedAt: string;
  readonly parameters: CanonicalValue;
  readonly recordCount: number;
}

export interface ObservationSource extends Omit<ObservationSourceInput, 'parameters'> {
  readonly extractedAt: string;
  readonly parameters: CanonicalValue;
  readonly parametersFingerprint: string;
}

export interface ObservationQualityInput {
  /** Latest source instant whose records are represented by this observation. */
  readonly freshThrough: string;
  readonly observedPoints: number;
  readonly expectedPoints: number;
  readonly coverageBasis: string;
  readonly qualityFlags?: readonly string[];
}

export interface ObservationQuality extends Omit<ObservationQualityInput, 'qualityFlags'> {
  readonly freshThrough: string;
  readonly completenessRatio: number;
  readonly qualityFlags: readonly string[];
}

export interface DenominatorEvidenceInput {
  readonly kind: DenominatorKind;
  /** Null preserves a successful query whose required aggregate was absent. */
  readonly value: number | null;
  readonly unit: string;
  /** Required only for the monetary `revenue_minor` denominator. */
  readonly currency: string | null;
  /** Independent receipt: a denominator from another period must never be reused. */
  readonly window: ObservationWindowInput;
  readonly source: ObservationSourceInput;
  readonly quality: ObservationQualityInput;
}

export interface DenominatorEvidence extends Omit<DenominatorEvidenceInput, 'source' | 'quality' | 'window'> {
  readonly currency: string | null;
  readonly currencyStorageScale: number | null;
  readonly source: ObservationSource;
  readonly quality: ObservationQuality;
  readonly window: ObservationWindow;
  readonly fingerprint: string;
}

export interface MetricObservationInput {
  readonly profile: PropertyProfileSnapshot;
  readonly metricId: string;
  readonly metricVersion: string;
  readonly observedAt: string;
  /** Null preserves a successful numerator query with no usable aggregate. */
  readonly rawValue: number | null;
  readonly rawUnit: string;
  /** Null for non-monetary metrics. No currency is ever inferred. */
  readonly rawCurrency: string | null;
  readonly window: ObservationWindowInput;
  readonly source: ObservationSourceInput;
  readonly quality: ObservationQualityInput;
  readonly denominator: DenominatorEvidenceInput | null;
  /** Exact metric-specific source facts stored once with this immutable receipt. */
  readonly metadata?: CanonicalValue;
}

export interface MetricObservation {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_OBSERVATION_VERSION;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly relationshipId: string | null;
  readonly profileFingerprint: string;
  readonly metricId: string;
  readonly metricVersion: string;
  readonly observedAt: string;
  readonly rawValue: number | null;
  readonly rawUnit: string;
  readonly rawCurrency: string | null;
  readonly rawCurrencyStorageScale: number | null;
  readonly window: ObservationWindow;
  readonly source: ObservationSource;
  readonly quality: ObservationQuality;
  readonly denominator: DenominatorEvidence | null;
  readonly metadata: CanonicalValue;
  readonly fingerprint: string;
}

const LOCAL_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RX = /^[A-Z]{3}$/;

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must not be empty`);
  return trimmed;
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function instant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.includes('T')) throw new TypeError(`${field} must be an ISO-8601 instant`);
  return new Date(parsed).toISOString();
}

function localDate(value: string, field: string): string {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !LOCAL_DATE_RX.test(value)
    || Number.isNaN(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${field} must be a YYYY-MM-DD date`);
  }
  return value;
}

function timeZone(value: string): string {
  const candidate = nonEmpty(value, 'window.timeZone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    throw new TypeError('window.timeZone must be a recognized IANA time zone');
  }
}

function nextLocalDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function zonedDateAndTime(value: string, zone: string): { date: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
  };
}

function assertBusinessWindowMatchesCutoff(
  payload: Omit<ObservationWindow, 'fingerprint'>,
): void {
  if (payload.kind !== 'business_dates' || payload.businessDateCutoffHour === null) return;
  const start = zonedDateAndTime(payload.utcStart, payload.timeZone);
  const end = zonedDateAndTime(payload.utcEnd, payload.timeZone);
  const startsAtCutoff = (
    start.date === payload.localStartDate
    && start.hour === payload.businessDateCutoffHour
    && start.minute === 0
    && start.second === 0
    && Date.parse(payload.utcStart) % 1_000 === 0
  );
  const endsAtCutoff = (
    end.date === nextLocalDate(payload.localEndDate)
    && end.hour === payload.businessDateCutoffHour
    && end.minute === 0
    && end.second === 0
    && Date.parse(payload.utcEnd) % 1_000 === 0
  );
  if (!startsAtCutoff || !endsAtCutoff) {
    throw new TypeError('business-date UTC window does not match the profile time zone and cutoff hour');
  }
}

function currency(value: string | null, field: string): string | null {
  if (value === null) return null;
  const code = value.trim().toUpperCase();
  if (!CURRENCY_RX.test(code)) throw new TypeError(`${field} must be null or three letters`);
  return code;
}

function createWindow(
  input: ObservationWindowInput,
  profile: PropertyProfileSnapshot,
): ObservationWindow {
  const localStartDate = localDate(input.localStartDate, 'window.localStartDate');
  const localEndDate = localDate(input.localEndDate, 'window.localEndDate');
  if (localStartDate > localEndDate) throw new TypeError('window local start must not follow local end');
  const utcStart = instant(input.utcStart, 'window.utcStart');
  const utcEnd = instant(input.utcEnd, 'window.utcEnd');
  if (Date.parse(utcStart) >= Date.parse(utcEnd)) throw new TypeError('window.utcEnd must follow window.utcStart');
  const payload = {
    kind: input.kind,
    localStartDate,
    localEndDate,
    timeZone: timeZone(input.timeZone),
    // An instant range may still carry local calendar labels for comparison,
    // but it is not a business-date interval and must not inherit a cutoff it
    // did not use. This keeps calendar-month numerators honest when paired
    // with business-date denominators.
    businessDateCutoffHour: input.kind === 'business_dates'
      ? profile.businessDateCutoffHour
      : null,
    businessDateCutoffProvenanceFingerprint: (
      input.kind !== 'business_dates' || profile.businessDateCutoffProvenance === null
    )
      ? null
      : stableFingerprint(profile.businessDateCutoffProvenance, 'business-date-cutoff-provenance'),
    utcStart,
    utcEnd,
  };
  assertBusinessWindowMatchesCutoff(payload);
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'observation-window') });
}

function createSource(input: ObservationSourceInput, field = 'source'): ObservationSource {
  const parameters = canonicalize(input.parameters, `${field}.parameters`);
  return Object.freeze({
    queryId: nonEmpty(input.queryId, `${field}.queryId`),
    queryVersion: nonEmpty(input.queryVersion, `${field}.queryVersion`),
    sourceRevision: nonEmpty(input.sourceRevision, `${field}.sourceRevision`),
    extractedAt: instant(input.extractedAt, `${field}.extractedAt`),
    parameters,
    parametersFingerprint: stableFingerprint(parameters, `${field}-parameters`),
    recordCount: nonNegativeInteger(input.recordCount, `${field}.recordCount`),
  });
}

function createQuality(input: ObservationQualityInput, field = 'quality'): ObservationQuality {
  const observedPoints = nonNegativeInteger(input.observedPoints, `${field}.observedPoints`);
  const expectedPoints = nonNegativeInteger(input.expectedPoints, `${field}.expectedPoints`);
  if (expectedPoints === 0) throw new TypeError(`${field}.expectedPoints must be greater than zero`);
  if (observedPoints > expectedPoints) throw new TypeError(`${field}.observedPoints must not exceed expectedPoints`);
  const qualityFlags = Object.freeze([...new Set((input.qualityFlags ?? []).map((flag) => nonEmpty(flag, `${field}.qualityFlags`)))].sort());
  return Object.freeze({
    freshThrough: instant(input.freshThrough, `${field}.freshThrough`),
    observedPoints,
    expectedPoints,
    coverageBasis: nonEmpty(input.coverageBasis, `${field}.coverageBasis`),
    completenessRatio: observedPoints / expectedPoints,
    qualityFlags,
  });
}

function createDenominator(
  input: DenominatorEvidenceInput,
  profile: PropertyProfileSnapshot,
): DenominatorEvidence {
  const denominatorCurrency = currency(input.currency, 'denominator.currency');
  if (input.kind === 'revenue_minor' && denominatorCurrency === null) {
    throw new TypeError('denominator.currency is required for revenue_minor');
  }
  if (input.kind !== 'revenue_minor' && denominatorCurrency !== null) {
    throw new TypeError('denominator.currency is only valid for revenue_minor');
  }
  const source = createSource(input.source, 'denominator.source');
  const quality = createQuality(input.quality, 'denominator.quality');
  if (Date.parse(quality.freshThrough) > Date.parse(source.extractedAt)) {
    throw new TypeError('denominator.quality.freshThrough must not follow source extraction');
  }
  const payload = {
    kind: input.kind,
    value: input.value === null ? null : finite(input.value, 'denominator.value'),
    unit: nonEmpty(input.unit, 'denominator.unit'),
    currency: denominatorCurrency,
    currencyStorageScale: denominatorCurrency === null ? null : profile.operatingCurrency?.storageScale ?? null,
    window: createWindow(input.window, profile),
    source,
    quality,
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'denominator') });
}

/**
 * Build a provenance-complete immutable observation. Invalid or contradictory
 * declarations throw; usable-but-insufficient data is retained and is later
 * turned into an explicit normalization abstention.
 */
export function createMetricObservation(input: MetricObservationInput): MetricObservation {
  const rawCurrency = currency(input.rawCurrency, 'rawCurrency');
  const profileCurrency = input.profile.operatingCurrency?.code ?? null;
  if (rawCurrency !== null && profileCurrency === null) {
    throw new TypeError('rawCurrency has no matching explicit currency in the property profile');
  }
  if (rawCurrency !== null && rawCurrency !== profileCurrency) {
    throw new TypeError('rawCurrency conflicts with the property profile currency');
  }
  const denominator = input.denominator === null ? null : createDenominator(input.denominator, input.profile);
  if (denominator !== null && denominator.currency !== null && denominator.currency !== profileCurrency) {
    throw new TypeError('denominator currency conflicts with the property profile currency');
  }
  const source = createSource(input.source);
  const quality = createQuality(input.quality);
  if (Date.parse(quality.freshThrough) > Date.parse(source.extractedAt)) {
    throw new TypeError('quality.freshThrough must not follow source extraction');
  }

  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_OBSERVATION_VERSION,
    organizationId: input.profile.organizationId,
    propertyId: input.profile.propertyId,
    relationshipId: input.profile.relationshipId,
    profileFingerprint: input.profile.fingerprint,
    metricId: nonEmpty(input.metricId, 'metricId'),
    metricVersion: nonEmpty(input.metricVersion, 'metricVersion'),
    observedAt: instant(input.observedAt, 'observedAt'),
    rawValue: input.rawValue === null ? null : finite(input.rawValue, 'rawValue'),
    rawUnit: nonEmpty(input.rawUnit, 'rawUnit'),
    rawCurrency,
    rawCurrencyStorageScale: rawCurrency === null ? null : input.profile.operatingCurrency?.storageScale ?? null,
    window: createWindow(input.window, input.profile),
    source,
    quality,
    denominator,
    metadata: canonicalize(input.metadata ?? {}, 'metadata'),
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'metric-observation') });
}
