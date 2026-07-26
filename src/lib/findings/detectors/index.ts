// ─── Detector registrations ──────────────────────────────────────────────────
//
// Importing this module registers every detector. The runner imports it for the
// side effect; nothing else should need to. Registration validates each
// declaration, so an ill-formed detector fails the first import rather than at
// 3am against a real hotel.
//
// Phase 1 registered ports of the three detection systems that already existed:
// the cleaning rules engine, the nudge checks and the operational signals. They
// answer questions somebody thought to ask in advance.
//
// Phase 2A adds the four that do not need anyone to have predicted the problem.
// Three learn what is normal FOR THIS HOTEL from its own trailing weeks and
// speak when a week falls outside it; one learns each hotel's own rhythms and
// speaks when one of them stops. Both classes stay silent — deliberately and
// by construction — on a hotel too new or too sporadic to have a normal, which
// is the single most important behaviour either of them has.
//
// Not one runner line changed to add them. That was the point of the spine.

export { operationalPatternDetector } from './operational-patterns';
export { roomAttentionDetector } from './room-attention';
export { cleaningPlanHealthDetector } from './cleaning-plan-health';
export { supplySpendBaselineDetector } from './supply-spend-baseline';
export { workOrderRateBaselineDetector } from './work-order-rate-baseline';
export { inventoryUsageBaselineDetector } from './inventory-usage-baseline';
export { expectedActivityDetector } from './expected-activity';

// The hands, 2026-07-26. The first detector whose cards arrive with the fix
// attached: one place that keeps producing work orders, and an offer to put a
// full inspection on the board. `inventory_usage_baseline` grew the same
// capability at the same time (raise the reorder point to cover its own lead
// time) without a new detector — which is the shape the action layer was built
// for. Both actions are frozen at proposal time, re-verified inside the
// transaction that executes them, and undoable; see src/lib/findings/actions.
export { repeatRoomWorkOrdersDetector } from './repeat-room-work-orders';
