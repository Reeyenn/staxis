// ─── Action registrations ────────────────────────────────────────────────────
//
// Importing this module registers every action. The store and the API route
// import it for the side effect; nothing else should need to.
//
// TWO ENTRIES, AND THAT IS A DECISION, NOT A STAGE.
// The bar for a third is not "is it useful" — it is "is it safe to do to a real
// hotel on one tap, and does it genuinely come back". Everything that failed
// that bar is written down here rather than left as a gap somebody re-proposes
// in three months:
//
//   • placing an order with a vendor        — spends money; an undo would be a
//                                             cancellation call, not a database
//                                             write
//   • marking a room clean / assigning a
//     housekeeper                           — housekeeping is a rebuilt section
//                                             with its own rules, and the
//                                             standing constraint is that
//                                             Staxis never adds a step to
//                                             anyone's job
//   • anything written back to a PMS        — the standing "no PMS write-back
//                                             ever" constraint
//   • deleting or archiving anything the
//     hotel created                         — reversible in a schema sense,
//                                             never in an operational one
//   • creating an inventory count TASK      — there is no such thing in this
//                                             schema. `inventory_counts` records
//                                             a count that HAPPENED; there is no
//                                             request object to create, and
//                                             inventing a table so that an
//                                             action could exist is backwards.

export { createWorkOrderAction, createWorkOrderParams } from './create-work-order';
export { raiseReorderPointAction, raiseReorderPointParams } from './raise-reorder-point';
