'use client';

import React from 'react';
import {
  BarChart3,
  ClipboardCheck,
  DollarSign,
  MessageSquare,
  Package,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';

import styles from './PortfolioUI.module.css';
import { ContextBanner, type ContextBannerProps } from './ContextBanner';
import {
  PortfolioCollectionControls,
  PortfolioPagination,
} from './PortfolioCollectionControls';
import {
  PortfolioActionControl,
  PortfolioFactList,
  PortfolioPartialNotice,
  PortfolioProgress,
  PortfolioStatePanel,
  PortfolioStatusChip,
} from './PortfolioPrimitives';
import { PortfolioSectionSkeleton } from './PortfolioSkeletons';
import type {
  PortfolioAction,
  PortfolioFilterModel,
  PortfolioMetric,
  PortfolioModuleId,
  PortfolioPaginationModel,
  PortfolioSectionItem,
  PortfolioStateContent,
  PortfolioViewState,
} from './types';

const MODULE_ICONS = {
  staxis: Sparkles,
  dashboard: BarChart3,
  housekeeping: ClipboardCheck,
  communications: MessageSquare,
  maintenance: Wrench,
  inventory: Package,
  staff: Users,
  financials: DollarSign,
} as const;

export interface PortfolioSectionViewProps {
  module: PortfolioModuleId;
  context: ContextBannerProps;
  eyebrow: string;
  title: string;
  description?: string;
  primaryAction?: PortfolioAction;
  metrics?: readonly PortfolioMetric[];
  itemSectionTitle: string;
  itemSectionDescription?: string;
  items: readonly PortfolioSectionItem[];
  filters?: PortfolioFilterModel;
  pagination?: PortfolioPaginationModel;
  state?: PortfolioViewState;
  stateContent?: PortfolioStateContent;
  /** Empty result after client filters; collection controls remain visible. */
  collectionEmptyContent?: PortfolioStateContent;
  loadingLabel?: string;
}

function SectionItemCard({ item }: { item: PortfolioSectionItem }) {
  const titleId = React.useId();
  return (
    <article className={styles.sectionItem} aria-labelledby={titleId}>
      <div className={styles.sectionItemTopline}>
        <span className={styles.scopeAttribution}>{item.scopeLabel}</span>
        {item.status ? <PortfolioStatusChip status={item.status} /> : null}
      </div>
      <div className={styles.sectionItemCopy}>
        <h3 id={titleId}>{item.title}</h3>
        <span className={styles.secondaryLabel}>{item.secondaryLabel}</span>
        {item.description ? <p>{item.description}</p> : null}
      </div>
      {item.facts && item.facts.length > 0 ? <PortfolioFactList facts={item.facts} /> : null}
      <PortfolioActionControl action={item.drilldown} className={styles.rowAction} />
    </article>
  );
}

export function PortfolioSectionView({
  module,
  context,
  eyebrow,
  title,
  description,
  primaryAction,
  metrics = [],
  itemSectionTitle,
  itemSectionDescription,
  items,
  filters,
  pagination,
  state = 'ready',
  stateContent,
  collectionEmptyContent,
  loadingLabel = title,
}: PortfolioSectionViewProps) {
  const titleId = React.useId();
  const listTitleId = React.useId();
  const Icon = MODULE_ICONS[module];
  const showCollection = state === 'ready' || state === 'partial';
  const viewMode = filters?.viewMode?.value ?? 'list';

  return (
    <div className={`${styles.themeScope} ${styles.portfolioPage}`} data-view="section" data-module={module}>
      <ContextBanner {...context} />

      <header className={styles.sectionHero}>
        <span className={styles.sectionMark} aria-hidden="true"><Icon size={22} /></span>
        <div className={styles.sectionHeroCopy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1 id={titleId}>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {primaryAction ? <PortfolioActionControl action={primaryAction} className={styles.primaryAction} /> : null}
      </header>

      {state === 'partial' && stateContent ? <PortfolioPartialNotice content={stateContent} /> : null}
      {state === 'loading' ? <PortfolioSectionSkeleton label={loadingLabel} /> : null}

      {showCollection && metrics.length > 0 ? (
        <section className={styles.metricGrid} aria-label={eyebrow}>
          {metrics.map((metric) => (
            <article className={styles.metricCard} data-tone={metric.tone ?? 'neutral'} key={metric.id}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              {metric.supportingText ? <p>{metric.supportingText}</p> : null}
              {metric.progress ? <PortfolioProgress progress={metric.progress} /> : null}
            </article>
          ))}
        </section>
      ) : null}

      {state !== 'loading' ? <section className={styles.sectionCollectionWrap} aria-labelledby={listTitleId}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 id={listTitleId}>{itemSectionTitle}</h2>
            {itemSectionDescription ? <p>{itemSectionDescription}</p> : null}
          </div>
        </div>

        {showCollection && filters ? <PortfolioCollectionControls filters={filters} /> : null}
        {(state === 'empty' || state === 'error' || state === 'unauthorized') && stateContent ? (
          <PortfolioStatePanel state={state} content={stateContent} />
        ) : null}
        {showCollection && items.length === 0 && collectionEmptyContent ? (
          <PortfolioStatePanel state="empty" content={collectionEmptyContent} />
        ) : null}
        {showCollection && items.length > 0 ? (
          <div className={styles.sectionCollection} data-view-mode={viewMode}>
            {items.map((item) => <SectionItemCard item={item} key={item.id} />)}
          </div>
        ) : null}
        {showCollection && pagination && items.length > 0 ? (
          <PortfolioPagination pagination={pagination} />
        ) : null}
      </section> : null}
    </div>
  );
}
