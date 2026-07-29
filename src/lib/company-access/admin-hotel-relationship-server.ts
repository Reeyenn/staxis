import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';

import {
  parseAdminHotelRelationshipCommitResult,
  parseAdminHotelRelationshipPreview,
  parseAdminHotelRelationshipProjection,
  type AdminHotelRelationshipChangeInput,
  type AdminHotelRelationshipCommitInput,
  type AdminHotelRelationshipCommitResult,
  type AdminHotelRelationshipPreview,
  type AdminHotelRelationshipProjection,
} from './admin-hotel-relationship';

interface RpcErrorLike { code?: string; message?: string }

export class AdminHotelRelationshipStoreError extends Error {
  readonly code?: string;

  constructor(operation: string, cause: RpcErrorLike | null, malformed = false) {
    super(malformed
      ? `${operation}: database response did not match the admin hotel relationship contract`
      : `${operation}: ${cause?.message ?? 'database request failed'}`);
    this.name = 'AdminHotelRelationshipStoreError';
    this.code = malformed ? 'PGRST_CONTRACT' : cause?.code;
  }
}

export async function loadAdminHotelRelationshipProjection(
  actorAccountId: string,
  propertyId: string,
  organizationQuery: string,
): Promise<AdminHotelRelationshipProjection> {
  const { data, error } = await supabaseAdmin.rpc('staxis_admin_hotel_relationship_projection', {
    p_actor_account_id: actorAccountId,
    p_property_id: propertyId,
    p_organization_query: organizationQuery,
  });
  if (error) throw new AdminHotelRelationshipStoreError('load hotel relationship', error);
  const parsed = parseAdminHotelRelationshipProjection(data);
  if (!parsed) throw new AdminHotelRelationshipStoreError('load hotel relationship', null, true);
  return parsed;
}

export async function previewAdminHotelRelationshipChange(
  actorAccountId: string,
  input: AdminHotelRelationshipChangeInput,
): Promise<AdminHotelRelationshipPreview> {
  const { data, error } = await supabaseAdmin.rpc('_staxis_preview_admin_hotel_relationship', {
    p_actor_account_id: actorAccountId,
    p_property_id: input.propertyId,
    p_target_organization_id: input.targetOrganizationId,
    p_relationship_type: input.relationshipType,
    p_expected_relationship_revision: input.expectedRelationshipRevision,
  });
  if (error) throw new AdminHotelRelationshipStoreError('preview hotel relationship', error);
  const parsed = parseAdminHotelRelationshipPreview(data);
  if (!parsed) throw new AdminHotelRelationshipStoreError('preview hotel relationship', null, true);
  return parsed;
}

export async function commitAdminHotelRelationshipChange(
  actorAccountId: string,
  input: AdminHotelRelationshipCommitInput,
  idempotencyKey: string,
): Promise<AdminHotelRelationshipCommitResult> {
  const { data, error } = await supabaseAdmin.rpc('staxis_commit_admin_hotel_relationship', {
    p_actor_account_id: actorAccountId,
    p_property_id: input.propertyId,
    p_target_organization_id: input.targetOrganizationId,
    p_relationship_type: input.relationshipType,
    p_expected_relationship_revision: input.expectedRelationshipRevision,
    p_preview_fingerprint: input.previewFingerprint,
    p_confirmed: input.confirmed,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new AdminHotelRelationshipStoreError('commit hotel relationship', error);
  const parsed = parseAdminHotelRelationshipCommitResult(data);
  if (!parsed) throw new AdminHotelRelationshipStoreError('commit hotel relationship', null, true);
  return parsed;
}
