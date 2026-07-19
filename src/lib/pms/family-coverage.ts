import {
  LEARNABLE_ACTION_KEYS,
  parseKnowledgeCoverage,
} from '@/lib/pms/recipe-coverage';

export type FeedState = 'live' | 'learning' | 'unavailable';

export interface PerFeed {
  key: string;
  label: string;
  state: FeedState;
}

interface FeedGapsShape {
  missingRequired?: Array<{ target?: unknown }>;
  missingBusinessCritical?: unknown[];
}

function extractGappedTargets(knowledge: unknown): Set<string> {
  const gaps = (knowledge && typeof knowledge === 'object'
    ? (knowledge as { feedGaps?: FeedGapsShape }).feedGaps
    : undefined) ?? null;
  return new Set<string>([
    ...((gaps?.missingRequired ?? [])
      .map((gap) => (typeof gap?.target === 'string' ? gap.target : ''))
      .filter(Boolean)),
    ...((gaps?.missingBusinessCritical ?? []).filter(
      (target): target is string => typeof target === 'string',
    )),
  ]);
}

/** Compute actions-aware coverage for one PMS family's knowledge envelope. */
export function computeFamilyCoverage(knowledge: unknown): {
  perFeed: PerFeed[];
  coveragePct: number;
} {
  const parsed = parseKnowledgeCoverage(knowledge);
  const gapped = extractGappedTargets(knowledge);

  const perFeed: PerFeed[] = parsed.feeds.map((feed) => {
    const target = feed.actionKey;
    const state: FeedState = target && gapped.has(target) ? 'learning' : 'live';
    return { key: feed.key, label: feed.label, state };
  });

  const learnable = parsed.feeds.filter(
    (feed) => feed.actionKey != null && LEARNABLE_ACTION_KEYS.has(feed.actionKey),
  );
  const liveLearnable = learnable.filter(
    (feed) => !(feed.actionKey && gapped.has(feed.actionKey)),
  );
  const coveragePct = learnable.length === 0
    ? 0
    : Math.round((liveLearnable.length / learnable.length) * 100);

  return { perFeed, coveragePct };
}
