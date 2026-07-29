'use client';

import React from 'react';
import { ArrowUpRight, Hotel } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import {
  PortfolioActionControl,
  PortfolioFactList,
  PortfolioStatusChip,
} from './PortfolioPrimitives';
import type { PortfolioHotelCardData } from './types';

/** One truthful hotel drill-down. It intentionally has no chat affordance. */
export function PortfolioHotelCard({ hotel }: { hotel: PortfolioHotelCardData }) {
  return (
    <PortfolioActionControl action={hotel.drilldown} className={styles.hotelCard}>
      <span className={styles.hotelCardHeader}>
        <span className={styles.hotelIdentity}>
          <span className={styles.hotelMark} aria-hidden="true"><Hotel size={18} /></span>
          <span className={styles.hotelCardCopy}>
            <strong>{hotel.name}</strong>
            <span className={styles.secondaryLabel}>{hotel.secondaryLabel}</span>
            {hotel.description ? <span className={styles.hotelDescription}>{hotel.description}</span> : null}
          </span>
        </span>
        {hotel.status ? <PortfolioStatusChip status={hotel.status} /> : null}
      </span>
      {hotel.facts && hotel.facts.length > 0 ? <PortfolioFactList facts={hotel.facts} /> : null}
      <span className={styles.hotelOpenLabel} aria-hidden="true">
        <span>Open hotel</span>
        <ArrowUpRight size={16} />
      </span>
    </PortfolioActionControl>
  );
}
