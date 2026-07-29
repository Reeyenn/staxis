'use client';

import React from 'react';
import { ChevronLeft, ChevronRight, Grid2X2, List, Search } from 'lucide-react';

import styles from './PortfolioUI.module.css';
import { PortfolioActionControl } from './PortfolioPrimitives';
import type { PortfolioFilterModel, PortfolioPaginationModel } from './types';

export function PortfolioCollectionControls({ filters }: { filters: PortfolioFilterModel }) {
  const hasInputs = Boolean(filters.search || filters.region || filters.status || filters.sort);
  return (
    <div className={styles.collectionControls}>
      {hasInputs ? (
        <div className={styles.filterFields}>
          {filters.search ? (
            <label className={`${styles.fieldLabel} ${styles.searchField}`}>
              <span>{filters.search.label}</span>
              <span className={styles.inputShell}>
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  value={filters.search.value}
                  placeholder={filters.search.placeholder}
                  onChange={(event) => filters.search?.onChange(event.target.value)}
                />
              </span>
            </label>
          ) : null}
          {[filters.region, filters.status, filters.sort].map((control, index) => control ? (
            <label className={styles.fieldLabel} key={`${control.label}:${index}`}>
              <span>{control.label}</span>
              <select value={control.value} onChange={(event) => control.onChange(event.target.value)}>
                {control.options.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.count == null ? option.label : `${option.label} (${option.count})`}
                  </option>
                ))}
              </select>
            </label>
          ) : null)}
        </div>
      ) : null}
      <div className={styles.controlFooter}>
        <div className={styles.resultControls}>
          {filters.resultSummary ? <span className={styles.resultSummary} role="status">{filters.resultSummary}</span> : null}
          {filters.clearAction ? (
            <PortfolioActionControl action={filters.clearAction} className={styles.clearAction} />
          ) : null}
        </div>
        {filters.viewMode ? (
          <div className={styles.viewToggle} role="group" aria-label={filters.viewMode.label}>
            <button
              type="button"
              aria-pressed={filters.viewMode.value === 'grid'}
              aria-label={filters.viewMode.gridLabel}
              title={filters.viewMode.gridLabel}
              onClick={() => filters.viewMode?.onChange('grid')}
            >
              <Grid2X2 size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={filters.viewMode.value === 'list'}
              aria-label={filters.viewMode.listLabel}
              title={filters.viewMode.listLabel}
              onClick={() => filters.viewMode?.onChange('list')}
            >
              <List size={18} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PortfolioPagination({ pagination }: { pagination: PortfolioPaginationModel }) {
  const pageCount = Math.max(1, pagination.pageCount);
  const page = Math.min(Math.max(1, pagination.page), pageCount);
  return (
    <nav className={styles.pagination} aria-label={pagination.pageLabel}>
      <span>{pagination.summary}</span>
      <div>
        <button
          type="button"
          disabled={page <= 1}
          aria-label={pagination.previousLabel}
          onClick={() => pagination.onPageChange(page - 1)}
        >
          <ChevronLeft size={17} aria-hidden="true" />
          <span>{pagination.previousLabel}</span>
        </button>
        <span className={styles.pageCounter} aria-current="page">{page} / {pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount}
          aria-label={pagination.nextLabel}
          onClick={() => pagination.onPageChange(page + 1)}
        >
          <span>{pagination.nextLabel}</span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
