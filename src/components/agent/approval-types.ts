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

/** One editable field on the card's "Adjust" panel (schema-driven). */
export interface FieldSpec {
  key: string;
  label: { en: string; es: string };
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
    { key: 'recipient', label: { en: 'To', es: 'Para' }, kind: 'text' },
    { key: 'message', label: { en: 'Message', es: 'Mensaje' }, kind: 'multiline' },
  ],
  create_todo: [
    { key: 'title', label: { en: 'Task', es: 'Tarea' }, kind: 'text' },
    { key: 'notes', label: { en: 'Notes', es: 'Notas' }, kind: 'multiline' },
    { key: 'assignee', label: { en: 'Assign to', es: 'Asignar a' }, kind: 'text' },
    { key: 'priority', label: { en: 'Priority', es: 'Prioridad' }, kind: 'enum', options: ['normal', 'high', 'urgent'] },
  ],
  add_logbook_entry: [
    { key: 'title', label: { en: 'Title', es: 'Título' }, kind: 'text' },
    { key: 'body', label: { en: 'Detail', es: 'Detalle' }, kind: 'multiline' },
    { key: 'category', label: { en: 'Category', es: 'Categoría' }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general'] },
  ],
  post_announcement: [
    { key: 'message', label: { en: 'Announcement', es: 'Aviso' }, kind: 'multiline' },
  ],
  log_complaint: [
    { key: 'description', label: { en: 'Complaint', es: 'Queja' }, kind: 'multiline' },
    { key: 'roomNumber', label: { en: 'Room', es: 'Habitación' }, kind: 'text' },
    { key: 'guestName', label: { en: 'Guest', es: 'Huésped' }, kind: 'text' },
  ],
  assign_room: [
    { key: 'roomNumber', label: { en: 'Room', es: 'Habitación' }, kind: 'text' },
    { key: 'staffName', label: { en: 'Housekeeper', es: 'Camarista' }, kind: 'text' },
  ],
  createMaintenanceWorkOrder: [
    { key: 'room_number', label: { en: 'Room', es: 'Habitación' }, kind: 'text' },
    { key: 'item', label: { en: 'Item', es: 'Objeto' }, kind: 'text' },
    { key: 'note', label: { en: 'Note', es: 'Nota' }, kind: 'multiline' },
  ],
  remove_from_shift: [
    { key: 'staffName', label: { en: 'Staff', es: 'Personal' }, kind: 'text' },
    { key: 'date', label: { en: 'Date', es: 'Fecha' }, kind: 'text' },
  ],
  assign_shift: [
    { key: 'staffName', label: { en: 'Staff', es: 'Personal' }, kind: 'text' },
    { key: 'date', label: { en: 'Date', es: 'Fecha' }, kind: 'text' },
    { key: 'startTime', label: { en: 'Start', es: 'Inicio' }, kind: 'text' },
    { key: 'endTime', label: { en: 'End', es: 'Fin' }, kind: 'text' },
    { key: 'department', label: { en: 'Department', es: 'Departamento' }, kind: 'enum', options: ['housekeeping', 'front_desk', 'maintenance'] },
  ],
  adjust_stock: [
    { key: 'itemName', label: { en: 'Item', es: 'Artículo' }, kind: 'text' },
    { key: 'newCount', label: { en: 'New count', es: 'Nuevo conteo' }, kind: 'number' },
    { key: 'orderQuantity', label: { en: 'Order quantity', es: 'Cantidad pedida' }, kind: 'number' },
  ],
  create_reminder: [
    { key: 'body', label: { en: 'Reminder', es: 'Recordatorio' }, kind: 'multiline' },
    { key: 'fireAt', label: { en: 'When', es: 'Cuándo' }, kind: 'text' },
    { key: 'recipient', label: { en: 'Person', es: 'Persona' }, kind: 'text' },
    { key: 'department', label: { en: 'Department', es: 'Departamento' }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general'] },
  ],
  create_recurring_todo: [
    { key: 'title', label: { en: 'Task', es: 'Tarea' }, kind: 'text' },
    { key: 'assignee', label: { en: 'Assign to', es: 'Asignar a' }, kind: 'text' },
    { key: 'department', label: { en: 'Department', es: 'Departamento' }, kind: 'enum', options: ['front_desk', 'housekeeping', 'maintenance', 'general'] },
    { key: 'cadence', label: { en: 'Repeat', es: 'Repetir' }, kind: 'enum', options: ['daily', 'weekly', 'weekdays'] },
    { key: 'priority', label: { en: 'Priority', es: 'Prioridad' }, kind: 'enum', options: ['normal', 'high', 'urgent'] },
  ],
};
