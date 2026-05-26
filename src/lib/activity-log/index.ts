/**
 * Cross-department activity log module.
 *
 * Surface: types + readers + a recorder for events without a source table.
 * Writers for events that DO have a source table happen automatically via
 * the triggers in supabase/migrations/0228_activity_log.sql.
 */

export * from './types';
export * from './renderer';
export * from './query';
export * from './recorder';
export * from './export';
