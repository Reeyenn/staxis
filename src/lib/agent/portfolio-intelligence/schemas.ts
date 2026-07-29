import { z } from 'zod';

import {
  PORTFOLIO_MAX_DETAIL_ROWS,
  PORTFOLIO_QUERY_PLAN_VERSION,
} from './versions';

export const uuidSchema = z.string().uuid();

export const portfolioMetricIdSchema = z.enum([
  'rooms_booked_otb',
  'live_in_house_rooms',
  'final_rooms_sold',
  'housekeeping_rooms_cleaned',
  'housekeeping_active_minutes',
  'work_orders_open',
]);
export type PortfolioMetricId = z.infer<typeof portfolioMetricIdSchema>;

export const portfolioKnowledgeCategorySchema = z.enum([
  'standards',
  'money',
  'vendors',
  'people',
  'guests',
  'rooms',
  'rhythm',
]);
export type PortfolioKnowledgeCategory = z.infer<typeof portfolioKnowledgeCategorySchema>;

export const portfolioKnowledgeQuerySchema = z.object({
  categories: z.array(portfolioKnowledgeCategorySchema).max(7),
  terms: z.array(
    z.string().regex(/^[a-z0-9][a-z0-9_]{1,47}$/),
  ).max(12),
}).strict();
export type PortfolioKnowledgeQuery = z.infer<typeof portfolioKnowledgeQuerySchema>;

export const portfolioScopeSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all_authorized') }).strict(),
  z.object({ kind: z.literal('portfolio'), portfolioId: uuidSchema }).strict(),
  z.object({
    kind: z.literal('explicit_subset'),
    propertyIds: z.array(uuidSchema).min(1).max(250),
  }).strict(),
  z.object({ kind: z.literal('hotel'), propertyId: uuidSchema }).strict(),
]);
export type PortfolioScopeSelector = z.infer<typeof portfolioScopeSelectorSchema>;

export const portfolioQueryPlanSchema = z.object({
  version: z.literal(PORTFOLIO_QUERY_PLAN_VERSION),
  intent: z.enum([
    'portfolio_summary',
    'metric_total',
    'metric_comparison',
    'property_drilldown',
    'knowledge_lookup',
    'generic_tools',
  ]),
  selector: portfolioScopeSelectorSchema,
  metricIds: z.array(portfolioMetricIdSchema).max(6),
  /** Present only for the deterministic company/property knowledge path. The
   * renderer receives opaque claim IDs; these bounded lexical hints merely
   * select which already-confirmed records enter that catalog. */
  knowledgeQuery: portfolioKnowledgeQuerySchema.optional(),
  window: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hotel_business_today') }).strict(),
    z.object({ kind: z.literal('trailing_complete_days'), days: z.number().int().min(1).max(90) }).strict(),
  ]),
  groupBy: z.enum(['portfolio', 'property']),
  comparison: z.enum(['none', 'own_same_weekday_normal']),
  detailLimit: z.number().int().min(1).max(PORTFOLIO_MAX_DETAIL_ROWS),
  defaultedScope: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.intent === 'knowledge_lookup') {
    if (!value.knowledgeQuery) {
      ctx.addIssue({
        code: 'custom',
        path: ['knowledgeQuery'],
        message: 'knowledge lookup requires a bounded knowledge query',
      });
    }
    if (value.metricIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['metricIds'],
        message: 'knowledge lookup cannot carry metric ids',
      });
    }
  } else if (value.knowledgeQuery !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['knowledgeQuery'],
      message: 'knowledge query is valid only for knowledge lookup',
    });
  }
});
export type PortfolioQueryPlan = z.infer<typeof portfolioQueryPlanSchema>;

export interface ScopeHotelCandidate {
  propertyId: string;
  name: string;
  city: string | null;
  region: string | null;
  propertyCode: string | null;
  timezone: string | null;
  businessDateCutoffHour: number | null;
  totalRooms: number | null;
  portfolioIds: string[];
}

export interface ScopePortfolioCandidate {
  portfolioId: string;
  name: string;
  type: 'portfolio' | 'region' | 'division' | 'other' | string;
  propertyIds: string[];
}

export interface PlannerScopeCatalog {
  organizationId: string;
  hotels: ScopeHotelCandidate[];
  portfolios: ScopePortfolioCandidate[];
}

export type PlannedQuestion =
  | { ok: true; plan: PortfolioQueryPlan }
  | {
      ok: false;
      kind: 'clarification' | 'unsupported' | 'scope_denied' | 'budget_exceeded';
      message: string;
      candidates?: Array<{ propertyId: string; label: string }>;
    };

export const portfolioToolInputSchema = z.object({
  scopeReceiptId: uuidSchema,
  plan: portfolioQueryPlanSchema,
  targetPropertyIds: z.array(uuidSchema).min(1).max(250),
}).strict();
export type PortfolioToolInput = z.infer<typeof portfolioToolInputSchema>;
