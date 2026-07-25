// ─── Detector registrations ──────────────────────────────────────────────────
//
// Importing this module registers every detector. The runner imports it for the
// side effect; nothing else should need to. Registration validates each
// declaration, so an ill-formed detector fails the first import rather than at
// 3am against a real hotel.
//
// Phase 1 registers ports of the three detection systems that already existed.
// Baseline and absence detectors ("nobody has counted linen in nine days")
// belong to a later phase and plug in here with no runner changes.

export { operationalPatternDetector } from './operational-patterns';
export { roomAttentionDetector } from './room-attention';
export { cleaningPlanHealthDetector } from './cleaning-plan-health';
