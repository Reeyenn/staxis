/**
 * Activity log description renderer.
 *
 * The trigger functions in migration 0228 already pre-render an English
 * `description` for every row. That string is what we display by default
 * in the timeline + exports.
 *
 * This module exists so the UI can:
 *   - Group events into the friendly category label shown on the filter
 *     pills.
 *   - Map event_type to a leading icon (handled in the React layer).
 */

import type { ActivityCategory, ActivityLogRow, ActivitySource } from './types';

/** Friendly category labels for the filter pills + side panel header. */
export function categoryLabel(category: ActivityCategory): string {
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
export function sourceLabel(source: ActivitySource): string {
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
    case 'staxis_agent':      return 'Staxis';
  }
}

/**
 * Render the trigger-produced English description verbatim.
 */
export function renderDescription(row: ActivityLogRow): string {
  return row.description;
}
