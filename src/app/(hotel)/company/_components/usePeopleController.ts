'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type { StaffMember } from '@/types';

import type { CompanyJobLine, HotelTeamMember } from './HotelTeamPanel';

interface TeamEnvelope {
  ok?: boolean;
  data?: {
    team?: unknown;
    hatsByAccountId?: unknown;
  };
  error?: unknown;
}

interface TeamSnapshot {
  key: string;
  team: HotelTeamMember[];
  jobsByAccountId: Record<string, CompanyJobLine[]>;
  status: 'loading' | 'ready' | 'error';
  error: string;
}

export interface PeopleControllerInput {
  /** The exact selected hotel. A null id is always fail-closed. */
  hotelId: string | null;
  /** Canonical identity/capability stamp for the selected hotel. */
  viewerKey: string | null;
  enabled: boolean;
  adminPreview: boolean;
  readOnly: boolean;
  /** Staff remains subscribed by PropertyContext; this controller consumes its
   * viewer-stamped snapshot instead of opening another subscription. */
  staff: StaffMember[];
  staffViewerKey: string | null;
  staffExpectedViewerKey: string | null;
  staffLoaded: boolean;
  staffLoadFailed: boolean;
  refreshStaff: () => Promise<void>;
}

export interface PeopleControllerState {
  /** Canonical account projection from GET /api/auth/team. */
  team: HotelTeamMember[];
  jobsByAccountId: Record<string, CompanyJobLine[]>;
  teamLoading: boolean;
  teamError: string;
  teamSettled: boolean;
  /** PropertyContext's exact-property staff snapshot, fail-closed when stale. */
  staff: StaffMember[];
  staffLoaded: boolean;
  rosterUnavailable: boolean;
  staffViewerKey: string | null;
  refreshTeam: () => Promise<void>;
  refresh: () => Promise<void>;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isHotelTeamMember(value: unknown): value is HotelTeamMember {
  if (!isRecord(value)) return false;
  return typeof value.accountId === 'string'
    && typeof value.username === 'string'
    && typeof value.displayName === 'string'
    && typeof value.email === 'string'
    && typeof value.role === 'string'
    && typeof value.active === 'boolean'
    && typeof value.updatedAt === 'string'
    && typeof value.ownerProtected === 'boolean'
    && typeof value.lastSignInKnown === 'boolean'
    && isStringOrNull(value.lastSignInAt)
    && Array.isArray(value.propertyAccess)
    && value.propertyAccess.every((propertyId) => typeof propertyId === 'string')
    && isStringOrNull(value.staffId)
    && isStringOrNull(value.historicalStaffId)
    && typeof value.staffLinkAllowed === 'boolean'
    && (value.managementSurface === 'legacy_hotel' || value.managementSurface === 'company_access');
}

function isCompanyJobLine(value: unknown): value is CompanyJobLine {
  if (!isRecord(value) || !isRecord(value.label)) return false;
  return typeof value.membershipId === 'string'
    && (value.scope === 'company' || value.scope === 'property')
    && typeof value.role === 'string'
    && typeof value.label.en === 'string'
    && (value.label.es === undefined || typeof value.label.es === 'string')
    && Array.isArray(value.propertyIds)
    && value.propertyIds.every((propertyId) => typeof propertyId === 'string')
    && Array.isArray(value.propertyNames)
    && value.propertyNames.every((propertyName) => typeof propertyName === 'string');
}

function controllerIdentityKey({
  enabled,
  hotelId,
  viewerKey,
  adminPreview,
  readOnly,
}: Pick<PeopleControllerInput, 'enabled' | 'hotelId' | 'viewerKey' | 'adminPreview' | 'readOnly'>): string | null {
  if (!enabled || !hotelId || !viewerKey) return null;
  return [
    viewerKey,
    hotelId,
    adminPreview ? 'admin-preview' : 'customer',
    readOnly ? 'read-only' : 'interactive',
  ].join(':');
}

/**
 * The single People data seam used by the selected-hotel page.
 *
 * PropertyContext owns the privacy-safe staff subscription because schedule
 * consumers use that same snapshot. This hook owns the canonical account
 * projection and joins the two only after both carry the current identity
 * stamp. The panel therefore has no second team fetch or staff subscription to
 * race a hotel switch, capability revocation, or mutation refresh.
 */
export function usePeopleController(input: PeopleControllerInput): PeopleControllerState {
  const {
    enabled,
    hotelId,
    viewerKey,
    adminPreview,
    readOnly,
    staff,
    staffViewerKey,
    staffExpectedViewerKey,
    staffLoaded,
    staffLoadFailed,
    refreshStaff,
  } = input;
  const key = controllerIdentityKey(input);
  const keyRef = useRef<string | null>(key);
  keyRef.current = key;
  const inputRef = useRef({ hotelId, adminPreview, readOnly, refreshStaff });
  inputRef.current = { hotelId, adminPreview, readOnly, refreshStaff };
  const sequenceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);

  const loadTeam = useCallback(async (
    requestKey: string,
    requestSequence: number,
    controller: AbortController,
  ): Promise<void> => {
    try {
      const response = await fetchWithAuth(
        `/api/auth/team?hotelId=${encodeURIComponent(inputRef.current.hotelId ?? '')}`,
        { signal: controller.signal },
      );
      const body = await response.json().catch(() => ({})) as TeamEnvelope;
      const responseTeam = body.data?.team;
      if (!response.ok || body.ok !== true || !Array.isArray(responseTeam)) {
        throw new Error(errorMessage(
          body.error,
          "Couldn't load the people at this hotel.",
        ));
      }
      if (!responseTeam.every(isHotelTeamMember)) {
        throw new Error("Couldn't load the people at this hotel.");
      }
      const responseJobs = body.data?.hatsByAccountId;
      if (responseJobs !== undefined && !isRecord(responseJobs)) {
        throw new Error("Couldn't load the people at this hotel.");
      }
      if (responseJobs && !Object.values(responseJobs).every((jobs) => (
        Array.isArray(jobs) && jobs.every(isCompanyJobLine)
      ))) {
        throw new Error("Couldn't load the people at this hotel.");
      }
      if (
        controller.signal.aborted
        || requestSequence !== sequenceRef.current
        || keyRef.current !== requestKey
      ) return;
      const currentInput = inputRef.current;
      const parsedTeam = responseTeam as HotelTeamMember[];
      const nextTeam = (currentInput.adminPreview || currentInput.readOnly)
        ? parsedTeam.filter((member) => !member.isPlatformAdmin && member.role !== 'admin')
        : parsedTeam;
      setSnapshot({
        key: requestKey,
        team: nextTeam,
        jobsByAccountId: (responseJobs ?? {}) as Record<string, CompanyJobLine[]>,
        status: 'ready',
        error: '',
      });
    } catch (error) {
      if (
        controller.signal.aborted
        || isAbortError(error)
        || requestSequence !== sequenceRef.current
        || keyRef.current !== requestKey
      ) return;
      console.error('[usePeopleController] team load failed', error);
      setSnapshot({
        key: requestKey,
        team: [],
        jobsByAccountId: {},
        status: 'error',
        error: errorMessage(
          error,
          "Couldn't load the people at this hotel. Check your connection and try again.",
        ),
      });
    }
  }, []);

  const startTeamLoad = useCallback((requestKey: string, clearFirst: boolean): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSequence = ++sequenceRef.current;
    setSnapshot((current) => {
      const previous = current?.key === requestKey ? current : null;
      return {
        key: requestKey,
        team: clearFirst ? [] : previous?.team ?? [],
        jobsByAccountId: clearFirst ? {} : previous?.jobsByAccountId ?? {},
        status: 'loading',
        error: '',
      };
    });
    return loadTeam(requestKey, requestSequence, controller);
  }, [loadTeam]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    ++sequenceRef.current;
    if (!key) {
      setSnapshot(null);
      return;
    }
    void startTeamLoad(key, true);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [key, startTeamLoad]);

  const refreshTeam = useCallback(async () => {
    const currentKey = keyRef.current;
    if (!currentKey) return;
    await startTeamLoad(currentKey, false);
  }, [startTeamLoad]);

  const refresh = useCallback(async () => {
    await Promise.all([
      refreshTeam(),
      keyRef.current ? inputRef.current.refreshStaff() : Promise.resolve(),
    ]);
  }, [refreshTeam]);

  const matchingSnapshot = snapshot?.key === key ? snapshot : null;
  const exactStaffSnapshot = Boolean(
    enabled
    && staffExpectedViewerKey
    && staffViewerKey === staffExpectedViewerKey,
  );

  return useMemo(() => ({
    team: matchingSnapshot?.team ?? [],
    jobsByAccountId: matchingSnapshot?.jobsByAccountId ?? {},
    teamLoading: Boolean(key && !matchingSnapshot)
      || matchingSnapshot?.status === 'loading',
    teamError: matchingSnapshot?.status === 'error' ? matchingSnapshot.error : '',
    teamSettled: matchingSnapshot?.status === 'ready' || matchingSnapshot?.status === 'error',
    staff: exactStaffSnapshot ? staff : [],
    staffLoaded: exactStaffSnapshot && staffLoaded,
    rosterUnavailable: exactStaffSnapshot && staffLoadFailed,
    staffViewerKey: exactStaffSnapshot ? staffViewerKey : null,
    refreshTeam,
    refresh,
  }), [
    exactStaffSnapshot,
    key,
    matchingSnapshot,
    refresh,
    refreshTeam,
    staff,
    staffLoadFailed,
    staffLoaded,
    staffViewerKey,
  ]);
}
