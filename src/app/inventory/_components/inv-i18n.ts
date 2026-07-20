// Bilingual (EN + ES) strings for the Inventory module. Co-located with the
// feature (same pattern as financials/_components/fin-i18n.ts) rather than
// added to the global translations.ts so parallel features don't collide.
//
// Threading: InventoryShell reads `lang` from useLang() and passes it down as
// a prop to every text-rendering child + overlay. Components call t(lang) to
// get the strings object, or the small helpers below for status/category
// labels and month names.

import { makeT, makeLabelFor } from '@/lib/i18n-utils';
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
export const statusLabelFor = makeLabelFor(STATUS_LABELS);

// ── Category labels (tokens.catLabel, now lang-aware) ─────────────────────
const CAT_LABELS: Record<Lang, Record<InvCat, string>> = {
  en: { housekeeping: 'Housekeeping', maintenance: 'Maintenance', breakfast: 'Food & Beverage' },
  es: { housekeeping: 'Limpieza', maintenance: 'Mantenimiento', breakfast: 'Alimentos y Bebidas' },
};
export const catLabelFor = makeLabelFor(CAT_LABELS);

// ── Month abbreviations (BudgetsPanel) ────────────────────────────────────
const MONTHS: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
};
// ── Set-aside marker (0321) — label + the ⓘ hover explanation ─────────────
export function setAsideTagLabel(lang: Lang, count: number): string {
  return lang === 'es' ? `${count} apartado${count === 1 ? '' : 's'}` : `${count} set aside`;
}
export function setAsideTip(lang: Lang): string {
  return lang === 'es'
    ? 'Apartado = no se puede usar por ahora (manchado, dañado, en reparación) pero sigue siendo suyo. Cuenta en el valor del inventario, no en el stock utilizable.'
    : "Set aside = can't be used right now (stained, damaged, being fixed) but still yours. Counts in inventory value, not in usable stock.";
}

export function monthsFor(lang: Lang): string[] {
  return MONTHS[lang] ?? MONTHS.en;
}

// Date-locale string for toLocaleDateString ('es-ES' / 'en-US' — the shared
// helper's default pair is this file's original pair exactly).
export { dateLocale } from '@/lib/i18n-utils';

const STRINGS = {
  en: {
    // ── Shell ──
    loading: 'Loading…',
    loadFailed: 'Inventory could not load. Check the connection and try again.',
    retry: 'Try again',
    quickCountSaveFailed: 'A quick count did not fully save. Refresh before trying that item again.',
    pageTitle: 'Inventory',
    stockHealth: 'Stock health',
    orderNow: 'Order now',
    onTheShelf: 'On the shelf',
    shelfCostsMissing: 'some item costs are missing',
    allClear: 'All clear',
    allClearSub: 'nothing needs ordering',
    // ── Sidebar ──
    do: 'Do',
    look: 'Look',
    startCount: 'Start count',
    addDelivery: 'Add a delivery',
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
    emptyTab: 'No items in this tab yet — add one, or move items here from Edit item.',
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
    removeCustomMsg: 'This removes the tab for good. Its items aren’t deleted — they return to their normal category and show under All.',
    removeBuiltinMsg: 'Its items keep their category and still show under All. To bring the tab back later, add a tab with the same name.',
    removeConfirmBtn: 'Remove',
    cancelBtn: 'Cancel',
  },
  es: {
    // ── Shell ──
    loading: 'Cargando…',
    loadFailed: 'No se pudo cargar el inventario. Revisa la conexión e inténtalo de nuevo.',
    retry: 'Intentar de nuevo',
    quickCountSaveFailed: 'Un conteo rápido no se guardó por completo. Actualiza antes de intentar ese artículo otra vez.',
    pageTitle: 'Inventario',
    stockHealth: 'Salud del inventario',
    orderNow: 'Pedir ahora',
    onTheShelf: 'En estante',
    shelfCostsMissing: 'faltan costos de algunos artículos',
    allClear: 'Todo en orden',
    allClearSub: 'no hay nada que pedir',
    // ── Sidebar ──
    do: 'Acciones',
    look: 'Ver',
    startCount: 'Iniciar conteo',
    addDelivery: 'Agregar entrega',
    monthClose: 'Cierre mensual',
    reports: 'Informes',
    compareMonths: 'Comparar meses',
    history: 'Historial',
    aiHelper: 'Asistente IA',
    budgets: 'Presupuestos',
    thisMonth: 'Este mes',
    usagePending: 'Uso pendiente',
    partialUsage: 'Período parcial',
    actualUsed: 'uso real',
    purchasesLogged: 'compras registradas',
    purchaseCostsMissing: 'faltan costos de algunas entregas',
    purchasesUnavailable: 'totales de compras no disponibles',
    budgetAfterClose: 'El estado del presupuesto aparece después del cierre mensual',
    leftInBudget: 'disponible en presupuesto',
    overBudget: 'sobre presupuesto',
    of: 'de',
    stillToSpend: 'por gastar',
    noBudgetSet: 'Sin presupuesto',
    // ── FilterBar ──
    all: 'Todos',
    generalInventory: 'Inventario general',
    breakfastInventory: 'Inventario de desayuno',
    search: 'Buscar…',
    searchInventory: 'Buscar en inventario',
    clearSearch: 'Borrar búsqueda',
    previousActions: 'Mostrar acciones anteriores',
    moreActions: 'Mostrar más acciones',
    savingQuickCount: 'Guardando conteo rápido',
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
    // ── Empty catalog (zero items — StockList panel) ──
    noItemsBody: 'Agrega tu primer artículo para empezar a controlar el stock.',
    noItemsYet: 'Aún no hay artículos',
    team: 'equipo',
    // ── Ledger table (redesign) ──
    sort: 'Ordenar',
    sortAttention: 'Poco stock primero',
    sortAZ: 'A a Z',
    sortValue: 'Mayor valor',
    sortStale: 'Sin contar hace tiempo',
    colItem: 'Artículo',
    colStatus: 'Estado',
    colStockVsPar: 'Stock vs par',
    colOnHand: 'En mano · conteo rápido',
    colPar: 'Par',
    colDays: 'Días',
    colValue: 'Valor',
    notCountedPill: 'Sin contar',
    nothingMatches: 'Nada coincide con tu búsqueda.',
    emptyTab: 'Aún no hay artículos en esta pestaña — agrega uno, o mueve artículos aquí desde Editar artículo.',
    ledgerHint: 'Los conteos rápidos se guardan tras una pausa breve · el recorrido completo está en Iniciar conteo',
    // ── View toggle (tabla Libro ↔ tablero) ──
    viewLedger: 'Tabla',
    viewBoard: 'Tablero',
    // ── Pestañas de categoría personalizadas (0307) + edición de pestañas (0308) ──
    addTab: 'Agregar pestaña',
    newTabPh: 'Nombre (ej. Licor)',
    removeTab: 'Quitar pestaña',
    editTabs: 'Editar pestañas',
    doneEditing: 'Listo',
    dragHint: 'Arrastra para reordenar · toca ✕ para quitar · toca Listo al terminar',
    removeTabTitle: '¿Quitar esta pestaña?',
    removeCustomMsg: 'Esto elimina la pestaña de forma permanente. Sus artículos no se eliminan — vuelven a su categoría normal y aparecen en Todos.',
    removeBuiltinMsg: 'Sus artículos conservan su categoría y siguen apareciendo en Todos. Para recuperar la pestaña más tarde, agrega una pestaña con el mismo nombre.',
    removeConfirmBtn: 'Quitar',
    cancelBtn: 'Cancelar',
  },
};

export type InvStrings = (typeof STRINGS)['en'];

// makeT bakes in the EN↔ES key-parity compile check (a key added to `en` but
// forgotten in `es` is a type error, not a silent runtime `undefined`) and
// the same `STRINGS[lang] ?? STRINGS.en` lookup this file used to hand-roll.
export const t = makeT(STRINGS);
