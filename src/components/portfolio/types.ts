/** Every operational destination that can have a portfolio summary. */
export type PortfolioModuleId =
  | 'staxis'
  | 'dashboard'
  | 'housekeeping'
  | 'communications'
  | 'maintenance'
  | 'inventory'
  | 'staff'
  | 'financials';

export type PortfolioScopeKind = 'portfolio' | 'hotel';

export type PortfolioTone = 'neutral' | 'info' | 'positive' | 'warning' | 'critical';

export type PortfolioViewState =
  | 'ready'
  | 'partial'
  | 'loading'
  | 'empty'
  | 'error'
  | 'unauthorized';

interface PortfolioActionBase {
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/** A real destination or callback supplied by the connected surface. */
export type PortfolioAction = PortfolioActionBase & (
  | { href: string; onActivate?: () => void }
  | { href?: never; onActivate: () => void }
);

/** Explicit status copy only. Omitting this object makes no status claim. */
export interface PortfolioStatus {
  label: string;
  tone: PortfolioTone;
  detail?: string;
  ariaLabel?: string;
}

export interface PortfolioFact {
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface PortfolioProgressData {
  label: string;
  value: number;
  max: number;
  valueLabel: string;
  tone?: PortfolioTone;
}

export interface PortfolioMetric {
  id: string;
  label: string;
  value: string;
  supportingText?: string;
  tone?: PortfolioTone;
  progress?: PortfolioProgressData;
}

/**
 * `secondaryLabel` is deliberately required. Hotel names are not unique across
 * a portfolio; the caller must supply truthful identifying context such as a
 * city, property code, or region rather than the view inventing one.
 */
export interface PortfolioHotelCardData {
  id: string;
  name: string;
  secondaryLabel: string;
  description?: string;
  regionKey?: string;
  regionLabel?: string;
  status?: PortfolioStatus | null;
  facts?: readonly PortfolioFact[];
  drilldown: PortfolioAction;
}

/** Generic row used by every portfolio module; all operational copy is data. */
export interface PortfolioSectionItem {
  id: string;
  title: string;
  /** Hotel/company attribution, required for duplicate-safe portfolio reading. */
  scopeLabel: string;
  secondaryLabel: string;
  description?: string;
  status?: PortfolioStatus | null;
  facts?: readonly PortfolioFact[];
  drilldown: PortfolioAction;
}

export interface PortfolioFilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface PortfolioTextFilter {
  value: string;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
}

export interface PortfolioSelectFilter {
  value: string;
  label: string;
  options: readonly PortfolioFilterOption[];
  onChange: (value: string) => void;
}

export interface PortfolioViewModeControl {
  value: 'grid' | 'list';
  label: string;
  gridLabel: string;
  listLabel: string;
  onChange: (value: 'grid' | 'list') => void;
}

export interface PortfolioFilterModel {
  search?: PortfolioTextFilter;
  region?: PortfolioSelectFilter;
  status?: PortfolioSelectFilter;
  sort?: PortfolioSelectFilter;
  viewMode?: PortfolioViewModeControl;
  resultSummary?: string;
  clearAction?: PortfolioAction;
}

export interface PortfolioPaginationModel {
  page: number;
  pageCount: number;
  summary: string;
  previousLabel: string;
  nextLabel: string;
  pageLabel: string;
  onPageChange: (page: number) => void;
}

export interface PortfolioStateContent {
  title: string;
  description?: string;
  guidance?: string;
  action?: PortfolioAction;
}

export interface PortfolioScopeOption {
  id: string;
  kind: PortfolioScopeKind;
  eyebrow: string;
  name: string;
  secondaryLabel: string;
  status?: PortfolioStatus | null;
  facts?: readonly PortfolioFact[];
}
