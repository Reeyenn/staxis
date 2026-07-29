'use client';

import React from 'react';
import { Building2, ChevronRight } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import { ContextBanner, type ContextBannerProps } from './ContextBanner';
import {
  PortfolioCollectionControls,
  PortfolioPagination,
} from './PortfolioCollectionControls';
import { PortfolioHotelCard } from './PortfolioHotelCard';
import {
  PortfolioActionControl,
  PortfolioPartialNotice,
  PortfolioStatePanel,
} from './PortfolioPrimitives';
import { PortfolioHomeSkeleton } from './PortfolioSkeletons';
import {
  PortfolioStatusCard,
  type PortfolioStatusCardProps,
} from './PortfolioStatusCard';
import type {
  PortfolioAction,
  PortfolioFilterModel,
  PortfolioHotelCardData,
  PortfolioPaginationModel,
  PortfolioStateContent,
  PortfolioViewState,
} from './types';

export interface PortfolioHomeViewProps {
  context: ContextBannerProps;
  greeting: string;
  dateline: string;
  /** The only Ask entry rendered by this view. Omit until its acting scope is verified. */
  ask?: React.ReactNode;
  askLabel?: string;
  statusCard?: PortfolioStatusCardProps;
  hotelSectionTitle: string;
  hotelSectionDescription?: string;
  hotels: readonly PortfolioHotelCardData[];
  filters?: PortfolioFilterModel;
  pagination?: PortfolioPaginationModel;
  /** Bottom destination is shown only after a portfolio scope is verified. */
  portfolioAction?: PortfolioAction;
  portfolioDescription?: string;
  state?: PortfolioViewState;
  stateContent?: PortfolioStateContent;
  /** Empty result after client filters; collection controls remain visible. */
  collectionEmptyContent?: PortfolioStateContent;
  loadingLabel?: string;
}

export function PortfolioHomeView({
  context,
  greeting,
  dateline,
  ask,
  askLabel,
  statusCard,
  hotelSectionTitle,
  hotelSectionDescription,
  hotels,
  filters,
  pagination,
  portfolioAction,
  portfolioDescription,
  state = 'ready',
  stateContent,
  collectionEmptyContent,
  loadingLabel = hotelSectionTitle,
}: PortfolioHomeViewProps) {
  const titleId = React.useId();
  const hotelsTitleId = React.useId();
  const viewMode = filters?.viewMode?.value ?? 'grid';
  const showCollection = state === 'ready' || state === 'partial';

  return (
    <div className={`${styles.themeScope} ${styles.portfolioPage}`} data-view="home">
      <ContextBanner {...context} />

      <header className={styles.homeHero}>
        <h1 id={titleId}>{greeting}</h1>
        <p>{dateline}</p>
      </header>

      {ask ? (
        <section className={styles.askRegion} aria-label={askLabel}>
          {ask}
        </section>
      ) : null}

      {statusCard ? <PortfolioStatusCard {...statusCard} /> : null}

      {state === 'partial' && stateContent ? <PortfolioPartialNotice content={stateContent} /> : null}
      {state === 'loading' ? <PortfolioHomeSkeleton label={loadingLabel} /> : null}

      {state !== 'loading' ? <section className={styles.hotelSection} aria-labelledby={hotelsTitleId}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 id={hotelsTitleId}>{hotelSectionTitle}</h2>
            {hotelSectionDescription ? <p>{hotelSectionDescription}</p> : null}
          </div>
        </div>

        {showCollection && filters ? <PortfolioCollectionControls filters={filters} /> : null}

        {(state === 'empty' || state === 'error' || state === 'unauthorized') && stateContent ? (
          <PortfolioStatePanel state={state} content={stateContent} />
        ) : null}

        {showCollection && hotels.length === 0 && collectionEmptyContent ? (
          <PortfolioStatePanel state="empty" content={collectionEmptyContent} />
        ) : null}

        {showCollection && hotels.length > 0 ? (
          <div className={styles.hotelCollection} data-view-mode={viewMode}>
            {hotels.map((hotel) => <PortfolioHotelCard hotel={hotel} key={hotel.id} />)}
          </div>
        ) : null}

        {showCollection && pagination && hotels.length > 0 ? (
          <PortfolioPagination pagination={pagination} />
        ) : null}
      </section> : null}

      {portfolioAction ? (
        <PortfolioActionControl action={portfolioAction} className={styles.portfolioEntry}>
          <span className={styles.portfolioEntryIcon} aria-hidden="true"><Building2 size={19} /></span>
          <span className={styles.portfolioEntryCopy}>
            <strong>{portfolioAction.label}</strong>
            {portfolioDescription ? <span>{portfolioDescription}</span> : null}
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </PortfolioActionControl>
      ) : null}
    </div>
  );
}
