import 'server-only';

import type { NextRequest, NextResponse } from 'next/server';
import { requireSession as requireExistingSession } from '@/lib/api-auth';
import {
  capabilityDecisionForProperty,
  capabilityDecisionForPropertyFresh,
  type CapabilityDecision,
} from '@/lib/capabilities/server';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import {
  requireSectionEnabled,
  type SectionGate,
} from '@/lib/sections/server';
import type { AppSection, EnabledSections } from '@/lib/sections/registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from './server';

/** Authenticated identity. Hotel authority is deliberately resolved separately. */
export interface RequestPrincipal {
  authUserId: string;
  email: string | null;
}

/** Identity joined to the active Staxis account used by the authority resolver. */
export interface AccountRequestPrincipal extends RequestPrincipal {
  accountId: string;
}

export type HotelReadAuthorizationCheck =
  | {
    kind: 'capability';
    capability: CapabilityKey;
    /** Commit boundaries may opt out of the request cache explicitly. */
    freshness?: 'request' | 'fresh';
  }
  | { kind: 'section'; section: AppSection };

export type HotelAuthorizationCheck =
  | HotelReadAuthorizationCheck
  | { kind: 'mutation-standing' };

export type AuthorizeHotelRequestInput =
  | {
    propertyId: string;
    intent: 'read';
    checks?: readonly HotelReadAuthorizationCheck[];
  }
  | {
    propertyId: string;
    intent: 'mutation';
    /**
     * Must contain exactly one mutation-standing check. Its position preserves
     * each route's existing section/capability/error ordering.
     */
    checks: readonly HotelAuthorizationCheck[];
  };

export interface AuthorizedHotelRequest {
  ok: true;
  requestId: string;
  principal: AccountRequestPrincipal;
  propertyId: string;
  authority: AuthoritativePropertyAccess;
  standing: AuthoritativePropertyStanding;
  allowedCapabilities: CapabilityKey[];
  /** Undefined when no section check was requested; null is a valid default-on map. */
  enabledSections: EnabledSections | undefined;
}

export type HotelAuthorizationRefusal =
  | { ok: false; reason: 'account_denied' }
  | { ok: false; reason: 'account_unavailable' }
  | { ok: false; reason: 'authority_unavailable' }
  | { ok: false; reason: 'property_denied' }
  | { ok: false; reason: 'mutation_denied' }
  | { ok: false; reason: 'capability_denied'; capability: CapabilityKey }
  | { ok: false; reason: 'capability_unavailable'; capability: CapabilityKey }
  | { ok: false; reason: 'section_denied'; section: AppSection; response: NextResponse };

export type HotelRequestAuthorizationResult =
  | AuthorizedHotelRequest
  | HotelAuthorizationRefusal;

export interface AuthorizedRequestSession {
  ok: true;
  requestId: string;
  principal: RequestPrincipal;
  authorizeHotel(input: AuthorizeHotelRequestInput): Promise<HotelRequestAuthorizationResult>;
}

export type RequestSessionAuthorizationResult =
  | AuthorizedRequestSession
  | { ok: false; reason: 'session_denied'; response: NextResponse };

export interface RequestAuthorizationFacade {
  /**
   * Runs the existing session + MFA gate unchanged. This hotel facade never
   * exposes the underlying `enforce2FA:false` escape hatch; non-MFA endpoints
   * must use their separate credential boundary and cannot obtain hotel
   * authorization from this object.
   */
  requireSession(): Promise<RequestSessionAuthorizationResult>;
}

type AccountResolution =
  | { kind: 'active'; accountId: string }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/**
 * Dependency seam used by focused parity tests. Production routes must call
 * createRequestAuthorization(), which supplies the existing resolvers below.
 */
export interface RequestAuthorizationDependencies {
  requireSession(req: NextRequest): Promise<
    | { ok: true; userId: string; email: string | null }
    | { ok: false; response: NextResponse }
  >;
  loadAccount(authUserId: string): Promise<AccountResolution>;
  loadAuthority(accountId: string): Promise<AuthoritativePropertyAccess | null>;
  capabilityDecision(
    standing: AuthoritativePropertyStanding,
    capability: CapabilityKey,
    propertyId: string,
    freshness: 'request' | 'fresh',
  ): Promise<CapabilityDecision>;
  sectionDecision(
    req: NextRequest,
    propertyId: string,
    section: AppSection,
  ): Promise<SectionGate>;
}

/** @internal Exported only so the orchestration can be tested without live auth/data stores. */
export function createRequestAuthorizationWithDependencies(
  req: NextRequest,
  input: { requestId: string },
  dependencies: RequestAuthorizationDependencies,
): RequestAuthorizationFacade {
  return {
    async requireSession() {
      const session = await dependencies.requireSession(req);
      if (!session.ok) {
        return { ok: false, reason: 'session_denied', response: session.response };
      }

      const principal: RequestPrincipal = {
        authUserId: session.userId,
        email: session.email,
      };

      return {
        ok: true,
        requestId: input.requestId,
        principal,
        async authorizeHotel(hotelInput) {
          const checks: readonly HotelAuthorizationCheck[] = hotelInput.checks ?? [];
          const mutationCheckCount = checks.filter(
            (check) => check.kind === 'mutation-standing',
          ).length;
          if (hotelInput.intent === 'mutation' && mutationCheckCount !== 1) {
            throw new Error(
              'Mutation hotel authorization requires exactly one ordered mutation-standing check.',
            );
          }
          if (hotelInput.intent === 'read' && mutationCheckCount !== 0) {
            throw new Error('Read hotel authorization cannot include a mutation-standing check.');
          }

          // Reach is always resolved before property-specific section or
          // capability state. This ordering prevents cross-hotel probes from
          // learning whether another hotel's feature switches are configured.
          const account = await dependencies.loadAccount(principal.authUserId);
          if (account.kind === 'denied') return { ok: false, reason: 'account_denied' };
          if (account.kind === 'unavailable') {
            return { ok: false, reason: 'account_unavailable' };
          }

          const authority = await dependencies.loadAuthority(account.accountId);
          if (!authority) return { ok: false, reason: 'authority_unavailable' };
          const standing = authoritativeStandingForProperty(authority, hotelInput.propertyId);
          if (!standing) return { ok: false, reason: 'property_denied' };

          const allowedCapabilities: CapabilityKey[] = [];
          let enabledSections: EnabledSections | undefined;
          for (const check of checks) {
            if (check.kind === 'mutation-standing') {
              if (!standing.hotelMutationAllowed) {
                return { ok: false, reason: 'mutation_denied' };
              }
              continue;
            }

            if (check.kind === 'capability') {
              const decision = await dependencies.capabilityDecision(
                standing,
                check.capability,
                hotelInput.propertyId,
                check.freshness ?? 'request',
              );
              if (decision === 'unavailable') {
                return {
                  ok: false,
                  reason: 'capability_unavailable',
                  capability: check.capability,
                };
              }
              if (decision === 'denied') {
                return {
                  ok: false,
                  reason: 'capability_denied',
                  capability: check.capability,
                };
              }
              allowedCapabilities.push(check.capability);
              continue;
            }

            // Use the existing composite section gate, including its repeated
            // session/MFA check, so pilot routes retain today's decisions and
            // response envelopes exactly. A later optimization requires its
            // own explicit parity review.
            const section = await dependencies.sectionDecision(
              req,
              hotelInput.propertyId,
              check.section,
            );
            if (!section.ok) {
              return {
                ok: false,
                reason: 'section_denied',
                section: check.section,
                response: section.response,
              };
            }
            enabledSections = section.enabledSections;
          }

          return {
            ok: true,
            requestId: input.requestId,
            principal: { ...principal, accountId: account.accountId },
            propertyId: hotelInput.propertyId,
            authority,
            standing,
            allowedCapabilities,
            enabledSections,
          };
        },
      };
    },
  };
}

const productionDependencies: RequestAuthorizationDependencies = {
  requireSession: requireExistingSession,
  async loadAccount(authUserId) {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('id, active')
      .eq('data_user_id', authUserId)
      .maybeSingle();
    if (error) return { kind: 'unavailable' };
    if (!data || data.active !== true) return { kind: 'denied' };
    return { kind: 'active', accountId: data.id as string };
  },
  loadAuthority: listAuthoritativePropertyAccess,
  capabilityDecision(standing, capability, propertyId, freshness) {
    const decide = freshness === 'fresh'
      ? capabilityDecisionForPropertyFresh
      : capabilityDecisionForProperty;
    return decide({ role: standing.operationalRole }, capability, propertyId);
  },
  sectionDecision: requireSectionEnabled,
};

/**
 * Behavior-preserving request authorization spine for authenticated hotel APIs.
 * It composes existing sources; it does not reinterpret roles or entitlements.
 */
export function createRequestAuthorization(
  req: NextRequest,
  input: { requestId: string },
): RequestAuthorizationFacade {
  return createRequestAuthorizationWithDependencies(req, input, productionDependencies);
}
