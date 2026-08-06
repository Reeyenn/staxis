'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import {
  AI_DISCOVERABLE_PROVIDERS,
  AI_PROVIDERS,
  type ActivateAiConfigRequest,
  type ActivateAiConfigResponse,
  type AiConfigVersion,
  type AiConfigsResponse,
  type AiFeatureKey,
  type AiFeatureSummary,
  type AiFeaturesResponse,
  type AiModelCatalogEntry,
  type AiModelPricing,
  type AiModelRef,
  type AiModelsResponse,
  type AiProvider,
  type AiHostedProvider,
  type CreateAiConfigRequest,
  type CreateAiConfigResponse,
  type RefreshAiModelsRequest,
  type RefreshAiModelsResponse,
  type ValidateAiConfigResponse,
} from '@/lib/ai/types';
import {
  NO_FALLBACK,
  curateSelectableAiModels,
  describeConfigChange,
  draftFromConfig,
  essentialAiModelRates,
  findStaleModelProviders,
  formatAiCatalogDate,
  formatAiDate,
  groupAiFeatures,
  hasAiConfigBaseChanged,
  isAiFeatureDraftDirty,
  isGloballyControllableAiFeature,
  isRuntimeCompatibleAiModel,
  modelRefKey,
  modelsForControlCenterPresentation,
  normalizeAiSearchText,
  parseModelRefKey,
  planGlobalModelDrafts,
  stageGlobalEnabledDrafts,
  type AiFeatureDraft,
  type GlobalDraftPlan,
} from './AIControlCenter.helpers';
import styles from './AIControlCenter.module.css';

type TabId = 'features' | 'models' | 'history';
type ProviderFilter = 'all' | AiHostedProvider;
type FeatureActionPhase = 'creating' | 'validating' | 'activating';
type ToastKind = 'success' | 'error' | 'info';
type PanelStatus<T> = Record<TabId, T>;

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface PendingActivation {
  configId: string;
  expectedActiveId: string | null;
  reason: string;
  warnings: string[];
  probeCount: number;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string | { message?: string };
  requestId?: string;
}

const API_ROOT = '/api/admin/ai-control';
const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'features', label: 'Features', icon: <Settings2 size={14} /> },
  { id: 'models', label: 'Models', icon: <Sparkles size={14} /> },
  { id: 'history', label: 'History', icon: <History size={14} /> },
];
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function apiErrorMessage(error: ApiEnvelope<unknown>['error'], fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return fallback;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(`${API_ROOT}${path}`, init);
  const json = await res.json() as ApiEnvelope<T>;
  if (!res.ok || !json.ok || json.data === undefined) {
    throw new Error(apiErrorMessage(json.error, `Request failed (${res.status})`));
  }
  return json.data;
}

function isProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

function isHostedProvider(value: string): value is AiHostedProvider {
  return (AI_DISCOVERABLE_PROVIDERS as readonly string[]).includes(value);
}

function displayModel(ref: Pick<AiModelRef, 'provider' | 'modelId' | 'displayName'>): string {
  return ref.displayName?.trim() || ref.modelId;
}

function providerLabel(provider: AiProvider): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'browser') return 'Browser built-in';
  return 'Staxis in-house';
}

/** "Anthropic", or "Anthropic or OpenAI" — the providers a feature can run on,
 * for the message shown when a selection is rejected. */
function runtimeProvidersLabel(providers: readonly AiProvider[]): string {
  const labels = providers.map(providerLabel);
  if (labels.length <= 1) return labels[0] ?? 'no';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

function capabilityLabel(capability: string): string {
  return capability.replaceAll('_', ' ');
}

function validationFailed(response: ValidateAiConfigResponse): string | null {
  if (response.report.valid) return null;
  return response.report.errors[0] ?? 'This model setup did not pass its safety test.';
}

function formatCatalogDate(value: string | null): string {
  const formatted = formatAiCatalogDate(value);
  return formatted === '—' ? 'Not provided' : formatted;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.1 ? 3 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : value < 1 ? 4 : 2,
  }).format(value);
}

function pricingSourceLabel(source: string): string {
  if (source === 'conservative-unverified') return 'Conservative estimate';
  if (source === 'application-default') return 'Application catalog';
  return source.replaceAll('_', ' ').replaceAll('-', ' ');
}

function pricingRateSummary(pricing: AiModelPricing | null): string {
  if (!pricing) return 'No verified pricing stored';
  const rates: string[] = [];
  if (pricing.inputUsdPerMillionTokens !== undefined) {
    rates.push(`input ${formatUsd(pricing.inputUsdPerMillionTokens)}/1M`);
  }
  if (pricing.outputUsdPerMillionTokens !== undefined) {
    rates.push(`output ${formatUsd(pricing.outputUsdPerMillionTokens)}/1M`);
  }
  if (pricing.cachedInputUsdPerMillionTokens !== undefined) {
    rates.push(`cache read ${formatUsd(pricing.cachedInputUsdPerMillionTokens)}/1M`);
  }
  if (pricing.cacheCreation5mInputUsdPerMillionTokens !== undefined) {
    rates.push(`5m cache write ${formatUsd(pricing.cacheCreation5mInputUsdPerMillionTokens)}/1M`);
  }
  if (pricing.cacheCreation1hInputUsdPerMillionTokens !== undefined) {
    rates.push(`1h cache write ${formatUsd(pricing.cacheCreation1hInputUsdPerMillionTokens)}/1M`);
  }
  if (pricing.usdPerAudioMinute !== undefined) {
    rates.push(`audio ${formatUsd(pricing.usdPerAudioMinute)}/min`);
  }
  const rateCopy = rates.length > 0 ? rates.join(' · ') : 'No stored rate fields';
  return `${rateCopy} · ${pricingSourceLabel(pricing.source)} as of ${formatCatalogDate(pricing.asOf)}`;
}

function comparePrimaryPricing(
  selected: AiModelPricing | null,
  current: AiModelPricing | null,
): { tone: 'info' | 'warn'; message: string } {
  if (!selected) {
    return { tone: 'warn', message: 'Selected primary pricing cannot be compared because no verified rates are stored.' };
  }
  if (selected.source === 'conservative-unverified') {
    return { tone: 'warn', message: 'Selected primary pricing is a conservative estimate, not a verified provider rate.' };
  }
  if (!current) {
    return { tone: 'warn', message: 'Current primary pricing is missing, so a price comparison is not available.' };
  }

  const comparable = [
    ['input', selected.inputUsdPerMillionTokens, current.inputUsdPerMillionTokens],
    ['output', selected.outputUsdPerMillionTokens, current.outputUsdPerMillionTokens],
    ['cache read', selected.cachedInputUsdPerMillionTokens, current.cachedInputUsdPerMillionTokens],
    ['5m cache write', selected.cacheCreation5mInputUsdPerMillionTokens, current.cacheCreation5mInputUsdPerMillionTokens],
    ['1h cache write', selected.cacheCreation1hInputUsdPerMillionTokens, current.cacheCreation1hInputUsdPerMillionTokens],
    ['audio', selected.usdPerAudioMinute, current.usdPerAudioMinute],
  ] as const;
  const available = comparable.filter((entry) => entry[1] !== undefined && entry[2] !== undefined);
  if (available.length === 0) {
    return { tone: 'warn', message: 'Current and selected models do not have comparable stored rate units.' };
  }
  const higher = available.filter((entry) => entry[1]! > entry[2]!).map((entry) => entry[0]);
  if (higher.length > 0) {
    return { tone: 'warn', message: `Selected stored pricing is higher for ${higher.join(' and ')}.` };
  }
  return { tone: 'info', message: 'Selected stored rates are equal to or lower than current for comparable units.' };
}

function validationMessages(report: AiConfigVersion['validationReport']): { errors: string[]; warnings: string[] } {
  if (!report || typeof report !== 'object') return { errors: [], warnings: [] };
  const candidate = report as { errors?: unknown; warnings?: unknown };
  return {
    errors: Array.isArray(candidate.errors)
      ? candidate.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [],
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [],
  };
}

export function AIControlCenter() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('features');
  const [features, setFeatures] = useState<AiFeatureSummary[]>([]);
  const [models, setModels] = useState<AiModelCatalogEntry[]>([]);
  const [configuredProviders, setConfiguredProviders] = useState<AiHostedProvider[]>([]);
  const [history, setHistory] = useState<AiConfigVersion[]>([]);
  const [providers, setProviders] = useState<AiHostedProvider[]>([...AI_DISCOVERABLE_PROVIDERS]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AiFeatureDraft>>({});
  const [featureQuery, setFeatureQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [panelLoading, setPanelLoading] = useState<PanelStatus<boolean>>({ features: false, models: false, history: false });
  const [panelErrors, setPanelErrors] = useState<PanelStatus<string | null>>({ features: null, models: null, history: null });
  const [featureActions, setFeatureActions] = useState<Record<string, FeatureActionPhase | undefined>>({});
  const [featureErrors, setFeatureErrors] = useState<Record<string, string | undefined>>({});
  const [pendingActivations, setPendingActivations] = useState<Record<string, PendingActivation | undefined>>({});
  const [draftReviewRequired, setDraftReviewRequired] = useState<Record<string, boolean | undefined>>({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [rollbackId, setRollbackId] = useState<string | null>(null);
  // Asking "close anyway?" when picks were staged but never tested. Closing
  // used to throw them away without a word, which is how a whole screen of
  // model choices went missing in one click.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [rollbackWarnings, setRollbackWarnings] = useState<Record<string, string[] | undefined>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const globalEnableRef = useRef<HTMLInputElement>(null);
  const globalModelsButtonRef = useRef<HTMLButtonElement>(null);
  const globalModelsDialogRef = useRef<HTMLDivElement>(null);
  const globalPrimaryRef = useRef<HTMLSelectElement>(null);
  const globalModelsOpenRef = useRef(false);
  const featuresRef = useRef<AiFeatureSummary[]>([]);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rollbackIdRef = useRef<string | null>(null);
  const confirmDiscardRef = useRef(false);
  const rollingBackIdRef = useRef<string | null>(null);
  const featureActionsRef = useRef<Record<string, FeatureActionPhase | undefined>>({});
  const [groupBulkBusy, setGroupBulkBusy] = useState<string | null>(null);
  const groupBulkBusyRef = useRef<string | null>(null);
  const [globalModelsOpen, setGlobalModelsOpen] = useState(false);
  const [globalPrimaryKey, setGlobalPrimaryKey] = useState('');
  const [globalFallbackKey, setGlobalFallbackKey] = useState('');
  const draftsRef = useRef<Record<string, AiFeatureDraft>>({});
  const draftReviewRequiredRef = useRef<Record<string, boolean | undefined>>({});
  const toastIdRef = useRef(0);
  const loadedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const autoRefreshCheckedRef = useRef(false);
  const catalogRefreshInFlightRef = useRef(false);

  useEffect(() => setMounted(true), []);

  const selectableModels = useMemo(
    () => curateSelectableAiModels(models, configuredProviders),
    [configuredProviders, models],
  );
  const globalPickerModels = useMemo(() => selectableModels.filter((model) => (
    features.some((feature) => (
      feature.editable
      && feature.modelSwitchable
      && feature.fallbackAllowed
      && feature.availability === 'available'
      && isRuntimeCompatibleAiModel(feature, model)
    ))
  )), [features, selectableModels]);
  const globallyControllable = useMemo(
    () => features.filter(isGloballyControllableAiFeature),
    [features],
  );
  const globallyEnabledCount = globallyControllable.filter((feature) => (
    drafts[feature.key]?.enabled ?? feature.activeConfig.enabled
  )).length;
  const globalAllEnabled = globallyControllable.length > 0
    && globallyEnabledCount === globallyControllable.length;
  const globalEnableMixed = globallyEnabledCount > 0
    && globallyEnabledCount < globallyControllable.length;
  const globalModelPlan = useMemo(() => planGlobalModelDrafts(
    features,
    globalPickerModels,
    drafts,
    globalPrimaryKey,
    globalFallbackKey,
  ), [drafts, features, globalFallbackKey, globalPickerModels, globalPrimaryKey]);

  useEffect(() => {
    if (globalEnableRef.current) globalEnableRef.current.indeterminate = globalEnableMixed;
  }, [globalEnableMixed]);

  rollbackIdRef.current = rollbackId;
  rollingBackIdRef.current = rollingBackId;
  globalModelsOpenRef.current = globalModelsOpen;
  confirmDiscardRef.current = confirmDiscard;

  const toast = useCallback((kind: ToastKind, message: string) => {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current, { id, kind, message }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const setFeatureAction = useCallback((key: AiFeatureKey, phase: FeatureActionPhase | undefined) => {
    const next = { ...featureActionsRef.current, [key]: phase };
    featureActionsRef.current = next;
    setFeatureActions(next);
  }, []);

  const refreshProviderCatalogs = useCallback(async (
    targets: readonly AiHostedProvider[],
    notifySuccess: boolean,
  ) => {
    const results = await Promise.allSettled(targets.map((provider) => {
      const body: RefreshAiModelsRequest = { provider };
      return apiRequest<RefreshAiModelsResponse>('/models/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }));

    let succeeded = 0;
    results.forEach((result, index) => {
      const provider = targets[index];
      if (result.status === 'fulfilled') {
        succeeded += 1;
        if (notifySuccess) {
          toast(
            'success',
            `${providerLabel(provider)} catalog refreshed: ${result.value.available} available of ${result.value.discovered} listed.`,
          );
        }
        return;
      }
      const message = result.reason instanceof Error
        ? result.reason.message
        : 'The provider did not return a usable catalog.';
      toast('error', `${providerLabel(provider)} catalog refresh failed: ${message} Cached models were kept.`);
    });

    if (succeeded > 0) {
      try {
        const modelData = await apiRequest<AiModelsResponse>('/models');
        setModels(modelData.models);
        setConfiguredProviders(modelData.configuredProviders);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not reload the combined model catalog.';
        toast('error', `Provider refresh succeeded, but the updated catalog could not be loaded: ${message}`);
      }
    }
  }, [toast]);

  const loadAll = useCallback(async (
    quiet = false,
    preserveDirtyDrafts = false,
    resetFeatureKeys?: AiFeatureKey | readonly AiFeatureKey[],
  ) => {
    // Keys whose drafts must follow the fresh live config even when dirty —
    // a just-completed action (single activate or a category-wide bulk) is the
    // admin's latest word, so a stale hand-flipped switch must not survive it.
    const resetSet = new Set<AiFeatureKey>(
      resetFeatureKeys === undefined
        ? []
        : Array.isArray(resetFeatureKeys) ? resetFeatureKeys : [resetFeatureKeys as AiFeatureKey],
    );
    const sequence = ++loadSequenceRef.current;
    if (!quiet) {
      setPanelLoading({ features: true, models: true, history: true });
      setPanelErrors({ features: null, models: null, history: null });
    }

    const finishPanel = (panel: TabId) => {
      if (sequence === loadSequenceRef.current) {
        setPanelLoading((current) => ({ ...current, [panel]: false }));
      }
    };
    const failPanel = (panel: TabId, error: unknown) => {
      if (sequence !== loadSequenceRef.current) return;
      const message = error instanceof Error ? error.message : `Could not load ${panel}.`;
      if (quiet) {
        toast('error', `${panel[0].toUpperCase()}${panel.slice(1)} refresh failed: ${message} Existing data was kept.`);
      } else {
        setPanelErrors((current) => ({ ...current, [panel]: message }));
      }
    };

    const featureTask = apiRequest<AiFeaturesResponse>('/features')
      .then((featureData) => {
        if (sequence !== loadSequenceRef.current) return;
        const previousFeatures = new Map(featuresRef.current.map((feature) => [feature.key, feature]));
        const currentDrafts = draftsRef.current;
        const currentReviews = draftReviewRequiredRef.current;
        const changedBaseKeys = new Set<AiFeatureKey>();
        const nextDrafts: Record<string, AiFeatureDraft> = {};
        const nextReviews: Record<string, boolean | undefined> = {};

        featureData.features.forEach((feature) => {
          const previous = previousFeatures.get(feature.key);
          const existing = currentDrafts[feature.key];
          const baseChanged = Boolean(previous)
            && hasAiConfigBaseChanged(previous!.activeConfig, feature.activeConfig);
          if (baseChanged) changedBaseKeys.add(feature.key);
          const keepExisting = preserveDirtyDrafts
            && !resetSet.has(feature.key)
            && existing !== undefined
            && previous !== undefined
            && isAiFeatureDraftDirty(previous.activeConfig, existing);
          nextDrafts[feature.key] = keepExisting ? existing : draftFromConfig(feature.activeConfig);
          nextReviews[feature.key] = keepExisting
            ? Boolean(currentReviews[feature.key]) || baseChanged
            : false;
        });

        setFeatures(featureData.features);
        featuresRef.current = featureData.features;
        setDrafts(nextDrafts);
        draftsRef.current = nextDrafts;
        setDraftReviewRequired(nextReviews);
        draftReviewRequiredRef.current = nextReviews;
        if (changedBaseKeys.size > 0) {
          setPendingActivations((current) => Object.fromEntries(
            Object.entries(current).map(([key, pending]) => [
              key,
              changedBaseKeys.has(key as AiFeatureKey) ? undefined : pending,
            ]),
          ));
        }
        const discoverable = featureData.providers.filter(
          (provider): provider is AiHostedProvider => (AI_DISCOVERABLE_PROVIDERS as readonly string[]).includes(provider),
        );
        setProviders(discoverable.length > 0 ? discoverable : [...AI_DISCOVERABLE_PROVIDERS]);
        setGeneratedAt(featureData.generatedAt);
        setPanelErrors((current) => ({ ...current, features: null }));
      })
      .catch((error: unknown) => failPanel('features', error))
      .finally(() => finishPanel('features'));

    const modelTask = apiRequest<AiModelsResponse>('/models')
      .then((modelData) => {
        if (sequence !== loadSequenceRef.current) return;
        setModels(modelData.models);
        setConfiguredProviders(modelData.configuredProviders);
        setPanelErrors((current) => ({ ...current, models: null }));
      })
      .catch((error: unknown) => failPanel('models', error))
      .finally(() => finishPanel('models'));

    const historyTask = apiRequest<AiConfigsResponse>('/configs?limit=500')
      .then((configData) => {
        if (sequence !== loadSequenceRef.current) return;
        setHistory(configData.configs);
        setPanelErrors((current) => ({ ...current, history: null }));
      })
      .catch((error: unknown) => failPanel('history', error))
      .finally(() => finishPanel('history'));

    await Promise.all([featureTask, modelTask, historyTask]);
    if (sequence === loadSequenceRef.current) loadedRef.current = true;
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    loadedRef.current = false;
    void loadAll(false, true);
  }, [loadAll, open]);

  // One best-effort discovery check per opening. Cached rows remain usable while
  // stale or missing provider catalogs refresh, and discovery never activates a model.
  useEffect(() => {
    if (!open) {
      autoRefreshCheckedRef.current = false;
      return;
    }
    const loading = Object.values(panelLoading).some(Boolean);
    if (!loadedRef.current || loading || panelErrors.models || autoRefreshCheckedRef.current) return;
    autoRefreshCheckedRef.current = true;

    const staleProviders = findStaleModelProviders(providers, models);
    if (staleProviders.length === 0 || catalogRefreshInFlightRef.current) return;
    catalogRefreshInFlightRef.current = true;
    setRefreshingModels(true);

    void (async () => {
      try {
        await refreshProviderCatalogs(staleProviders, false);
      } finally {
        catalogRefreshInFlightRef.current = false;
        setRefreshingModels(false);
      }
    })();
  }, [models, open, panelErrors.models, panelLoading, providers, refreshProviderCatalogs]);

  /** Picks staged on this screen that were never tested and never activated. */
  const hasUntestedPicks = useCallback(() => featuresRef.current.some(
    (feature) => isAiFeatureDraftDirty(feature.activeConfig, draftsRef.current[feature.key]),
  ), []);

  /**
   * Leaving the screen. Staged picks live only in this component and only until
   * the tab is reloaded, so closing on them is how a screenful of choices went
   * missing, silently, in one click. Now the first attempt to close with staged
   * picks stops and asks; `discardPicks` is the answer to that question, and it
   * is the only way past.
   *
   * Answering "close and lose them" really does drop them, rather than leaving
   * them to reappear on the next open. Being told the picks are gone and then
   * finding them still there is the same lie in the other direction, and the
   * next reload would settle it the other way anyway.
   */
  const close = useCallback((options: { discardPicks?: boolean } = {}) => {
    if (rollingBackIdRef.current || Object.values(featureActionsRef.current).some(Boolean)) return;
    if (!options.discardPicks && hasUntestedPicks()) {
      setConfirmDiscard(true);
      return;
    }
    if (options.discardPicks) {
      const cleanDrafts: Record<string, AiFeatureDraft> = {};
      const clearedReviews: Record<string, boolean | undefined> = {};
      for (const feature of featuresRef.current) {
        cleanDrafts[feature.key] = draftFromConfig(feature.activeConfig);
        clearedReviews[feature.key] = false;
      }
      draftsRef.current = cleanDrafts;
      draftReviewRequiredRef.current = clearedReviews;
      setDrafts(cleanDrafts);
      setDraftReviewRequired(clearedReviews);
    }
    setConfirmDiscard(false);
    setGlobalModelsOpen(false);
    setOpen(false);
    setRollbackId(null);
    setRollbackWarnings({});
  }, [hasUntestedPicks]);

  // Dialog behavior: scroll lock, Escape, focus trap, and focus restoration.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (rollingBackIdRef.current || Object.values(featureActionsRef.current).some(Boolean)) return;
        // The "close anyway?" question is the topmost thing on the screen, so
        // Escape answers it with "keep editing" rather than reaching past it.
        if (confirmDiscardRef.current) {
          setConfirmDiscard(false);
          requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
          return;
        }
        if (globalModelsOpenRef.current) {
          setGlobalModelsOpen(false);
          requestAnimationFrame(() => globalModelsButtonRef.current?.focus({ preventScroll: true }));
          return;
        }
        if (rollbackIdRef.current) {
          setRollbackId(null);
          setRollbackWarnings({});
        }
        else close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusScope = globalModelsOpenRef.current ? globalModelsDialogRef.current : dialogRef.current;
      const nodes = Array.from(focusScope?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        .filter((node) => node.tabIndex >= 0 && !node.hasAttribute('disabled') && node.offsetParent !== null);
      if (nodes.length === 0) {
        event.preventDefault();
        focusScope?.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const focusIsInScope = nodes.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (document.activeElement === first || !focusIsInScope)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusIsInScope)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    };
  }, [close, open]);

  useEffect(() => {
    if (!globalModelsOpen) return;
    const frame = requestAnimationFrame(() => globalPrimaryRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [globalModelsOpen]);

  const updateDraft = useCallback((key: AiFeatureKey, patch: Partial<AiFeatureDraft>) => {
    const currentDraft = draftsRef.current[key];
    if (!currentDraft) return;
    const next = {
      ...draftsRef.current,
      [key]: { ...currentDraft, ...patch },
    };
    draftsRef.current = next;
    setDrafts(next);
    setFeatureErrors((current) => ({ ...current, [key]: undefined }));
    setPendingActivations((current) => ({ ...current, [key]: undefined }));
  }, []);

  const stageGlobalEnabled = useCallback((enabled: boolean) => {
    const plan = stageGlobalEnabledDrafts(featuresRef.current, draftsRef.current, enabled);
    draftsRef.current = plan.drafts;
    setDrafts(plan.drafts);
    if (plan.changed.length > 0) {
      const changed = new Set(plan.changed);
      setFeatureErrors((current) => Object.fromEntries(
        Object.entries(current).map(([key, value]) => [key, changed.has(key) ? undefined : value]),
      ));
      setPendingActivations((current) => Object.fromEntries(
        Object.entries(current).map(([key, value]) => [key, changed.has(key) ? undefined : value]),
      ));
    }
    toast(
      'info',
      `Staged ${plan.changed.length} feature${plan.changed.length === 1 ? '' : 's'} ${enabled ? 'on' : 'off'}; `
      + `${plan.unchanged.length} already matched and ${plan.skipped.length} read-only or unavailable skipped. `
      + 'Test each changed feature before making it live.',
    );
  }, [toast]);

  const applyGlobalModelDrafts = useCallback(() => {
    if (!globalPrimaryKey || !globalFallbackKey || globalPrimaryKey === globalFallbackKey) return;
    const plan = planGlobalModelDrafts(
      featuresRef.current,
      globalPickerModels,
      draftsRef.current,
      globalPrimaryKey,
      globalFallbackKey,
    );
    draftsRef.current = plan.drafts;
    setDrafts(plan.drafts);
    if (plan.changed.length > 0) {
      const changed = new Set(plan.changed);
      setFeatureErrors((current) => Object.fromEntries(
        Object.entries(current).map(([key, value]) => [key, changed.has(key) ? undefined : value]),
      ));
      setPendingActivations((current) => Object.fromEntries(
        Object.entries(current).map(([key, value]) => [key, changed.has(key) ? undefined : value]),
      ));
    }
    setGlobalModelsOpen(false);
    setGlobalPrimaryKey('');
    setGlobalFallbackKey('');
    toast(
      'info',
      `Staged both models for ${plan.changed.length} feature${plan.changed.length === 1 ? '' : 's'}; `
      + `${plan.unchanged.length} already matched and ${plan.skipped.length} incompatible or fixed skipped. `
      + 'Test each changed feature before making it live.',
    );
    requestAnimationFrame(() => globalModelsButtonRef.current?.focus({ preventScroll: true }));
  }, [globalFallbackKey, globalPickerModels, globalPrimaryKey, toast]);

  const resetDraft = useCallback((feature: AiFeatureSummary) => {
    const next = {
      ...draftsRef.current,
      [feature.key]: draftFromConfig(feature.activeConfig),
    };
    draftsRef.current = next;
    setDrafts(next);
    const nextReviews = { ...draftReviewRequiredRef.current, [feature.key]: false };
    draftReviewRequiredRef.current = nextReviews;
    setDraftReviewRequired(nextReviews);
    setFeatureErrors((current) => ({ ...current, [feature.key]: undefined }));
    setPendingActivations((current) => ({ ...current, [feature.key]: undefined }));
  }, []);

  const testConfiguration = useCallback(async (feature: AiFeatureSummary) => {
    const draft = drafts[feature.key];
    if (!draft || rollingBackIdRef.current || featureActionsRef.current[feature.key]) return;
    const primary = parseModelRefKey(draft.primaryKey);
    const fallback = parseModelRefKey(draft.fallbackKey);
    if (!primary || !isProvider(primary.provider)) {
      setFeatureErrors((current) => ({ ...current, [feature.key]: 'Choose a primary model.' }));
      return;
    }
    if (!feature.runtimeProviders.includes(primary.provider)) {
      setFeatureErrors((current) => ({
        ...current,
        [feature.key]: `This feature supports ${runtimeProvidersLabel(feature.runtimeProviders)} models only.`,
      }));
      return;
    }
    if (fallback && !isProvider(fallback.provider)) {
      setFeatureErrors((current) => ({ ...current, [feature.key]: 'Choose a valid fallback model.' }));
      return;
    }
    const fallbackProvider: AiProvider | null = fallback ? fallback.provider as AiProvider : null;
    if (fallbackProvider && !feature.runtimeProviders.includes(fallbackProvider)) {
      setFeatureErrors((current) => ({
        ...current,
        [feature.key]: `The fallback must also use ${runtimeProvidersLabel(feature.runtimeProviders)}.`,
      }));
      return;
    }

    const automaticReason = describeConfigChange(feature.label, feature.activeConfig, draft);
    const reason = draft.changeReason.trim() || automaticReason;
    setFeatureErrors((current) => ({ ...current, [feature.key]: undefined }));
    try {
      setFeatureAction(feature.key, 'creating');
      const createBody: CreateAiConfigRequest = {
        featureKey: feature.key,
        enabled: draft.enabled,
        primary: { provider: primary.provider, modelId: primary.modelId },
        fallback: fallback && isProvider(fallback.provider)
          ? { provider: fallback.provider, modelId: fallback.modelId }
          : null,
        parameters: feature.activeConfig.parameters,
        parentId: feature.activeConfig.versionId,
        changeReason: reason,
      };
      const created = await apiRequest<CreateAiConfigResponse>('/configs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });

      setFeatureAction(feature.key, 'validating');
      const validated = await apiRequest<ValidateAiConfigResponse>(`/configs/${encodeURIComponent(created.config.id)}/validate`, {
        method: 'POST',
      });
      const validationError = validationFailed(validated);
      if (validationError) throw new Error(validationError);
      setPendingActivations((current) => ({
        ...current,
        [feature.key]: {
          configId: created.config.id,
          expectedActiveId: feature.activeConfig.versionId,
          reason,
          warnings: validated.report.warnings,
          probeCount: validated.report.probes.length,
        },
      }));
      toast('success', `${feature.label} passed its provider test. Review it, then activate manually.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test and activation failed.';
      setFeatureErrors((current) => ({ ...current, [feature.key]: message }));
      toast('error', `${feature.label}: ${message}`);
      await loadAll(true, true);
    } finally {
      setFeatureAction(feature.key, undefined);
    }
  }, [drafts, loadAll, setFeatureAction, toast]);

  const activateTested = useCallback(async (feature: AiFeatureSummary) => {
    const pending = pendingActivations[feature.key];
    if (!pending || rollingBackIdRef.current || featureActionsRef.current[feature.key]) return;
    setFeatureErrors((current) => ({ ...current, [feature.key]: undefined }));
    setFeatureAction(feature.key, 'activating');
    try {
      const activateBody: ActivateAiConfigRequest = {
        expectedActiveId: pending.expectedActiveId,
        reason: pending.reason,
      };
      await apiRequest<ActivateAiConfigResponse>(`/configs/${encodeURIComponent(pending.configId)}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(activateBody),
      });
      setPendingActivations((current) => ({ ...current, [feature.key]: undefined }));
      toast('success', `${feature.label} is now active.`);
      await loadAll(true, true, feature.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Activation failed.';
      setFeatureErrors((current) => ({ ...current, [feature.key]: message }));
      setPendingActivations((current) => ({ ...current, [feature.key]: undefined }));
      toast('error', `${feature.label}: ${message}`);
      await loadAll(true, true);
    } finally {
      setFeatureAction(feature.key, undefined);
    }
  }, [loadAll, pendingActivations, setFeatureAction, toast]);

  /**
   * Category-wide on/off. For every switchable feature in the group whose
   * live state differs, runs the full create → test → activate cycle with the
   * models it already uses. Turning OFF skips the paid probe entirely (the
   * store only probes enabled configs); turning ON costs one tiny probe per
   * feature. Sequential on purpose — the config store allocates versions per
   * feature under an advisory lock, and a slow trickle of admin writes is
   * kinder than a burst.
   */
  const runGroupCycle = useCallback(async (
    groupName: string,
    groupFeatures: AiFeatureSummary[],
    plan: {
      /** Eligible features + the exact config each should get. */
      targets: Array<{ feature: AiFeatureSummary; body: CreateAiConfigRequest }>;
      /** Features considered but not applicable (with a short why). */
      skipped: string[];
      reason: string;
      successNoun: string;
    },
  ) => {
    const { targets, skipped } = plan;
    if (targets.length === 0) {
      toast('success', `${groupName}: nothing to change${skipped.length > 0 ? ` (${skipped.length} not applicable)` : ''}.`);
      return;
    }
    groupBulkBusyRef.current = groupName;
    setGroupBulkBusy(groupName);
    const failures: string[] = [];
    try {
      for (const { feature, body } of targets) {
        setFeatureAction(feature.key, 'validating');
        try {
          const created = await apiRequest<CreateAiConfigResponse>('/configs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const validated = await apiRequest<ValidateAiConfigResponse>(`/configs/${encodeURIComponent(created.config.id)}/validate`, {
            method: 'POST',
          });
          const validationError = validationFailed(validated);
          if (validationError) throw new Error(validationError);
          setFeatureAction(feature.key, 'activating');
          const activateBody: ActivateAiConfigRequest = {
            expectedActiveId: feature.activeConfig.versionId,
            reason: plan.reason,
          };
          await apiRequest<ActivateAiConfigResponse>(`/configs/${encodeURIComponent(created.config.id)}/activate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(activateBody),
          });
        } catch (error) {
          failures.push(`${feature.label}: ${error instanceof Error ? error.message : 'failed'}`);
        } finally {
          setFeatureAction(feature.key, undefined);
        }
      }
    } finally {
      groupBulkBusyRef.current = null;
      setGroupBulkBusy(null);
      // The bulk action is the admin's latest word for this whole category:
      // reset every card in the group to the fresh live config so a stale
      // hand-flipped switch can't keep showing the old state.
      await loadAll(true, true, groupFeatures.map((feature) => feature.key));
    }
    const applied = targets.length - failures.length;
    if (failures.length === 0) {
      toast('success', `${groupName}: ${plan.successNoun} for ${applied} feature${applied === 1 ? '' : 's'}${skipped.length > 0 ? ` (${skipped.length} skipped: ${skipped[0]})` : ''}.`);
    } else {
      toast('error', `${groupName}: ${failures.length} of ${targets.length} didn't apply. ${failures[0]}`);
    }
  }, [loadAll, setFeatureAction, toast]);

  const bulkToggleGroup = useCallback(async (groupName: string, groupFeatures: AiFeatureSummary[], enable: boolean) => {
    if (groupBulkBusyRef.current || rollingBackIdRef.current || Object.values(featureActionsRef.current).some(Boolean)) return;
    const reason = `Turned ${enable ? 'on' : 'off'} with the whole ${groupName} category`;
    const targets = groupFeatures
      .filter((feature) =>
        feature.editable
        && feature.switchable
        && feature.availability !== 'unavailable'
        && isHostedProvider(feature.activeConfig.primary.provider)
        && feature.activeConfig.enabled !== enable)
      .map((feature) => ({
        feature,
        body: {
          featureKey: feature.key,
          enabled: enable,
          primary: { provider: feature.activeConfig.primary.provider as AiHostedProvider, modelId: feature.activeConfig.primary.modelId },
          fallback: feature.activeConfig.fallback && isHostedProvider(feature.activeConfig.fallback.provider)
            ? { provider: feature.activeConfig.fallback.provider, modelId: feature.activeConfig.fallback.modelId }
            : null,
          parameters: feature.activeConfig.parameters,
          parentId: feature.activeConfig.versionId,
          changeReason: reason,
        } satisfies CreateAiConfigRequest,
      }));
    await runGroupCycle(groupName, groupFeatures, {
      targets,
      skipped: [],
      reason,
      successNoun: `turned ${enable ? 'on' : 'off'}`,
    });
  }, [runGroupCycle]);

  /**
   * Category-wide model change. Applies the chosen primary (and optional
   * fallback) to every feature in the group that can actually run it —
   * matching runtime provider, model switching allowed, and the model
   * covering the feature's required capabilities (e.g. a text-only model is
   * skipped for photo-reading features). Each feature keeps its current
   * on/off state and goes through the same test-then-activate cycle.
   */
  const bulkChangeGroupModels = useCallback(async (
    groupName: string,
    groupFeatures: AiFeatureSummary[],
    primaryKey: string,
    fallbackKey: string,
  ) => {
    if (groupBulkBusyRef.current || rollingBackIdRef.current || Object.values(featureActionsRef.current).some(Boolean)) return;
    const primaryEntry = selectableModels.find((model) => modelRefKey(model) === primaryKey);
    if (!primaryEntry || !primaryEntry.available) {
      toast('error', 'Pick an available primary model first.');
      return;
    }
    const fallbackEntry = fallbackKey !== NO_FALLBACK
      ? selectableModels.find((model) => modelRefKey(model) === fallbackKey)
      : undefined;
    const reason = `Set ${primaryEntry.displayName}${fallbackEntry ? ` (fallback ${fallbackEntry.displayName})` : ''} for the whole ${groupName} category`;
    const targets: Array<{ feature: AiFeatureSummary; body: CreateAiConfigRequest }> = [];
    const skipped: string[] = [];
    for (const feature of groupFeatures) {
      if (!feature.editable || feature.availability === 'unavailable') {
        skipped.push(`${feature.label} is not configurable`);
        continue;
      }
      if (!feature.modelSwitchable) {
        skipped.push(`${feature.label} has a fixed model`);
        continue;
      }
      if (!isRuntimeCompatibleAiModel(feature, primaryEntry)) {
        skipped.push(`${feature.label} can't run ${primaryEntry.displayName}`);
        continue;
      }
      const fallbackOk = fallbackEntry
        && feature.fallbackAllowed
        && isRuntimeCompatibleAiModel(feature, fallbackEntry)
        && modelRefKey(fallbackEntry) !== modelRefKey(primaryEntry);
      const samePrimary = feature.activeConfig.primary.provider === primaryEntry.provider
        && feature.activeConfig.primary.modelId === primaryEntry.modelId;
      const sameFallback = fallbackOk
        ? feature.activeConfig.fallback?.provider === fallbackEntry.provider
          && feature.activeConfig.fallback?.modelId === fallbackEntry.modelId
        : feature.activeConfig.fallback === null;
      if (samePrimary && sameFallback) continue; // already exactly this setup
      targets.push({
        feature,
        body: {
          featureKey: feature.key,
          enabled: feature.activeConfig.enabled,
          primary: { provider: primaryEntry.provider, modelId: primaryEntry.modelId },
          fallback: fallbackOk
            ? { provider: fallbackEntry.provider, modelId: fallbackEntry.modelId }
            : null,
          parameters: feature.activeConfig.parameters,
          parentId: feature.activeConfig.versionId,
          changeReason: reason,
        },
      });
    }
    await runGroupCycle(groupName, groupFeatures, {
      targets,
      skipped,
      reason,
      successNoun: `switched to ${primaryEntry.displayName}`,
    });
  }, [runGroupCycle, selectableModels, toast]);

  const refreshModels = useCallback(async () => {
    if (catalogRefreshInFlightRef.current) return;
    catalogRefreshInFlightRef.current = true;
    setRefreshingModels(true);
    try {
      const targets = providerFilter === 'all' ? providers : [providerFilter];
      await refreshProviderCatalogs(targets, true);
    } finally {
      catalogRefreshInFlightRef.current = false;
      setRefreshingModels(false);
    }
  }, [providerFilter, providers, refreshProviderCatalogs]);

  const rollback = useCallback(async (config: AiConfigVersion, acknowledgeWarnings = false) => {
    if (rollingBackIdRef.current || Object.values(featureActionsRef.current).some(Boolean)) return;
    const feature = features.find((row) => row.key === config.featureKey);
    if (!feature) return;
    rollingBackIdRef.current = config.id;
    setRollingBackId(config.id);
    try {
      if (config.enabled) {
        const validated = await apiRequest<ValidateAiConfigResponse>(`/configs/${encodeURIComponent(config.id)}/validate`, {
          method: 'POST',
        });
        const validationError = validationFailed(validated);
        if (validationError) throw new Error(validationError);
        if (validated.report.warnings.length > 0) {
          const previouslyReviewed = rollbackWarnings[config.id] ?? [];
          const warningsChanged = JSON.stringify(previouslyReviewed) !== JSON.stringify(validated.report.warnings);
          if (!acknowledgeWarnings || warningsChanged) {
            setRollbackWarnings((current) => ({ ...current, [config.id]: validated.report.warnings }));
            toast('info', 'Fresh rollback validation returned warnings. Review them and explicitly acknowledge before rollback.');
            return;
          }
        }
      }
      const body: ActivateAiConfigRequest = {
        expectedActiveId: feature.activeConfig.versionId,
        reason: `Rollback ${feature.label} to version ${config.version} from AI Control Center`,
      };
      await apiRequest<ActivateAiConfigResponse>(`/configs/${encodeURIComponent(config.id)}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setRollbackId(null);
      setRollbackWarnings((current) => ({ ...current, [config.id]: undefined }));
      toast('success', `${feature.label} rolled back to version ${config.version}.`);
      await loadAll(true, true, config.featureKey);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Rollback failed.');
      await loadAll(true, true);
    } finally {
      rollingBackIdRef.current = null;
      setRollingBackId(null);
    }
  }, [features, loadAll, rollbackWarnings, toast]);

  const confirmRollback = useCallback((id: string | null) => {
    setRollbackId(id);
    if (id === null) setRollbackWarnings({});
  }, []);

  const switchTab = (next: TabId) => {
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`ai-control-tab-${next}`)?.focus());
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: TabId) => {
    const index = TABS.findIndex((item) => item.id === current);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    switchTab(TABS[next].id);
  };

  const activeCount = features.filter((feature) => feature.activeConfig.enabled).length;
  const dirtyCount = features.filter((feature) => (
    isAiFeatureDraftDirty(feature.activeConfig, drafts[feature.key])
  )).length;
  const featureActionInFlight = Object.values(featureActions).some(Boolean);
  const featureMutationInFlight = Boolean(rollingBackId) || featureActionInFlight;
  const globalControlsDisabled = featureMutationInFlight || Boolean(groupBulkBusy) || panelLoading.features;
  const currentPanelLoading = panelLoading[tab];
  const currentPanelError = panelErrors[tab];

  const overlay = open ? (
    <>
      <div
        className={styles.scrim}
        onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
        data-testid="ai-control-scrim"
      >
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-control-title"
          aria-describedby="ai-control-description"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className={styles.modalHeader}>
            <div className={styles.headerRow}>
              <div className={styles.titleWrap}>
                <span className={styles.eyebrow}>Staxis AI · Admin control</span>
                <h2 id="ai-control-title" className={styles.title}>AI Control Center</h2>
                <p id="ai-control-description" className={styles.intro}>
                  App AI features controlled here, with active models, fallbacks, pricing, and change history.
                  Core operational workflows and Knowledge OCR are managed elsewhere and explicitly excluded.
                </p>
                <div className={styles.headerMeta}>
                  <StatusChip tone="good">{activeCount} on</StatusChip>
                  <StatusChip tone="info">{features.length} app features</StatusChip>
                  {dirtyCount > 0 && <StatusChip tone="warn">{dirtyCount} unsaved</StatusChip>}
                  {generatedAt && <StatusChip>updated {formatAiDate(generatedAt)}</StatusChip>}
                </div>
              </div>
              <div className={styles.headerActions}>
                <label
                  className={styles.headerEnable}
                  title="Stage every controllable AI feature on or off"
                >
                  <span className={styles.headerActionLabel}>All AI</span>
                  <input
                    ref={globalEnableRef}
                    type="checkbox"
                    className={styles.srOnly}
                    checked={globalAllEnabled}
                    disabled={globalControlsDisabled || globallyControllable.length === 0}
                    aria-label="Stage all controllable AI features on or off"
                    onChange={(event) => stageGlobalEnabled(event.target.checked)}
                  />
                  <span className={styles.headerEnableTrack} aria-hidden="true">
                    <span className={styles.headerEnableHandle} />
                  </span>
                </label>
                <button
                  ref={globalModelsButtonRef}
                  type="button"
                  className={styles.headerModelButton}
                  disabled={globalControlsDisabled || globalPickerModels.length < 2}
                  aria-label="Set all models"
                  aria-haspopup="dialog"
                  aria-expanded={globalModelsOpen}
                  onClick={() => setGlobalModelsOpen(true)}
                  title={globalPickerModels.length < 2
                    ? 'At least two confirmed usable models are required'
                    : 'Stage one primary and fallback across compatible AI features'}
                >
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  <span className={styles.headerActionLabel}>Set all models</span>
                </button>
                <button
                  ref={closeRef}
                  type="button"
                  className={styles.closeButton}
                  onClick={() => close()}
                  disabled={featureMutationInFlight}
                  aria-label="Close AI Control Center"
                  title={featureMutationInFlight ? 'Wait for the current AI settings change to finish' : 'Close AI Control Center'}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {confirmDiscard && (
              <div className={styles.confirmBox} role="alert" data-testid="ai-control-discard-confirm">
                <AlertTriangle size={17} />
                <span className={styles.confirmCopy}>
                  You picked models that were never tested. Close anyway and lose those picks?
                </span>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    setConfirmDiscard(false);
                    requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
                  }}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => close({ discardPicks: true })}
                >
                  Close and lose them
                </button>
              </div>
            )}

            <div className={styles.tabs} role="tablist" aria-label="AI Control Center sections">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  id={`ai-control-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls={`ai-control-panel-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                  className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => onTabKeyDown(event, item.id)}
                >
                  {item.icon} {item.label}
                </button>
              ))}
            </div>
          </header>

          <div className={styles.body}>
            {currentPanelLoading ? (
              <div className={styles.panel}><LoadingState label={`Loading ${tab}…`} /></div>
            ) : currentPanelError ? (
              <div className={styles.panel}>
                <div className={styles.errorState} role="alert">
                  <XCircle size={24} />
                  <span>{currentPanelError}</span>
                  <button type="button" className={styles.secondaryButton} onClick={() => void loadAll(false, true)}>Retry {tab}</button>
                </div>
              </div>
            ) : tab === 'features' ? (
              <FeaturesPanel
                features={features}
                models={selectableModels}
                drafts={drafts}
                query={featureQuery}
                actions={featureActions}
                errors={featureErrors}
                pendingActivations={pendingActivations}
                reviewRequired={draftReviewRequired}
                rollbackInFlight={Boolean(rollingBackId)}
                onQuery={setFeatureQuery}
                onDraft={updateDraft}
                onReset={resetDraft}
                onTest={testConfiguration}
                onActivate={activateTested}
                groupBulkBusy={groupBulkBusy}
                onGroupToggle={bulkToggleGroup}
                onGroupModels={bulkChangeGroupModels}
              />
            ) : tab === 'models' ? (
              <ModelsPanel
                models={models}
                selectableModels={selectableModels}
                features={features}
                query={modelQuery}
                provider={providerFilter}
                providers={providers}
                refreshing={refreshingModels}
                onQuery={setModelQuery}
                onProvider={setProviderFilter}
                onRefresh={refreshModels}
              />
            ) : (
              <HistoryPanel
                history={history}
                features={features}
                confirmingId={rollbackId}
                rollingBackId={rollingBackId}
                rollbackWarnings={rollbackWarnings}
                featureMutationInFlight={featureActionInFlight}
                onConfirm={confirmRollback}
                onRollback={rollback}
              />
            )}
          </div>
          {globalModelsOpen && (
            <GlobalModelsDialog
              dialogRef={globalModelsDialogRef}
              primaryRef={globalPrimaryRef}
              models={globalPickerModels}
              features={features}
              plan={globalModelPlan}
              primaryKey={globalPrimaryKey}
              fallbackKey={globalFallbackKey}
              onPrimary={(value) => {
                setGlobalPrimaryKey(value);
                if (value === globalFallbackKey) setGlobalFallbackKey('');
              }}
              onFallback={setGlobalFallbackKey}
              onCancel={() => {
                setGlobalModelsOpen(false);
                requestAnimationFrame(() => globalModelsButtonRef.current?.focus({ preventScroll: true }));
              }}
              onApply={applyGlobalModelDrafts}
            />
          )}
          <ToastViewport items={toasts} onDismiss={dismissToast} />
        </div>
      </div>
    </>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => { setConfirmDiscard(false); setOpen(true); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Open AI Control Center"
      >
        <Sparkles className={styles.triggerIcon} size={15} aria-hidden="true" />
        <span className={styles.triggerText}>AI Control Center</span>
      </button>
      {mounted && overlay ? createPortal(overlay, document.body) : null}
    </>
  );
}

function FeaturesPanel({
  features,
  models,
  drafts,
  query,
  actions,
  errors,
  pendingActivations,
  reviewRequired,
  rollbackInFlight,
  onQuery,
  onDraft,
  onReset,
  onTest,
  onActivate,
  groupBulkBusy,
  onGroupToggle,
  onGroupModels,
}: {
  features: AiFeatureSummary[];
  models: AiModelCatalogEntry[];
  drafts: Record<string, AiFeatureDraft>;
  query: string;
  actions: Record<string, FeatureActionPhase | undefined>;
  errors: Record<string, string | undefined>;
  pendingActivations: Record<string, PendingActivation | undefined>;
  reviewRequired: Record<string, boolean | undefined>;
  rollbackInFlight: boolean;
  onQuery: (value: string) => void;
  onDraft: (key: AiFeatureKey, patch: Partial<AiFeatureDraft>) => void;
  onReset: (feature: AiFeatureSummary) => void;
  onTest: (feature: AiFeatureSummary) => void;
  onActivate: (feature: AiFeatureSummary) => void;
  groupBulkBusy: string | null;
  onGroupToggle: (groupName: string, groupFeatures: AiFeatureSummary[], enable: boolean) => void;
  onGroupModels: (groupName: string, groupFeatures: AiFeatureSummary[], primaryKey: string, fallbackKey: string) => void;
}) {
  const groups = useMemo(() => groupAiFeatures(features, query), [features, query]);
  return (
    <section
      id="ai-control-panel-features"
      className={styles.panel}
      role="tabpanel"
      aria-labelledby="ai-control-tab-features"
    >
      <div className={styles.toolbar}>
        <label className={styles.searchWrap}>
          <span className={styles.srOnly}>Search AI features</span>
          <Search className={styles.searchIcon} size={15} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Find a feature, department, or model use…"
          />
        </label>
        <span className={styles.summaryText}>{groups.reduce((total, group) => total + group.features.length, 0)} shown · nothing changes until you test and make it live</span>
      </div>

      {groups.length === 0 ? (
        <div className={styles.emptyState}><Search size={22} />No AI features match “{query}”.</div>
      ) : (
        <div className={styles.featureGroups}>
          {groups.map((group) => (
            <section key={group.group} className={styles.groupSection} aria-labelledby={`ai-group-${group.group.replaceAll(' ', '-').toLowerCase()}`}>
              <div className={styles.groupHeader}>
                <h3 id={`ai-group-${group.group.replaceAll(' ', '-').toLowerCase()}`} className={styles.groupTitle}>{group.group}</h3>
                <span className={styles.groupCount}>{group.features.length}</span>
                {group.features.some((feature) => feature.editable && feature.switchable) && (
                  <span className={styles.groupBulkActions}>
                    {groupBulkBusy === group.group ? (
                      <span className={styles.groupBulkBusy}><span className={styles.spinner} aria-hidden="true" /> Switching…</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={Boolean(groupBulkBusy) || rollbackInFlight}
                          onClick={() => onGroupToggle(group.group, group.features, true)}
                        >
                          All on
                        </button>
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={Boolean(groupBulkBusy) || rollbackInFlight}
                          onClick={() => onGroupToggle(group.group, group.features, false)}
                        >
                          All off
                        </button>
                        <GroupModelControls
                          models={models}
                          disabled={Boolean(groupBulkBusy) || rollbackInFlight}
                          onApply={(primaryKey, fallbackKey) => onGroupModels(group.group, group.features, primaryKey, fallbackKey)}
                        />
                      </>
                    )}
                  </span>
                )}
              </div>
              <div className={styles.featureList}>
                {group.features.map((feature) => (
                  <FeatureEditor
                    key={feature.key}
                    feature={feature}
                    models={models}
                    draft={drafts[feature.key] ?? draftFromConfig(feature.activeConfig)}
                    action={actions[feature.key]}
                    error={errors[feature.key]}
                    pendingActivation={pendingActivations[feature.key]}
                    reviewRequired={Boolean(reviewRequired[feature.key])}
                    mutationBlocked={rollbackInFlight}
                    onDraft={(patch) => onDraft(feature.key, patch)}
                    onReset={() => onReset(feature)}
                    onTest={() => onTest(feature)}
                    onActivate={() => onActivate(feature)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function FeatureEditor({
  feature,
  models,
  draft,
  action,
  error,
  pendingActivation,
  reviewRequired,
  mutationBlocked,
  onDraft,
  onReset,
  onTest,
  onActivate,
}: {
  feature: AiFeatureSummary;
  models: AiModelCatalogEntry[];
  draft: AiFeatureDraft;
  action?: FeatureActionPhase;
  error?: string;
  pendingActivation?: PendingActivation;
  reviewRequired: boolean;
  mutationBlocked: boolean;
  onDraft: (patch: Partial<AiFeatureDraft>) => void;
  onReset: () => void;
  onTest: () => void;
  onActivate: () => void;
}) {
  const dirty = isAiFeatureDraftDirty(feature.activeConfig, draft);
  const environmentOverride = feature.activeConfig.source === 'default'
    && (
      feature.activeConfig.primary.provider !== feature.defaultConfig.primary.provider
      || feature.activeConfig.primary.modelId !== feature.defaultConfig.primary.modelId
    );
  const modelSafetyMessage = feature.modelLockReason?.trim()
    || (feature.key === 'knowledge.embeddings' && (!feature.modelSwitchable || !feature.fallbackAllowed)
      ? 'Requires knowledge re-index.'
      : null);
  const compatibleModels = useMemo(
    () => models.filter((model) => isRuntimeCompatibleAiModel(feature, model)),
    [feature, models],
  );
  // Say WHY only one provider's models are listed, so a narrowed picker reads
  // as a deliberate limit rather than a missing catalog. Only shown when the
  // feature really is restricted AND could otherwise have been broader — a
  // feature that can run on everything says nothing.
  const singleProviderNote = feature.modelSwitchable && feature.runtimeProviders.length === 1
    && feature.requiredCapabilities.length > 0
    ? `Only ${providerLabel(feature.runtimeProviders[0])} models can run this feature. It needs ${feature.requiredCapabilities.map(capabilityLabel).join(' + ')}.`
    : null;
  const busyLabel = action === 'creating'
    ? 'Saving…'
    : action === 'validating'
      ? 'Testing…'
      : action === 'activating'
        ? 'Going live…'
        : null;

  return (
    <article className={`${styles.featureCard} ${dirty ? styles.featureCardDirty : ''} ${action ? styles.featureCardBusy : ''}`}>
      <div className={styles.featureTop}>
        <div className={styles.featureIdentity}>
          <div className={styles.featureTitleRow}>
            <h4 className={styles.featureTitle}>{feature.label}</h4>
            <StatusChip tone={feature.activeConfig.enabled ? 'good' : 'danger'}>{feature.activeConfig.enabled ? 'On' : 'Off'}</StatusChip>
            {feature.availability === 'unavailable' && <StatusChip tone="danger">Unavailable</StatusChip>}
            <StatusChip tone={feature.activeConfig.source === 'fail_closed' ? 'danger' : feature.activeConfig.source === 'database' || environmentOverride ? 'info' : undefined}>
              {feature.activeConfig.source === 'fail_closed'
                ? 'Safety lock'
                : feature.activeConfig.source === 'database'
                  ? `Custom · v${feature.activeConfig.version ?? '—'}`
                  : environmentOverride
                    ? 'Environment override'
                    : 'Default'}
            </StatusChip>
            {!feature.editable && <StatusChip>Read only</StatusChip>}
          </div>
          <p className={styles.featureDescription}>{feature.description}</p>
        </div>
        <div className={styles.switchWrap}>
          <span className={styles.switchLabel}>{draft.enabled ? 'Enabled' : 'Disabled'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label={`${draft.enabled ? 'Disable' : 'Enable'} ${feature.label}`}
            className={`${styles.switch} ${draft.enabled ? styles.switchOn : ''}`}
            disabled={!feature.editable || !feature.switchable || Boolean(action) || mutationBlocked}
            onClick={() => onDraft({ enabled: !draft.enabled })}
          >
            <span className={styles.switchKnob} aria-hidden="true" />
          </button>
        </div>
      </div>

      {feature.editable ? (
        <div className={styles.editorGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Primary model</span>
            <ModelSelect
              value={draft.primaryKey}
              models={compatibleModels}
              preserve={[feature.activeConfig.primary]}
              ariaLabel={`Primary model for ${feature.label}`}
              disabled={Boolean(action) || mutationBlocked || !feature.modelSwitchable}
              onChange={(value) => onDraft({
                primaryKey: value,
                ...(draft.fallbackKey === value ? { fallbackKey: NO_FALLBACK } : {}),
              })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fallback model</span>
            <ModelSelect
              value={draft.fallbackKey}
              models={compatibleModels.filter((model) => modelRefKey(model) !== draft.primaryKey)}
              preserve={feature.activeConfig.fallback ? [feature.activeConfig.fallback] : []}
              allowNone
              ariaLabel={`Fallback model for ${feature.label}`}
              disabled={Boolean(action) || mutationBlocked || !feature.fallbackAllowed}
              onChange={(value) => onDraft({ fallbackKey: value })}
            />
          </label>
          {singleProviderNote && (
            <p className={styles.providerNote}>{singleProviderNote}</p>
          )}
          <div className={styles.featureActions}>
            {dirty && <button type="button" className={styles.textButton} disabled={Boolean(action) || mutationBlocked} onClick={onReset}>Reset</button>}
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!dirty || Boolean(action) || mutationBlocked}
              onClick={pendingActivation ? onActivate : onTest}
              title={mutationBlocked ? 'Wait for the rollback to finish' : undefined}
            >
              {action ? <span className={styles.spinner} aria-hidden="true" /> : <CheckCircle2 size={14} />}
              {busyLabel ?? (pendingActivation ? 'Make it live' : reviewRequired ? 'Re-test my change' : 'Test my change')}
            </button>
          </div>
          {reviewRequired && (
            <div className={styles.draftConflict} role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span><strong>The live setup changed while you were editing.</strong> Your draft was preserved. Review the selected models and pricing, then test it against the new live version before activation.</span>
            </div>
          )}
          {pendingActivation && (
            <>
              <div className={styles.validationResult} role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>
                  {pendingActivation.probeCount > 0 ? (
                    <><strong>Test passed.</strong> The model answered correctly. This proves it responds, not how smart it is. Click “Make it live” to switch.</>
                  ) : (
                    <><strong>Ready.</strong> No test needed. This change turns the feature off. Click “Make it live” to switch.</>
                  )}
                  {pendingActivation.warnings.length > 0 && (
                    <span className={styles.validationWarnings}> Worth knowing first: {pendingActivation.warnings.join(' ')}</span>
                  )}
                </span>
              </div>
              <ActivationRecap feature={feature} draft={draft} models={models} />
            </>
          )}
          {modelSafetyMessage && (
            <div className={styles.modelSafetyNote} role="note">
              <AlertTriangle size={14} aria-hidden="true" />
              <span><strong>{modelSafetyMessage}</strong> Model switching and cross-model fallback stay locked until a full re-index workflow is available.</span>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.readOnlyConfig}>
          <StatusChip tone={feature.availability === 'available' ? 'info' : 'danger'}>{providerLabel(feature.activeConfig.primary.provider)}</StatusChip>
          <span>{displayModel(feature.activeConfig.primary)}</span>
          <span>· {feature.availability === 'available' ? 'managed by the app, shown here for visibility' : 'not currently running'}</span>
        </div>
      )}

      {error && <div className={`${styles.inlineMessage} ${styles.inlineError}`} role="alert"><AlertTriangle size={14} />{error}</div>}
      {!error && feature.activeConfig.source === 'fail_closed' && (
        <div className={`${styles.inlineMessage} ${styles.inlineError}`} role="alert">
          <AlertTriangle size={14} />AI configuration could not be verified, so this feature is safely off.
        </div>
      )}
      {!error && feature.activeConfig.source !== 'fail_closed' && dirty && !action && !pendingActivation && <div className={styles.inlineMessage}><Info size={13} />Nothing changes until the setup passes its provider test and you activate it.</div>}
      {action && <div className={styles.inlineMessage} role="status"><span className={styles.spinner} aria-hidden="true" />{busyLabel}</div>}
    </article>
  );
}

function ActivationRecap({
  feature,
  draft,
  models,
}: {
  feature: AiFeatureSummary;
  draft: AiFeatureDraft;
  models: AiModelCatalogEntry[];
}) {
  const knownRefs = [feature.activeConfig.primary, feature.activeConfig.fallback].filter(
    (ref): ref is AiModelRef => Boolean(ref),
  );
  const resolveModel = (key: string): {
    provider: string;
    modelId: string;
    displayName?: string;
    pricing: AiModelPricing | null;
  } | null => {
    const parsed = parseModelRefKey(key);
    if (!parsed) return null;
    return models.find((model) => modelRefKey(model) === key)
      ?? knownRefs.find((ref) => modelRefKey(ref) === key)
      ?? { ...parsed, pricing: null };
  };

  const primary = resolveModel(draft.primaryKey);
  const fallback = draft.fallbackKey === NO_FALLBACK ? null : resolveModel(draft.fallbackKey);
  const comparison = comparePrimaryPricing(primary?.pricing ?? null, feature.activeConfig.primary.pricing);
  const fallbackWarning = fallback?.pricing?.source === 'conservative-unverified'
    ? 'Fallback pricing is a conservative estimate.'
    : fallback && fallback.pricing === null
      ? 'Fallback pricing is not verified.'
      : null;

  return (
    <div className={styles.activationRecap} role="note" aria-label="Activation review">
      <div className={styles.activationRecapTitle}>Activation review · nothing changes until you activate</div>
      <div className={styles.activationRecapRows}>
        <div>
          <span>Selected primary</span>
          <strong>{primary ? `${providerLabel(primary.provider as AiProvider)} · ${displayModel(primary as AiModelRef)}` : 'Invalid selection'}</strong>
          <small>{pricingRateSummary(primary?.pricing ?? null)}</small>
        </div>
        <div>
          <span>Selected fallback</span>
          <strong>{fallback ? `${providerLabel(fallback.provider as AiProvider)} · ${displayModel(fallback as AiModelRef)}` : 'No fallback'}</strong>
          <small>{fallback ? pricingRateSummary(fallback.pricing) : 'No fallback cost'}</small>
        </div>
        <div>
          <span>Current primary for comparison</span>
          <strong>{providerLabel(feature.activeConfig.primary.provider)} · {displayModel(feature.activeConfig.primary)}</strong>
          <small>{pricingRateSummary(feature.activeConfig.primary.pricing)}</small>
        </div>
      </div>
      <div className={`${styles.activationCostNote} ${comparison.tone === 'warn' ? styles.activationCostWarn : styles.activationCostInfo}`}>
        {comparison.tone === 'warn' ? <AlertTriangle size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
        <span>{comparison.message}{fallbackWarning ? ` ${fallbackWarning}` : ''}</span>
      </div>
    </div>
  );
}

/**
 * Compact category-wide model controls, inline with All on / All off:
 * [Primary model ▾] [Fallback model ▾] [Test & apply my change]. The chosen
 * models are applied to every feature in the group that can run them (others
 * are skipped and reported); each application goes through the normal
 * test-then-activate cycle. Selections clear after applying.
 */
function GroupModelControls({
  models,
  disabled,
  onApply,
}: {
  models: AiModelCatalogEntry[];
  disabled: boolean;
  onApply: (primaryKey: string, fallbackKey: string) => void;
}) {
  const available = useMemo(() => models.filter((model) => model.available), [models]);
  const [primaryKey, setPrimaryKey] = useState('');
  const [fallbackKey, setFallbackKey] = useState(NO_FALLBACK);
  return (
    <>
      <ModelSelect
        value={primaryKey}
        models={available}
        preserve={[]}
        allowNone={false}
        placeholder="Primary model"
        compact
        ariaLabel="Category-wide primary model"
        disabled={disabled}
        onChange={(value) => {
          setPrimaryKey(value);
          if (value === fallbackKey) setFallbackKey(NO_FALLBACK);
        }}
      />
      <ModelSelect
        value={fallbackKey}
        models={available.filter((model) => modelRefKey(model) !== primaryKey)}
        preserve={[]}
        allowNone
        noneLabel="Fallback model"
        compact
        ariaLabel="Category-wide fallback model"
        disabled={disabled}
        onChange={setFallbackKey}
      />
      <button
        type="button"
        className={styles.textButton}
        disabled={disabled || !primaryKey}
        onClick={() => {
          onApply(primaryKey, fallbackKey);
          setPrimaryKey('');
          setFallbackKey(NO_FALLBACK);
        }}
      >
        Test & apply my change
      </button>
    </>
  );
}

function GlobalModelsDialog({
  dialogRef,
  primaryRef,
  models,
  features,
  plan,
  primaryKey,
  fallbackKey,
  onPrimary,
  onFallback,
  onCancel,
  onApply,
}: {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  primaryRef: React.RefObject<HTMLSelectElement | null>;
  models: AiModelCatalogEntry[];
  features: AiFeatureSummary[];
  plan: GlobalDraftPlan;
  primaryKey: string;
  fallbackKey: string;
  onPrimary: (value: string) => void;
  onFallback: (value: string) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const featureByKey = useMemo(
    () => new Map(features.map((feature) => [feature.key as string, feature])),
    [features],
  );
  const hasPair = Boolean(primaryKey && fallbackKey && primaryKey !== fallbackKey);
  return (
    <div className={styles.bulkDialogScrim} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div
        ref={dialogRef}
        className={styles.bulkDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-model-title"
        aria-describedby="global-model-description"
        tabIndex={-1}
      >
        <div className={styles.bulkDialogHeader}>
          <div>
            <span className={styles.eyebrow}>Whole Control Center</span>
            <h3 id="global-model-title" className={styles.bulkDialogTitle}>Set all models</h3>
          </div>
          <button type="button" className={styles.closeButton} onClick={onCancel} aria-label="Close Set all models dialog">
            <X size={17} />
          </button>
        </div>
        <p id="global-model-description" className={styles.bulkDialogCopy}>
          Choose a primary and fallback. Apply stages the pair only for features that can run both models; every changed feature must still be tested and made live individually.
        </p>

        <div className={styles.bulkModelFields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Primary model</span>
            <ModelSelect
              inputRef={primaryRef}
              value={primaryKey}
              models={models}
              preserve={[]}
              placeholder="Choose primary"
              ariaLabel="Whole Control Center primary model"
              disabled={false}
              onChange={onPrimary}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fallback model</span>
            <ModelSelect
              value={fallbackKey}
              models={models.filter((model) => modelRefKey(model) !== primaryKey)}
              preserve={[]}
              placeholder="Choose fallback"
              ariaLabel="Whole Control Center fallback model"
              disabled={!primaryKey}
              onChange={onFallback}
            />
          </label>
        </div>

        <div className={styles.bulkPlan} aria-live="polite">
          {!hasPair ? (
            <p>Select two different confirmed usable models to see the exact effect.</p>
          ) : (
            <>
              <div className={styles.bulkPlanCounts}>
                <StatusChip tone="info">{plan.changed.length} affected</StatusChip>
                <StatusChip>{plan.unchanged.length} already set</StatusChip>
                <StatusChip tone={plan.skipped.length > 0 ? 'warn' : 'good'}>{plan.skipped.length} skipped</StatusChip>
              </div>
              <div className={styles.bulkPlanLists}>
                <div>
                  <strong>Affected</strong>
                  {plan.changed.length > 0 ? (
                    <ul>{plan.changed.map((key) => <li key={key}>{featureByKey.get(key)?.label ?? key}</li>)}</ul>
                  ) : <p>No compatible draft would change.</p>}
                </div>
                <div>
                  <strong>Skipped</strong>
                  {plan.skipped.length > 0 ? (
                    <ul>{plan.skipped.map((item) => <li key={item.key}>{item.label} · {item.reason}</li>)}</ul>
                  ) : <p>Nothing skipped.</p>}
                </div>
              </div>
            </>
          )}
        </div>

        <div className={styles.bulkDialogActions}>
          <button type="button" className={styles.textButton} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!hasPair || plan.changed.length === 0}
            onClick={onApply}
          >
            <Check size={14} aria-hidden="true" /> Apply to drafts
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSelect({
  inputRef,
  value,
  models,
  preserve,
  allowNone = false,
  placeholder,
  noneLabel = 'No fallback',
  compact = false,
  ariaLabel,
  disabled,
  onChange,
}: {
  inputRef?: React.RefObject<HTMLSelectElement | null>;
  value: string;
  models: AiModelCatalogEntry[];
  preserve: AiModelRef[];
  allowNone?: boolean;
  placeholder?: string;
  noneLabel?: string;
  compact?: boolean;
  ariaLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  // Memoized: this select renders once per feature card, and rebuilding +
  // re-sorting the whole catalog on every parent keystroke makes typing lag.
  const grouped = useMemo(() => {
    const options = [...models];
    for (const ref of preserve) {
      if (!isHostedProvider(ref.provider)) continue;
      if (options.some((model) => modelRefKey(model) === modelRefKey(ref))) continue;
      options.push({
        provider: ref.provider,
        modelId: ref.modelId,
        displayName: ref.displayName ?? ref.modelId,
        status: 'unavailable',
        available: false,
        capabilities: ref.capabilities ?? [],
        maxInputTokens: null,
        maxOutputTokens: null,
        releasedAt: null,
        pricing: ref.pricing,
        source: 'registry',
        firstSeenAt: '',
        lastSeenAt: '',
        updatedAt: '',
      });
    }
    return AI_DISCOVERABLE_PROVIDERS.map((provider) => ({
      provider,
      models: options
        .filter((model) => model.provider === provider)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    })).filter((group) => group.models.length > 0);
  }, [models, preserve]);

  return (
    <select
      ref={inputRef}
      className={compact ? styles.selectCompact : styles.select}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {placeholder !== undefined && <option value="" disabled>{placeholder}</option>}
      {allowNone && <option value={NO_FALLBACK}>{noneLabel}</option>}
      {grouped.map((group) => (
        <optgroup key={group.provider} label={providerLabel(group.provider)}>
          {group.models.map((model) => (
            <option key={modelRefKey(model)} value={modelRefKey(model)} disabled={!model.available}>
              {model.displayName}{model.available ? '' : ' · current/legacy, choose another model'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ModelsPanel({
  models,
  selectableModels,
  features,
  query,
  provider,
  providers,
  refreshing,
  onQuery,
  onProvider,
  onRefresh,
}: {
  models: AiModelCatalogEntry[];
  selectableModels: AiModelCatalogEntry[];
  features: AiFeatureSummary[];
  query: string;
  provider: ProviderFilter;
  providers: AiHostedProvider[];
  refreshing: boolean;
  onQuery: (value: string) => void;
  onProvider: (value: ProviderFilter) => void;
  onRefresh: () => void;
}) {
  const usageByModel = useMemo(() => {
    const usage = new Map<string, string[]>();
    features.forEach((feature) => {
      [feature.activeConfig.primary, feature.activeConfig.fallback].forEach((ref) => {
        if (!ref || !isHostedProvider(ref.provider)) return;
        const key = modelRefKey(ref);
        const labels = usage.get(key) ?? [];
        if (!labels.includes(feature.label)) labels.push(feature.label);
        usage.set(key, labels);
      });
    });
    return usage;
  }, [features]);
  const selectableKeys = useMemo(
    () => new Set(selectableModels.map(modelRefKey)),
    [selectableModels],
  );
  const displayed = useMemo(
    () => modelsForControlCenterPresentation(models, selectableModels, features),
    [features, models, selectableModels],
  );
  const needle = normalizeAiSearchText(query);
  const visible = displayed.filter(({ model }) => (
    (provider === 'all' || model.provider === provider)
    && (!needle
      || normalizeAiSearchText(model.displayName).includes(needle)
      || normalizeAiSearchText(model.modelId).includes(needle)
      || normalizeAiSearchText(model.provider).includes(needle))
  ));
  const groups = providers.map((item) => ({
    provider: item,
    models: visible.filter(({ model }) => model.provider === item),
  })).filter((group) => group.models.length > 0);

  return (
    <section id="ai-control-panel-models" className={styles.panel} role="tabpanel" aria-labelledby="ai-control-tab-models">
      <div className={styles.toolbar}>
        <label className={styles.searchWrap}>
          <span className={styles.srOnly}>Search model catalog</span>
          <Search className={styles.searchIcon} size={15} aria-hidden="true" />
          <input type="search" className={styles.searchInput} value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Find a model or provider…" />
        </label>
        <button type="button" className={styles.secondaryButton} disabled={refreshing} onClick={onRefresh}>
          {refreshing ? <span className={styles.spinner} aria-hidden="true" /> : <RefreshCw size={14} />}
          {refreshing ? 'Checking…' : provider === 'all' ? 'Check for new models' : `Check ${providerLabel(provider)} for new models`}
        </button>
      </div>

      <div className={styles.modelToolbar}>
        <div className={styles.providerButtons} aria-label="Filter models by provider">
          <button type="button" className={`${styles.providerButton} ${provider === 'all' ? styles.providerButtonActive : ''}`} aria-pressed={provider === 'all'} onClick={() => onProvider('all')}>All</button>
          {providers.map((item) => (
            <button key={item} type="button" className={`${styles.providerButton} ${provider === item ? styles.providerButtonActive : ''}`} aria-pressed={provider === item} onClick={() => onProvider(item)}>{providerLabel(item)}</button>
          ))}
        </div>
        <span className={styles.summaryText}>{visible.length} main or current model{visible.length === 1 ? '' : 's'} · refresh never switches anything</span>
      </div>

      {groups.length === 0 ? (
        <div className={styles.emptyState}><Sparkles size={22} />No models match this filter.</div>
      ) : (
        <div className={styles.modelGroups}>
          {groups.map((group) => (
            <section key={group.provider}>
              <div className={styles.groupHeader}>
                <h3 className={styles.groupTitle}>{providerLabel(group.provider)}</h3>
                <span className={styles.groupCount}>{group.models.length}</span>
              </div>
              <div className={styles.modelGrid}>
                {group.models.map(({ model, currentOnly }) => (
                  <ModelCard
                    key={modelRefKey(model)}
                    model={model}
                    usageLabels={usageByModel.get(modelRefKey(model)) ?? []}
                    currentOnly={currentOnly || !selectableKeys.has(modelRefKey(model))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCard({
  model,
  usageLabels,
  currentOnly,
}: {
  model: AiModelCatalogEntry;
  usageLabels: string[];
  currentOnly: boolean;
}) {
  const rates = essentialAiModelRates(model.pricing);
  const inputPrice = rates.inputUsdPerMillionTokens !== null
    ? `${formatUsd(rates.inputUsdPerMillionTokens)} / 1M`
    : rates.audioUsdPerMinute !== null
      ? `${formatUsd(rates.audioUsdPerMinute)} / min audio`
      : '—';
  const outputPrice = rates.outputUsdPerMillionTokens !== null
    ? `${formatUsd(rates.outputUsdPerMillionTokens)} / 1M`
    : rates.audioUsdPerMinute !== null
      ? 'Included'
      : '—';
  return (
    <article className={styles.modelCard} data-selectable={currentOnly ? 'false' : 'true'}>
      <div className={styles.modelCardTitle}>
        <div className={styles.modelName}>{model.displayName}</div>
        <span className={styles.modelProvider}>{providerLabel(model.provider)}</span>
      </div>
      <div className={styles.modelEssentialPrice}>
        <span>Input<strong>{inputPrice}</strong></span>
        <span>Output<strong>{outputPrice}</strong></span>
      </div>
      {currentOnly && <StatusChip tone="warn">Current · legacy only</StatusChip>}
      {currentOnly && <span className={styles.srOnly}>Not selectable for a new configuration.</span>}
      {currentOnly && usageLabels.length > 0 && (
        <span className={styles.modelCurrentUse} title={usageLabels.join(', ')}>
          Used by {usageLabels.length} feature{usageLabels.length === 1 ? '' : 's'}
        </span>
      )}
    </article>
  );
}

function HistoryPanel({
  history,
  features,
  confirmingId,
  rollingBackId,
  rollbackWarnings,
  featureMutationInFlight,
  onConfirm,
  onRollback,
}: {
  history: AiConfigVersion[];
  features: AiFeatureSummary[];
  confirmingId: string | null;
  rollingBackId: string | null;
  rollbackWarnings: Record<string, string[] | undefined>;
  featureMutationInFlight: boolean;
  onConfirm: (id: string | null) => void;
  onRollback: (config: AiConfigVersion, acknowledgeWarnings?: boolean) => void;
}) {
  const featureByKey = new Map(features.map((feature) => [feature.key, feature]));
  return (
    <section id="ai-control-panel-history" className={styles.panel} role="tabpanel" aria-labelledby="ai-control-tab-history">
      <div className={styles.toolbar}>
        <div>
          <h3 className={styles.groupTitle}>Latest immutable change history</h3>
          <div className={styles.featureDescription}>Latest drafts, validation states, activations, and previous live versions. Rollback is manual.</div>
        </div>
        <span className={styles.summaryText}>
          {history.length === 500 ? 'Latest 500 versions' : `${history.length} latest ${history.length === 1 ? 'version' : 'versions'}`}
        </span>
      </div>

      {history.length === 0 ? (
        <div className={styles.emptyState}><History size={22} />No AI settings have been changed yet. Defaults are still active.</div>
      ) : (
        <div className={styles.historyList}>
          {history.map((config) => {
            const feature = featureByKey.get(config.featureKey);
            const canRollback = !config.isActive && config.activatedAt !== null && config.validationStatus === 'passed';
            const confirming = confirmingId === config.id;
            const reportMessages = validationMessages(config.validationReport);
            const freshRollbackWarnings = rollbackWarnings[config.id] ?? [];
            return (
              <article key={config.id} className={styles.historyRow}>
                <div className={styles.historyFeature}>
                  <div className={styles.historyFeatureName}>{feature?.label ?? config.featureKey}</div>
                  <div className={styles.historyVersion}>v{config.version} · {formatAiDate(config.createdAt)}</div>
                  <div className={styles.historyMeta}>
                    {config.isActive ? <StatusChip tone="good">Current</StatusChip>
                      : config.validationStatus === 'failed' ? <StatusChip tone="danger">Test failed</StatusChip>
                        : config.activatedAt ? <StatusChip tone="info">Previous</StatusChip>
                          : <StatusChip tone="warn">Draft</StatusChip>}
                    <StatusChip tone={config.enabled ? 'good' : 'danger'}>{config.enabled ? 'On' : 'Off'}</StatusChip>
                  </div>
                </div>
                <div className={styles.historyModels}>
                  <div>Primary · {displayModel(config.primary)}</div>
                  <div>Fallback · {config.fallback ? displayModel(config.fallback) : 'none'}</div>
                </div>
                <div className={styles.historyReason}>
                  <div>{config.changeReason ?? 'No change note supplied.'}</div>
                  {reportMessages.errors.map((message) => (
                    <div key={`error-${message}`} className={styles.historyValidationError}>Validation error · {message}</div>
                  ))}
                  {reportMessages.warnings.map((message) => (
                    <div key={`warning-${message}`} className={styles.historyValidationWarning}>Validation warning · {message}</div>
                  ))}
                  <div className={styles.historyAudit}>
                    <div>
                      <span>Created</span>
                      <time dateTime={config.createdAt}>{formatAiDate(config.createdAt)}</time>
                      <code title={config.createdByEmail ?? config.createdBy ?? 'system / unknown'}>{config.createdByEmail ?? config.createdBy ?? 'system / unknown'}</code>
                    </div>
                    {(config.validatedAt || config.validatedBy) && (
                      <div>
                        <span>Validated</span>
                        <time dateTime={config.validatedAt ?? undefined}>{formatAiDate(config.validatedAt)}</time>
                        <code title={config.validatedByEmail ?? config.validatedBy ?? 'system / unknown'}>{config.validatedByEmail ?? config.validatedBy ?? 'system / unknown'}</code>
                      </div>
                    )}
                    {(config.activatedAt || config.activatedBy) && (
                      <div>
                        <span>Activated</span>
                        <time dateTime={config.activatedAt ?? undefined}>{formatAiDate(config.activatedAt)}</time>
                        <code title={config.activatedByEmail ?? config.activatedBy ?? 'system / unknown'}>{config.activatedByEmail ?? config.activatedBy ?? 'system / unknown'}</code>
                      </div>
                    )}
                  </div>
                </div>
                <div className={styles.historyActions}>
                  {canRollback && (
                    <button type="button" className={styles.secondaryButton} disabled={Boolean(rollingBackId) || featureMutationInFlight} onClick={() => onConfirm(config.id)}>
                      <RotateCcw size={13} /> Roll back
                    </button>
                  )}
                </div>
                {confirming && (
                  <div className={styles.confirmBox} role="alert">
                    <AlertTriangle size={17} />
                    <span className={styles.confirmCopy}>Make version {config.version} live again for {feature?.label ?? config.featureKey}? The current version stays in history.</span>
                    {freshRollbackWarnings.length > 0 && (
                      <div className={styles.rollbackWarningReview}>
                        <strong>Fresh validation warnings require explicit acknowledgement:</strong>
                        <ul>{freshRollbackWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                      </div>
                    )}
                    <button type="button" className={styles.textButton} disabled={Boolean(rollingBackId)} onClick={() => onConfirm(null)}>Cancel</button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      disabled={Boolean(rollingBackId) || featureMutationInFlight}
                      onClick={() => onRollback(config, freshRollbackWarnings.length > 0)}
                    >
                      {rollingBackId === config.id ? <span className={styles.spinner} aria-hidden="true" /> : <RotateCcw size={13} />}
                      {rollingBackId === config.id
                        ? 'Validating rollback…'
                        : freshRollbackWarnings.length > 0
                          ? 'Acknowledge warnings & roll back'
                          : 'Confirm rollback'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StatusChip({ children, tone }: { children: React.ReactNode; tone?: 'good' | 'info' | 'warn' | 'danger' }) {
  const toneClass = tone === 'good' ? styles.chipGood
    : tone === 'info' ? styles.chipInfo
      : tone === 'warn' ? styles.chipWarn
        : tone === 'danger' ? styles.chipDanger
          : '';
  return <span className={`${styles.statusChip} ${toneClass}`}>{children}</span>;
}

function LoadingState({ label }: { label: string }) {
  return <div className={styles.loadingState} role="status"><span className={styles.spinner} aria-hidden="true" />{label}</div>;
}

function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className={styles.toastViewport} aria-live="polite" aria-atomic="false">
      {items.map((item) => {
        const icon = item.kind === 'success' ? <Check size={16} color="#8ed4ad" />
          : item.kind === 'error' ? <XCircle size={16} color="#f3a68c" />
            : <Info size={16} color="#8cc8d8" />;
        const kindClass = item.kind === 'success' ? styles.toastSuccess
          : item.kind === 'error' ? styles.toastError
            : styles.toastInfo;
        return (
          <ToastCard
            key={item.id}
            item={item}
            icon={icon}
            kindClass={kindClass}
            onDismiss={() => onDismiss(item.id)}
          />
        );
      })}
    </div>
  );
}

function ToastCard({
  item,
  icon,
  kindClass,
  onDismiss,
}: {
  item: ToastItem;
  icon: React.ReactNode;
  kindClass: string;
  onDismiss: () => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(4600);
  const startedAtRef = useRef(0);

  const pause = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
  }, []);

  const resume = useCallback(() => {
    if (item.kind === 'error' || timerRef.current || remainingRef.current <= 0) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, remainingRef.current);
  }, [item.kind, onDismiss]);

  useEffect(() => {
    resume();
    return pause;
  }, [pause, resume]);

  return (
    <div
      className={`${styles.toast} ${kindClass}`}
      role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
      }}
    >
      {icon}
      <span className={styles.toastMessage}>{item.message}</span>
      <button
        type="button"
        className={styles.toastDismiss}
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}
