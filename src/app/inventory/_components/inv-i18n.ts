// English strings for the Inventory module.

import { makeT, makeLabelFor } from '@/lib/i18n-utils';
import type { StockStatus, InvCat } from './tokens';

export type Lang = 'en' | 'es';

export function invLang(_storedLanguage: string | undefined): Lang {
  return 'en';
}

// ── Status labels (tokens.statusLabel, now lang-aware) ────────────────────
const STATUS_LABELS: Record<'en', Record<StockStatus, string>> = {
  en: { good: 'Good', low: 'Low', critical: 'Critical' },

};
export const statusLabelFor = makeLabelFor(STATUS_LABELS);

// ── Category labels (tokens.catLabel, now lang-aware) ─────────────────────
const CAT_LABELS: Record<'en', Record<InvCat, string>> = {
  en: { housekeeping: 'Housekeeping', maintenance: 'Maintenance', breakfast: 'Food & Beverage' },

};
export const catLabelFor = makeLabelFor(CAT_LABELS);

// ── Month abbreviations (BudgetsPanel) ────────────────────────────────────
const MONTHS: Record<'en', string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

};
// ── Set-aside marker (0321) — label + the ⓘ hover explanation ─────────────
export function setAsideTagLabel(lang: Lang, count: number): string {
  return `${count} set aside`;
}
export function setAsideTip(lang: Lang): string {
  return "Set aside = can't be used right now (stained, damaged, being fixed) but still yours. Counts in inventory value, not in usable stock.";
}

export function monthsFor(lang: Lang): string[] {
  return MONTHS['en'] ?? MONTHS.en;
}

// Date-locale string for toLocaleDateString ('es-ES' / 'en-US' — the shared
// helper's default pair is this file's original pair exactly).
export { dateLocale } from '@/lib/i18n-utils';

const STRINGS = {
  en: {
    // ── Shell ──
    loading: 'Loading…',
    loadFailed: 'Inventory could not load. Check the connection and try again.',
    detailsLoadFailed: 'Some inventory details are unavailable. Try again.',
    retry: 'Try again',
    quickCountSaveFailed: 'A quick count did not fully save. Refresh before trying that item again.',
    pageTitle: 'Inventory',
    stockHealth: 'Stock health',
    orderNow: 'Order now',
    onTheShelf: 'On the shelf',
    shelfCostsMissing: 'some item costs are missing',
    shelfValueWarningIntro: 'This total is incomplete because prices are missing.',
    shelfValueWarningList: 'Missing prices:',
    shelfValueWarningResolution: 'Once added, the total will update automatically.',
    allClear: 'All clear',
    allClearSub: 'nothing needs ordering',
    // ── Sidebar ──
    do: 'Do',
    look: 'Look',
    startCount: 'Start count',
    addDelivery: 'Add a delivery',
    ordering: 'Ordering',
    monthClose: 'Month close',
    reports: 'Reports',
    compareMonths: 'Compare months',
    history: 'History',
    aiHelper: 'AI Helper',
    budgets: 'Budgets',
    thisMonth: 'This month',
    usagePending: 'Usage pending',
    partialUsage: 'Partial tracking period',
    actualUsed: 'actual used',
    purchasesLogged: 'purchases logged',
    purchaseCostsMissing: 'some delivery costs are missing',
    purchasesUnavailable: 'purchase totals unavailable',
    budgetAfterClose: 'Budget status appears after month close',
    leftInBudget: 'left in budget',
    overBudget: 'over budget',
    of: 'of',
    stillToSpend: 'still to spend',
    noBudgetSet: 'No budget set',
    // ── FilterBar ──
    all: 'All',
    generalInventory: 'General inventory',
    breakfastInventory: 'Breakfast inventory',
    search: 'Search…',
    searchInventory: 'Search inventory',
    clearSearch: 'Clear search',
    previousActions: 'Show previous actions',
    moreActions: 'Show more actions',
    savingQuickCount: 'Saving quick count',
    addItem: '+ Add item',
    // ── Import a whole file ──
    importFile: 'Import a file',
    importTitle: 'Bring in a file you already have',
    importIntro: 'Upload a spreadsheet, a PDF, a photo of a count sheet, or paste your list. Nothing is saved until you approve it.',
    importPickFile: 'Choose a file',
    importPasteLabel: 'Or paste your list here',
    importKindInventory: 'Inventory items',
    importKindOccupancy: 'Occupancy history',
    importReading: 'Reading your file',
    importAsOfLabel: 'This sheet was current on',
    importReview: 'Review before saving',
    importConfirm: 'Save this import',
    importCancel: 'Cancel',
    importRemove: 'Remove this import',
    importHistoryTitle: 'Imports',
    importNothingYet: 'No imports yet.',
    importMerge: 'Merge into',
    importCreate: 'Add as new',
    importSkip: 'Leave out',
    // ── StockList columns ──
    colOrderNow: 'Order now',
    colOrderSoon: 'Order soon',
    colStocked: 'Stocked',
    // Wording tracks the house 70/30 rule in src/lib/stock-status.ts. Keep the
    // three in step with it: a column subtitle that names a threshold the code
    // no longer uses is worse than no subtitle at all.
    subCritical: 'under 30% of par',
    subLow: '30% to 70% of par',
    subGood: '70% of par or more',
    nothingHere: 'Nothing here.',
    // ── Not-counted-yet (new-hotel day 1) ──
    notCountedTitle: 'Not counted yet',
    notCountedSub: 'Count these to see what to reorder',
    notCountedHint: 'No counts yet. Start your first inventory count to see what needs ordering.',
    countInventory: 'Count inventory',
    // ── BoardCard ──
    daysLeft: 'd left', // suffix → "5d left"
    daysLeft90: '90+d left',
    aiTracked: 'ai-tracked',
    value: 'value',
    lead: 'lead',
    count: 'Count',
    reorder: 'Reorder',
    edit: 'Edit',
    flipBack: 'Flip back',
    // ── Empty catalog (zero items — StockList panel) ──
    noItemsBody: 'Add your first item to start tracking stock.',
    noItemsYet: 'No items yet',
    team: 'team',
    // ── Ledger table (redesign) ──
    sort: 'Sort',
    sortAttention: 'Low stock first',
    sortAZ: 'A to Z',
    sortValue: 'Highest value',
    sortStale: 'Not counted lately',
    colItem: 'Item',
    colStatus: 'Status',
    colStockVsPar: 'Stock vs par',
    colOnHand: 'On hand · quick count',
    colPar: 'Par',
    colDays: 'Days',
    colValue: 'Value',
    notCountedPill: 'Not counted',
    nothingMatches: 'Nothing matches your search.',
    emptyTab: 'No items in this tab yet. Add one, or move items here from Edit item.',
    ledgerHint: 'Quick counts save after a short pause · full walk lives in Start count',
    // ── View toggle (Ledger table ↔ triage board) ──
    viewLedger: 'Ledger',
    viewBoard: 'Board',
    // ── Custom category tabs (0307) + tab layout editing (0308) ──
    addTab: 'Add a tab',
    newTabPh: 'Name (e.g. Liquor)',
    removeTab: 'Remove tab',
    editTabs: 'Edit tabs',
    doneEditing: 'Done',
    dragHint: 'Drag to reorder · tap ✕ to remove · tap Done when you’re finished',
    removeTabTitle: 'Remove this tab?',
    removeCustomMsg: 'This removes the tab for good. Its items aren’t deleted. They return to their normal category and show under All.',
    removeBuiltinMsg: 'Its items keep their category and still show under All. To bring the tab back later, add a tab with the same name.',
    removeConfirmBtn: 'Remove',
    cancelBtn: 'Cancel',
  },

};

export type InvStrings = (typeof STRINGS)['en'];

// makeT bakes in the EN↔ES key-parity compile check (a key added to `en` but
// forgotten in `es` is a type error, not a silent runtime `undefined`) and
// the same `STRINGS[lang] ?? STRINGS.en` lookup this file used to hand-roll.
export const t = makeT(STRINGS);
