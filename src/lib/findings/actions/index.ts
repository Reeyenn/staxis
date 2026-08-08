// ─── The hands ───────────────────────────────────────────────────────────────
//
// A finding that Staxis can fix arrives with the fix attached. One tap runs
// exactly what was shown — no model call at execution, no improvisation — after
// re-deriving the finding's receipt inside the same transaction that does the
// work, and declining if the facts have moved.
//
// Read `./types.ts` first: it states the four rules the rest of this directory
// exists to hold.

export {
  allActions,
  getAction,
  registerAction,
  validateActionDefinition,
  ActionDeclarationError,
  DB_ACTION_KINDS,
  __resetActionCatalogForTests,
} from './registry';

export {
  executeAction,
  loadAction,
  loadActionsForFindings,
  proposeAction,
  rowToAction,
  undoAction,
  type ActionCallResult,
  type ProposeOutcome,
} from './store';

export {
  createWorkOrderAction,
  createWorkOrderParams,
  raiseReorderPointAction,
  raiseReorderPointParams,
} from './catalog';

export {
  pickLang,
  type ActionDefinition,
  type ActionParams,
  type ActionReceipt,
  type AnyActionDefinition,
  type Bilingual,
  type ChangedFacts,
  type FindingAction,
  type FindingActionDraft,
  type FindingActionKind,
  type FindingActionState,
  type ActionTemplate,
  type PostConditionResult,
} from './types';

export type { ActionAdmissionContract } from '@/lib/staxis/foundation';
