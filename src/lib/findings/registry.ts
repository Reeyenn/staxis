// ─── Detector registry ───────────────────────────────────────────────────────
//
// One place that knows every detector, and one place that validates them. A
// detector registers a DECLARATION, not just a function, and the registry
// refuses a declaration that would let the runner behave badly:
//
//   • no id collisions          — dedupe keys are detector-prefixed, so two
//                                 detectors sharing an id would share a slot
//   • declared inputs           — every requirement names a feed the detector
//                                 actually reads, and vice versa
//   • a cap and a staleness     — a detector with no maxPerRun could flood the
//                                 queue on the night the data goes strange
//   • at least one eval case    — a detector nobody ever asserted on is a
//                                 detector nobody knows the behaviour of
//
// These are checked at REGISTRATION, which happens at module load, so a bad
// declaration fails the first test that imports the registry rather than at
// 3am against a real hotel.

import type { AnyDetector, Detector, DetectorParams, FeedId } from './types';

export class DetectorDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetectorDeclarationError';
  }
}

const REGISTRY = new Map<string, AnyDetector>();

const ID_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** Every check a declaration must pass. Exported so tests can drive it directly. */
export function validateDeclaration(detector: AnyDetector, known: ReadonlySet<string>): void {
  const d = detector.declaration;

  if (!ID_RE.test(d.id)) {
    throw new DetectorDeclarationError(
      `Detector id "${d.id}" must be lower_snake_case, 3-64 chars. It is stored in ` +
      'findings.detector_id and prefixes every dedupe key, so it cannot be renamed casually.',
    );
  }
  if (known.has(d.id)) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" is already registered. Two detectors sharing an id would share ` +
      'the one-row-per-problem slot and silently overwrite each other.',
    );
  }
  if (d.description.trim().length === 0) {
    throw new DetectorDeclarationError(`Detector "${d.id}" has no description.`);
  }
  if (d.inputs.length === 0) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" declares no inputs. A detector that reads nothing cannot find ` +
      'anything, and the runner would have no way to know when to skip it.',
    );
  }
  if (new Set(d.inputs).size !== d.inputs.length) {
    throw new DetectorDeclarationError(`Detector "${d.id}" lists a feed twice in inputs.`);
  }
  if (d.requires.length === 0) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" declares no minimum data. Say { minRecords: 0 } explicitly if the ` +
      'feed merely has to load — silence for want of data must be counted, not assumed.',
    );
  }
  const inputs: ReadonlySet<FeedId> = new Set(d.inputs);
  for (const requirement of d.requires) {
    if (!inputs.has(requirement.feed)) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" requires feed "${requirement.feed}" but does not list it in inputs.`,
      );
    }
    if (!Number.isInteger(requirement.minRecords) || requirement.minRecords < 0) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" requirement on "${requirement.feed}" has a non-integer minRecords.`,
      );
    }
    if (requirement.because.trim().length === 0) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" requirement on "${requirement.feed}" has no reason. The reason is ` +
        'what the run summary shows a human when the detector stays quiet.',
      );
    }
  }
  const covered = new Set(d.requires.map((r) => r.feed));
  for (const feed of d.inputs) {
    if (!covered.has(feed)) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" reads feed "${feed}" but declares no minimum data for it.`,
      );
    }
  }
  if (d.receiptQueryId.trim().length === 0) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" has no receiptQueryId. A finding nobody can re-check is a rumour.`,
    );
  }
  if (!Number.isInteger(d.maxPerRun) || d.maxPerRun < 1 || d.maxPerRun > 200) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" needs a maxPerRun between 1 and 200. Without a cap, one strange ` +
      'night of data becomes a hundred cards nobody reads.',
    );
  }
  if (!Number.isFinite(d.staleAfterDays) || d.staleAfterDays < 1) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" needs staleAfterDays >= 1 so a finding cannot outlive the problem.`,
    );
  }
  if (d.escalation) {
    if (!(d.escalation.factor > 1)) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" has an escalation factor <= 1, which would re-surface a silenced ` +
        'problem on any re-find at all — that is not a silencer.',
      );
    }
    if (!(d.escalation.minDelta > 0)) {
      throw new DetectorDeclarationError(
        `Detector "${d.id}" has an escalation minDelta <= 0, same problem.`,
      );
    }
  }
  if (d.actionTemplate && d.defaultDisposition !== 'propose') {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" declares an action template but its defaultDisposition is ` +
      `"${d.defaultDisposition}". An action is an OFFER, and an offer rendered as a ` +
      'recommendation or an FYI is a button on a card that says it needs no decision. Set ' +
      "defaultDisposition to 'propose' and override the drafts that carry no action.",
    );
  }
  if (d.evalCases.length === 0) {
    throw new DetectorDeclarationError(
      `Detector "${d.id}" ships no eval cases. Every detector must carry at least one frozen ` +
      'example of what it does and does not fire on.',
    );
  }
}

/** Register a detector. Throws on any declaration defect. */
export function registerDetector<P extends DetectorParams>(detector: Detector<P>): Detector<P> {
  validateDeclaration(detector as unknown as AnyDetector, new Set(REGISTRY.keys()));
  REGISTRY.set(detector.declaration.id, detector as unknown as AnyDetector);
  return detector;
}

/** Every registered detector, ordered by id so a run is reproducible. */
export function allDetectors(): AnyDetector[] {
  return [...REGISTRY.values()].sort((a, b) =>
    a.declaration.id < b.declaration.id ? -1 : a.declaration.id > b.declaration.id ? 1 : 0,
  );
}

export function getDetector(id: string): AnyDetector | null {
  return REGISTRY.get(id) ?? null;
}

/** The union of feeds the registered detectors read. The runner loads exactly this. */
export function requiredFeeds(detectors: readonly AnyDetector[] = allDetectors()): FeedId[] {
  const out = new Set<FeedId>();
  for (const detector of detectors) for (const feed of detector.declaration.inputs) out.add(feed);
  return [...out].sort();
}

/** Test-only: drop every registration. Never called by shipped code. */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
}
