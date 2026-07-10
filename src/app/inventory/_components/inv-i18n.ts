// Bilingual (EN + ES) strings for the Inventory module. Co-located with the
// feature (same pattern as financials/_components/fin-i18n.ts) rather than
// added to the global translations.ts so parallel features don't collide.
//
// Threading: InventoryShell reads `lang` from useLang() and passes it down as
// a prop to every text-rendering child + overlay. Components call t(lang) to
// get the strings object, or the small helpers below for status/category
// labels and month names.

import type { StockStatus, InvCat } from './tokens';

export type Lang = 'en' | 'es';

// Narrow any LanguageContext value (en|es|ht|tl|vi) down to the en/es branch
// the inventory UI keys off — mirrors the app-wide `lang === 'es'` ternary.
export function invLang(l: string | undefined): Lang {
  return l === 'es' ? 'es' : 'en';
}

// ── Status labels (tokens.statusLabel, now lang-aware) ────────────────────
const STATUS_LABELS: Record<Lang, Record<StockStatus, string>> = {
  en: { good: 'Good', low: 'Low', critical: 'Critical' },
  es: { good: 'Bien', low: 'Bajo', critical: 'Crítico' },
};
export function statusLabelFor(lang: Lang, s: StockStatus): string {
  return STATUS_LABELS[lang]?.[s] ?? STATUS_LABELS.en[s] ?? s;
}

// ── Category labels (tokens.catLabel, now lang-aware) ─────────────────────
const CAT_LABELS: Record<Lang, Record<InvCat, string>> = {
  en: { housekeeping: 'Housekeeping', maintenance: 'Maintenance', breakfast: 'Food & Beverage' },
  es: { housekeeping: 'Limpieza', maintenance: 'Mantenimiento', breakfast: 'Alimentos y Bebidas' },
};
export function catLabelFor(lang: Lang, c: InvCat): string {
  return CAT_LABELS[lang]?.[c] ?? CAT_LABELS.en[c] ?? c;
}

// ── Month abbreviations (BudgetsPanel) ────────────────────────────────────
const MONTHS: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
};
export function monthsFor(lang: Lang): string[] {
  return MONTHS[lang] ?? MONTHS.en;
}

// Date-locale string for toLocaleDateString.
export function dateLocale(lang: Lang): string {
  return lang === 'es' ? 'es-ES' : 'en-US';
}

const STRINGS = {
  en: {
    // ── Shell ──
    loading: 'Loading…',
    pageTitle: 'Inventory',
    stockHealth: 'Stock health',
    orderNow: 'Order now',
    onTheShelf: 'On the shelf',
    allClear: 'All clear',
    allClearSub: 'nothing needs ordering',
    // ── Sidebar ──
    do: 'Do',
    look: 'Look',
    startCount: 'Start count',
    scanInvoice: 'Scan invoice',
    reorderList: 'Reorder list',
    orders: 'Orders',
    reports: 'Reports',
    history: 'History',
    aiHelper: 'AI Helper',
    budgets: 'Budgets',
    orderingSettings: 'Ordering settings',
    thisMonth: 'This month',
    of: 'of',
    stillToSpend: 'still to spend',
    noBudgetSet: 'No budget set',
    // ── FilterBar ──
    all: 'All',
    generalInventory: 'General inventory',
    breakfastInventory: 'Breakfast inventory',
    search: 'Search…',
    addItem: '+ Add item',
    // ── StockList columns ──
    colOrderNow: 'Order now',
    colOrderSoon: 'Order soon',
    colStocked: 'Stocked',
    subBelowHalfPar: 'below half par',
    subUnderPar: 'under par',
    subAtOrAbovePar: 'at or above par',
    nothingHere: 'Nothing here.',
    // ── Not-counted-yet (new-hotel day 1) ──
    notCountedTitle: 'Not counted yet',
    notCountedSub: 'Count these to see what to reorder',
    notCountedHint: 'No counts yet — start your first inventory count to see what needs ordering.',
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
    // ── Empty catalog (zero items — StockList panel; noItemsYet reused below) ──
    noItemsBody: 'Add your first item to start tracking stock.',
    // ── HeroStats ──
    itemsHaveEnough: 'items have enough', // "{n} of {m} items have enough"
    noItemsYet: 'No items yet',
    whatEverythingsWorth: "What everything's worth today",
    lastCounted: 'Last counted',
    by: 'by',
    team: 'team',
    today: 'today',
    yesterday: 'yesterday',
    daysAgo: 'days ago', // "{n} days ago"
    noCountYet: 'No count yet',
  },
  es: {
    // ── Shell ──
    loading: 'Cargando…',
    pageTitle: 'Inventario',
    stockHealth: 'Salud del inventario',
    orderNow: 'Pedir ahora',
    onTheShelf: 'En estante',
    allClear: 'Todo en orden',
    allClearSub: 'no hay nada que pedir',
    // ── Sidebar ──
    do: 'Acciones',
    look: 'Ver',
    startCount: 'Iniciar conteo',
    scanInvoice: 'Escanear factura',
    reorderList: 'Lista de pedidos',
    orders: 'Órdenes',
    reports: 'Informes',
    history: 'Historial',
    aiHelper: 'Asistente IA',
    budgets: 'Presupuestos',
    orderingSettings: 'Ajustes de pedidos',
    thisMonth: 'Este mes',
    of: 'de',
    stillToSpend: 'por gastar',
    noBudgetSet: 'Sin presupuesto',
    // ── FilterBar ──
    all: 'Todos',
    generalInventory: 'Inventario general',
    breakfastInventory: 'Inventario de desayuno',
    search: 'Buscar…',
    addItem: '+ Agregar artículo',
    // ── StockList columns ──
    colOrderNow: 'Pedir ahora',
    colOrderSoon: 'Pedir pronto',
    colStocked: 'En stock',
    subBelowHalfPar: 'menos de la mitad del par',
    subUnderPar: 'bajo el par',
    subAtOrAbovePar: 'en o sobre el par',
    nothingHere: 'Nada aquí.',
    // ── Not-counted-yet (new-hotel day 1) ──
    notCountedTitle: 'Sin contar aún',
    notCountedSub: 'Cuéntalos para ver qué reordenar',
    notCountedHint: 'Aún sin conteos — inicia tu primer conteo de inventario para ver qué hay que pedir.',
    countInventory: 'Contar inventario',
    // ── BoardCard ──
    daysLeft: 'd restantes',
    daysLeft90: '90+d restantes',
    aiTracked: 'seguido por IA',
    value: 'valor',
    lead: 'entrega',
    count: 'Contar',
    reorder: 'Pedir',
    edit: 'Editar',
    flipBack: 'Voltear',
    // ── Empty catalog (zero items — StockList panel; noItemsYet reused below) ──
    noItemsBody: 'Agrega tu primer artículo para empezar a controlar el stock.',
    // ── HeroStats ──
    itemsHaveEnough: 'artículos con suficiente',
    noItemsYet: 'Aún no hay artículos',
    whatEverythingsWorth: 'Lo que todo vale hoy',
    lastCounted: 'Último conteo',
    by: 'por',
    team: 'equipo',
    today: 'hoy',
    yesterday: 'ayer',
    daysAgo: 'días atrás',
    noCountYet: 'Sin conteo aún',
  },
};

export type InvStrings = (typeof STRINGS)['en'];

// Compile-time drift guard: every EN key MUST also exist in ES. Because t() is
// typed as the EN shape, a key added to `en` but forgotten in `es` would return
// `undefined` at runtime with NO build error (lint + build both stay green).
// This assignment makes that mistake a type error instead.
const _esKeyParity: Record<keyof InvStrings, string> = STRINGS.es;
void _esKeyParity;

export function t(lang: Lang): InvStrings {
  return STRINGS[lang] ?? STRINGS.en;
}
