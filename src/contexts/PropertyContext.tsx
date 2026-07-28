'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import type { CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  getProperties,
  getProperty,
  getStaff,
  subscribeToStaff,
} from '@/lib/db';
import { isOnboardingInProgress } from '@/lib/onboarding/state';
import type { Property, StaffMember } from '@/types';
import { propertyChangeAllowed } from '@/lib/property-change-guard';
import { RequestTimeoutError, withPromiseDeadline } from '@/lib/fetch-deadline';
import { useAuthorizationRefreshKey } from '@/lib/hooks/use-authorization-refresh-key';

export type CapabilityOverridesStatus = 'idle' | 'loading' | 'ready' | 'error';

interface PropertyContextType {
  properties: Property[];
  activeProperty: Property | null;
  activePropertyId: string | null;
  /** Canonical signed-in account + resolved hotel identity for all scoped
   *  client snapshots. Consumers must not rebuild this key independently. */
  activePropertyViewerKey: string | null;
  staff: StaffMember[];
  staffLoaded: boolean;
  staffLoadFailed: boolean;
  /** Identity + hotel key for the currently exposed staff snapshot. */
  staffViewerKey: string | null;
  /** The active hotel's capability restrictions (admin's Access-tab toggles).
   *  Empty = everyone-everything (the default). Drives useCan(). */
  capabilityOverrides: CapabilityOverrideMap;
  /** Identity + hotel key for the capability snapshot currently exposed. Null
   *  while the active identity/property is unresolved or still loading. */
  capabilityOverridesViewerKey: string | null;
  /** Hotel id carried by the exposed capability snapshot. Kept separately from
   *  the viewer key so consumers can make property readiness explicit. */
  capabilityOverridesPropertyId: string | null;
  /** Terminal state for the exact signed-in viewer + resolved hotel. */
  capabilityOverridesStatus: CapabilityOverridesStatus;
  /** Safe user-facing copy when the exact capability snapshot failed. */
  capabilityOverridesError: string | null;
  loading: boolean;
  propertiesError: string | null;
  setActivePropertyId: (id: string) => void;
  retryProperties: () => void;
  refreshProperty: () => Promise<void>;
  refreshStaff: () => Promise<void>;
  refreshCapabilities: () => Promise<void>;
}

const PropertyContext = createContext<PropertyContextType>({
  properties: [],
  activeProperty: null,
  activePropertyId: null,
  activePropertyViewerKey: null,
  staff: [],
  staffLoaded: false,
  staffLoadFailed: false,
  staffViewerKey: null,
  capabilityOverrides: {},
  capabilityOverridesViewerKey: null,
  capabilityOverridesPropertyId: null,
  capabilityOverridesStatus: 'idle',
  capabilityOverridesError: null,
  loading: true,
  propertiesError: null,
  setActivePropertyId: () => {},
  retryProperties: () => {},
  refreshProperty: async () => {},
  refreshStaff: async () => {},
  refreshCapabilities: async () => {},
});

const EMPTY_CAPABILITY_OVERRIDES: CapabilityOverrideMap = {};
const PROPERTY_CONTEXT_TIMEOUT_MS = 10_000;

interface CapabilityOverrideSnapshot {
  viewerKey: string;
  propertyId: string;
  overrides: CapabilityOverrideMap;
  status: Exclude<CapabilityOverridesStatus, 'idle'>;
  error: string | null;
}

/** Read one hotel's capability override map via the service-role-backed route
 *  (the table is deny-all RLS, so a direct browser read would return []). A
 *  Failure is surfaced as a retryable terminal state. It must never be
 *  converted into {}: that value means "the server confirmed no overrides",
 *  while a timeout means the server has not made an access decision at all.
 *
 *  CRITICAL — this MUST fail soft, never force a logout. We pass our OWN
 *  Authorization header, which makes fetchWithAuth treat the call as "caller
 *  opted out of 401 recovery" and RETURN the 401 instead of running its
 *  signOut + redirect-to-/signin path (see api-fetch.ts). Reason: this is a
 *  scoped UI access read that auto-fires the instant a single-property owner is
 *  authenticated — including the 2FA-trust window during onboarding / a fresh
 *  login, where it transiently 401s `requires_2fa`. With the default
 *  fetchWithAuth recovery, that 401 nuked the session and bounced the owner to
 *  /signin the moment they entered their 2FA code (the access-control feature,
 *  2026-06-14, introduced this call and the regression). A transient failure
 *  now stays on-page with an explicit retry instead of logging out or allowing.
 */
async function fetchOverridesFor(pid: string): Promise<CapabilityOverrideMap> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token ?? null;
  if (!token) throw new Error('The signed-in session is not ready.');

  const res = await fetchWithAuth(`/api/capabilities/overrides?propertyId=${encodeURIComponent(pid)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Capability access check failed (${res.status}).`);
  const json = await res.json().catch(() => null);
  if (!json?.data || typeof json.data.overrides !== 'object' || json.data.overrides === null) {
    throw new Error('Capability access check returned an invalid response.');
  }
  return json.data.overrides as CapabilityOverrideMap;
}

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const authFlowActive = pathname === '/signin' || pathname.startsWith('/signin/');
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertiesViewerUid, setPropertiesViewerUid] = useState<string | null>(null);
  const [propertiesAuthorizationViewerKey, setPropertiesAuthorizationViewerKey] = useState<string | null>(null);
  const [activePropertyId, setActivePropertyIdState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      try { return localStorage.getItem('hotelops-active-property'); } catch { return null; }
    }
    return null;
  });
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [staffLoadFailed, setStaffLoadFailed] = useState(false);
  const [staffViewerKey, setStaffViewerKey] = useState<string | null>(null);
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<CapabilityOverrideSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [propertiesErrorViewerUid, setPropertiesErrorViewerUid] = useState<string | null>(null);
  const [propertiesErrorAuthorizationViewerKey, setPropertiesErrorAuthorizationViewerKey] = useState<string | null>(null);
  const [propertiesRetryKey, setPropertiesRetryKey] = useState(0);

  const userUid = user?.uid;
  const userAccountId = user?.accountId;
  const userRole = user?.role;
  // Canonicalize the legacy access array so a harmless ordering difference on
  // token refresh does not reload the shell, while any actual grant/revocation
  // changes the authorization identity immediately. Company-hat coverage is
  // still resolved exclusively by /api/properties; this key never filters it.
  const userPropertyAccessKey = [...(user?.propertyAccess ?? [])].sort().join(',');
  const propertyAuthorizationIdentityKey = userUid && userAccountId
    ? `${userUid}:${userAccountId}:${userRole ?? 'unknown'}:${userPropertyAccessKey}`
    : null;
  const propertyAuthorizationViewerKey = useAuthorizationRefreshKey(
    propertyAuthorizationIdentityKey,
    Boolean(propertyAuthorizationIdentityKey) && !authFlowActive,
  );
  const propertyAuthorizationViewerKeyRef = useRef(propertyAuthorizationViewerKey);
  propertyAuthorizationViewerKeyRef.current = propertyAuthorizationViewerKey;
  // A same-tab account switch can render once before the loading effect runs.
  // Stamp the hotel list with both the account and its authorization identity
  // so same-UID role/grant changes mask old coverage during that render too.
  const exposedProperties = propertiesViewerUid === userUid
    && propertiesAuthorizationViewerKey === propertyAuthorizationViewerKey
    && propertyAuthorizationViewerKey !== null
    ? properties
    : [];
  const exposedPropertiesError = propertiesErrorViewerUid === userUid
    && propertiesErrorAuthorizationViewerKey === propertyAuthorizationViewerKey
    && propertyAuthorizationViewerKey !== null
    ? propertiesError
    : null;
  // Effects run after render. During an Account A -> Account B switch, the raw
  // `loading` bit can therefore still be false for one render while the
  // viewer-stamped rows are already masked. Treat that identity gap as
  // loading unless the new viewer owns a terminal error snapshot.
  const exposedPropertiesLoading = loading || Boolean(
    userUid
    && propertiesViewerUid !== userUid
    && propertiesErrorViewerUid !== userUid,
  ) || Boolean(
    propertyAuthorizationViewerKey
    && propertiesAuthorizationViewerKey !== propertyAuthorizationViewerKey
    && propertiesErrorAuthorizationViewerKey !== propertyAuthorizationViewerKey,
  );
  // Derived from the viewer-stamped list — never from a stale selected id.
  const activeProperty = exposedProperties.find(p => p.id === activePropertyId) ?? null;
  const resolvedPropertyId = activeProperty?.id ?? null;
  const activePropertyViewerKey = userUid && userAccountId && resolvedPropertyId
    ? `${userUid}:${userAccountId}:${resolvedPropertyId}`
    : null;
  // Auth pages deliberately establish a short-lived password/OTP session
  // before device trust is complete. Protected property reads during that
  // window can receive requires_2fa and must not persist a false hotel-access
  // error. Keep the provider quiescent until navigation leaves the auth flow;
  // pathname is an explicit dependency, so the real load starts immediately
  // after verification succeeds.
  const staffRosterNeeded = pathname.startsWith('/staff')
    || pathname.startsWith('/company')
    || pathname.startsWith('/housekeeping');

  // Is the active property still in the PRISTINE wizard phase — mid-onboarding
  // AND the wizard has never been left for the app (onboardingPromptShownAt
  // null)? Only then do we skip the capability-override fetch below. Once the
  // owner has dropped into the app on a half-set-up hotel (stamped), it's a
  // normal operable hotel — staff may have joined and the Access tab's
  // restrictions must apply, so overrides MUST be fetched. A primitive (not the
  // property object) so the capabilities effect depends on it without re-firing
  // on unrelated property-data updates.
  const activeOnboardingInProgress = activeProperty
    ? isOnboardingInProgress(activeProperty.onboardingCompletedAt, activeProperty.onboardingState)
      && !activeProperty.onboardingPromptShownAt
    : false;

  const setActivePropertyId = useCallback((id: string) => {
    // The selector also calls this for one-hotel auto-entry and when a user
    // explicitly chooses the hotel that is already active. That is not a
    // property transition: clearing the capability snapshot here would leave
    // it at `idle`, because the capability effect keys on the unchanged
    // resolved id and therefore has no reason to run again. Preserve the
    // terminal/loading snapshot so gated pages cannot hang until hard refresh.
    if (id === activePropertyId) {
      try { localStorage.setItem('hotelops-active-property', id); } catch { /* storage unavailable */ }
      return;
    }
    if (activePropertyId && !propertyChangeAllowed({
      fromPropertyId: activePropertyId,
      toPropertyId: id,
      source: 'selector',
    })) return;
    // Clear in the same event as the hotel change. No render may pair the new
    // hotel with the previous hotel's capability map.
    setCapabilitySnapshot(null);
    setActivePropertyIdState(id);
    try { localStorage.setItem('hotelops-active-property', id); } catch { /* storage unavailable */ }
  }, [activePropertyId]);

  // Cross-tab sync (audit/concurrency #13). Without this, swapping the
  // active property in Tab A leaves Tab B's dashboard/rooms/staff list
  // pointing at the OLD property until manual reload — confusing in
  // multi-property accounts.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'hotelops-active-property') return;
      const next = e.newValue;
      if (next && next !== activePropertyId) {
        if (activePropertyId && !propertyChangeAllowed({
          fromPropertyId: activePropertyId,
          toPropertyId: next,
          source: 'cross-tab',
        })) return;
        setCapabilitySnapshot(null);
        setActivePropertyIdState(next);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [activePropertyId]);

  // Load properties list — from /api/properties, which resolves coverage
  // through the company spine with service-role. Never from the browser
  // Supabase client: `properties` RLS answers from the legacy
  // `accounts.property_access` array only, so every company person read back
  // zero rows with a 200 and no error and was locked out of the whole product.
  // See the header of src/lib/db/properties.ts.
  //
  // Right after sign-in there is still a short window where the session gate
  // can refuse (device-trust settling after an OTP verify). If the first
  // attempt fails that way, retry with a short backoff so the user isn't
  // greeted by a spurious "No properties found" screen.
  //
  // ⚠️ The dependency below is INTENTIONALLY narrow (uid + account row +
  // role + access + the explicit live-authorization revision)
  // rather than the full `user` object. Reason: AuthContext's
  // onAuthStateChange handler fires on every Supabase token refresh
  // (~hourly, plus on tab focus/visibility). Each fire creates a NEW
  // appUser object reference even though the data is identical. If this
  // effect depended on `[user]` (the reference), every token refresh
  // would re-run loadProps and flip setLoading(true) — producing a brief
  // 'loading spinner over the dashboard' that the operator sees every
  // time they come back to the tab. Depending only on the identity-
  // bearing primitives makes this effect idempotent across refreshes.
  // The full user object is still in scope inside the effect; we just
  // don't react to its reference identity.
  const expectedStaffViewerKey = activePropertyViewerKey;
  const expectedStaffViewerKeyRef = useRef(expectedStaffViewerKey);
  expectedStaffViewerKeyRef.current = expectedStaffViewerKey;
  // Like capabilities and properties, roster state is identity-owned. Hotel B
  // must see an empty/not-yet-loaded roster on the render where selection
  // changes, never Hotel A's staff until the clearing effect runs.
  const exposedStaffSnapshot = staffViewerKey === expectedStaffViewerKey && expectedStaffViewerKey !== null;
  const exposedStaff = exposedStaffSnapshot ? staff : [];
  const exposedStaffLoaded = exposedStaffSnapshot ? staffLoaded : false;
  const exposedStaffLoadFailed = exposedStaffSnapshot ? staffLoadFailed : false;
  const exposedStaffViewerKey = exposedStaffSnapshot ? staffViewerKey : null;
  const staffSubscriptionRef = useRef<{
    viewerKey: string;
    refresh: () => Promise<void>;
  } | null>(null);
  useEffect(() => {
    if (!userUid || !propertyAuthorizationViewerKey || authFlowActive) {
      setProperties([]);
      setPropertiesViewerUid(null);
      setPropertiesAuthorizationViewerKey(null);
      setActivePropertyIdState(null);
      setCapabilitySnapshot(null);
      setPropertiesError(null);
      setPropertiesErrorViewerUid(null);
      setPropertiesErrorAuthorizationViewerKey(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const loadUserUid = userUid;
    const loadViewerKey = propertyAuthorizationViewerKey;
    // One deadline belongs to the WHOLE load, including permission-race
    // retries and their backoff. Recursive attempts may spend only what is
    // left; none receives a fresh ten seconds.
    const loadDeadlineAt = Date.now() + PROPERTY_CONTEXT_TIMEOUT_MS;
    const remainingPropertyLoadBudgetMs = (): number => {
      const remainingMs = Math.floor(loadDeadlineAt - Date.now());
      if (remainingMs <= 0) {
        throw new RequestTimeoutError('Hotel access', PROPERTY_CONTEXT_TIMEOUT_MS);
      }
      return remainingMs;
    };

    const loadProps = async (retries = 3): Promise<Property[]> => {
      try {
        // THE WALL IS THE SERVER'S, NOT THIS FILTER'S.
        //
        // There used to be a second narrowing here: the list came back from the
        // browser Supabase client and was then filtered through
        // `user.propertyAccess` — the legacy `accounts.property_access` array,
        // which is empty for every company person, because their hotels come
        // from a company hat (0364) instead. So a dual-hat GM+VP was filtered to
        // zero hotels and could not open her own building. Both narrowings were
        // blind to hats, and fixing only one would have changed nothing.
        //
        // `/api/properties` now resolves coverage once, with service-role, as
        // the legacy array UNION every live hat. Re-filtering the result here
        // would only be able to take hotels back away.
        return await withPromiseDeadline(getProperties(loadUserUid), {
          timeoutMs: remainingPropertyLoadBudgetMs(),
          label: 'Hotel access',
        });
      } catch (err) {
        if (cancelled) throw err;
        // Detect Supabase/PostgREST permission errors.
        //   - PGRST301 = JWT-related (missing/invalid/expired auth)
        //   - PGRST116 = no rows returned where one expected (not really perm,
        //     but symptomatic of an auth race where RLS hid the row)
        //   - '42501' = Postgres "insufficient_privilege"
        //   - Text fallbacks for anything that doesn't bubble a code.
        //
        // Firestore-era strings ('permission', 'unauthorized',
        // 'unauthenticated') kept as a safety net but will rarely match
        // Supabase responses.
        //
        // The read goes through /api/properties now, so the shape a race
        // arrives in changed: instead of a PostgREST error object it is an
        // `/api/properties <status>: <body>` message. The 401/403 window is
        // real and short (the account row lookup, or device-trust settling
        // right after an OTP verify) and blanking the shell for it would look
        // exactly like "you have no hotels" — the failure this whole change
        // exists to stop. A 5xx or timeout settles to the visible retry state;
        // replaying a nearly-timed-out request three times would violate the
        // route's terminal-state budget.
        //
        // NOT retried: SessionEndedError. fetchWithAuth has already signed the
        // user out and started the redirect; retrying would fight a navigation.
        const e = err as { code?: string; message?: string; name?: string } | undefined;
        const code = String(e?.code ?? '').toUpperCase();
        const errStr = String(e?.message ?? err).toLowerCase();
        const isPermErr =
          e?.name !== 'SessionEndedError' && (
            code === 'PGRST301' ||
            code === 'PGRST116' ||
            code === '42501' ||
            /\/api\/properties (401|403)\b/.test(errStr) ||
            errStr.includes('policy') ||
            errStr.includes('jwt') ||
            errStr.includes('permission') ||
            errStr.includes('unauthorized') ||
            errStr.includes('unauthenticated')
          );
        // Retry with short backoff: 200ms, 500ms, 1s.
        if (retries > 0 && isPermErr) {
          const delay = retries === 3 ? 200 : retries === 2 ? 500 : 1000;
          await withPromiseDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, delay)),
            {
              timeoutMs: remainingPropertyLoadBudgetMs(),
              label: 'Hotel access',
            },
          );
          if (cancelled) throw err;
          return loadProps(retries - 1);
        }
        throw err;
      }
    };

    void (async () => {
      setLoading(true);
      setPropertiesError(null);
      setPropertiesErrorViewerUid(null);
      setPropertiesErrorAuthorizationViewerKey(null);
      try {
        const props = await loadProps();
        if (cancelled) return;
        setProperties(props);
        setPropertiesViewerUid(loadUserUid);
        setPropertiesAuthorizationViewerKey(loadViewerKey);
        setPropertiesError(null);
        setPropertiesErrorViewerUid(null);
        setPropertiesErrorAuthorizationViewerKey(null);

        let stored: string | null = null;
        try { stored = localStorage.getItem('hotelops-active-property'); } catch { /* storage unavailable */ }
        const pid = stored && props.find(p => p.id === stored) ? stored : props[0]?.id ?? null;
        setCapabilitySnapshot(null);
        setActivePropertyIdState(pid);
      } catch (err) {
        if (cancelled) return;
        console.error('PropertyContext: failed to load properties', err);
        setProperties([]);
        setPropertiesViewerUid(null);
        setPropertiesAuthorizationViewerKey(null);
        setActivePropertyIdState(null);
        setCapabilitySnapshot(null);
        setPropertiesError('We could not load the hotels available to this account.');
        setPropertiesErrorViewerUid(loadUserUid);
        setPropertiesErrorAuthorizationViewerKey(loadViewerKey);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // See note above for why we depend on identity primitives, not `user`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyAuthorizationViewerKey, propertiesRetryKey, authFlowActive]);

  const retryProperties = useCallback(() => {
    // Set loading in the click event, before the retry effect gets a chance to
    // run. Pages must never see "signed in + no hotel + not loading" and fire
    // a redirect during that render gap.
    setLoading(true);
    setPropertiesError(null);
    setPropertiesErrorViewerUid(null);
    setPropertiesErrorAuthorizationViewerKey(null);
    setPropertiesRetryKey((key) => key + 1);
  }, []);

  // Load active property data.
  // Staff uses a safe projected snapshot rather than postgres_changes. The
  // database intentionally denies table-wide SELECT to protect phone/payroll
  // columns, while Realtime still authorizes against the full row. The roster
  // helper fetches immediately, retries transient auth races, polls while the
  // page is visible, and catches up on foreground/online.
  // ── Staff roster snapshot listener ───────────────────────────────────────
  // Only routes that render roster data subscribe. Key to the RESOLVED hotel,
  // never the raw localStorage value, so a new account cannot query a stale
  // property id before its authorized property list has loaded.
  useEffect(() => {
    if (!userUid || !resolvedPropertyId || !expectedStaffViewerKey || !staffRosterNeeded) {
      setStaff([]);
      setStaffLoaded(false);
      setStaffLoadFailed(false);
      setStaffViewerKey(null);
      return;
    }
    let cancelled = false;
    const subscriptionViewerKey = expectedStaffViewerKey;
    // Never carry one hotel's roster through the transition to another hotel
    // or account while the new real-time snapshot is connecting.
    setStaff([]);
    setStaffLoaded(false);
    setStaffLoadFailed(false);
    setStaffViewerKey(null);
    const staffSubscription = subscribeToStaff(userUid, resolvedPropertyId, staffList => {
      if (!cancelled) {
        setStaff(staffList);
        setStaffLoaded(true);
        setStaffLoadFailed(false);
        setStaffViewerKey(subscriptionViewerKey);
      }
    }, undefined, () => {
      if (!cancelled) {
        setStaff([]);
        setStaffLoaded(false);
        setStaffLoadFailed(true);
        setStaffViewerKey(subscriptionViewerKey);
      }
    });
    staffSubscriptionRef.current = {
      viewerKey: subscriptionViewerKey,
      refresh: staffSubscription.refresh,
    };
    return () => {
      cancelled = true;
      if (staffSubscriptionRef.current?.viewerKey === subscriptionViewerKey) {
        staffSubscriptionRef.current = null;
      }
      staffSubscription.unsubscribe();
    };
    // Depend on the stable uid (not the object ref) so a token refresh doesn't
    // tear down + recreate the subscription every hour.
  }, [userUid, resolvedPropertyId, expectedStaffViewerKey, staffRosterNeeded]);

  // Public laundry screens have their own scoped bootstrap route. The prior
  // provider eagerly read and even INSERT-seeded public-area/laundry rows on
  // every authenticated route although no authenticated consumer used them.
  // Keeping that work out of the root provider removes a navigation-wide
  // request/write waterfall.
  const expectedCapabilityViewerKey = activePropertyViewerKey;
  const expectedCapabilityViewerKeyRef = useRef(expectedCapabilityViewerKey);
  expectedCapabilityViewerKeyRef.current = expectedCapabilityViewerKey;
  // Never expose a snapshot from a previous identity/property while the next
  // request settles, even for the render before the clearing effect runs.
  const exposedCapabilitySnapshot = capabilitySnapshot
    && capabilitySnapshot.viewerKey === expectedCapabilityViewerKey
    && capabilitySnapshot.propertyId === resolvedPropertyId
    ? capabilitySnapshot
    : null;
  const capabilityOverrides = exposedCapabilitySnapshot?.status === 'ready'
    ? exposedCapabilitySnapshot.overrides
    : EMPTY_CAPABILITY_OVERRIDES;
  const capabilityOverridesViewerKey = exposedCapabilitySnapshot?.status === 'ready'
    ? exposedCapabilitySnapshot.viewerKey
    : null;
  const capabilityOverridesPropertyId = exposedCapabilitySnapshot?.status === 'ready'
    ? exposedCapabilitySnapshot.propertyId
    : null;
  const capabilityOverridesStatus = exposedCapabilitySnapshot?.status ?? 'idle';
  const capabilityOverridesError = exposedCapabilitySnapshot?.error ?? null;

  // Load the active hotel's capability overrides whenever the hotel (or the
  // signed-in user) changes, so useCan() resolves from the same restrictions the
  // server enforces. Same identity-primitive dependency reasoning as above — we
  // don't want a token refresh to re-fetch.
  useEffect(() => {
    if (!user || !resolvedPropertyId || !expectedCapabilityViewerKey) {
      setCapabilitySnapshot(null);
      return;
    }
    // Don't fire this protected call while the property is still mid-onboarding.
    // The owner belongs in the signup wizard (not the app), their 2FA device-
    // trust may still be settling, and overrides default to everyone-everything
    // anyway. Firing it the instant a freshly-created 1-property owner verifies
    // is exactly what raced a `requires_2fa` 401 into a forced logout → /signin.
    if (activeOnboardingInProgress) {
      setCapabilitySnapshot({
        viewerKey: expectedCapabilityViewerKey,
        propertyId: resolvedPropertyId,
        overrides: EMPTY_CAPABILITY_OVERRIDES,
        status: 'ready',
        error: null,
      });
      return;
    }
    let cancelled = false;
    setCapabilitySnapshot({
      viewerKey: expectedCapabilityViewerKey,
      propertyId: resolvedPropertyId,
      overrides: EMPTY_CAPABILITY_OVERRIDES,
      status: 'loading',
      error: null,
    });
    void (async () => {
      try {
        const map = await withPromiseDeadline(fetchOverridesFor(resolvedPropertyId), {
          timeoutMs: PROPERTY_CONTEXT_TIMEOUT_MS,
          label: 'Capability access check',
        });
        if (
          !cancelled
          && expectedCapabilityViewerKeyRef.current === expectedCapabilityViewerKey
        ) {
          setCapabilitySnapshot({
            viewerKey: expectedCapabilityViewerKey,
            propertyId: resolvedPropertyId,
            overrides: map,
            status: 'ready',
            error: null,
          });
        }
      } catch (err) {
        console.error('PropertyContext: failed to load capability access', err);
        if (
          !cancelled
          && expectedCapabilityViewerKeyRef.current === expectedCapabilityViewerKey
        ) {
          setCapabilitySnapshot({
            viewerKey: expectedCapabilityViewerKey,
            propertyId: resolvedPropertyId,
            overrides: EMPTY_CAPABILITY_OVERRIDES,
            status: 'error',
            error: 'We could not confirm access for this hotel.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedPropertyId, expectedCapabilityViewerKey, activeOnboardingInProgress]);

  const refreshCapabilities = useCallback(async () => {
    const viewerKey = expectedCapabilityViewerKey;
    const propertyId = resolvedPropertyId;
    setCapabilitySnapshot(null);
    if (!viewerKey || !propertyId) return;
    setCapabilitySnapshot({
      viewerKey,
      propertyId,
      overrides: EMPTY_CAPABILITY_OVERRIDES,
      status: 'loading',
      error: null,
    });
    try {
      const map = await withPromiseDeadline(fetchOverridesFor(propertyId), {
        timeoutMs: PROPERTY_CONTEXT_TIMEOUT_MS,
        label: 'Capability access check',
      });
      if (expectedCapabilityViewerKeyRef.current !== viewerKey) return;
      setCapabilitySnapshot({
        viewerKey,
        propertyId,
        overrides: map,
        status: 'ready',
        error: null,
      });
    } catch (err) {
      console.error('PropertyContext: failed to refresh capability access', err);
      if (expectedCapabilityViewerKeyRef.current !== viewerKey) return;
      setCapabilitySnapshot({
        viewerKey,
        propertyId,
        overrides: EMPTY_CAPABILITY_OVERRIDES,
        status: 'error',
        error: 'We could not confirm access for this hotel.',
      });
    }
  }, [expectedCapabilityViewerKey, resolvedPropertyId]);

  const refreshProperty = async () => {
    if (!user || !resolvedPropertyId || !propertyAuthorizationViewerKey) return;
    const refreshViewerUid = user.uid;
    const refreshViewerKey = propertyAuthorizationViewerKey;
    const propertyId = resolvedPropertyId;
    const prop = await getProperty(refreshViewerUid, propertyId);
    if (prop) {
      if (
        userUid !== refreshViewerUid
        || resolvedPropertyId !== propertyId
        || propertyAuthorizationViewerKeyRef.current !== refreshViewerKey
      ) return;
      setProperties(prev => prev.map(p => p.id === propertyId ? prop : p));
    }
  };

  const refreshStaff = async () => {
    if (!user || !resolvedPropertyId) return;
    const refreshViewerKey = expectedStaffViewerKey;
    if (!refreshViewerKey) return;
    const subscription = staffSubscriptionRef.current;
    if (subscription?.viewerKey === refreshViewerKey) {
      await subscription.refresh();
      return;
    }
    const list = await getStaff(user.uid, resolvedPropertyId);
    if (expectedStaffViewerKeyRef.current !== refreshViewerKey) return;
    setStaff(list);
    setStaffLoaded(true);
    setStaffLoadFailed(false);
    setStaffViewerKey(refreshViewerKey);
  };

  return (
    <PropertyContext.Provider
      value={{
        properties: exposedProperties,
        activeProperty,
        activePropertyId: resolvedPropertyId,
        activePropertyViewerKey,
        staff: exposedStaff,
        staffLoaded: exposedStaffLoaded,
        staffLoadFailed: exposedStaffLoadFailed,
        staffViewerKey: exposedStaffViewerKey,
        capabilityOverrides,
        capabilityOverridesViewerKey,
        capabilityOverridesPropertyId,
        capabilityOverridesStatus,
        capabilityOverridesError,
        loading: exposedPropertiesLoading,
        propertiesError: exposedPropertiesError,
        setActivePropertyId,
        retryProperties,
        refreshProperty,
        refreshStaff,
        refreshCapabilities,
      }}
    >
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperty() {
  return useContext(PropertyContext);
}
