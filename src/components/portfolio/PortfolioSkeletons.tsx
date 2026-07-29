import React from 'react';

import styles from './PortfolioUI.module.css';

function SkeletonLine({ width }: { width: 'short' | 'medium' | 'long' }) {
  return <span className={styles.skeletonLine} data-width={width} />;
}

function SkeletonCard() {
  return (
    <div className={styles.skeletonCard} aria-hidden="true">
      <span className={styles.skeletonMark} />
      <SkeletonLine width="medium" />
      <SkeletonLine width="short" />
      <SkeletonLine width="long" />
    </div>
  );
}

function SkeletonSectionChrome() {
  return (
    <div className={styles.skeletonSectionChrome} aria-hidden="true">
      <div className={styles.skeletonHeading}>
        <SkeletonLine width="medium" />
        <SkeletonLine width="long" />
      </div>
      <div className={styles.skeletonFilters}>
        {Array.from({ length: 4 }, (_, index) => (
          <span className={styles.skeletonField} key={index} />
        ))}
      </div>
    </div>
  );
}

export function PortfolioHomeSkeleton({
  label,
  hotelCount = 6,
}: {
  label: string;
  hotelCount?: number;
}) {
  return (
    <div className={`${styles.themeScope} ${styles.skeletonStack}`} role="status" aria-busy="true" aria-label={label}>
      <div className={styles.skeletonCommand} aria-hidden="true">
        <span className={styles.skeletonMark} />
        <div><SkeletonLine width="short" /><SkeletonLine width="long" /></div>
      </div>
      <SkeletonSectionChrome />
      <div className={styles.skeletonGrid}>
        {Array.from({ length: hotelCount }, (_, index) => <SkeletonCard key={index} />)}
      </div>
    </div>
  );
}

export function PortfolioSectionSkeleton({
  label,
  rowCount = 5,
}: {
  label: string;
  rowCount?: number;
}) {
  return (
    <div className={`${styles.themeScope} ${styles.skeletonStack}`} role="status" aria-busy="true" aria-label={label}>
      <div className={styles.skeletonMetrics} aria-hidden="true">
        <SkeletonCard /><SkeletonCard /><SkeletonCard />
      </div>
      <SkeletonSectionChrome />
      <div className={styles.skeletonList} aria-hidden="true">
        {Array.from({ length: rowCount }, (_, index) => (
          <div className={styles.skeletonRow} key={index}>
            <span className={styles.skeletonMark} />
            <div><SkeletonLine width="medium" /><SkeletonLine width="long" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScopeChooserSkeleton({
  label,
  optionCount = 3,
}: {
  label: string;
  optionCount?: number;
}) {
  return (
    <div className={`${styles.themeScope} ${styles.scopeSkeleton}`} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: optionCount }, (_, index) => <SkeletonCard key={index} />)}
    </div>
  );
}
