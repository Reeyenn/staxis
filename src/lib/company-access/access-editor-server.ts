import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';

import {
  parseCompanyAccessEditCommitResult,
  parseCompanyAccessEditPreview,
  parseCompanyAccessEditorProjection,
  type CompanyAccessEditCommitInput,
  type CompanyAccessEditCommitResult,
  type CompanyAccessEditInput,
  type CompanyAccessEditPreview,
  type CompanyAccessEditorProjection,
} from './access-editor';

interface RpcErrorLike {
  code?: string;
  message?: string;
}

export class CompanyAccessEditorStoreError extends Error {
  readonly code?: string;

  constructor(operation: string, cause: RpcErrorLike | null, malformed = false) {
    super(malformed
      ? `${operation}: database response did not match the company access editor contract`
      : `${operation}: ${cause?.message ?? 'database request failed'}`);
    this.name = 'CompanyAccessEditorStoreError';
    this.code = malformed ? 'PGRST_CONTRACT' : cause?.code;
  }
}

export async function loadCompanyAccessEditorProjection(
  actorAccountId: string,
): Promise<CompanyAccessEditorProjection> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_company_access_editor_projection_v2',
    { p_actor_account_id: actorAccountId },
  );
  if (error) throw new CompanyAccessEditorStoreError('load company access editor', error);
  const parsed = parseCompanyAccessEditorProjection(data);
  if (!parsed) throw new CompanyAccessEditorStoreError('load company access editor', null, true);
  return parsed;
}

export async function previewCompanyAccessEdit(
  actorAccountId: string,
  input: CompanyAccessEditInput,
): Promise<CompanyAccessEditPreview> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_preview_company_access_edit_v2',
    {
      p_actor_account_id: actorAccountId,
      p_organization_id: input.organizationId,
      p_membership_id: input.membershipId,
      p_operation: input.operation,
      p_access_profile: input.accessProfile,
      p_scope_kind: input.scopeKind,
      p_portfolio_id: input.portfolioId,
      p_property_ids: input.propertyIds,
      p_expires_at: input.expiresAt,
      p_expected_access_epoch: input.expectedAccessEpoch,
      p_expected_access_revision: input.expectedAccessRevision,
    },
  );
  if (error) throw new CompanyAccessEditorStoreError('preview company access edit', error);
  const parsed = parseCompanyAccessEditPreview(data);
  if (!parsed) throw new CompanyAccessEditorStoreError('preview company access edit', null, true);
  return parsed;
}

export async function commitCompanyAccessEdit(
  actorAccountId: string,
  input: CompanyAccessEditCommitInput,
  idempotencyKey: string,
): Promise<CompanyAccessEditCommitResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_commit_company_access_edit_v2',
    {
      p_actor_account_id: actorAccountId,
      p_organization_id: input.organizationId,
      p_membership_id: input.membershipId,
      p_operation: input.operation,
      p_access_profile: input.accessProfile,
      p_scope_kind: input.scopeKind,
      p_portfolio_id: input.portfolioId,
      p_property_ids: input.propertyIds,
      p_expires_at: input.expiresAt,
      p_expected_access_epoch: input.expectedAccessEpoch,
      p_expected_access_revision: input.expectedAccessRevision,
      p_preview_fingerprint: input.previewFingerprint,
      p_confirmed: input.confirmed,
      p_idempotency_key: idempotencyKey,
    },
  );
  if (error) throw new CompanyAccessEditorStoreError('commit company access edit', error);
  const parsed = parseCompanyAccessEditCommitResult(data);
  if (!parsed) throw new CompanyAccessEditorStoreError('commit company access edit', null, true);
  return parsed;
}
