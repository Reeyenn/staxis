// ─── AgentConfig validation + migration ─────────────────────────────────────
// validateAgentConfig — STRICT, for the API write path (POST/PATCH).
// migrateConfig      — LENIENT + never-throws, for the engine read path:
//                      normalizes any stored config to the current version and
//                      drops unknown action keys rather than failing a run.
//
// Valid action/scope keys are derived from the registries at runtime (no
// parallel hardcoded list), mirroring how tools.ts derives its destructive set.

import '@/lib/agents/actions';   // ensure the action registry is populated
import '@/lib/agents/scopes';    // ensure the scope registry is populated
import { listActionMeta } from '@/lib/agents/actions/registry';
import { listScopeMeta } from '@/lib/agents/scopes/registry';
import {
  AGENT_CONFIG_VERSION,
  type AgentConfig,
  type AgentApprovalRules,
  type ActionApprovalMode,
  type ScopeKey,
  type TriggerConfig,
} from '@/lib/agents/types';

const APPROVAL_MODES: readonly ActionApprovalMode[] = ['suggest', 'approve_first', 'auto'];
const HHMM_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

function knownActionKeys(): Set<string> {
  return new Set(listActionMeta().map((m) => m.key));
}
function knownScopeKeys(): Set<string> {
  return new Set(listScopeMeta().map((m) => m.key));
}

// ── normalizers (lenient) ───────────────────────────────────────────────────

function normalizeTrigger(raw: unknown): TriggerConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.type === 'event' && typeof o.eventName === 'string' && o.eventName.length > 0) {
    return {
      type: 'event',
      eventName: o.eventName,
      filter: o.filter && typeof o.filter === 'object' ? (o.filter as Record<string, unknown>) : undefined,
    };
  }
  if (o.type === 'schedule' && typeof o.atLocalTime === 'string' && HHMM_RX.test(o.atLocalTime)) {
    const days = Array.isArray(o.daysOfWeek)
      ? o.daysOfWeek.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
      : undefined;
    return { type: 'schedule', atLocalTime: o.atLocalTime, daysOfWeek: days };
  }
  // Malformed → a schedule trigger that NEVER fires (empty daysOfWeek). Safe default.
  return { type: 'schedule', atLocalTime: '00:00', daysOfWeek: [] };
}

function normalizeScopes(raw: unknown): ScopeKey[] {
  const known = knownScopeKeys();
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is ScopeKey => typeof s === 'string' && known.has(s));
}

function normalizeActions(raw: unknown): string[] {
  const known = knownActionKeys();
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === 'string' && known.has(a));
}

function normalizeApproval(raw: unknown, actions: string[]): AgentApprovalRules {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const defaultMode: ActionApprovalMode =
    typeof o.defaultMode === 'string' && APPROVAL_MODES.includes(o.defaultMode as ActionApprovalMode)
      ? (o.defaultMode as ActionApprovalMode)
      : 'suggest';
  const perAction: Record<string, ActionApprovalMode> = {};
  const rawPer = (o.perAction && typeof o.perAction === 'object' ? o.perAction : {}) as Record<string, unknown>;
  for (const k of actions) {
    const m = rawPer[k];
    if (typeof m === 'string' && APPROVAL_MODES.includes(m as ActionApprovalMode)) {
      perAction[k] = m as ActionApprovalMode;
    }
  }
  return {
    moneyOrGuestRequiresApproval: o.moneyOrGuestRequiresApproval !== false, // default true
    defaultMode,
    perAction,
  };
}

/** Normalize any stored config to the current version. Never throws. */
export function migrateConfig(raw: unknown): AgentConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const actions = normalizeActions(o.actions);
  return {
    version: AGENT_CONFIG_VERSION,
    trigger: normalizeTrigger(o.trigger),
    scopes: normalizeScopes(o.scopes),
    actions,
    approvalRules: normalizeApproval(o.approvalRules, actions),
    templateParams:
      o.templateParams && typeof o.templateParams === 'object'
        ? (o.templateParams as Record<string, unknown>)
        : undefined,
  };
}

// ── strict validation (API write path) ──────────────────────────────────────

export function validateAgentConfig(raw: unknown): { error?: string; value?: AgentConfig } {
  if (!raw || typeof raw !== 'object') return { error: 'config must be an object' };
  const o = raw as Record<string, unknown>;

  // trigger
  const t = (o.trigger && typeof o.trigger === 'object' ? o.trigger : null) as Record<string, unknown> | null;
  if (!t) return { error: 'config.trigger is required' };
  if (t.type === 'schedule') {
    if (typeof t.atLocalTime !== 'string' || !HHMM_RX.test(t.atLocalTime)) {
      return { error: 'schedule trigger needs atLocalTime "HH:MM"' };
    }
    if (t.daysOfWeek !== undefined) {
      if (!Array.isArray(t.daysOfWeek) || t.daysOfWeek.some((d) => typeof d !== 'number' || d < 0 || d > 6)) {
        return { error: 'daysOfWeek must be an array of 0-6' };
      }
    }
  } else if (t.type === 'event') {
    if (typeof t.eventName !== 'string' || t.eventName.length === 0) {
      return { error: 'event trigger needs eventName' };
    }
  } else {
    return { error: 'trigger.type must be "schedule" or "event"' };
  }

  // scopes
  const knownScopes = knownScopeKeys();
  if (!Array.isArray(o.scopes)) return { error: 'config.scopes must be an array' };
  for (const s of o.scopes) {
    if (typeof s !== 'string' || !knownScopes.has(s)) return { error: `unknown scope: ${String(s)}` };
  }

  // actions
  const knownActions = knownActionKeys();
  if (!Array.isArray(o.actions)) return { error: 'config.actions must be an array' };
  for (const a of o.actions) {
    if (typeof a !== 'string' || !knownActions.has(a)) return { error: `unknown action: ${String(a)}` };
  }

  // approvalRules (lenient-normalize; the strict bits above already passed)
  const value = migrateConfig({ ...o, version: AGENT_CONFIG_VERSION });
  return { value };
}
