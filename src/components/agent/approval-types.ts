// ─── Shared client types for the AI approval flow ──────────────────────────
// Used by useAgentChat (state) and ApprovalCard (rendering). Kept in a plain
// module so both can import without a hook dependency.

/** A bilingual string sent by the server (client picks by useLang()). */
export interface BiText {
  en: string;
  es?: string;
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

/** One editable field on the card's "Adjust" panel (schema-driven). */
export interface FieldSpec {
  key: string;
  label: { en: string; es?: string };
  kind: 'text' | 'multiline' | 'number' | 'enum';
  options?: string[];
}

// Fields rendered as editable in the "Adjust" panel per tool. Keyed by tool
// name → the arg keys the user may edit; everything else rides along unchanged.
// Kept in this plain module (not the .tsx component) so a drift-guard test can
// bind these keys to each tool's inputSchema.properties without importing React.
// Every key here MUST be a real property of that tool's inputSchema.
export const EDITABLE_FIELDS: Record<string, FieldSpec[]> = {
  send_message: [
    { key: 'recipient', label: { en: 'To', }, kind: 'text' },
    { key: 'message', label: { en: 'Message', }, kind: 'multiline' },
  ],
  create_todo: [
    { key: 'title', label: { en: 'Task', }, kind: 'text' },
    { key: 'notes', label: { en: 'Notes', }, kind: 'multiline' },
    { key: 'assignee', label: { en: 'Assign to', }, kind: 'text' },
    { key: 'priority', label: { en: 'Priority', }, kind: 'enum', options: ['normal', 'high', 'urgent'] },
  ],
  add_logbook_entry: [
    { key: 'title', label: { en: 'Title', }, kind: 'text' },
    { key: 'body', label: { en: 'Detail', }, kind: 'multiline' },
    { key: 'category', label: { en: 'Category', }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general'] },
  ],
  post_announcement: [
    { key: 'message', label: { en: 'Announcement', }, kind: 'multiline' },
  ],
  log_complaint: [
    { key: 'description', label: { en: 'Complaint', }, kind: 'multiline' },
    { key: 'roomNumber', label: { en: 'Room', }, kind: 'text' },
    { key: 'guestName', label: { en: 'Guest', }, kind: 'text' },
  ],
  assign_room: [
    { key: 'roomNumber', label: { en: 'Room', }, kind: 'text' },
    { key: 'staffName', label: { en: 'Housekeeper', }, kind: 'text' },
  ],
  remove_from_shift: [
    { key: 'staffName', label: { en: 'Staff', }, kind: 'text' },
    { key: 'date', label: { en: 'Date', }, kind: 'text' },
  ],
  assign_shift: [
    { key: 'staffName', label: { en: 'Staff', }, kind: 'text' },
    { key: 'date', label: { en: 'Date', }, kind: 'text' },
    { key: 'startTime', label: { en: 'Start', }, kind: 'text' },
    { key: 'endTime', label: { en: 'End', }, kind: 'text' },
    { key: 'department', label: { en: 'Department', }, kind: 'enum', options: ['housekeeping', 'front_desk', 'maintenance'] },
  ],
  adjust_stock: [
    { key: 'itemName', label: { en: 'Item', }, kind: 'text' },
    { key: 'newCount', label: { en: 'New count', }, kind: 'number' },
  ],
  create_reminder: [
    { key: 'body', label: { en: 'Reminder', }, kind: 'multiline' },
    { key: 'fireAt', label: { en: 'When', }, kind: 'text' },
    { key: 'recipient', label: { en: 'Person', }, kind: 'text' },
    { key: 'department', label: { en: 'Department', }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general'] },
  ],
  create_recurring_todo: [
    { key: 'title', label: { en: 'Task', }, kind: 'text' },
    { key: 'assignee', label: { en: 'Assign to', }, kind: 'text' },
    { key: 'department', label: { en: 'Department', }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general', 'all_staff'] },
    { key: 'cadence', label: { en: 'Repeat', }, kind: 'enum', options: ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'] },
    { key: 'priority', label: { en: 'Priority', }, kind: 'enum', options: ['normal', 'high', 'urgent'] },
  ],
};
