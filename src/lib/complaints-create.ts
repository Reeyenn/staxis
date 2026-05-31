// ═══════════════════════════════════════════════════════════════════════════
// Complaints — server-side create + auto-route.  Shared by the API route AND
// the agent/voice tool so both behave identically. Uses supabaseAdmin
// (service role) → bypasses RLS, so it works for any authorized caller after
// the route/tool has done its own property-access check.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { classifyComplaint } from '@/lib/complaints-ai';
import {
  type Complaint, type ComplaintCategory, type ComplaintSeverity,
  type ComplaintSource, type ComplaintDept,
  fromComplaintRow,
} from '@/lib/complaints-shared';

export interface CreateComplaintInput {
  propertyId: string;
  description: string;
  guestName?: string | null;
  guestContact?: string | null;
  roomNumber?: string | null;
  /** Omit category/severity to let Claude classify. */
  category?: ComplaintCategory | null;
  severity?: ComplaintSeverity | null;
  source: ComplaintSource;
  createdBy?: string | null;
  createdByName?: string | null;
  /** Auto-create + link a work order for maintenance/cleanliness. Default true. */
  autoRoute?: boolean;
}

export interface CreateComplaintResult {
  complaint: Complaint;
  linkedWorkOrderId: string | null;
  aiClassified: boolean;
  /** Prior complaints for the same room + category in the last 30 days. */
  repeatCount: number;
}

// The legacy work_orders table (what the Maintenance tab + Dashboard tile
// read via subscribeToWorkOrders) has NO title/category/priority columns —
// those live on pms_work_orders_v2. Its real columns are room_number (NOT
// NULL), description (NOT NULL), severity (NOT NULL: low|medium|urgent),
// status (submitted|assigned|in_progress|resolved), source, notes. Map
// complaint severity onto that severity enum.
function severityToWoSeverity(s: ComplaintSeverity): 'low' | 'medium' | 'urgent' {
  return s === 'high' ? 'urgent' : s === 'low' ? 'low' : 'medium';
}

/** Count prior complaints for the same room + category in the trailing 30 days. */
export async function getRepeatCount(
  propertyId: string, roomNumber: string | null, category: ComplaintCategory,
): Promise<number> {
  if (!roomNumber) return 0;
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('complaints')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq('room_number', roomNumber)
    .eq('category', category)
    .gte('created_at', since);
  if (error) { log.warn('[complaints] repeat count failed', { err: error.message }); return 0; }
  return count ?? 0;
}

/**
 * Create a complaint. Classifies category+severity when not supplied, inserts,
 * and (for maintenance/cleanliness) auto-creates + links a work order. Returns
 * the saved complaint plus repeat-issue info. Throws only on the complaint
 * insert itself failing — auto-route/AI failures are swallowed (best-effort).
 */
export async function createComplaint(input: CreateComplaintInput): Promise<CreateComplaintResult> {
  const description = input.description.trim();

  // 1. Classify if needed (best-effort).
  let category = input.category ?? null;
  let severity = input.severity ?? null;
  let aiClassified = false;
  if (!category || !severity) {
    const c = await classifyComplaint(description, input.roomNumber);
    if (!category) category = c.category;
    if (!severity) severity = c.severity;
    aiClassified = c.aiClassified;
  }
  const finalCategory: ComplaintCategory = category ?? 'other';
  const finalSeverity: ComplaintSeverity = severity ?? 'medium';

  // 2. Pre-decide dept (so it lands on the inserted row).
  const assignedDept: ComplaintDept | null =
    finalCategory === 'maintenance' ? 'maintenance'
    : finalCategory === 'cleanliness' ? 'housekeeping'
    : null;

  // 3. Insert the complaint.
  const { data: inserted, error } = await supabaseAdmin
    .from('complaints')
    .insert({
      property_id: input.propertyId,
      guest_name: input.guestName ?? null,
      guest_contact: input.guestContact ?? null,
      room_number: input.roomNumber ?? null,
      category: finalCategory,
      severity: finalSeverity,
      description,
      status: 'open',
      assigned_dept: assignedDept,
      source: input.source,
      created_by: input.createdBy ?? null,
      created_by_name: input.createdByName ?? null,
    })
    .select('*')
    .single();
  if (error || !inserted) {
    log.error('[complaints] insert failed', { err: error?.message });
    throw new Error('Failed to save complaint');
  }
  const complaintId = String(inserted.id);

  // 4. Repeat-issue lookup (excludes the row we just inserted).
  const repeatTotal = await getRepeatCount(input.propertyId, input.roomNumber ?? null, finalCategory);
  const repeatCount = Math.max(0, repeatTotal - 1);

  // 5. Auto-route maintenance/cleanliness → a linked work order (best-effort).
  let linkedWorkOrderId: string | null = null;
  const shouldRoute = input.autoRoute !== false && assignedDept !== null;
  if (shouldRoute) {
    try {
      const deptLabel = finalCategory === 'cleanliness' ? 'Cleanliness' : 'Maintenance';
      const { data: wo, error: woErr } = await supabaseAdmin
        .from('work_orders')
        .insert({
          property_id: input.propertyId,
          room_number: input.roomNumber || 'N/A', // legacy work_orders.room_number is NOT NULL
          description: `${deptLabel}: ${description}`.slice(0, 1000),
          severity: severityToWoSeverity(finalSeverity), // legacy enum: low|medium|urgent
          status: 'submitted',
          source: 'manual',
          notes: `Auto-created from guest complaint ${complaintId}.`,
        })
        .select('id')
        .single();
      if (woErr || !wo) {
        log.warn('[complaints] auto-route work order failed', { complaintId, err: woErr?.message });
      } else {
        linkedWorkOrderId = String(wo.id);
        const { error: linkErr } = await supabaseAdmin
          .from('complaints')
          .update({ linked_work_order_id: linkedWorkOrderId })
          .eq('id', complaintId);
        if (linkErr) log.warn('[complaints] link work order failed', { complaintId, err: linkErr.message });
      }
    } catch (e) {
      log.warn('[complaints] auto-route threw', { complaintId, err: e instanceof Error ? e.message : String(e) });
    }
  }

  // Re-read so the returned row reflects the link (cheap, single row).
  const { data: fresh } = await supabaseAdmin.from('complaints').select('*').eq('id', complaintId).single();
  const complaint = fromComplaintRow((fresh ?? inserted) as Record<string, unknown>);

  return { complaint, linkedWorkOrderId, aiClassified, repeatCount };
}
