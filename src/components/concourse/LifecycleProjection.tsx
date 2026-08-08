'use client';

import React from 'react';
import type {
  LifecycleActionProjection,
  LifecycleOutcome,
  LifecycleProjection as LifecycleProjectionItem,
  LifecycleResponse as LifecycleProjectionPayload,
  LifecycleState as LifecycleProjectionState,
} from '@/lib/staxis/lifecycle';

type LifecycleAction = LifecycleActionProjection;
type LifecycleFreshness = LifecycleProjectionItem['freshness'];
type LifecycleCompleteness = LifecycleProjectionItem['completeness'];
export type { LifecycleProjectionPayload, LifecycleProjectionItem, LifecycleProjectionState };

const STATE_ORDER: readonly LifecycleProjectionState[] = [
  'observed',
  'proposed',
  'approved',
  'executed',
  'outcome_verified',
];

const STATE_LABEL: Record<LifecycleProjectionState, string> = {
  observed: 'Observed',
  proposed: 'Proposed',
  approved: 'Approved',
  executed: 'Executed',
  outcome_verified: 'Outcome verified',
  not_observable: 'Not observable',
  unverifiable: 'Unverifiable',
};

const FRESHNESS_LABEL: Record<LifecycleFreshness['status'], string> = {
  fresh: 'Fresh source',
  stale: 'Source is stale',
  unknown: 'Freshness unknown',
};

const COMPLETENESS_LABEL: Record<LifecycleCompleteness['status'], string> = {
  complete: 'Complete record',
  partial: 'Partial record',
  unknown: 'Completeness unknown',
};

const OUTCOME_LABEL: Record<LifecycleAction['outcome']['state'], string> = {
  pending: 'Pending',
  verified: 'Verified',
  not_observable: 'Not observable',
  unverifiable: 'Unverifiable',
  reverted: 'Reverted',
};

/** Keep server copy intact while making malformed dates visibly unknown. */
export function lifecycleTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function lifecycleStateLabel(state: LifecycleProjectionState): string {
  return STATE_LABEL[state];
}

export function lifecycleSourceLabel(sourceFactIds: readonly string[]): string {
  const count = sourceFactIds.length;
  return count === 1 ? '1 source fact recorded' : `${count} source facts recorded`;
}

export function lifecycleSourceSummary(
  sources: readonly LifecycleProjectionItem['sources'][number][],
  sourceFactIds: readonly string[],
): string {
  const labels = sources
    .map((source) => [source.label?.trim(), source.kind?.trim(), source.reference?.trim()].filter(Boolean).join(' · '))
    .filter(Boolean);
  const receiptCount = sources.filter((source) => source.receiptId || source.receiptHash).length;
  const receiptLine = receiptCount === 0
    ? null
    : receiptCount === 1 ? '1 source receipt recorded' : `${receiptCount} source receipts recorded`;
  return [
    labels.length > 0 ? labels.join(', ') : null,
    lifecycleSourceLabel(sourceFactIds),
    receiptLine,
  ].filter(Boolean).join(' · ');
}

export function lifecycleApprovalLabel(
  approval: LifecycleAction['approval'] | null | undefined,
): string {
  if (!approval) return 'Approval state unavailable';
  const state = approval.state.trim();
  if (!state) return 'Approval required; state unavailable';
  if (state === 'not_required') return 'Approval not required';
  return `Approval ${state.replace(/[_-]+/g, ' ')}`;
}

export function lifecycleOutcomeLabel(
  outcome: LifecycleAction['outcome'] | LifecycleOutcome | null | undefined,
): string {
  if (!outcome) return 'Outcome verification unavailable';
  const label = OUTCOME_LABEL[outcome.state] ?? 'Unknown';
  return outcome.basis?.trim() ? `${label} — ${outcome.basis.trim()}` : label;
}

function lifecycleOutcomeProofLabel(item: LifecycleProjectionItem): string | null {
  if (item.outcomeEvidenceId && item.outcome?.sourceFactId) return 'Outcome evidence and source fact recorded';
  if (item.outcomeEvidenceId) return 'Outcome evidence recorded';
  if (item.outcome?.sourceFactId) return 'Source fact recorded';
  return null;
}

function isTerminalState(state: LifecycleProjectionState): boolean {
  return state === 'not_observable' || state === 'unverifiable';
}

export function lifecycleStateProgress(state: LifecycleProjectionState): number {
  // These are post-execution outcome terminals. Keep the execution history
  // visible, then append the terminal truth rather than erasing what happened.
  if (isTerminalState(state)) return STATE_ORDER.indexOf('executed');
  const index = STATE_ORDER.indexOf(state);
  return index < 0 ? 0 : index;
}

function itemHasExecutionReceipt(item: LifecycleProjectionItem): boolean {
  return typeof item.executionReceiptId === 'string' && item.executionReceiptId.trim().length > 0;
}

function lifecycleReceiptLabel(item: LifecycleProjectionItem): string {
  if (itemHasExecutionReceipt(item)) return 'Execution receipt recorded';
  if (item.state === 'executed' || item.state === 'outcome_verified' || isTerminalState(item.state)) {
    return 'Execution receipt not recorded';
  }
  return 'No execution receipt yet';
}

function itemOwnerLine(item: LifecycleProjectionItem): string | null {
  if (!item.domainWorkItem) return null;
  const owner = item.domainWorkItem.owner.label?.trim();
  const role = item.domainWorkItem.owner.role?.trim();
  const ownerLabel = owner && role
    ? `${owner} (${role})`
    : owner
      ? owner
      : role
        ? `role ${role}`
        : item.domainWorkItem.owner.kind === 'unassigned'
          ? 'unassigned'
          : item.domainWorkItem.owner.kind === 'unknown'
            ? 'unknown'
            : item.domainWorkItem.owner.kind;
  return `Owner at last verified update: ${ownerLabel} · ${lifecycleTime(item.domainWorkItem.observedAt) ?? item.domainWorkItem.observedAt}`;
}

function authorityLine(item: LifecycleProjectionItem): string {
  const owner = item.authority.owner;
  const label = owner.label?.trim();
  const role = owner.role?.trim();
  if (label && role) return `Authority: ${label} (${role})`;
  if (label) return `Authority: ${label}`;
  if (role) return `Authority role: ${role}`;
  if (owner.kind === 'unassigned') return 'Authority: unassigned';
  if (owner.kind === 'unknown') return 'Authority: unknown';
  return `Authority: ${owner.kind}`;
}

function LifecycleStateRail({ state }: { state: LifecycleProjectionState }) {
  const terminal = isTerminalState(state);
  const progress = lifecycleStateProgress(state);
  return (
    <ol className={`fx-life-states${terminal ? ' fx-life-terminal' : ''}`} aria-label="Lifecycle state">
      {STATE_ORDER.map((step, index) => (
        <li
          key={step}
          className={index <= progress ? 'fx-life-state fx-life-state-on' : 'fx-life-state'}
          aria-current={!terminal && step === state ? 'step' : undefined}
        >
          <span className="fx-life-dot" aria-hidden="true" />
          <span>{STATE_LABEL[step]}</span>
        </li>
      ))}
      {terminal && (
        <li className="fx-life-state fx-life-state-terminal" aria-current="step">
          <span className="fx-life-dot" aria-hidden="true" />
          <span>{STATE_LABEL[state]}</span>
        </li>
      )}
    </ol>
  );
}

function LifecycleItem({ item }: { item: LifecycleProjectionItem }) {
  const action = item.action ?? null;
  const freshness = item.freshness ?? { status: 'unknown', maxAgeSeconds: null };
  const completeness = item.completeness ?? { status: 'unknown' };
  const itemOwner = itemOwnerLine(item);
  const domain = item.domainWorkItem;
  const effectiveAt = lifecycleTime(item.effectiveAt);
  const asOf = lifecycleTime(item.asOf);
  const observedAt = lifecycleTime(item.observedAt);
  const recordedAt = lifecycleTime(item.recordedAt);
  const outcomeEvidenceAt = lifecycleTime(action?.outcome?.observedAt ?? item.outcome?.observedAt);
  const outcomeProofLabel = lifecycleOutcomeProofLabel(item);
  return (
    <article className="fx-life-item" data-lifecycle-state={item.state}>
      <div className="fx-life-item-head">
        <div>
          <div className="fx-life-eyebrow">{STATE_LABEL[item.state]}</div>
          <h3 className="fx-life-title">{item.title}</h3>
        </div>
        <span className="fx-life-entity">{item.entity.label ?? item.entity.kind}</span>
      </div>
      <p className="fx-life-summary">{item.summary}</p>

      <LifecycleStateRail state={item.state} />

      <div className="fx-life-facts" aria-label="Lifecycle evidence">
        <div className="fx-life-fact">
          <span className="fx-life-key">Source</span>
          <span>{lifecycleSourceSummary(item.sources, item.sourceFactIds)}</span>
        </div>
        <div className="fx-life-fact">
          <span className="fx-life-key">Freshness</span>
          <span>{FRESHNESS_LABEL[freshness.status]}</span>
        </div>
        <div className="fx-life-fact">
          <span className="fx-life-key">Completeness</span>
          <span>
            {COMPLETENESS_LABEL[completeness.status]}
            {completeness.reason?.trim() ? ` — ${completeness.reason.trim()}` : ''}
          </span>
        </div>
        {effectiveAt && (
          <div className="fx-life-fact">
            <span className="fx-life-key">Effective</span>
            <span>{effectiveAt}</span>
          </div>
        )}
        {asOf && (
          <div className="fx-life-fact">
            <span className="fx-life-key">As of</span>
            <span>{asOf}</span>
          </div>
        )}
        {observedAt && (
          <div className="fx-life-fact">
            <span className="fx-life-key">Observed</span>
            <span>{observedAt}</span>
          </div>
        )}
        {recordedAt && (
          <div className="fx-life-fact">
            <span className="fx-life-key">Recorded at</span>
            <span>{recordedAt}</span>
          </div>
        )}
      </div>

      {action && (
        <div className="fx-life-action" aria-label="In-app action details">
          <div className="fx-life-action-line">
            <span className="fx-life-key">Effect</span>
            <span>{action.effect.statement}</span>
          </div>
          <div className="fx-life-action-line">
            <span className="fx-life-key">Boundary</span>
            <span>
              {action.effect.boundary === 'in_app_only'
                ? 'In-app only'
                : action.effect.boundary}
            </span>
          </div>
          <div className="fx-life-action-line">
            <span className="fx-life-key">Limit</span>
            <span>{action.effect.limit}</span>
          </div>
          <div className="fx-life-action-line">
            <span className="fx-life-key">Approval</span>
            <span>{lifecycleApprovalLabel(action.approval)}</span>
          </div>
          <div className="fx-life-action-line">
            <span className="fx-life-key">Receipt</span>
            <span>{lifecycleReceiptLabel(item)}</span>
          </div>
          <div className="fx-life-action-line">
            <span className="fx-life-key">Outcome</span>
            <span>
              {lifecycleOutcomeLabel(action.outcome)}
              {outcomeEvidenceAt ? ` · ${outcomeEvidenceAt}` : ''}
              {outcomeProofLabel ? ` · ${outcomeProofLabel}` : ''}
            </span>
          </div>
        </div>
      )}

      {!action && item.outcome && (
        <div className="fx-life-action" aria-label="Outcome verification">
          <div className="fx-life-action-line">
            <span className="fx-life-key">Outcome</span>
            <span>
              {lifecycleOutcomeLabel(item.outcome)}
              {outcomeEvidenceAt ? ` · ${outcomeEvidenceAt}` : ''}
              {outcomeProofLabel ? ` · ${outcomeProofLabel}` : ''}
            </span>
          </div>
        </div>
      )}

      {(itemOwner || domain) && (
        <div className="fx-life-owner">
          {itemOwner && <span>{itemOwner}</span>}
          {domain && (
            <span>
              <span className="fx-life-key">Domain</span>{' '}
              {domain.href ? (
                <a className="fx-life-link" href={domain.href}>
                  {domain.label ?? domain.kind}
                </a>
              ) : (
                `${domain.label ?? domain.kind} reference recorded`
              )}
            </span>
          )}
        </div>
      )}

      {item.reason?.trim() && <p className="fx-life-note">{item.reason.trim()}</p>}

      <div className="fx-life-foot">
        <span>{authorityLine(item)}</span>
        {recordedAt && <span>Recorded {recordedAt}</span>}
      </div>
    </article>
  );
}

export function LifecycleProjection({
  payload,
  loading = false,
  error = null,
}: {
  payload: LifecycleProjectionPayload | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (loading && !payload) {
    return (
      <section className="fx-life-panel" aria-labelledby="fx-life-heading" aria-busy="true">
        <div className="fx-ptop">
          <div>
            <h2 id="fx-life-heading" className="fx-pt">Lifecycle</h2>
            <p className="fx-ps">Reading what Staxis can currently prove.</p>
          </div>
        </div>
        <p className="fx-life-status" role="status">One moment…</p>
      </section>
    );
  }

  if (error && !payload) {
    return (
      <section className="fx-life-panel" aria-labelledby="fx-life-heading">
        <div className="fx-ptop">
          <div>
            <h2 id="fx-life-heading" className="fx-pt">Lifecycle</h2>
            <p className="fx-ps">Reading what Staxis can currently prove.</p>
          </div>
        </div>
        <p className="fx-life-error" role="status">
          Staxis could not check lifecycle just now. This is not a complete view.
        </p>
      </section>
    );
  }

  if (!payload) return null;

  const generatedAt = lifecycleTime(payload.generatedAt);
  return (
    <section className="fx-life-panel" aria-labelledby="fx-life-heading">
      <div className="fx-ptop">
        <div>
          <h2 id="fx-life-heading" className="fx-pt">Lifecycle</h2>
          <p className="fx-ps">What Staxis can currently prove, without implying more.</p>
        </div>
        <span className="fx-count">{payload.items.length}</span>
      </div>

      <div className="fx-life-provenance">
        <span>{generatedAt ? `Projection read ${generatedAt}` : 'Projection time unavailable'}</span>
      </div>

      {error && (
        <p className="fx-life-stale" role="status">
          This is the last available projection. A refresh did not complete.
        </p>
      )}

      {payload.items.length === 0 ? (
        <p className="fx-life-empty" role="status">
          No lifecycle records are available for this hotel. That does not mean every source is clear.
        </p>
      ) : (
        <div className="fx-life-items">
          {payload.items.map((item) => <LifecycleItem key={item.id} item={item} />)}
        </div>
      )}
    </section>
  );
}
