'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { inventoryMonthKeyInZone } from '@/lib/inventory-month-close';
import {
  isCurrentMonthCloseMutation,
  normalizeMonthCloseDashboardForProperty,
  normalizeMonthCloseMutationReceipt,
  type MonthCloseDashboardView,
  type MonthCloseIssue,
  type MonthClosePurchaseSource,
} from '@/lib/inventory-month-close-contract';

import { Btn } from '../Btn';
import type { Lang } from '../inv-i18n';
import { T, fonts } from '../tokens';
import { Overlay } from './Overlay';

export interface MonthClosePanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  /** Opens the existing full inventory count workflow. */
  onStartCount: () => void;
  /** Lets the inventory shell refresh its summary after a baseline or close is saved. */
  onChanged?: () => void;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function monthCloseStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Month close',
      fallbackTitle: 'Current month',
      close: 'Close',
      done: 'Done',
      cancel: 'Cancel',
      loadingTitle: 'Preparing the month close',
      loadingBody: 'Checking counts, costs, and received lines.',
      loadErrorTitle: 'Month close could not load',
      loadErrorBody: 'Check the connection and try again. Nothing was changed.',
      retry: 'Try again',
      noPropertyTitle: 'Choose a property first',
      noPropertyBody: 'Month close is tied to one hotel. Select a property, then return here.',
      statusSetup: 'Beginning inventory needed',
      statusOpen: 'Tracking is open',
      statusClosed: 'Month closed',
      setupTitle: 'Set the beginning inventory',
      setupBody: 'A current full count becomes the opening value for monthly tracking. Purchases will stay separate from what is on the shelf.',
      beginningInventory: 'Beginning inventory',
      fromCurrentCount: 'From the latest complete count and saved unit costs',
      valueUnavailable: 'Count required',
      startTracking: 'Start monthly tracking',
      starting: 'Starting…',
      started: 'Monthly tracking started.',
      openIntro: 'Estimated usage is different from purchases and from the value still on the shelf. This preview becomes final when the month closes.',
      previewEquationLabel: (beginning: string, purchases: string, ending: string, estimated: string) =>
        `Beginning inventory ${beginning} plus purchases ${purchases} minus ending inventory ${ending} equals estimated usage ${estimated}, close preview`,
      equationLabel: (beginning: string, purchases: string, ending: string, actual: string) =>
        `Beginning inventory ${beginning} plus purchases ${purchases} minus ending inventory ${ending} equals actual used ${actual}`,
      beginning: 'Beginning',
      purchases: 'Purchases',
      ending: 'Ending',
      estimatedUsage: 'Estimated usage / close preview',
      actualUsed: 'Actual used',
      openingBaseline: 'Opening baseline',
      openingAdjustmentTitle: 'Opening inventory adjusted',
      openingAdjustmentBody: (amount: string) => `${amount} of stock already at the hotel was added to beginning inventory. It is not a purchase.`,
      selectedSource: 'Selected source',
      latestCount: 'Latest full count',
      countNeeded: 'Eligible month-end count needed',
      previewFormulaResult: 'Preview only — final when the month closes',
      formulaResult: 'Inventory consumed this period',
      choosePurchases: 'Choose the purchases for this close',
      choosePurchasesHelp: 'Use one source. Purchases are shown separately from beginning and ending inventory.',
      loggedTitle: 'Use received lines',
      loggedBody: (count: number) => `${count} received line${count === 1 ? '' : 's'} in this period`,
      loggedDetail: 'Keeps item, category, and budget-section detail.',
      loggedIncomplete: (known: string) => `Incomplete · ${known} is costed so far. Add the missing received-line costs or choose another source.`,
      noLoggedDeliveries: 'No received lines were found. Choose “No purchases” to explicitly confirm $0.',
      manualTitle: 'Enter one monthly total',
      manualBody: 'Use a verified invoice or accounting total instead of received lines.',
      manualDetail: 'This records one total only. Item, category, and budget-section comparisons will be unavailable.',
      zeroTitle: 'No purchases this period',
      zeroBody: 'Explicitly confirm that no inventory was purchased.',
      monthlyPurchaseTotal: 'Monthly purchase total',
      amountExample: '0.00',
      manualRequired: 'Enter a purchase total greater than $0, or choose “No purchases.”',
      manualInvalid: 'Enter a valid amount with no more than two decimal places.',
      readinessTitle: 'Close readiness',
      readinessBody: 'Take the ending count on the hotel’s final local calendar day of the month or during the first 3 local calendar days after month end. Complete unit costs are also required.',
      endingCount: 'Eligible ending count',
      countedItems: (counted: number, total: number) => `${counted} of ${total} items counted`,
      countedItemsAt: (counted: number, total: number, date: string) => `${counted} of ${total} items counted · latest ${date}`,
      noItems: 'No inventory items in this period',
      costs: 'Cost coverage',
      costsReady: 'All required costs are present',
      needsAttention: 'Needs attention',
      ready: 'Ready',
      startCount: 'Start or update count',
      blockersTitle: 'Resolve before closing',
      warningsTitle: 'Review before closing',
      missingCost: (name: string) => `Add a unit cost for ${name}.`,
      missingCosts: (count: number) => `${count} inventory item${count === 1 ? '' : 's'} need a unit cost.`,
      staleCount: 'Complete a full count on the hotel’s final local calendar day of the month or during the first 3 local calendar days after month end.',
      uncounted: (count: number) => `${count} item${count === 1 ? '' : 's'} still need an ending count.`,
      uncostedDeliveries: (count: number) => `${count} received line${count === 1 ? ' is' : 's are'} missing cost. Choose another purchase source or complete the line costs.`,
      genericBlocker: 'Month-close information is incomplete.',
      negativeTitle: 'Estimated usage cannot be negative',
      negativeBody: 'Ending inventory is greater than beginning inventory plus purchases. Check the ending count or purchase source before closing.',
      closeMonth: 'Close month',
      closing: 'Closing…',
      finalReview: 'Final review',
      confirmTitle: (month: string) => `Close ${month}?`,
      confirmBody: 'Review the purchase source and equation below. Closing locks this monthly result so the hotel keeps one reliable record.',
      confirmMonth: 'Month',
      confirmLockedTitle: 'This result will be locked',
      confirmLockedBody: 'After closing, the month, purchase source, and calculated usage cannot be edited from Inventory.',
      confirmAction: (month: string) => `Close ${month}`,
      closeAvailableTitle: 'Close is not available yet',
      closeAvailableBody: (date: string) => `This property can close the period on ${date}. Prepare costs now, then take the ending count in the eligible month-end window.`,
      closed: 'Month closed successfully.',
      committedRefreshTitle: 'The month-close action was saved',
      committedRefreshBody: 'The saved result is committed, but the refreshed checklist could not load. Retry loading the status; do not repeat the month-close action.',
      actionFailed: 'The month close was not saved. Review the information and try again.',
      actionFailedTitle: 'Could not save month close',
      networkActionFailed: 'The connection failed, so we could not confirm the result. Retry this same safe action or reload the month status; its saved request ID prevents a duplicate.',
      timezoneChangedAction: 'The property timezone changed after this period opened. Nothing was closed. An administrator must rebaseline the current month before usage can be recorded safely.',
      endingCountAction: 'No eligible complete ending count was found. Run a full count in the allowed window. If the window has passed, reload the current month; the missed period remains unclosed.',
      baselineCountAction: 'No current full count can start this baseline. Run one complete count, then start monthly tracking again. Nothing was saved.',
      recountAction: 'Inventory changed around the selected count. Nothing was closed. Run one new complete count, then retry.',
      tooEarlyAction: 'This period cannot close before the hotel’s local month boundary. No values were saved.',
      costsAction: 'Required cost evidence is missing. Complete the flagged item or received-line costs, then retry. No values were saved.',
      purchaseAction: 'The purchase choice does not match this period’s evidence. Review the source and try again. No values were saved.',
      requestConflictAction: 'This saved retry belongs to different close values. Reload the checklist before trying again.',
      missedWindowTitle: 'The previous close window was missed',
      missedWindowBody: 'That period remains unclosed and excluded; no $0 usage was invented. Run a fresh complete count, then start a new baseline for the current month.',
      loadCurrentMonth: 'Reload current month',
      partialTitle: 'First period is partial',
      partialPreviewBody: (date: string) => `Tracking starts ${date}. This preview covers only from that baseline through close—not the full month—and should not be treated as a full-month budget actual.`,
      partialBody: (date: string) => `Tracking starts ${date}. Actual used covers only from that baseline through close—not the full month—and should not be treated as a full-month budget actual.`,
      closedBody: 'This result is locked to preserve the monthly record.',
      closedMeta: (date: string, name: string | null) => name ? `Closed ${date} by ${name}` : `Closed ${date}`,
      purchaseSource: 'Purchase source',
      loggedSource: 'Received lines',
      manualSource: 'One monthly total',
      zeroSource: 'No purchases',
      budgetUnavailable: 'Category and budget-section comparisons are unavailable because purchases were entered as one total.',
    },
    es: {
      eyebrow: 'Cierre mensual',
      fallbackTitle: 'Mes actual',
      close: 'Cerrar',
      done: 'Listo',
      cancel: 'Cancelar',
      loadingTitle: 'Preparando el cierre mensual',
      loadingBody: 'Revisando conteos, costos y líneas recibidas.',
      loadErrorTitle: 'No se pudo cargar el cierre mensual',
      loadErrorBody: 'Revisa la conexión e inténtalo de nuevo. No se cambió nada.',
      retry: 'Intentar de nuevo',
      noPropertyTitle: 'Primero elige una propiedad',
      noPropertyBody: 'El cierre mensual corresponde a un solo hotel. Selecciona una propiedad y vuelve aquí.',
      statusSetup: 'Falta el inventario inicial',
      statusOpen: 'Seguimiento abierto',
      statusClosed: 'Mes cerrado',
      setupTitle: 'Establece el inventario inicial',
      setupBody: 'Un conteo completo actual se convierte en el valor inicial del seguimiento mensual. Las compras se mantienen separadas de lo que queda disponible.',
      beginningInventory: 'Inventario inicial',
      fromCurrentCount: 'Del último conteo completo y los costos unitarios guardados',
      valueUnavailable: 'Se requiere un conteo',
      startTracking: 'Iniciar seguimiento mensual',
      starting: 'Iniciando…',
      started: 'Se inició el seguimiento mensual.',
      openIntro: 'El uso estimado es distinto de las compras y del valor que aún queda disponible. Esta vista previa será final cuando se cierre el mes.',
      previewEquationLabel: (beginning: string, purchases: string, ending: string, estimated: string) =>
        `Inventario inicial ${beginning} más compras ${purchases} menos inventario final ${ending} es igual al uso estimado ${estimated}, vista previa del cierre`,
      equationLabel: (beginning: string, purchases: string, ending: string, actual: string) =>
        `Inventario inicial ${beginning} más compras ${purchases} menos inventario final ${ending} es igual al uso real ${actual}`,
      beginning: 'Inicial',
      purchases: 'Compras',
      ending: 'Final',
      estimatedUsage: 'Uso estimado / vista previa del cierre',
      actualUsed: 'Uso real',
      openingBaseline: 'Base inicial',
      openingAdjustmentTitle: 'Inventario inicial ajustado',
      openingAdjustmentBody: (amount: string) => `${amount} de inventario que ya estaba en el hotel se agregó al inventario inicial. No es una compra.`,
      selectedSource: 'Fuente elegida',
      latestCount: 'Último conteo completo',
      countNeeded: 'Se necesita un conteo elegible de fin de mes',
      previewFormulaResult: 'Vista previa; será final al cerrar el mes',
      formulaResult: 'Inventario consumido en este período',
      choosePurchases: 'Elige las compras para este cierre',
      choosePurchasesHelp: 'Usa una sola fuente. Las compras se muestran separadas del inventario inicial y final.',
      loggedTitle: 'Usar líneas recibidas',
      loggedBody: (count: number) => `${count} línea${count === 1 ? '' : 's'} recibida${count === 1 ? '' : 's'} en este período`,
      loggedDetail: 'Conserva el detalle por artículo, categoría y sección presupuestaria.',
      loggedIncomplete: (known: string) => `Incompleto · hasta ahora hay ${known} con costo. Agrega los costos faltantes de las líneas recibidas o elige otra fuente.`,
      noLoggedDeliveries: 'No se encontraron líneas recibidas. Elige “No hubo compras” para confirmar explícitamente $0.',
      manualTitle: 'Ingresar un total mensual',
      manualBody: 'Usa un total verificado de facturas o contabilidad en lugar de las líneas recibidas.',
      manualDetail: 'Esto registra un solo total. No estarán disponibles las comparaciones por artículo, categoría o sección presupuestaria.',
      zeroTitle: 'No hubo compras en este período',
      zeroBody: 'Confirma explícitamente que no se compró inventario.',
      monthlyPurchaseTotal: 'Total mensual de compras',
      amountExample: '0.00',
      manualRequired: 'Ingresa un total mayor que $0 o elige “No hubo compras”.',
      manualInvalid: 'Ingresa un monto válido con un máximo de dos decimales.',
      readinessTitle: 'Preparación para el cierre',
      readinessBody: 'Realiza el conteo final el último día calendario local del mes del hotel o durante los primeros 3 días calendario locales después del fin de mes. También se requieren costos unitarios completos.',
      endingCount: 'Conteo final elegible',
      countedItems: (counted: number, total: number) => `${counted} de ${total} artículos contados`,
      countedItemsAt: (counted: number, total: number, date: string) => `${counted} de ${total} artículos contados · último ${date}`,
      noItems: 'No hay artículos de inventario en este período',
      costs: 'Cobertura de costos',
      costsReady: 'Están todos los costos requeridos',
      needsAttention: 'Requiere atención',
      ready: 'Listo',
      startCount: 'Iniciar o actualizar conteo',
      blockersTitle: 'Resuelve esto antes de cerrar',
      warningsTitle: 'Revisa esto antes de cerrar',
      missingCost: (name: string) => `Agrega un costo unitario para ${name}.`,
      missingCosts: (count: number) => `${count} artículo${count === 1 ? '' : 's'} necesita${count === 1 ? '' : 'n'} un costo unitario.`,
      staleCount: 'Completa un conteo total el último día calendario local del mes del hotel o durante los primeros 3 días calendario locales después del fin de mes.',
      uncounted: (count: number) => `${count} artículo${count === 1 ? '' : 's'} todavía necesita${count === 1 ? '' : 'n'} un conteo final.`,
      uncostedDeliveries: (count: number) => `${count} línea${count === 1 ? '' : 's'} recibida${count === 1 ? '' : 's'} no tiene${count === 1 ? '' : 'n'} costo. Elige otra fuente de compras o completa los costos de las líneas.`,
      genericBlocker: 'La información del cierre mensual está incompleta.',
      negativeTitle: 'El uso estimado no puede ser negativo',
      negativeBody: 'El inventario final es mayor que el inventario inicial más las compras. Revisa el conteo final o la fuente de compras antes de cerrar.',
      closeMonth: 'Cerrar mes',
      closing: 'Cerrando…',
      finalReview: 'Revisión final',
      confirmTitle: (month: string) => `¿Cerrar ${month}?`,
      confirmBody: 'Revisa la fuente de compras y la ecuación a continuación. Al cerrar, este resultado mensual queda bloqueado para conservar un registro confiable del hotel.',
      confirmMonth: 'Mes',
      confirmLockedTitle: 'Este resultado quedará bloqueado',
      confirmLockedBody: 'Después del cierre, el mes, la fuente de compras y el uso calculado no se pueden editar desde Inventario.',
      confirmAction: (month: string) => `Cerrar ${month}`,
      closeAvailableTitle: 'El cierre aún no está disponible',
      closeAvailableBody: (date: string) => `Esta propiedad puede cerrar el período el ${date}. Prepara los costos ahora y realiza el conteo final en el período elegible de fin de mes.`,
      closed: 'El mes se cerró correctamente.',
      committedRefreshTitle: 'Se guardó la acción de cierre mensual',
      committedRefreshBody: 'El resultado guardado ya está confirmado, pero no se pudo cargar la lista actualizada. Vuelve a cargar el estado; no repitas la acción de cierre mensual.',
      actionFailed: 'No se guardó el cierre mensual. Revisa la información e inténtalo de nuevo.',
      actionFailedTitle: 'No se pudo guardar el cierre mensual',
      networkActionFailed: 'Falló la conexión y no se pudo confirmar el resultado. Reintenta esta misma acción segura o vuelve a cargar el estado del mes; el ID guardado evita duplicados.',
      timezoneChangedAction: 'La zona horaria de la propiedad cambió después de abrir este período. No se cerró nada. Un administrador debe restablecer la base del mes actual antes de registrar el uso de forma segura.',
      endingCountAction: 'No se encontró un conteo final completo y elegible. Realiza un conteo total dentro del período permitido. Si ya pasó, vuelve a cargar el mes actual; el período omitido seguirá sin cerrar.',
      baselineCountAction: 'No hay un conteo total actual para iniciar esta base. Realiza un conteo completo y vuelve a iniciar el seguimiento mensual. No se guardó nada.',
      recountAction: 'El inventario cambió alrededor del conteo elegido. No se cerró nada. Realiza un nuevo conteo completo y vuelve a intentarlo.',
      tooEarlyAction: 'Este período no puede cerrarse antes del límite mensual local del hotel. No se guardaron valores.',
      costsAction: 'Falta evidencia de costos requerida. Completa los costos señalados del artículo o de la línea recibida y vuelve a intentarlo. No se guardaron valores.',
      purchaseAction: 'La fuente de compras no coincide con la evidencia del período. Revísala y vuelve a intentarlo. No se guardaron valores.',
      requestConflictAction: 'Este reintento guardado corresponde a otros valores de cierre. Vuelve a cargar la lista antes de intentarlo.',
      missedWindowTitle: 'Se perdió el período de cierre anterior',
      missedWindowBody: 'Ese período sigue sin cerrar y está excluido; no se inventó un uso de $0. Realiza un nuevo conteo completo e inicia una base para el mes actual.',
      loadCurrentMonth: 'Volver a cargar el mes actual',
      partialTitle: 'El primer período es parcial',
      partialPreviewBody: (date: string) => `El seguimiento comienza el ${date}. Esta vista previa cubre solo desde esa base hasta el cierre, no el mes completo, y no debe tratarse como un resultado presupuestario mensual completo.`,
      partialBody: (date: string) => `El seguimiento comienza el ${date}. El uso real cubre solo desde esa base hasta el cierre, no el mes completo, y no debe tratarse como un resultado presupuestario mensual completo.`,
      closedBody: 'Este resultado está bloqueado para conservar el registro mensual.',
      closedMeta: (date: string, name: string | null) => name ? `Cerrado el ${date} por ${name}` : `Cerrado el ${date}`,
      purchaseSource: 'Fuente de compras',
      loggedSource: 'Líneas recibidas',
      manualSource: 'Un total mensual',
      zeroSource: 'Sin compras',
      budgetUnavailable: 'Las comparaciones por categoría y sección presupuestaria no están disponibles porque las compras se ingresaron como un solo total.',
    },
  }[lang];
}

function localizedActionFailure(
  failure: MonthCloseActionFailure,
  copy: ReturnType<typeof monthCloseStrings>,
): MonthCloseActionFailure {
  const message = (() => {
    switch (failure.code) {
      case 'month_close_timezone_changed': return copy.timezoneChangedAction;
      case 'month_close_ending_count_required': return copy.endingCountAction;
      case 'month_close_baseline_count_required': return copy.baselineCountAction;
      case 'month_close_recount_required': return copy.recountAction;
      case 'month_close_too_early': return copy.tooEarlyAction;
      case 'month_close_costs_incomplete': return copy.costsAction;
      case 'month_close_purchase_selection_invalid': return copy.purchaseAction;
      case 'month_close_request_conflict': return copy.requestConflictAction;
      case 'month_close_network_error': return copy.networkActionFailed;
      case 'internal_error': return copy.networkActionFailed;
      case 'month_close_negative_usage': return copy.negativeBody;
      default: return failure.message;
    }
  })();
  return { ...failure, message };
}

function money(cents: number | null, lang: Lang): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function monthLabel(month: string, lang: Lang): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatDate(value: string | null, lang: Lang, timeZone?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  if (timeZone) options.timeZone = timeZone;
  try {
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', options).format(date);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', options).format(date);
  }
}

function formatPropertyDate(value: string, lang: Lang): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function parseMoneyInput(value: string): { cents: number | null; kind: 'empty' | 'invalid' | 'valid' } {
  const trimmed = value.trim();
  if (!trimmed) return { cents: null, kind: 'empty' };
  const normalized = trimmed.replace(/,/g, '');
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return { cents: null, kind: 'invalid' };
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER / 100) {
    return { cents: null, kind: 'invalid' };
  }
  return { cents: Math.round(amount * 100), kind: 'valid' };
}

function centsToInput(cents: number | null): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2);
}

function newRequestId(): string | null {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;
}

interface PendingMonthCloseAttempt {
  storageKey: string;
  signature: string;
  payload: Record<string, unknown>;
}

function pendingAttemptKey(propertyId: string, month: string, action: 'start' | 'close'): string {
  return `hotelops.inventory-month-close.pending.${propertyId}.${month}.${action}`;
}

function readPendingAttempt(storageKey: string): PendingMonthCloseAttempt | null {
  if (typeof window === 'undefined') return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
    if (!isRecord(value) || typeof value.signature !== 'string' || !isRecord(value.payload)) return null;
    if (typeof value.payload.requestId !== 'string') return null;
    return { storageKey, signature: value.signature, payload: value.payload };
  } catch {
    return null;
  }
}

function persistPendingAttempt(attempt: PendingMonthCloseAttempt): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(attempt.storageKey, JSON.stringify({
      signature: attempt.signature,
      payload: attempt.payload,
    }));
  } catch {
    // The in-memory ref still preserves the idempotency key for this session.
  }
}

function removePendingAttempt(attempt: PendingMonthCloseAttempt | null): void {
  if (!attempt || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(attempt.storageKey);
  } catch {
    // A stale durable attempt is harmless after the server has replied
    // definitively; its frozen payload will only match the same completed action.
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function apiMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === 'string') return payload.error.message;
  return null;
}

interface MonthCloseActionFailure {
  code: string;
  message: string;
}

function apiFailure(payload: unknown, fallback: string): MonthCloseActionFailure {
  if (!isRecord(payload)) return { code: 'month_close_network_error', message: fallback };
  const nested = isRecord(payload.error) ? payload.error : null;
  const code = asText(payload.code) ?? (nested ? asText(nested.code) : null) ?? 'month_close_not_ready';
  return { code, message: apiMessage(payload) ?? fallback };
}

function isCountIssue(code: string): boolean {
  return /count|ending_quantity|stale/i.test(code);
}

function isCostIssue(code: string): boolean {
  return /cost|price|valuation/i.test(code) && !/delivery/i.test(code);
}

function isUncostedDeliveryIssue(code: string): boolean {
  return /delivery/i.test(code) && /cost|price|uncosted/i.test(code);
}

function isPurchaseChoiceIssue(code: string): boolean {
  return /purchase.*(source|confirm)|(?:source|confirm).*purchase/i.test(code);
}

function sourceLabel(source: MonthClosePurchaseSource | null, copy: ReturnType<typeof monthCloseStrings>): string {
  if (source === 'manual_total') return copy.manualSource;
  if (source === 'zero') return copy.zeroSource;
  return copy.loggedSource;
}

function issueLabel(issue: MonthCloseIssue, copy: ReturnType<typeof monthCloseStrings>): string {
  if (issue.code === 'no_logged_deliveries') return copy.noLoggedDeliveries;
  if (issue.code === 'logged_purchase_total_incomplete') return issue.message || copy.genericBlocker;
  if (isUncostedDeliveryIssue(issue.code)) return copy.uncostedDeliveries(issue.count ?? 1);
  if (isCountIssue(issue.code)) {
    if (issue.count != null && issue.count > 0) return copy.uncounted(issue.count);
    return copy.staleCount;
  }
  if (isCostIssue(issue.code)) {
    if (issue.itemName) return copy.missingCost(issue.itemName);
    if (issue.count != null && issue.count > 0) return copy.missingCosts(issue.count);
  }
  return issue.message && issue.message !== issue.code ? issue.message : copy.genericBlocker;
}

const button44: React.CSSProperties = { height: 44, minHeight: 44, justifyContent: 'center' };

function StatusBadge({ tone, children }: { tone: 'neutral' | 'good' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'good' ? T.forestText : tone === 'warn' ? T.goldText : T.ink2;
  const background = tone === 'good' ? T.forestDim : tone === 'warn' ? T.goldDim : T.inkWash;
  return (
    <span style={{
      alignItems: 'center',
      background,
      border: `1px solid ${tone === 'neutral' ? T.rule : color}33`,
      borderRadius: 999,
      color,
      display: 'inline-flex',
      fontFamily: fonts.mono,
      fontSize: 10.5,
      fontWeight: 650,
      letterSpacing: '0.055em',
      minHeight: 28,
      padding: '0 10px',
      textTransform: 'uppercase',
    }}>
      {children}
    </span>
  );
}

function Notice({
  tone,
  title,
  children,
  role,
}: {
  tone: 'info' | 'warn' | 'error' | 'success';
  title: string;
  children: React.ReactNode;
  role?: 'alert' | 'status';
}) {
  const accent = tone === 'error' ? T.terra : tone === 'warn' ? T.goldText : tone === 'success' ? T.forestText : T.brand;
  const background = tone === 'error' ? T.terraDim : tone === 'warn' ? T.goldDim : tone === 'success' ? T.forestDim : T.tealDim;
  return (
    <div role={role} style={{
      background,
      border: `1px solid ${accent}33`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 12,
      color: T.ink2,
      padding: '13px 15px',
    }}>
      <div style={{ color: T.ink, fontSize: 13, fontWeight: 650, lineHeight: 1.35 }}>{title}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 3 }}>{children}</div>
    </div>
  );
}

function EquationCard({
  label,
  value,
  detail,
  result = false,
}: {
  label: string;
  value: string;
  detail: string;
  result?: boolean;
}) {
  return (
    <div className="mc-equation-card" style={{
      background: result ? T.forestDim : T.paper,
      border: `1px solid ${result ? `${T.forestText}55` : T.rule}`,
      borderRadius: 14,
      minWidth: 0,
      padding: '15px 14px',
    }}>
      <div style={{ color: result ? T.forestText : T.ink3, fontFamily: fonts.mono, fontSize: 10, fontWeight: 650, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ color: T.ink, fontFamily: fonts.sans, fontSize: 21, fontWeight: 680, letterSpacing: '-0.035em', marginTop: 8 }}>
        {value}
      </div>
      <div style={{ color: T.ink3, fontSize: 11, lineHeight: 1.4, marginTop: 5 }}>{detail}</div>
    </div>
  );
}

function Equation({
  lang,
  beginningCents,
  purchaseCents,
  endingCents,
  actualCents,
  purchaseDetail,
  isPreview = false,
  copy,
}: {
  lang: Lang;
  beginningCents: number | null;
  purchaseCents: number | null;
  endingCents: number | null;
  actualCents: number | null;
  purchaseDetail: string;
  isPreview?: boolean;
  copy: ReturnType<typeof monthCloseStrings>;
}) {
  const beginning = money(beginningCents, lang);
  const purchases = money(purchaseCents, lang);
  const ending = money(endingCents, lang);
  const actual = money(actualCents, lang);
  return (
    <div
      className="mc-equation"
      role="group"
      aria-label={isPreview
        ? copy.previewEquationLabel(beginning, purchases, ending, actual)
        : copy.equationLabel(beginning, purchases, ending, actual)}
    >
      <EquationCard label={copy.beginning} value={beginning} detail={copy.openingBaseline} />
      <span className="mc-operator" aria-hidden="true">+</span>
      <EquationCard label={copy.purchases} value={purchases} detail={purchaseDetail} />
      <span className="mc-operator" aria-hidden="true">−</span>
      <EquationCard label={copy.ending} value={ending} detail={endingCents == null ? copy.countNeeded : copy.latestCount} />
      <span className="mc-operator mc-equals" aria-hidden="true">=</span>
      <EquationCard
        label={isPreview ? copy.estimatedUsage : copy.actualUsed}
        value={actual}
        detail={isPreview ? copy.previewFormulaResult : copy.formulaResult}
        result
      />
    </div>
  );
}

function PurchaseOption({
  id,
  checked,
  value,
  onChange,
  title,
  amount,
  body,
  detail,
  children,
}: {
  id: string;
  checked: boolean;
  value: MonthClosePurchaseSource;
  onChange: (value: MonthClosePurchaseSource) => void;
  title: string;
  amount?: string;
  body: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`mc-purchase-option${checked ? ' is-selected' : ''}`}>
      <label className="mc-option-head" htmlFor={id}>
        <input
          id={id}
          className="mc-radio"
          type="radio"
          name="month-close-purchase-source"
          value={value}
          checked={checked}
          onChange={() => onChange(value)}
        />
        <span style={{ minWidth: 0 }}>
          <span className="mc-option-title-row">
            <span className="mc-option-title">{title}</span>
            {amount && <span className="mc-option-amount">{amount}</span>}
          </span>
          <span className="mc-option-body">{body}</span>
          {detail && <span className="mc-option-detail">{detail}</span>}
        </span>
      </label>
      {children}
    </div>
  );
}

function LoadingState({ copy }: { copy: ReturnType<typeof monthCloseStrings> }) {
  return (
    <div role="status" aria-live="polite" className="mc-loading-state">
      <span className="mc-sr-only">{copy.loadingTitle}. {copy.loadingBody}</span>
      <div className="mc-loading-visual" aria-hidden="true">
        <div className="mc-loading-section">
          <span className="mc-skeleton mc-skeleton-badge" />
          <span className="mc-skeleton mc-skeleton-title" />
          <span className="mc-skeleton mc-skeleton-copy" />
          <div className="mc-loading-equation">
            {[0, 1, 2, 3].map((index) => (
              <span className="mc-loading-equation-card" key={index}>
                <span className="mc-skeleton mc-skeleton-label" />
                <span className="mc-skeleton mc-skeleton-value" />
                <span className="mc-skeleton mc-skeleton-detail" />
              </span>
            ))}
          </div>
        </div>
        <div className="mc-loading-section">
          <span className="mc-skeleton mc-skeleton-title mc-skeleton-title-short" />
          <span className="mc-skeleton mc-skeleton-copy" />
          <div className="mc-loading-options">
            {[0, 1, 2].map((index) => (
              <span className="mc-loading-option" key={index}>
                <span className="mc-skeleton mc-skeleton-radio" />
                <span className="mc-skeleton mc-skeleton-option-copy" />
              </span>
            ))}
          </div>
        </div>
        <div className="mc-loading-readiness">
          {[0, 1].map((index) => (
            <span className="mc-loading-check" key={index}>
              <span className="mc-skeleton mc-skeleton-check-copy" />
              <span className="mc-skeleton mc-skeleton-check-badge" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MonthClosePanel({ lang, open, onClose, onStartCount, onChanged }: MonthClosePanelProps) {
  const { activePropertyId } = useProperty();
  const copy = useMemo(() => monthCloseStrings(lang), [lang]);
  const [propertyDashboard, setPropertyDashboard] = useState<MonthCloseDashboardView | null>(null);
  const [loading, setLoading] = useState(false);
  const [failedPropertyId, setFailedPropertyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [committedRefreshPending, setCommittedRefreshPending] = useState(false);
  const [mutationError, setMutationError] = useState<MonthCloseActionFailure | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [purchaseSource, setPurchaseSource] = useState<MonthClosePurchaseSource>('logged_deliveries');
  const [manualPurchase, setManualPurchase] = useState('');
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const pendingAttemptRef = useRef<PendingMonthCloseAttempt | null>(null);
  const activePropertyIdRef = useRef(activePropertyId);
  activePropertyIdRef.current = activePropertyId;
  const cancelConfirmationRef = useRef<HTMLButtonElement>(null);
  const closeMonthButtonRef = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const purchaseHelpId = useId();
  const manualHelpId = useId();
  // The state stays mounted between opens. Gate it synchronously so a hotel
  // switch can never paint the previous property's financial checklist while
  // the next request's effect is still waiting to run.
  const dashboard = propertyDashboard?.propertyId === activePropertyId
    ? propertyDashboard
    : null;
  const loadError = failedPropertyId === activePropertyId;

  const applyDashboard = useCallback((next: MonthCloseDashboardView) => {
    setPropertyDashboard(next);
    setCommittedRefreshPending(false);
    setPurchaseSource(next.purchase.source ?? 'logged_deliveries');
    setManualPurchase(centsToInput(next.purchase.manualPurchaseCents));
    const propertyId = next.propertyId || activePropertyId;
    if (propertyId && next.status !== 'not_started') {
      const key = pendingAttemptKey(propertyId, next.month, 'start');
      removePendingAttempt(readPendingAttempt(key));
      if (pendingAttemptRef.current?.storageKey === key) pendingAttemptRef.current = null;
    }
    if (propertyId && next.status === 'closed') {
      const key = pendingAttemptKey(propertyId, next.month, 'close');
      removePendingAttempt(readPendingAttempt(key));
      if (pendingAttemptRef.current?.storageKey === key) pendingAttemptRef.current = null;
    }
  }, [activePropertyId]);

  const loadDashboard = useCallback(async (showLoading = true): Promise<MonthCloseDashboardView | null> => {
    if (!activePropertyId) {
      setPropertyDashboard(null);
      setFailedPropertyId(null);
      setLoading(false);
      return null;
    }

    const propertyId = activePropertyId;
    const sequence = ++requestSequence.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    if (showLoading) setLoading(true);
    setFailedPropertyId((current) => current === propertyId ? null : current);

    try {
      const response = await fetchWithAuth(
        `/api/inventory/month-close?propertyId=${encodeURIComponent(propertyId)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(apiMessage(payload) ?? `HTTP ${response.status}`);
      const next = normalizeMonthCloseDashboardForProperty(payload, propertyId);
      if (!next) throw new Error('INVALID_MONTH_CLOSE_DASHBOARD');
      if (sequence === requestSequence.current) applyDashboard(next);
      return next;
    } catch {
      if (controller.signal.aborted) return null;
      if (sequence === requestSequence.current) setFailedPropertyId(propertyId);
      return null;
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [activePropertyId, applyDashboard]);

  useEffect(() => {
    mutationSequence.current += 1;
    setSaving(false);
    setConfirmingClose(false);
    setCommittedRefreshPending(false);
    if (!open) {
      loadAbort.current?.abort();
      return;
    }
    setMutationError(null);
    setStatusMessage(null);
    void loadDashboard(true);
    return () => loadAbort.current?.abort();
  }, [open, activePropertyId, loadDashboard]);

  useEffect(() => {
    if (!confirmingClose) return;
    const frame = requestAnimationFrame(() => {
      cancelConfirmationRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [confirmingClose]);

  const manualParsed = useMemo(() => parseMoneyInput(manualPurchase), [manualPurchase]);
  const manualError = purchaseSource === 'manual_total'
    ? manualParsed.kind === 'invalid'
      ? copy.manualInvalid
      : manualParsed.cents == null || manualParsed.cents <= 0
        ? copy.manualRequired
        : null
    : null;

  const selectedPurchaseCents = dashboard
    ? purchaseSource === 'logged_deliveries'
      ? dashboard.purchase.loggedPurchaseCents
      : purchaseSource === 'manual_total'
        ? manualParsed.cents
        : 0
    : null;

  // Manual-total closes value the ending physical count with the cost saved
  // by that count. Other sources use the API's WAC/carried-cost preview.
  const manualEndingCents = dashboard
    ? dashboard.items.reduce<number | null>((sum, item) => {
        if (sum == null || item.endingQuantity == null) return null;
        if (item.endingQuantity === 0) return sum;
        if (item.physicalUnitCostCents == null) return null;
        return sum + Math.round(item.endingQuantity * item.physicalUnitCostCents);
      }, 0)
    : null;
  const selectedEndingCents = purchaseSource === 'manual_total'
    ? manualEndingCents
    : dashboard?.totals.endingCents ?? null;

  const actualCents = dashboard?.status === 'closed'
    ? dashboard.totals.actualUsageCents
    : dashboard?.totals.beginningCents != null
      && selectedPurchaseCents != null
      && selectedEndingCents != null
      ? dashboard.totals.beginningCents + selectedPurchaseCents - selectedEndingCents
      : null;
  const negativeActual = actualCents != null && actualCents < 0;

  const effectiveBlockers = useMemo(() => {
    if (!dashboard) return [];
    const blockers = dashboard.completeness.blockers.filter((issue) => {
      if (isPurchaseChoiceIssue(issue.code)) return false;
      if (issue.code === 'no_logged_deliveries') return purchaseSource === 'logged_deliveries';
      if (isUncostedDeliveryIssue(issue.code)) return purchaseSource === 'logged_deliveries';
      return true;
    });
    if (
      dashboard.status === 'open'
      && purchaseSource === 'logged_deliveries'
      && dashboard.purchase.uncostedDeliveryCount > 0
      && !blockers.some((issue) => isUncostedDeliveryIssue(issue.code))
    ) {
      blockers.push({
        code: 'uncosted_deliveries',
        message: '',
        itemId: null,
        itemName: null,
        count: dashboard.purchase.uncostedDeliveryCount,
      });
    }
    if (
      dashboard.status === 'open'
      && purchaseSource === 'logged_deliveries'
      && dashboard.purchase.loggedDeliveryCount === 0
      && !blockers.some((issue) => issue.code === 'no_logged_deliveries')
    ) {
      blockers.push({
        code: 'no_logged_deliveries',
        message: '',
        itemId: null,
        itemName: null,
        count: null,
      });
    } else if (
      dashboard.status === 'open'
      && purchaseSource === 'logged_deliveries'
      && dashboard.purchase.loggedPurchaseCents == null
      && !blockers.some((issue) => isUncostedDeliveryIssue(issue.code))
    ) {
      blockers.push({
        code: 'logged_purchase_total_incomplete',
        message: copy.loggedIncomplete(money(dashboard.purchase.knownLoggedPurchaseCents, lang)),
        itemId: null,
        itemName: null,
        count: null,
      });
    }
    if (
      dashboard.status === 'open'
      && dashboard.totals.endingCents == null
      && !blockers.some((issue) => isCountIssue(issue.code))
    ) {
      const countable = dashboard.items.filter((item) => item.archivedAt == null);
      const counted = countable.filter((item) => item.endingCountedAt != null).length;
      blockers.push({
        code: 'ending_count_required',
        message: '',
        itemId: null,
        itemName: null,
        count: Math.max(0, countable.length - counted) || null,
      });
    }
    return blockers;
  }, [copy, dashboard, lang, purchaseSource]);

  const costBlockers = effectiveBlockers.filter((issue) => isCostIssue(issue.code));
  const countBlockers = effectiveBlockers.filter((issue) => isCountIssue(issue.code));
  const countableItems = dashboard?.items.filter((item) => item.archivedAt == null) ?? [];
  const countedItems = countableItems.filter((item) => item.endingCountedAt != null).length;
  const itemCount = countableItems.length;
  const latestCountAt = countableItems.reduce<string | null>((latest, item) => {
    if (!item.endingCountedAt) return latest;
    if (!latest) return item.endingCountedAt;
    return new Date(item.endingCountedAt).getTime() > new Date(latest).getTime()
      ? item.endingCountedAt
      : latest;
  }, null) ?? null;
  const missedWindowWarning = dashboard?.completeness.warnings.find(
    (issue) => issue.code === 'expired_prior_period_rebaseline_required',
  ) ?? null;
  const setupWarnings = dashboard?.completeness.warnings.filter(
    (issue) => issue.code !== 'expired_prior_period_rebaseline_required',
  ) ?? [];
  const hotelCurrentMonth = (() => {
    if (!dashboard?.timezone) return null;
    try { return inventoryMonthKeyInZone(new Date(), dashboard.timezone); } catch { return null; }
  })();
  const recoveryNeedsCount = mutationError?.code === 'month_close_recount_required'
    || mutationError?.code === 'month_close_ending_count_required'
    || mutationError?.code === 'month_close_baseline_count_required';
  const recoveryNeedsCurrentMonth = mutationError?.code === 'month_close_ending_count_required'
    && hotelCurrentMonth != null
    && dashboard != null
    && dashboard.month < hotelCurrentMonth;
  const countReady = countBlockers.length === 0 && (itemCount === 0 || countedItems === itemCount);
  const costsReady = costBlockers.length === 0;
  const baselineBlocked = !dashboard
    || !dashboard.canStart
    || dashboard.totals.beginningCents == null
    || dashboard.completeness.blockers.filter((issue) => !isPurchaseChoiceIssue(issue.code)).length > 0;
  const closeBlocked = !dashboard
    || !dashboard.canClose
    || dashboard.totals.beginningCents == null
    || selectedEndingCents == null
    || selectedPurchaseCents == null
    || Boolean(manualError)
    || effectiveBlockers.length > 0
    || negativeActual;

  const title = dashboard ? monthLabel(dashboard.month, lang) : copy.fallbackTitle;
  // Effects run after paint, so `loading` alone cannot describe the very first
  // frame. This keeps the initial render in the full-size loading layout rather
  // than briefly presenting an error panel before the request starts.
  const showInitialLoading = Boolean(activePropertyId) && !dashboard && !loadError;
  const showPartialNotice = dashboard?.isPartial === true;
  const partialDate = formatDate(
    dashboard?.activityStartAt ?? dashboard?.baselineAt ?? null,
    lang,
    dashboard?.timezone,
  );

  const handleStartCount = () => {
    if (saving) return;
    onClose();
    onStartCount();
  };

  const cancelCloseConfirmation = () => {
    setConfirmingClose(false);
    requestAnimationFrame(() => {
      closeMonthButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const handlePanelClose = () => {
    if (saving) return;
    if (confirmingClose) {
      cancelCloseConfirmation();
      return;
    }
    onClose();
  };

  const reloadRecovery = async () => {
    setMutationError(null);
    await loadDashboard(true);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dashboard || !activePropertyId || saving) return;
    const action = dashboard.status === 'not_started' ? 'start' : dashboard.status === 'open' ? 'close' : null;
    if (!action || (action === 'start' ? baselineBlocked : closeBlocked)) return;
    if (action === 'close' && !confirmingClose) {
      setMutationError(null);
      setStatusMessage(null);
      setConfirmingClose(true);
      return;
    }

    const basePayload: Record<string, unknown> = {
      propertyId: activePropertyId,
      month: dashboard.month,
      action,
    };
    if (action === 'close') {
      basePayload.purchaseSource = purchaseSource;
      if (purchaseSource === 'manual_total') basePayload.manualPurchaseCents = manualParsed.cents;
    }
    const signature = JSON.stringify(basePayload);
    const storageKey = pendingAttemptKey(activePropertyId, dashboard.month, action);
    let attempt = pendingAttemptRef.current?.storageKey === storageKey
      ? pendingAttemptRef.current
      : readPendingAttempt(storageKey);
    if (!attempt || attempt.signature !== signature) {
      const requestId = newRequestId();
      if (!requestId) {
        setMutationError({ code: 'month_close_network_error', message: copy.networkActionFailed });
        return;
      }
      attempt = {
        storageKey,
        signature,
        payload: Object.freeze({ ...basePayload, requestId }),
      };
      persistPendingAttempt(attempt);
    }
    pendingAttemptRef.current = attempt;

    const clearAttempt = () => {
      removePendingAttempt(attempt);
      if (pendingAttemptRef.current?.storageKey === attempt?.storageKey) pendingAttemptRef.current = null;
    };
    const mutationScope = {
      propertyId: activePropertyId,
      sequence: ++mutationSequence.current,
    };
    const mutationRequestId = asText(attempt.payload.requestId);
    const mutationIsCurrent = () => isCurrentMonthCloseMutation(
      mutationScope,
      activePropertyIdRef.current,
      mutationSequence.current,
    );

    setSaving(true);
    setCommittedRefreshPending(false);
    setMutationError(null);
    setStatusMessage(null);
    try {
      const response = await fetchWithAuth('/api/inventory/month-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt.payload),
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        const definitiveClientFailure = response.status >= 400
          && response.status < 500
          && response.status !== 408
          && response.status !== 429;
        if (definitiveClientFailure) clearAttempt();
        if (!mutationIsCurrent()) return;
        setMutationError(localizedActionFailure(apiFailure(payload, copy.actionFailed), copy));
        return;
      }

      const returned = normalizeMonthCloseDashboardForProperty(payload, mutationScope.propertyId);
      const receipt = normalizeMonthCloseMutationReceipt(payload);
      const validReceipt = receipt != null
        && receipt.propertyId === mutationScope.propertyId
        && receipt.month === dashboard.month
        && receipt.action === action
        && receipt.mutationRequestId === mutationRequestId;
      if (!returned && !validReceipt) throw new Error('INVALID_MONTH_CLOSE_MUTATION_RESPONSE');
      clearAttempt();
      if (!mutationIsCurrent()) return;

      if (returned) {
        applyDashboard(returned);
      } else {
        const refreshed = await loadDashboard(false);
        if (!mutationIsCurrent()) return;
        if (!refreshed) setCommittedRefreshPending(true);
      }
      setConfirmingClose(false);
      setStatusMessage(action === 'start' ? copy.started : copy.closed);
      onChanged?.();
    } catch {
      if (!mutationIsCurrent()) return;
      setMutationError({ code: 'month_close_network_error', message: copy.networkActionFailed });
    } finally {
      if (mutationIsCurrent()) setSaving(false);
    }
  };

  let footer: React.ReactNode = (
    <Btn className="mc-button" variant="ghost" style={button44} onClick={onClose} disabled={saving}>
      {dashboard?.status === 'closed' ? copy.done : copy.cancel}
    </Btn>
  );
  if (dashboard?.status === 'not_started' && !loading && !loadError) {
    footer = (
      <>
        <Btn className="mc-button" variant="ghost" style={button44} onClick={onClose} disabled={saving}>{copy.cancel}</Btn>
        <Btn className="mc-button" variant="primary" style={button44} type="submit" form={formId} disabled={saving || baselineBlocked}>
          {saving ? copy.starting : copy.startTracking}
        </Btn>
      </>
    );
  } else if (dashboard?.status === 'open' && !loading && !loadError && confirmingClose) {
    footer = (
      <>
        <Btn
          ref={cancelConfirmationRef}
          className="mc-button"
          variant="ghost"
          style={button44}
          onClick={cancelCloseConfirmation}
          disabled={saving}
          aria-describedby={`${formId}-confirm-title ${formId}-confirm-copy`}
        >
          {copy.cancel}
        </Btn>
        <Btn
          className="mc-button"
          variant="primary"
          style={button44}
          type="submit"
          form={formId}
          disabled={saving}
          aria-busy={saving}
          aria-describedby={`${formId}-confirm-title ${formId}-confirm-copy`}
        >
          {saving ? copy.closing : copy.confirmAction(title)}
        </Btn>
      </>
    );
  } else if (dashboard?.status === 'open' && !loading && !loadError) {
    footer = (
      <>
        <Btn className="mc-button" variant="ghost" style={button44} onClick={onClose} disabled={saving}>{copy.cancel}</Btn>
        <Btn
          ref={closeMonthButtonRef}
          className="mc-button"
          variant="primary"
          style={button44}
          type="submit"
          form={formId}
          disabled={saving || closeBlocked}
        >
          {saving ? copy.closing : copy.closeMonth}
        </Btn>
      </>
    );
  }

  return (
    <Overlay
      open={open}
      onClose={handlePanelClose}
      eyebrow={copy.eyebrow}
      title={title}
      accent={T.brand}
      width={780}
      footer={footer}
    >
      <style>{`
        .mc-root { color: ${T.ink}; font-family: ${fonts.sans}; min-height: min(700px, calc(90vh - 120px)); }
        .mc-stack { display: flex; flex-direction: column; gap: 16px; }
        .mc-state-panel { align-items: center; background: ${T.inkWash}; border: 1px solid ${T.rule}; border-radius: 14px; display: flex; gap: 14px; min-height: 128px; padding: 24px; }
        .mc-state-title { color: ${T.ink}; font-size: 15px; font-weight: 650; line-height: 1.35; }
        .mc-state-body { color: ${T.ink2}; font-size: 12.5px; line-height: 1.55; margin-top: 4px; }
        .mc-spinner { animation: mc-spin .8s linear infinite; border: 2px solid ${T.rule}; border-radius: 50%; border-top-color: ${T.brand}; display: block; flex: 0 0 auto; height: 24px; width: 24px; }
        .mc-loading-state, .mc-loading-visual { min-width: 0; }
        .mc-loading-visual { display: flex; flex-direction: column; gap: 16px; }
        .mc-loading-section { background: ${T.paper}; border: 1px solid ${T.rule}; border-radius: 14px; padding: 17px; }
        .mc-loading-equation { display: grid; gap: 8px; grid-template-columns: repeat(4,minmax(0,1fr)); margin-top: 17px; }
        .mc-loading-equation-card { border: 1px solid ${T.rule}; border-radius: 14px; display: flex; flex-direction: column; gap: 9px; min-height: 112px; padding: 15px 14px; }
        .mc-loading-options { display: grid; gap: 9px; margin-top: 14px; }
        .mc-loading-option { align-items: center; border: 1px solid ${T.controlBorder}; border-radius: 12px; display: grid; gap: 11px; grid-template-columns: 20px minmax(0,1fr); min-height: 58px; padding: 13px 14px; }
        .mc-loading-readiness { display: grid; gap: 9px; grid-template-columns: repeat(2,minmax(0,1fr)); }
        .mc-loading-check { align-items: center; background: ${T.inkWash}; border: 1px solid ${T.rule}; border-radius: 11px; display: flex; gap: 14px; justify-content: space-between; min-height: 66px; padding: 12px; }
        .mc-skeleton { background: ${T.ruleSoft}; border-radius: 4px; display: block; overflow: hidden; position: relative; }
        .mc-skeleton::after { animation: mc-skeleton-shimmer 1.5s ease-in-out infinite; background: linear-gradient(90deg,transparent,${T.paper},transparent); content: ''; inset: 0; opacity: .72; position: absolute; transform: translateX(-100%); }
        .mc-skeleton-badge { border-radius: 999px; height: 28px; width: 118px; }
        .mc-skeleton-title { height: 18px; margin-top: 13px; width: 46%; }
        .mc-skeleton-title-short { margin-top: 0; width: 34%; }
        .mc-skeleton-copy { height: 12px; margin-top: 7px; width: 76%; }
        .mc-skeleton-label { height: 10px; width: 54%; }
        .mc-skeleton-value { height: 21px; width: 72%; }
        .mc-skeleton-detail { height: 10px; width: 88%; }
        .mc-skeleton-radio { border-radius: 999px; height: 20px; width: 20px; }
        .mc-skeleton-option-copy { height: 13px; width: 68%; }
        .mc-skeleton-check-copy { height: 13px; width: 54%; }
        .mc-skeleton-check-badge { border-radius: 999px; height: 24px; width: 68px; }
        .mc-sr-only { border: 0; clip: rect(0,0,0,0); height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; white-space: nowrap; width: 1px; }
        .mc-section { background: ${T.paper}; border: 1px solid ${T.rule}; border-radius: 14px; padding: 17px; }
        .mc-section-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
        .mc-section-title { color: ${T.ink}; font-size: 14px; font-weight: 670; line-height: 1.35; }
        .mc-section-copy { color: ${T.ink2}; font-size: 12.5px; line-height: 1.55; margin-top: 4px; max-width: 620px; }
        .mc-baseline { align-items: end; background: ${T.tealDim}; border: 1px solid rgba(62,92,72,.20); border-radius: 14px; display: flex; gap: 20px; justify-content: space-between; padding: 18px; }
        .mc-baseline-label { color: ${T.ink2}; font-family: ${fonts.mono}; font-size: 10.5px; font-weight: 650; letter-spacing: .055em; text-transform: uppercase; }
        .mc-baseline-value { color: ${T.ink}; font-size: 30px; font-weight: 690; letter-spacing: -.045em; line-height: 1.1; margin-top: 8px; }
        .mc-baseline-detail { color: ${T.ink2}; font-size: 11.5px; line-height: 1.45; margin-top: 7px; }
        .mc-equation { align-items: stretch; display: grid; gap: 8px; grid-template-columns: minmax(112px,1fr) 20px minmax(112px,1fr) 20px minmax(112px,1fr) 20px minmax(126px,1.08fr); }
        .mc-operator { align-items: center; color: ${T.ink2}; display: flex; font-family: ${fonts.mono}; font-size: 20px; font-weight: 500; justify-content: center; }
        .mc-purchases { border: 0; margin: 0; min-width: 0; padding: 0; }
        .mc-purchases legend { color: ${T.ink}; float: left; font-size: 14px; font-weight: 670; line-height: 1.35; padding: 0; width: 100%; }
        .mc-purchases-help { clear: both; color: ${T.ink2}; font-size: 12.5px; line-height: 1.55; margin: 4px 0 13px; }
        .mc-options { display: grid; gap: 9px; }
        .mc-purchase-option { background: ${T.paper}; border: 1px solid ${T.controlBorder}; border-radius: 12px; cursor: pointer; display: block; padding: 13px 14px; transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease; }
        .mc-purchase-option:hover { background: ${T.inkWash}; }
        .mc-purchase-option.is-selected { background: ${T.tealDim}; border-color: ${T.brand}; box-shadow: 0 0 0 1px ${T.brand}; }
        .mc-purchase-option:focus-within { outline: 3px solid rgba(62,92,72,.30); outline-offset: 3px; }
        .mc-option-head { align-items: flex-start; display: grid; gap: 11px; grid-template-columns: 20px minmax(0,1fr); }
        .mc-radio { accent-color: ${T.brand}; height: 20px; margin: 1px 0 0; width: 20px; }
        .mc-radio:focus-visible, .mc-money-input:focus-visible, .mc-button:focus-visible { outline: 3px solid rgba(62,92,72,.30); outline-offset: 3px; }
        .mc-option-title-row { align-items: baseline; display: flex; gap: 12px; justify-content: space-between; }
        .mc-option-title { color: ${T.ink}; font-size: 13px; font-weight: 650; line-height: 1.4; }
        .mc-option-amount { color: ${T.ink}; flex: none; font-family: ${fonts.mono}; font-size: 12px; font-weight: 650; }
        .mc-option-body, .mc-option-detail { color: ${T.ink2}; display: block; font-size: 11.5px; line-height: 1.5; margin-top: 3px; }
        .mc-option-detail { color: ${T.ink2}; }
        .mc-money-wrap { margin: 12px 0 2px 31px; max-width: 270px; }
        .mc-money-label { color: ${T.ink}; display: block; font-size: 11.5px; font-weight: 620; margin-bottom: 6px; }
        .mc-money-control { align-items: center; background: ${T.paper}; border: 1px solid ${T.controlBorder}; border-radius: 10px; display: flex; min-height: 48px; overflow: hidden; }
        .mc-money-prefix { color: ${T.ink2}; flex: 0 0 auto; font-family: ${fonts.mono}; font-size: 14px; padding-left: 13px; }
        .mc-money-input { background: transparent; border: 0; color: ${T.ink}; flex: 1; font-family: ${fonts.mono}; font-size: 15px; height: 46px; min-width: 0; outline: 0; padding: 0 13px 0 5px; }
        .mc-money-control:focus-within { border-color: ${T.brand}; box-shadow: 0 0 0 1px ${T.brand}; }
        .mc-money-error { color: ${T.terra}; font-size: 11.5px; line-height: 1.45; margin-top: 6px; }
        .mc-readiness-grid { display: grid; gap: 9px; grid-template-columns: repeat(2,minmax(0,1fr)); margin-top: 13px; }
        .mc-check-card { align-items: flex-start; background: ${T.inkWash}; border: 1px solid ${T.rule}; border-radius: 11px; display: flex; gap: 10px; justify-content: space-between; min-height: 66px; padding: 12px; }
        .mc-check-label { color: ${T.ink}; font-size: 12px; font-weight: 630; line-height: 1.4; }
        .mc-check-detail { color: ${T.ink2}; font-size: 11.5px; line-height: 1.45; margin-top: 3px; }
        .mc-check-status { border-radius: 999px; flex: none; font-family: ${fonts.mono}; font-size: 9.5px; font-weight: 700; letter-spacing: .04em; padding: 5px 7px; text-transform: uppercase; }
        .mc-check-status.is-ready { background: ${T.forestDim}; color: ${T.forestText}; }
        .mc-check-status.is-blocked { background: ${T.goldDim}; color: ${T.goldText}; }
        .mc-issues { margin: 0; padding-left: 19px; }
        .mc-issues li { color: ${T.ink2}; font-size: 12px; line-height: 1.5; margin: 4px 0; }
        .mc-closed-meta { color: ${T.ink2}; font-size: 12px; line-height: 1.5; }
        .mc-confirm { display: flex; flex-direction: column; gap: 16px; }
        .mc-confirm-title { color: ${T.ink}; font-size: 22px; font-weight: 680; letter-spacing: -.025em; line-height: 1.2; margin: 0; }
        .mc-confirm-copy { color: ${T.ink2}; font-size: 13.5px; line-height: 1.55; margin: 5px 0 0; max-width: 620px; }
        .mc-confirm-meta { display: grid; gap: 8px; grid-template-columns: repeat(2,minmax(0,1fr)); margin: 0; }
        .mc-confirm-meta > div { background: ${T.inkWash}; border: 1px solid ${T.rule}; border-radius: 12px; padding: 12px 14px; }
        .mc-confirm-meta dt { color: ${T.ink3}; font-family: ${fonts.mono}; font-size: 9.5px; font-weight: 650; letter-spacing: .055em; text-transform: uppercase; }
        .mc-confirm-meta dd { color: ${T.ink}; font-size: 13px; font-weight: 650; line-height: 1.4; margin: 5px 0 0; }
        @keyframes mc-spin { to { transform: rotate(360deg); } }
        @keyframes mc-skeleton-shimmer { to { transform: translateX(100%); } }
        @media (max-width: 760px) {
          .mc-root { min-height: 0; }
          .mc-loading-equation { grid-template-columns: repeat(2,minmax(0,1fr)); }
        }
        @media (max-width: 680px) {
          .mc-equation { grid-template-columns: 1fr; }
          .mc-operator { min-height: 16px; }
          .mc-baseline { align-items: stretch; flex-direction: column; }
          .mc-readiness-grid { grid-template-columns: 1fr; }
          .mc-section-head { flex-direction: column; }
          .mc-section-head .mc-button { width: 100%; }
          .mc-confirm-meta { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) {
          .mc-spinner { animation: none; }
          .mc-skeleton::after { animation: none; }
          .mc-purchase-option, .mc-button { transition: none !important; }
        }
      `}</style>

      <form
        id={formId}
        className="mc-root mc-stack"
        onSubmit={submit}
        noValidate
        aria-busy={loading || showInitialLoading}
      >
        {statusMessage && (
          <div aria-live="polite" aria-atomic="true">
            <Notice tone="success" title={statusMessage} role="status">{dashboard?.status === 'closed' ? copy.closedBody : copy.openIntro}</Notice>
          </div>
        )}
        {mutationError && (
          <Notice tone="error" title={copy.actionFailedTitle} role="alert">
            <div>{mutationError.message}</div>
            {recoveryNeedsCount && (
              <div style={{ marginTop: 10 }}>
                <Btn
                  className="mc-button"
                  variant="ghost"
                  style={button44}
                  onClick={recoveryNeedsCurrentMonth ? () => void reloadRecovery() : handleStartCount}
                >
                  {recoveryNeedsCurrentMonth ? copy.loadCurrentMonth : copy.startCount}
                </Btn>
              </div>
            )}
          </Notice>
        )}

        {confirmingClose && dashboard?.status === 'open' ? (
          <section
            className="mc-confirm"
            role="region"
            aria-labelledby={`${formId}-confirm-title`}
            aria-describedby={`${formId}-confirm-copy`}
          >
            <div>
              <StatusBadge tone="warn">{copy.finalReview}</StatusBadge>
              <h2 id={`${formId}-confirm-title`} className="mc-confirm-title" style={{ marginTop: 13 }}>
                {copy.confirmTitle(title)}
              </h2>
              <p id={`${formId}-confirm-copy`} className="mc-confirm-copy">{copy.confirmBody}</p>
            </div>
            <dl className="mc-confirm-meta">
              <div>
                <dt>{copy.confirmMonth}</dt>
                <dd>{title}</dd>
              </div>
              <div>
                <dt>{copy.purchaseSource}</dt>
                <dd>{sourceLabel(purchaseSource, copy)}</dd>
              </div>
            </dl>
            <Equation
              lang={lang}
              beginningCents={dashboard.totals.beginningCents}
              purchaseCents={selectedPurchaseCents}
              endingCents={selectedEndingCents}
              actualCents={actualCents}
              purchaseDetail={sourceLabel(purchaseSource, copy)}
              copy={copy}
            />
            <Notice tone="warn" title={copy.confirmLockedTitle} role="status">
              {copy.confirmLockedBody}
            </Notice>
          </section>
        ) : !activePropertyId ? (
          <Notice tone="info" title={copy.noPropertyTitle}>{copy.noPropertyBody}</Notice>
        ) : loading || showInitialLoading ? (
          <LoadingState copy={copy} />
        ) : loadError || !dashboard ? (
          <div className="mc-state-panel" role={committedRefreshPending ? 'status' : 'alert'}>
            <div style={{ flex: 1 }}>
              <div className="mc-state-title">
                {committedRefreshPending ? copy.committedRefreshTitle : copy.loadErrorTitle}
              </div>
              <div className="mc-state-body">
                {committedRefreshPending ? copy.committedRefreshBody : copy.loadErrorBody}
              </div>
            </div>
            <Btn className="mc-button" variant="ghost" style={button44} onClick={() => void loadDashboard(true)}>{copy.retry}</Btn>
          </div>
        ) : dashboard.status === 'not_started' ? (
          <>
            {missedWindowWarning && (
              <Notice tone="warn" title={copy.missedWindowTitle} role="status">
                <div>{copy.missedWindowBody}</div>
                <div style={{ marginTop: 10 }}>
                  <Btn className="mc-button" variant="ghost" style={button44} onClick={handleStartCount}>
                    {copy.startCount}
                  </Btn>
                </div>
              </Notice>
            )}
            <section className="mc-section mc-stack" aria-labelledby={`${formId}-setup-title`}>
              <div>
                <StatusBadge tone="warn">{copy.statusSetup}</StatusBadge>
                <h2 id={`${formId}-setup-title`} className="mc-section-title" style={{ fontSize: 18, margin: '13px 0 0' }}>{copy.setupTitle}</h2>
                <p className="mc-section-copy" style={{ marginBottom: 0 }}>{copy.setupBody}</p>
              </div>
              <div className="mc-baseline">
                <div>
                  <div className="mc-baseline-label">{copy.beginningInventory}</div>
                  <div className="mc-baseline-value">{dashboard.totals.beginningCents == null ? '—' : money(dashboard.totals.beginningCents, lang)}</div>
                  <div className="mc-baseline-detail">{dashboard.totals.beginningCents == null ? copy.valueUnavailable : copy.fromCurrentCount}</div>
                </div>
                <Btn className="mc-button" variant="ghost" style={button44} onClick={handleStartCount}>{copy.startCount}</Btn>
              </div>
            </section>

            {showPartialNotice && <Notice tone="warn" title={copy.partialTitle}>{copy.partialPreviewBody(partialDate)}</Notice>}

            <ReadinessSection
              titleId={`${formId}-setup-readiness`}
              copy={copy}
              countedItems={countedItems}
              itemCount={itemCount}
              latestCountDate={latestCountAt ? formatDate(latestCountAt, lang, dashboard.timezone) : null}
              countReady={countReady}
              costsReady={costsReady}
              blockers={dashboard.completeness.blockers}
              warnings={setupWarnings}
              onStartCount={handleStartCount}
            />
          </>
        ) : dashboard.status === 'open' ? (
          <>
            <section className="mc-section mc-stack" aria-labelledby={`${formId}-equation-title`}>
              <div>
                <StatusBadge tone="good">{copy.statusOpen}</StatusBadge>
                <h2 id={`${formId}-equation-title`} className="mc-section-title" style={{ fontSize: 18, margin: '13px 0 0' }}>{copy.estimatedUsage}</h2>
                <p className="mc-section-copy" style={{ marginBottom: 0 }}>{copy.openIntro}</p>
              </div>
              <Equation
                lang={lang}
                beginningCents={dashboard.totals.beginningCents}
                purchaseCents={selectedPurchaseCents}
                endingCents={selectedEndingCents}
                actualCents={actualCents}
                purchaseDetail={copy.selectedSource}
                isPreview
                copy={copy}
              />
              {dashboard.totals.openingAdjustmentCents > 0 && (
                <Notice tone="info" title={copy.openingAdjustmentTitle}>
                  {copy.openingAdjustmentBody(money(dashboard.totals.openingAdjustmentCents, lang))}
                </Notice>
              )}
            </section>

            {showPartialNotice && <Notice tone="warn" title={copy.partialTitle}>{copy.partialPreviewBody(partialDate)}</Notice>}
            {!dashboard.canClose && dashboard.closeAvailableOn && (
              <Notice tone="info" title={copy.closeAvailableTitle}>
                {copy.closeAvailableBody(formatPropertyDate(dashboard.closeAvailableOn, lang))}
              </Notice>
            )}

            <section className="mc-section" aria-labelledby={`${formId}-purchase-legend`}>
              <fieldset className="mc-purchases" aria-describedby={purchaseHelpId} disabled={saving}>
                <legend id={`${formId}-purchase-legend`}>{copy.choosePurchases}</legend>
                <p id={purchaseHelpId} className="mc-purchases-help">{copy.choosePurchasesHelp}</p>
                <div className="mc-options">
                  <PurchaseOption
                    id={`${formId}-logged`}
                    checked={purchaseSource === 'logged_deliveries'}
                    value="logged_deliveries"
                    onChange={setPurchaseSource}
                    title={copy.loggedTitle}
                    amount={money(dashboard.purchase.loggedPurchaseCents, lang)}
                    body={copy.loggedBody(dashboard.purchase.loggedDeliveryCount)}
                    detail={dashboard.purchase.loggedPurchaseCents == null
                      ? copy.loggedIncomplete(money(dashboard.purchase.knownLoggedPurchaseCents, lang))
                      : copy.loggedDetail}
                  />
                  <PurchaseOption
                    id={`${formId}-manual`}
                    checked={purchaseSource === 'manual_total'}
                    value="manual_total"
                    onChange={setPurchaseSource}
                    title={copy.manualTitle}
                    body={copy.manualBody}
                    detail={copy.manualDetail}
                  >
                    {purchaseSource === 'manual_total' && (
                      <div className="mc-money-wrap">
                        <label className="mc-money-label" htmlFor={`${formId}-manual-amount`}>{copy.monthlyPurchaseTotal}</label>
                        <div className="mc-money-control" style={manualError ? { borderColor: T.terra } : undefined}>
                          <span className="mc-money-prefix" aria-hidden="true">$</span>
                          <input
                            id={`${formId}-manual-amount`}
                            className="mc-money-input"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder={copy.amountExample}
                            value={manualPurchase}
                            onChange={(event) => setManualPurchase(event.target.value)}
                            aria-invalid={Boolean(manualError)}
                            aria-describedby={manualError ? manualHelpId : undefined}
                          />
                        </div>
                        {manualError && <div id={manualHelpId} className="mc-money-error" role="alert">{manualError}</div>}
                      </div>
                    )}
                  </PurchaseOption>
                  <PurchaseOption
                    id={`${formId}-zero`}
                    checked={purchaseSource === 'zero'}
                    value="zero"
                    onChange={setPurchaseSource}
                    title={copy.zeroTitle}
                    amount={money(0, lang)}
                    body={copy.zeroBody}
                  />
                </div>
              </fieldset>
            </section>

            <ReadinessSection
              titleId={`${formId}-close-readiness`}
              copy={copy}
              countedItems={countedItems}
              itemCount={itemCount}
              latestCountDate={latestCountAt ? formatDate(latestCountAt, lang, dashboard.timezone) : null}
              countReady={countReady}
              costsReady={costsReady}
              blockers={effectiveBlockers}
              warnings={dashboard.completeness.warnings}
              onStartCount={handleStartCount}
            />

            {negativeActual && <Notice tone="error" title={copy.negativeTitle} role="alert">{copy.negativeBody}</Notice>}
          </>
        ) : (
          <>
            <section className="mc-section mc-stack" aria-labelledby={`${formId}-closed-title`}>
              <div className="mc-section-head">
                <div>
                  <StatusBadge tone="neutral">{copy.statusClosed}</StatusBadge>
                  <h2 id={`${formId}-closed-title`} className="mc-section-title" style={{ fontSize: 18, margin: '13px 0 0' }}>{copy.actualUsed}</h2>
                  <p className="mc-section-copy" style={{ marginBottom: 0 }}>{copy.closedBody}</p>
                </div>
                {dashboard.closedAt && <div className="mc-closed-meta">{copy.closedMeta(formatDate(dashboard.closedAt, lang, dashboard.timezone), dashboard.closedByName)}</div>}
              </div>
              <Equation
                lang={lang}
                beginningCents={dashboard.totals.beginningCents}
                purchaseCents={dashboard.totals.purchasesCents ?? dashboard.purchase.confirmedPurchaseCents}
                endingCents={dashboard.totals.endingCents}
                actualCents={dashboard.totals.actualUsageCents}
                purchaseDetail={sourceLabel(dashboard.purchase.source, copy)}
                copy={copy}
              />
              {dashboard.totals.openingAdjustmentCents > 0 && (
                <Notice tone="info" title={copy.openingAdjustmentTitle}>
                  {copy.openingAdjustmentBody(money(dashboard.totals.openingAdjustmentCents, lang))}
                </Notice>
              )}
            </section>

            {dashboard.isPartial && <Notice tone="warn" title={copy.partialTitle}>{copy.partialBody(partialDate)}</Notice>}
            {dashboard.purchase.allocationMode === 'total_only' && <Notice tone="info" title={copy.purchaseSource}>{copy.budgetUnavailable}</Notice>}
            {dashboard.completeness.warnings.length > 0 && (
              <IssueList title={copy.warningsTitle} issues={dashboard.completeness.warnings} copy={copy} tone="warn" />
            )}
          </>
        )}
      </form>
    </Overlay>
  );
}

function IssueList({
  title,
  issues,
  copy,
  tone,
}: {
  title: string;
  issues: MonthCloseIssue[];
  copy: ReturnType<typeof monthCloseStrings>;
  tone: 'warn' | 'error';
}) {
  if (issues.length === 0) return null;
  return (
    <Notice tone={tone} title={title} role={tone === 'error' ? 'alert' : undefined}>
      <ul className="mc-issues">
        {issues.map((issue, index) => <li key={`${issue.code}-${issue.itemId ?? index}`}>{issueLabel(issue, copy)}</li>)}
      </ul>
    </Notice>
  );
}

function ReadinessSection({
  titleId,
  copy,
  countedItems,
  itemCount,
  latestCountDate,
  countReady,
  costsReady,
  blockers,
  warnings,
  onStartCount,
}: {
  titleId: string;
  copy: ReturnType<typeof monthCloseStrings>;
  countedItems: number;
  itemCount: number;
  latestCountDate: string | null;
  countReady: boolean;
  costsReady: boolean;
  blockers: MonthCloseIssue[];
  warnings: MonthCloseIssue[];
  onStartCount: () => void;
}) {
  return (
    <section className="mc-section mc-stack" aria-labelledby={titleId}>
      <div className="mc-section-head">
        <div>
          <h2 id={titleId} className="mc-section-title" style={{ margin: 0 }}>{copy.readinessTitle}</h2>
          <p className="mc-section-copy" style={{ marginBottom: 0 }}>{copy.readinessBody}</p>
        </div>
        <Btn className="mc-button" variant="ghost" style={button44} onClick={onStartCount}>{copy.startCount}</Btn>
      </div>
      <div className="mc-readiness-grid">
        <div className="mc-check-card">
          <div>
            <div className="mc-check-label">{copy.endingCount}</div>
            <div className="mc-check-detail">
              {itemCount > 0
                ? latestCountDate
                  ? copy.countedItemsAt(countedItems, itemCount, latestCountDate)
                  : copy.countedItems(countedItems, itemCount)
                : copy.noItems}
            </div>
          </div>
          <span className={`mc-check-status ${countReady ? 'is-ready' : 'is-blocked'}`}>{countReady ? copy.ready : copy.needsAttention}</span>
        </div>
        <div className="mc-check-card">
          <div>
            <div className="mc-check-label">{copy.costs}</div>
            <div className="mc-check-detail">{costsReady ? copy.costsReady : copy.needsAttention}</div>
          </div>
          <span className={`mc-check-status ${costsReady ? 'is-ready' : 'is-blocked'}`}>{costsReady ? copy.ready : copy.needsAttention}</span>
        </div>
      </div>
      <IssueList title={copy.blockersTitle} issues={blockers} copy={copy} tone="error" />
      <IssueList title={copy.warningsTitle} issues={warnings} copy={copy} tone="warn" />
    </section>
  );
}
