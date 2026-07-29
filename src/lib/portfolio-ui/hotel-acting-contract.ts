import { z } from 'zod';

import { ALL_ROLES, type AppRole } from '@/lib/roles';
import { PORTFOLIO_UI_SECTIONS, type PortfolioUiSection } from './contracts';

export const HOTEL_ACTING_CONTEXT_VERSION = 'hotel-acting-context.v1' as const;

export type HotelActingContextSource = 'local' | 'portfolio';
export type HotelActingParentKind = 'company' | 'region' | 'portfolio' | 'selected_hotels';

export interface HotelActingContextV1 {
  version: typeof HOTEL_ACTING_CONTEXT_VERSION;
  verifiedAt: string;
  source: HotelActingContextSource;
  organization: { id: string; name: string | null } | null;
  parentScope: { kind: HotelActingParentKind; id: string; name: string } | null;
  property: {
    id: string;
    name: string;
    region: string | null;
    totalRooms: number | null;
    timezone: string | null;
  };
  standing: {
    operationalRole: Exclude<AppRole, 'admin'>;
    localHotelAccess: boolean;
    hotelDetailRead: boolean;
    hotelMutationAllowed: boolean;
    seesFinancials: boolean;
    portfolioIntelligenceRead: boolean;
  };
  portfolioFeatures: {
    /** Exact whole-company queue visibility; never inferred from role. */
    queueAvailable: boolean;
  };
  sectionAvailability: Record<PortfolioUiSection | 'staxis', boolean>;
}

const uuid = z.string().uuid();
const instant = z.string().refine(
  (value) => value.includes('T') && Number.isFinite(Date.parse(value)),
  'must be an ISO-8601 instant',
);
const nullableLabel = z.string().trim().min(1).max(240).nullable();
const parentKinds = ['company', 'region', 'portfolio', 'selected_hotels'] as const;
const hotelRoles = ALL_ROLES.filter((role) => role !== 'admin') as [
  Exclude<AppRole, 'admin'>,
  ...Array<Exclude<AppRole, 'admin'>>,
];

const sectionAvailabilityShape = Object.fromEntries([
  ...PORTFOLIO_UI_SECTIONS,
  'staxis',
].map((section) => [section, z.boolean()])) as Record<
  PortfolioUiSection | 'staxis',
  z.ZodBoolean
>;

export const hotelActingContextSchema = z.object({
  version: z.literal(HOTEL_ACTING_CONTEXT_VERSION),
  verifiedAt: instant,
  source: z.enum(['local', 'portfolio']),
  organization: z.object({ id: uuid, name: nullableLabel }).strict().nullable(),
  parentScope: z.object({
    kind: z.enum(parentKinds),
    id: uuid,
    name: z.string().trim().min(1).max(240),
  }).strict().nullable(),
  property: z.object({
    id: uuid,
    name: z.string().trim().min(1).max(240),
    region: nullableLabel,
    totalRooms: z.number().int().nonnegative().nullable(),
    timezone: nullableLabel,
  }).strict(),
  standing: z.object({
    operationalRole: z.enum(hotelRoles),
    localHotelAccess: z.boolean(),
    hotelDetailRead: z.boolean(),
    hotelMutationAllowed: z.boolean(),
    seesFinancials: z.boolean(),
    portfolioIntelligenceRead: z.boolean(),
  }).strict(),
  portfolioFeatures: z.object({ queueAvailable: z.boolean() }).strict(),
  sectionAvailability: z.object(sectionAvailabilityShape).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.source === 'portfolio') {
    if (!value.organization || !value.parentScope) {
      ctx.addIssue({
        code: 'custom',
        path: ['organization'],
        message: 'portfolio hotel context requires an organization and parent scope',
      });
    }
    if (value.standing.localHotelAccess || !value.standing.hotelDetailRead) {
      ctx.addIssue({
        code: 'custom',
        path: ['standing'],
        message: 'portfolio hotel context requires portfolio detail reach without local-hotel elevation',
      });
    }
  } else {
    if (value.organization || value.parentScope) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentScope'],
        message: 'local hotel context cannot carry a portfolio parent',
      });
    }
    if (!value.standing.localHotelAccess || !value.standing.hotelDetailRead) {
      ctx.addIssue({
        code: 'custom',
        path: ['standing'],
        message: 'local hotel context requires explicit hotel access',
      });
    }
    if (value.portfolioFeatures.queueAvailable) {
      ctx.addIssue({
        code: 'custom',
        path: ['portfolioFeatures', 'queueAvailable'],
        message: 'local hotel context cannot advertise a company queue',
      });
    }
  }
  if (value.standing.hotelMutationAllowed && !value.standing.hotelDetailRead) {
    ctx.addIssue({
      code: 'custom',
      path: ['standing', 'hotelMutationAllowed'],
      message: 'hotel mutation requires hotel detail access',
    });
  }
});

/** Treat even a same-origin response as untrusted until its closed DTO validates. */
export function parseHotelActingContext(value: unknown): HotelActingContextV1 | null {
  const result = hotelActingContextSchema.safeParse(value);
  return result.success ? result.data : null;
}
