// ─── The action catalog ──────────────────────────────────────────────────────
//
// One place that knows every action Staxis may perform on its own suggestion,
// and one place that refuses an entry that would let a card lie.
//
// The bar for membership, checked at REGISTRATION (module load, so a bad entry
// fails the first test that imports the catalog rather than at the moment a
// manager taps a button):
//
//   • the kind is one the DATABASE also knows        — 0363's CHECK and this
//     registry must agree, or a proposal is written that no branch can execute
//   • it says how it comes back                      — `undoDescription`; an
//     action with no real undo is not safe to offer
//   • it declares when to check the fix held         — `outcomeCheckDays`
//   • it validates its own params                    — so a malformed plan is
//     refused before it is frozen, not after it is tapped
//   • it speaks both languages                       — every sentence a manager
//     reads is bilingual by construction
//
// The catalog is deliberately SHORT. Every entry is a thing Staxis will do to a
// real hotel without a human writing it; three of them is a product, thirty is
// a liability.

import type { AnyActionDefinition, ActionDefinition, ActionParams, FindingActionKind } from './types';

export class ActionDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionDeclarationError';
  }
}

/**
 * The kinds migration 0363's CHECK constraint accepts. Kept here as data so the
 * agreement between the schema and the catalog is ASSERTABLE — a test compares
 * this list to the constraint in the applied schema, which is the only way that
 * agreement stays true after somebody adds a fourth action.
 */
export const DB_ACTION_KINDS: readonly FindingActionKind[] = Object.freeze([
  'create_work_order',
  'raise_inventory_reorder_point',
]);

const CATALOG = new Map<string, AnyActionDefinition>();

/** Every check an entry must pass. Exported so tests can drive it directly. */
export function validateActionDefinition(
  definition: AnyActionDefinition,
  known: ReadonlySet<string>,
): void {
  const { kind } = definition;

  if (!DB_ACTION_KINDS.includes(kind)) {
    throw new ActionDeclarationError(
      `Action "${kind}" is not one of the kinds migration 0363 accepts. The database CHECK and ` +
      'this catalog must agree, or the runner freezes a plan no branch can execute.',
    );
  }
  if (known.has(kind)) {
    throw new ActionDeclarationError(
      `Action "${kind}" is already registered. Two entries for one kind would mean the card and ` +
      'the executor disagree about what the button does.',
    );
  }
  if (definition.description.trim().length === 0) {
    throw new ActionDeclarationError(`Action "${kind}" has no description.`);
  }
  if (definition.undoDescription.trim().length === 0) {
    throw new ActionDeclarationError(
      `Action "${kind}" does not say how it comes back. Every action Staxis performs on its own ` +
      'suggestion must be reversible, and writing the sentence is how that stays true.',
    );
  }
  if (!Number.isInteger(definition.outcomeCheckDays) || definition.outcomeCheckDays < 1) {
    throw new ActionDeclarationError(
      `Action "${kind}" needs outcomeCheckDays >= 1 — a fix nobody ever goes back to check is an ` +
      'intention, not an outcome.',
    );
  }
}

export function registerAction<P extends ActionParams>(
  definition: ActionDefinition<P>,
): ActionDefinition<P> {
  validateActionDefinition(definition as unknown as AnyActionDefinition, new Set(CATALOG.keys()));
  CATALOG.set(definition.kind, definition as unknown as AnyActionDefinition);
  return definition;
}

export function getAction(kind: string): AnyActionDefinition | null {
  return CATALOG.get(kind) ?? null;
}

/** Every registered action, ordered by kind so any listing is reproducible. */
export function allActions(): AnyActionDefinition[] {
  return [...CATALOG.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Test-only: drop every registration. Never called by shipped code. */
export function __resetActionCatalogForTests(): void {
  CATALOG.clear();
}
