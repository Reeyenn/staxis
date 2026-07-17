// ═══════════════════════════════════════════════════════════════════════════
// Complaints — shared, browser-safe types / enums / row-mappers + derived
// helpers. Imports only db-mappers' pure coercion helpers (which import only
// types), so this stays safe to use from client components, the anon-client db
// layer, server API routes, the agent tool, and the cron alike.
// ═══════════════════════════════════════════════════════════════════════════

import {
  toDate, parseStringField, parseUnionField, parseOptionalUnionField,
} from '@/lib/db-mappers';

export const COMPLAINT_CATEGORIES = [
  'maintenance', 'cleanliness', 'noise', 'service', 'billing', 'amenities', 'other',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_SEVERITIES = ['low', 'medium', 'high'] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];

export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_SOURCES = ['front_desk', 'housekeeper', 'voice', 'guest'] as const;
export type ComplaintSource = (typeof COMPLAINT_SOURCES)[number];

export const COMPLAINT_DEPTS = ['maintenance', 'housekeeping', 'front_desk', 'management', 'other'] as const;
export type ComplaintDept = (typeof COMPLAINT_DEPTS)[number];

/** App-facing complaint (camelCase, Dates parsed). */
export interface Complaint {
  id: string;
  propertyId: string;
  guestName: string | null;
  guestContact: string | null;
  roomNumber: string | null;
  category: ComplaintCategory;
  severity: ComplaintSeverity;
  description: string;
  status: ComplaintStatus;
  assignedTo: string | null;
  assignedName: string | null;
  assignedDept: ComplaintDept | null;
  linkedWorkOrderId: string | null;
  resolutionNotes: string | null;
  resolvedAt: Date | null;
  callbackAt: Date | null;
  callbackDone: boolean;
  callbackNotes: string | null;
  source: ComplaintSource;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ── row mappers (match db-mappers.ts house style: Record<string, unknown>) ──

export function fromComplaintRow(r: Record<string, unknown>): Complaint {
  return {
    id: String(r.id ?? ''),
    propertyId: String(r.property_id ?? ''),
    guestName: parseStringField(r.guest_name) ?? null,
    guestContact: parseStringField(r.guest_contact) ?? null,
    roomNumber: parseStringField(r.room_number) ?? null,
    category: parseUnionField(r.category, COMPLAINT_CATEGORIES, 'other'),
    severity: parseUnionField(r.severity, COMPLAINT_SEVERITIES, 'medium'),
    description: String(r.description ?? ''),
    status: parseUnionField(r.status, COMPLAINT_STATUSES, 'open'),
    assignedTo: parseStringField(r.assigned_to) ?? null,
    assignedName: parseStringField(r.assigned_name) ?? null,
    assignedDept: parseOptionalUnionField(r.assigned_dept, COMPLAINT_DEPTS) ?? null,
    linkedWorkOrderId: parseStringField(r.linked_work_order_id) ?? null,
    resolutionNotes: parseStringField(r.resolution_notes) ?? null,
    resolvedAt: toDate(r.resolved_at),
    callbackAt: toDate(r.callback_at),
    callbackDone: Boolean(r.callback_done),
    callbackNotes: parseStringField(r.callback_notes) ?? null,
    source: parseUnionField(r.source, COMPLAINT_SOURCES, 'front_desk'),
    createdBy: parseStringField(r.created_by) ?? null,
    createdByName: parseStringField(r.created_by_name) ?? null,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

// ── derived helpers used by tab + tile + cron ────────────────────────────────

/** A complaint is "overdue" if open/in_progress and older than this many hours. */
export const COMPLAINT_OVERDUE_HOURS = 24;
/** High-severity complaints are considered overdue sooner. */
export const COMPLAINT_OVERDUE_HOURS_HIGH = 4;

export function isOpenStatus(s: ComplaintStatus): boolean {
  return s === 'open' || s === 'in_progress';
}

/** Is this complaint aging past its severity-based SLA while still unresolved? */
export function isOverdue(c: Pick<Complaint, 'status' | 'severity' | 'createdAt'>, now: Date): boolean {
  if (!isOpenStatus(c.status) || !c.createdAt) return false;
  const limitH = c.severity === 'high' ? COMPLAINT_OVERDUE_HOURS_HIGH : COMPLAINT_OVERDUE_HOURS;
  return now.getTime() - c.createdAt.getTime() > limitH * 3600_000;
}

/** Is a satisfaction callback due (scheduled, not done, time has passed)? */
export function isCallbackDue(c: Pick<Complaint, 'callbackAt' | 'callbackDone'>, now: Date): boolean {
  return !c.callbackDone && !!c.callbackAt && c.callbackAt.getTime() <= now.getTime();
}
