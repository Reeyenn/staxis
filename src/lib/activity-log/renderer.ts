/**
 * Activity log description renderer.
 *
 * The trigger functions in migration 0225 already pre-render an English
 * `description` for every row. That string is what we display by default
 * in the timeline + exports.
 *
 * This module exists so the UI can:
 *   - Re-render in Spanish (or another lang) on the fly from `metadata`
 *     without round-tripping to Postgres.
 *   - Group events into the friendly category label shown on the filter
 *     pills.
 *   - Map event_type to a leading icon (handled in the React layer).
 *
 * Spanish translations are intentionally minimal in v1 — only the events
 * the timeline actually emits today. New event types fall through to the
 * pre-rendered English description, so coverage degrades gracefully.
 */

import type { ActivityCategory, ActivityLogRow, ActivitySource } from './types';

export type RendererLang = 'en' | 'es';

/** Friendly category labels for the filter pills + side panel header. */
export function categoryLabel(category: ActivityCategory, lang: RendererLang = 'en'): string {
  if (lang === 'es') {
    switch (category) {
      case 'housekeeping': return 'Limpieza';
      case 'maintenance':  return 'Mantenimiento';
      case 'staff':        return 'Personal';
      case 'system':       return 'Sistema';
      case 'messages':     return 'Mensajes';
      case 'inventory':    return 'Inventario';
      case 'front_desk':   return 'Recepción';
    }
  }
  switch (category) {
    case 'housekeeping': return 'Housekeeping';
    case 'maintenance':  return 'Maintenance';
    case 'staff':        return 'Staff';
    case 'system':       return 'System';
    case 'messages':     return 'Messages';
    case 'inventory':    return 'Inventory';
    case 'front_desk':   return 'Front Desk';
  }
}

/** Friendly source label for the source filter + side panel header. */
export function sourceLabel(source: ActivitySource, lang: RendererLang = 'en'): string {
  if (lang === 'es') {
    switch (source) {
      case 'housekeeper_app':   return 'App de camarera';
      case 'manager_dashboard': return 'Panel del gerente';
      case 'admin_dashboard':   return 'Panel de administrador';
      case 'cron':              return 'Tarea programada';
      case 'cua_worker':        return 'Sincronización PMS';
      case 'rules_engine':      return 'Motor de reglas';
      case 'pms_sync':          return 'Sincronización PMS';
      case 'system':            return 'Sistema';
      case 'sms':               return 'SMS';
      case 'voice':             return 'Voz';
    }
  }
  switch (source) {
    case 'housekeeper_app':   return 'Housekeeper app';
    case 'manager_dashboard': return 'Manager dashboard';
    case 'admin_dashboard':   return 'Admin dashboard';
    case 'cron':              return 'Scheduled job';
    case 'cua_worker':        return 'PMS sync';
    case 'rules_engine':      return 'Rules engine';
    case 'pms_sync':          return 'PMS sync';
    case 'system':            return 'System';
    case 'sms':               return 'SMS';
    case 'voice':             return 'Voice';
  }
}

/**
 * Render the description for a row. Falls back to the trigger-rendered
 * `description` field if we don't have a Spanish template for the event.
 *
 * The English path always returns the trigger output verbatim — we don't
 * try to second-guess what the trigger wrote.
 */
export function renderDescription(row: ActivityLogRow, lang: RendererLang = 'en'): string {
  if (lang === 'en') return row.description;
  const es = renderSpanish(row);
  return es ?? row.description;
}

function renderSpanish(row: ActivityLogRow): string | null {
  const md = row.metadata ?? {};
  const actor = row.actor_name ?? 'Una persona del equipo';
  const room = (md.room_number as string | undefined) ?? row.target_label?.replace(/^Room\s+/i, '') ?? '?';

  switch (row.event_type) {
    case 'cleaning_completed':
      return `${actor} terminó de limpiar la habitación ${room} (${roundMin(md.duration_minutes)} min)`;
    case 'cleaning_flagged':
      return `${actor} marcó una limpieza larga en la habitación ${room} (${roundMin(md.duration_minutes)} min)`;
    case 'cleaning_discarded':
      return `Toque accidental en la habitación ${room} — descartado por ser demasiado corto`;
    case 'cleaning_review_approved':
      return `Una limpieza marcada en la habitación ${room} fue aprobada en revisión`;
    case 'cleaning_review_rejected':
      return `Una limpieza marcada en la habitación ${room} fue rechazada en revisión`;

    case 'cleaning_task_created':
      return `Tarea de limpieza creada para la habitación ${room}`;
    case 'cleaning_task_in_progress':
      return `Limpieza iniciada en la habitación ${room}`;
    case 'cleaning_task_completed':
      return `Limpieza terminada en la habitación ${room}`;
    case 'cleaning_task_inspected_pass':
      return `La habitación ${room} pasó la inspección`;
    case 'cleaning_task_inspected_fail':
      return `La habitación ${room} no pasó la inspección`;
    case 'cleaning_task_correction_pending':
      return `Habitación ${room} enviada a corrección`;

    case 'inspection_started':
      return `Inspección iniciada en la habitación ${room}`;
    case 'inspection_pass':
      return `La habitación ${room} pasó la inspección`;
    case 'inspection_fail': {
      const failed = Array.isArray(md.failed_items) ? md.failed_items.length : 0;
      return `La habitación ${room} no pasó la inspección — ${failed} problema${failed === 1 ? '' : 's'}`;
    }
    case 'inspection_cancelled':
      return `Inspección en la habitación ${room} cancelada`;

    case 'callout_reported':
      return `${actor} reportó ausencia${md.reason ? ` (${md.reason})` : ''}`;
    case 'callout_reverted':
      return `Se revirtió la ausencia de ${actor}`;

    case 'assignment_created':
      return `${actor} asignado a la habitación ${room}`;
    case 'assignment_deactivated':
      return `${actor} desasignado de la habitación ${room}`;

    case 'work_order_created':
      return `Orden de trabajo creada en la habitación ${room}`;
    case 'work_order_resolved':
      return `Orden de trabajo resuelta en la habitación ${room}`;
    case 'work_order_in_progress':
      return `Orden de trabajo en progreso en la habitación ${room}`;
    case 'work_order_closed':
      return `Orden de trabajo cerrada en la habitación ${room}`;
    case 'work_order_deferred':
      return `Orden de trabajo diferida en la habitación ${room}`;

    case 'room_status_changed': {
      const status = (md.status as string | undefined)?.replace(/_/g, ' ') ?? 'cambio';
      return `Habitación ${room}: ahora ${status}`;
    }

    case 'user_created':
      return `${actor} fue agregado con rol ${md.role ?? ''}`;
    case 'role_changed':
    case 'role_role_change':
      return `${actor} — rol cambiado de ${md.old_role ?? '?'} a ${md.new_role ?? '?'}`;
    case 'role_deactivate':
      return `${actor} fue desactivado`;
    case 'role_reactivate':
      return `${actor} fue reactivado`;
    case 'role_transfer_ownership':
      return `Propiedad transferida a ${actor}`;

    case 'break_started':
      return `${actor} comenzó un descanso (${md.break_type ?? 'corto'})`;
    case 'break_ended':
      return `${actor} terminó un descanso (${md.duration_minutes ?? '?'} min)`;

    case 'cleaning_paused_room':
      return `${actor} pausó la limpieza en la habitación ${room}${md.reason ? ` — ${md.reason}` : ''}`;
    case 'cleaning_resumed_room':
      return `${actor} reanudó la limpieza en la habitación ${room}`;

    default:
      return null;
  }
}

function roundMin(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
