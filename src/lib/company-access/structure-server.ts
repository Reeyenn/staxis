import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';

import {
  parseCompanyStructureProjection,
  parsePortfolioAssignmentCommitResult,
  parsePortfolioAssignmentPreview,
  type CompanyStructureProjection,
  type PortfolioAssignmentCommitInput,
  type PortfolioAssignmentCommitResult,
  type PortfolioAssignmentInput,
  type PortfolioAssignmentPreview,
} from './structure';

interface RpcErrorLike {
  code?: string;
  message?: string;
}
export class CompanyStructureStoreError extends Error {
  readonly code?: string;

  constructor(operation: string, cause: RpcErrorLike | null, malformed = false) {
    super(malformed
      ? `${operation}: database response did not match the company structure contract`
      : `${operation}: ${cause?.message ?? 'database request failed'}`);
    this.name = 'CompanyStructureStoreError';
    this.code = malformed ? 'PGRST_CONTRACT' : cause?.code;
  }
}

export async function loadCompanyStructureProjection(
  actorAccountId: string,
): Promise<CompanyStructureProjection> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_company_structure_projection',
    { p_actor_account_id: actorAccountId },
  );
  if (error) throw new CompanyStructureStoreError('load company structure', error);
  const parsed = parseCompanyStructureProjection(data);
  if (!parsed) throw new CompanyStructureStoreError('load company structure', null, true);
  return parsed;
}

export async function previewCompanyPortfolioAssignment(
  actorAccountId: string,
  input: PortfolioAssignmentInput,
): Promise<PortfolioAssignmentPreview> {
  const { data, error } = await supabaseAdmin.rpc(
    '_staxis_preview_company_portfolio_assignment',
    {
      p_actor_account_id: actorAccountId,
      p_organization_id: input.organizationId,
      p_property_id: input.propertyId,
      p_desired_portfolio_ids: input.desiredPortfolioIds,
      p_expected_access_epoch: input.expectedAccessEpoch,
    },
  );
  if (error) throw new CompanyStructureStoreError('preview portfolio assignment', error);
  const parsed = parsePortfolioAssignmentPreview(data);
  if (!parsed) throw new CompanyStructureStoreError('preview portfolio assignment', null, true);
  return parsed;
}

export async function commitCompanyPortfolioAssignment(
  actorAccountId: string,
  input: PortfolioAssignmentCommitInput,
  idempotencyKey: string,
): Promise<PortfolioAssignmentCommitResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_commit_company_portfolio_assignment',
    {
      p_actor_account_id: actorAccountId,
      p_organization_id: input.organizationId,
      p_property_id: input.propertyId,
      p_desired_portfolio_ids: input.desiredPortfolioIds,
      p_expected_access_epoch: input.expectedAccessEpoch,
      p_preview_fingerprint: input.previewFingerprint,
      p_confirmed: input.confirmed,
      p_idempotency_key: idempotencyKey,
    },
  );
  if (error) throw new CompanyStructureStoreError('commit portfolio assignment', error);
  const parsed = parsePortfolioAssignmentCommitResult(data);
  if (!parsed) throw new CompanyStructureStoreError('commit portfolio assignment', null, true);
  return parsed;
}
