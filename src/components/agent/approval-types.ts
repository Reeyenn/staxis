// ─── Shared client types for the AI approval flow ──────────────────────────
// Used by useAgentChat (state) and ApprovalCard (rendering). Kept in a plain
// module so both can import without a hook dependency.

/** A bilingual string sent by the server (client picks by useLang()). */
export interface BiText {
  en: string;
  es: string;
}

export interface PendingAddon {
  id: string;
  label: string;
}

/** A proposed action awaiting the user's approval — drives the card. */
export interface PendingAction {
  pendingActionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  tier: 'quick' | 'card';
  summary: BiText;
  addons: PendingAddon[]; // already language-resolved for the current lang
}

/** The result-confirmation card shown after a decision resolves. */
export interface ResultCard {
  pendingActionId: string;
  toolName: string;
  ok: boolean;
  denied: boolean;
  summary: string; // language-resolved
  error?: string | null;
  addonNotes: string[];
}
