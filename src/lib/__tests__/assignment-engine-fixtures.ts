/**
 * Shared test fixtures for the auto-assignment engine. Keeps each test
 * file free of boilerplate builder noise so the test bodies stay
 * focused on the behavior under verification.
 */

import type {
  AssignmentTask,
  AssignmentHousekeeper,
} from '@/types/assignments';
import { makeAssignmentConfig } from '@/types/assignments';

/** Fixed "now" for deterministic urgency math. 2026-05-24T09:00:00-05:00. */
export const FIXED_NOW_MS = Date.parse('2026-05-24T14:00:00.000Z');

export function mkTask(overrides: Partial<AssignmentTask> = {}): AssignmentTask {
  return {
    id: overrides.id ?? 'task-' + Math.random().toString(36).slice(2, 8),
    property_id: 'prop-1',
    room_number: '201',
    cleaning_type: 'departure',
    priority: 'normal',
    due_by: null,
    estimated_minutes: null,
    requires_inspection: false,
    extras: [],
    guest_language: null,
    ...overrides,
  };
}

export function mkHk(overrides: Partial<AssignmentHousekeeper> = {}): AssignmentHousekeeper {
  return {
    id: overrides.id ?? 'hk-' + Math.random().toString(36).slice(2, 8),
    name: 'Maria',
    language: 'en',
    isSenior: true,
    isActive: true,
    homeFloor: null,
    weeklyHours: 0,
    maxWeeklyHours: 40,
    isOutToday: false,
    ...overrides,
  };
}

export function mkConfig(overrides: Parameters<typeof makeAssignmentConfig>[0] = {}) {
  return makeAssignmentConfig({ nowMs: FIXED_NOW_MS, ...overrides });
}
