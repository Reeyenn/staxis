'use client';

/* ──────────────────────────────────────────────────────────────────────
   Scan Invoice — upload → review/match → commit
   Snap an invoice, Claude Vision reads the lines, we match each to an
   inventory item, the manager confirms, and we write the received stock +
   log the delivery. See plan §Feature 1.

   This file is the orchestrator (phase machine + state + handlers); the
   pieces live next door:
     scan-staging.tsx — staged pages/PDF model, folding rules, upload UI
     scan-review.tsx  — review-row model + row UI
     scan-commit.ts   — the resumable commit executor (progress bookkeeping)
     scan-i18n.ts     — the sheet's bilingual dictionary
   ────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import { listEffectiveInventoryDeliveries } from '@/lib/db';
import { BEFORE_PROPERTY_CHANGE_EVENT } from '@/lib/property-change-guard';
import { inventoryDateKeyInZone } from '@/lib/inventory-month-close';
import {
  buildCommitPlan,
  buildNotesTag,
  INVOICE_REFERENCE_MAX_LENGTH,
  invoiceDateFromReceivedAt,
  invoiceAlreadyRecorded,
  invoiceReferenceValidationCode,
  isInvoiceCalendarDate,
  normalizeInvoiceReference,
} from '@/lib/inventory-invoice-commit';

import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';
import { type Lang } from '../inv-i18n';
import { inputLg, numGuard } from './form-kit';
import overlayStyles from './Overlay.module.css';
import type { InventoryCustomCategory, InventoryTabLayout } from '@/types';
import {
  clearInventoryOverlayDraft,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from './inventory-overlay-draft';
import { ssStrings, scanErrorFor } from './scan-i18n';
import { StagingStep, foldFiles, fileToBase64, type Staged } from './scan-staging';
import {
  buildRow,
  effectiveInvoiceUnitCost,
  invoiceReviewHasUnsavedWork,
  reviewRowHasCompleteCost,
  reviewRowHasCompleteNewItem,
  reviewRowIsReady,
  ReviewRowView,
  type RawInvoiceLine,
  type ReviewRow,
} from './scan-review';
import {
  executeCommit,
  retryCommit,
  newCommitProgress,
  releaseRejectedCommit,
  loadDeliveryAttempt,
  isDefinitiveDeliveryFailure,
  numberedInvoiceSaveBlocked,
  errMsg,
} from './scan-commit';
import {
  beginInvoiceOperation,
  createInvoiceOperationCursor,
  duplicateInvoiceRequestIsCurrent,
  invalidateInvoiceOperations,
  invoiceOperationIsCurrent,
  normalizeDuplicateVendorIdentity,
  syncInvoiceOperationLifecycle,
  type DuplicateInvoiceRequestScope,
  type InvoiceOperationScope,
} from './scan-operation-scope';

type ScanPhase = 'upload' | 'reading' | 'review' | 'verifying' | 'committing' | 'done' | 'error';

interface InvoiceReviewDraft {
  propertyId: string;
  vendor: string;
  invoiceDate: string;
  invoiceNumber: string | null;
  rows: ReviewRow[];
}

function validInvoiceReviewDraft(value: unknown, propertyId: string): InvoiceReviewDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<InvoiceReviewDraft>;
  if (
    draft.propertyId !== propertyId
    || typeof draft.vendor !== 'string'
    || typeof draft.invoiceDate !== 'string'
    || (draft.invoiceNumber !== null && typeof draft.invoiceNumber !== 'string')
    || !Array.isArray(draft.rows)
    || draft.rows.length === 0
    || !draft.rows.every((row) => row && typeof row === 'object'
      && typeof row.key === 'string' && typeof row.qtyInput === 'string')
  ) return null;
  return {
    ...(draft as InvoiceReviewDraft),
    // Drafts saved before scan-created items gained full Add Item parity are
    // upgraded in place instead of being discarded.
    rows: (draft.rows as ReviewRow[]).map((row) => ({
      ...row,
      newCustomCategoryId: typeof row.newCustomCategoryId === 'string'
        ? row.newCustomCategoryId
        : null,
      newSetAside: typeof row.newSetAside === 'string' ? row.newSetAside : '0',
    })),
  };
}

// Warm notice strip used twice in the review phase (dup-invoice warning +
// partial-failure banner) — identical styling, kept as one const.
const warmStrip: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  background: T.warmDim,
  border: `1px solid ${T.warm}33`,
  fontFamily: fonts.sans,
  fontSize: 12.5,
  color: T.warm,
};

export function ScanInvoiceSheet({
  lang,
  open,
  onClose,
  display,
  timezone,
  customCategories = [],
  tabLayout,
}: {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
  timezone: string;
  customCategories?: InventoryCustomCategory[];
  tabLayout?: InventoryTabLayout;
}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ss = ssStrings(lang);

  const [phase, setPhase] = useState<ScanPhase>('upload');
  const [errorText, setErrorText] = useState('');
  // Staged file(s) waiting on the manager to press "Scan invoice". Held in a ref
  // for cleanup (revoking object-URLs) alongside the state that drives the view.
  const [staged, setStaged] = useState<Staged>({ kind: 'none' });
  const stagedRef = useRef<Staged>(staged);
  stagedRef.current = staged;
  const [stageNote, setStageNote] = useState(''); // brief inline message (max reached, no-mix, size…)
  const [vendor, setVendor] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [dupWarn, setDupWarn] = useState(false);
  const [dupChecking, setDupChecking] = useState(false);
  const [dupCheckFailed, setDupCheckFailed] = useState(false);
  const [banner, setBanner] = useState('');
  const [retryLocked, setRetryLocked] = useState(false);
  const [recoveredLineCount, setRecoveredLineCount] = useState(0);
  const vendorRef = useRef(vendor);
  const invoiceNumberRef = useRef<string | null>(invoiceNumber);
  // This ref closes the one-render gap between Save and the visible
  // `verifying` phase. Keep it populated through the write so no property
  // change can slip between duplicate verification and commit.
  const saveBoundaryScopeRef = useRef<InvoiceOperationScope | null>(null);
  const operationCursorRef = useRef(createInvoiceOperationCursor(open, activePropertyId));

  // Synchronize only after React commits this lifecycle. Mutating these refs
  // during render would let an abandoned concurrent render cancel work that
  // still belongs to the currently committed hotel. Layout cleanup runs
  // synchronously on a committed lifecycle change or unmount, before a stale
  // continuation can cross the Save boundary.
  useLayoutEffect(() => {
    const nextLifecycle = syncInvoiceOperationLifecycle(
      operationCursorRef.current,
      open,
      activePropertyId,
    );
    if (nextLifecycle !== operationCursorRef.current) {
      operationCursorRef.current = nextLifecycle;
      saveBoundaryScopeRef.current = null;
    }
    return () => {
      operationCursorRef.current = invalidateInvoiceOperations(operationCursorRef.current);
      saveBoundaryScopeRef.current = null;
    };
  }, [activePropertyId, open]);

  useLayoutEffect(() => {
    vendorRef.current = vendor;
    invoiceNumberRef.current = invoiceNumber;
  }, [invoiceNumber, vendor]);

  const beginOperation = useCallback((propertyId: string) => {
    const started = beginInvoiceOperation(operationCursorRef.current, propertyId);
    operationCursorRef.current = started.cursor;
    return started.scope;
  }, []);
  const invalidateOperations = useCallback(() => {
    operationCursorRef.current = invalidateInvoiceOperations(operationCursorRef.current);
  }, []);
  const operationCurrent = useCallback((scope: InvoiceOperationScope) => (
    invoiceOperationIsCurrent(scope, operationCursorRef.current)
  ), []);

  // Per-line commit progress, so a retry after a partial failure resumes the
  // failed step and never double-inserts an order / re-creates an item.
  const progressRef = useRef(newCommitProgress());
  const byId = useMemo(() => {
    const m = new Map<string, DisplayItem>();
    for (const d of display) m.set(d.id, d);
    return m;
  }, [display]);
  const timezoneRef = useRef(timezone);
  timezoneRef.current = timezone;
  const langRef = useRef(lang);
  langRef.current = lang;
  const reviewStorageInput = useMemo(() => user?.uid && activePropertyId
    ? { kind: 'invoice-review' as const, userId: user.uid, propertyId: activePropertyId, scope: 'review' }
    : null, [activePropertyId, user?.uid]);

  const verifyDuplicateInvoice = useCallback(async (
    number: string,
    vendorName: string,
    existingScope?: InvoiceOperationScope,
  ) => {
    const reference = normalizeInvoiceReference(number);
    const propertyId = existingScope?.propertyId ?? activePropertyId;
    const scope = existingScope ?? (propertyId ? beginOperation(propertyId) : null);
    if (invoiceReferenceValidationCode(reference) !== null) {
      if (scope && !operationCurrent(scope)) return 'stale' as const;
      setDupChecking(false);
      setDupWarn(false);
      setDupCheckFailed(false);
      return 'invalid' as const;
    }
    if (!user?.uid || !propertyId || !scope) return 'failed' as const;
    const requestScope: DuplicateInvoiceRequestScope = {
      ...scope,
      reference,
      vendor: normalizeDuplicateVendorIdentity(vendorName),
    };
    const requestCurrent = () => duplicateInvoiceRequestIsCurrent(
      requestScope,
      operationCursorRef.current,
      {
        reference: normalizeInvoiceReference(invoiceNumberRef.current),
        vendor: vendorRef.current,
      },
    );
    if (!requestCurrent()) return 'stale' as const;
    setDupChecking(true);
    setDupWarn(false);
    setDupCheckFailed(false);
    try {
      const tag = buildNotesTag(reference, vendorName || null);
      const deliveries = await listEffectiveInventoryDeliveries(
        user.uid,
        requestScope.propertyId,
        2000,
        false,
      );
      if (!requestCurrent()) return 'stale' as const;
      // A fully voided invoice may be re-entered through the audited database
      // replacement path. Any still-effective line keeps the hard duplicate
      // block, so voiding one line cannot weaken protection for the rest.
      const duplicate = invoiceAlreadyRecorded(
        deliveries
          .filter((delivery) => delivery.status !== 'voided')
          .map((delivery) => delivery.original.notes),
        tag,
      );
      setDupWarn(duplicate);
      return duplicate ? 'duplicate' as const : 'clear' as const;
    } catch {
      if (!requestCurrent()) return 'stale' as const;
      setDupCheckFailed(true);
      return 'failed' as const;
    } finally {
      // An older request must not clear the spinner for a newer identity.
      if (requestCurrent()) setDupChecking(false);
    }
  }, [activePropertyId, beginOperation, operationCurrent, user?.uid]);

  // Revoke every thumbnail object-URL currently staged. Called on reset/close
  // and unmount so we never leak blob URLs (esp. across repeated open/close).
  const clearStaged = () => {
    const cur = stagedRef.current;
    if (cur.kind === 'images') for (const p of cur.pages) URL.revokeObjectURL(p.url);
    setStaged({ kind: 'none' });
    setStageNote('');
  };

  useEffect(() => {
    if (!open) return;
    const restored = activePropertyId
      ? loadDeliveryAttempt('scan', activePropertyId)
      : null;
    const reviewDraft = !restored && activePropertyId && reviewStorageInput
      ? validInvoiceReviewDraft(
          loadInventoryOverlayDraft<InvoiceReviewDraft>(reviewStorageInput),
          activePropertyId,
        )
      : null;
    const restoredVendor = restored?.vendorName ?? reviewDraft?.vendor ?? '';
    const restoredInvoiceNumber = reviewDraft?.invoiceNumber ?? null;
    vendorRef.current = restoredVendor;
    invoiceNumberRef.current = restoredInvoiceNumber;
    setPhase(restored || reviewDraft ? 'review' : 'upload');
    setErrorText('');
    clearStaged();
    setVendor(restoredVendor);
    setInvoiceDate(restored
      ? (invoiceDateFromReceivedAt(restored.receivedAt, timezoneRef.current) ?? '')
      : reviewDraft?.invoiceDate ?? '');
    setInvoiceNumber(restoredInvoiceNumber);
    setRows(reviewDraft?.rows ?? []);
    setDupWarn(false);
    setDupChecking(false);
    setDupCheckFailed(false);
    setBanner(restored
      ? (langRef.current === 'es'
          ? 'El resultado anterior no se pudo confirmar. Reintenta exactamente la misma entrega para resolverlo.'
          : 'The previous result could not be confirmed. Retry the exact same delivery to resolve it.')
      : reviewDraft
        ? (langRef.current === 'es' ? 'Se recuperó la revisión sin guardar de esta factura.' : 'Your unsaved invoice review was restored.')
        : '');
    setRetryLocked(!!restored);
    setRecoveredLineCount(restored?.lines.length ?? 0);
    progressRef.current = newCommitProgress(restored);
    if (reviewDraft?.invoiceNumber) {
      void verifyDuplicateInvoice(reviewDraft.invoiceNumber, reviewDraft.vendor);
    }
  }, [open, activePropertyId, reviewStorageInput, verifyDuplicateInvoice]);

  useEffect(() => {
    if (!open || !reviewStorageInput || retryLocked) return;
    if (phase === 'review' && rows.length > 0 && activePropertyId) {
      persistInventoryOverlayDraft({
        ...reviewStorageInput,
        data: { propertyId: activePropertyId, vendor, invoiceDate, invoiceNumber, rows } satisfies InvoiceReviewDraft,
      });
    } else if (phase === 'done') {
      clearInventoryOverlayDraft(reviewStorageInput);
    }
  }, [activePropertyId, invoiceDate, invoiceNumber, open, phase, retryLocked, reviewStorageInput, rows, vendor]);

  // Belt-and-suspenders: revoke any staged thumbnails if the sheet unmounts
  // while pages are staged (open/close resets already handle the common path).
  useEffect(() => () => {
    const cur = stagedRef.current;
    if (cur.kind === 'images') for (const p of cur.pages) URL.revokeObjectURL(p.url);
  }, []);

  const onHandFor = (itemId: string | null) =>
    itemId ? Math.max(0, Math.round(byId.get(itemId)?.estimated ?? 0)) : 0;

  const patchRow = (key: string, patch: Partial<ReviewRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const setQty = (row: ReviewRow, v: string) => {
    if (!numGuard(v)) return;
    const patch: Partial<ReviewRow> = { qtyInput: v };
    const quantity = Number(v);
    if (!row.unitCostDirty && Number.isFinite(quantity) && quantity > 0) {
      patch.unitCostInput = effectiveInvoiceUnitCost(row.raw, quantity);
    }
    if (!row.afterDirty && row.decision === 'match') {
      patch.afterInput = String(onHandFor(row.matchedItemId) + (Number(v) || 0));
    }
    patchRow(row.key, patch);
  };

  const setDecision = (row: ReviewRow, value: string) => {
    if (value === '__create__') {
      patchRow(row.key, { decision: 'create' });
      return;
    }
    if (value === '__skip__') {
      patchRow(row.key, { decision: 'skip' });
      return;
    }
    const patch: Partial<ReviewRow> = {
      decision: 'match',
      matchedItemId: value,
      // An explicit pick answers the "two close matches" question — clear it.
      ambiguous: false,
      matchConfirmed: true,
      afterDirty: false,
      afterInput: String(onHandFor(value) + (Number(row.qtyInput) || 0)),
    };
    // Picked via the full-catalog ⇄ button: the name select renders from the
    // row's shortlist, so an off-shortlist pick must join it (front of the
    // list) or the row would keep showing the old name.
    if (!row.candidates.some((c) => c.id === value)) {
      const name = byId.get(value)?.name;
      // A human pick outranks anything the matcher scored.
      if (name) patch.candidates = [{ id: value, name, score: 1, tier: 'exact' }, ...row.candidates];
    }
    patchRow(row.key, patch);
  };

  // Fold newly-picked/dropped files into the staged set (rules live in
  // scan-staging.tsx).
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const { next, note } = foldFiles(stagedRef.current, files, ss);
    if (next) setStaged(next);
    setStageNote(note);
  };

  const removePage = (idx: number) => {
    const cur = stagedRef.current;
    if (cur.kind !== 'images') return;
    const target = cur.pages[idx];
    if (target) URL.revokeObjectURL(target.url);
    const next = cur.pages.filter((_, i) => i !== idx);
    setStaged(next.length > 0 ? { kind: 'images', pages: next } : { kind: 'none' });
    setStageNote('');
  };

  // Any close/back affordance (✕, ESC, click-outside, Cancel) releases staged
  // pages and their thumbnails before delegating to the parent's onClose, so
  // closing mid-stage never leaks blob URLs or carries pages into a reopen.
  const handleClose = () => {
    if (saveBoundaryScopeRef.current || phase === 'verifying' || phase === 'committing' || retryLocked) return;
    const unsaved = invoiceReviewHasUnsavedWork({
      phase,
      hasStagedFile: stagedRef.current.kind !== 'none',
      rowCount: rows.length,
    });
    if (unsaved && !confirm(ss.discardConfirm)) return;
    invalidateOperations();
    clearStaged();
    if (reviewStorageInput) clearInventoryOverlayDraft(reviewStorageInput);
    onClose();
  };

  // Submit the staged file(s). Images → resize EACH page (same 1600px long-edge
  // treatment the single-image path used) and send { pid, pages: [...] }. PDF →
  // read raw base64 and send { pid, pdfBase64 }. Everything downstream (reading/
  // review/commit) is unchanged — the response shape is identical either way.
  const handleScan = async () => {
    if (!user || !activePropertyId) return;
    const cur = stagedRef.current;
    if (cur.kind === 'none') return;
    const scanScope = beginOperation(activePropertyId);
    setPhase('reading');
    setErrorText('');
    setDupWarn(false);
    setDupChecking(false);
    setDupCheckFailed(false);
    try {
      let body: string;
      if (cur.kind === 'images') {
        // Resize before upload — Vision bills per pixel area; 1600px long-edge
        // keeps small receipt text legible at ~1/4 the cost of a raw photo.
        const pages = await Promise.all(
          cur.pages.map(async (p) => {
            const resized = await resizeImageForVision(p.file);
            return { imageBase64: resized.base64, mediaType: resized.mediaType };
          }),
        );
        if (!operationCurrent(scanScope)) return;
        body = JSON.stringify({ pid: scanScope.propertyId, pages });
      } else {
        const pdfBase64 = await fileToBase64(cur.file);
        if (!operationCurrent(scanScope)) return;
        body = JSON.stringify({ pid: scanScope.propertyId, pdfBase64 });
      }
      const res = await fetchWithAuth('/api/inventory/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!operationCurrent(scanScope)) return;
      const json = (await res.json()) as {
        ok?: boolean;
        vendor_name?: string | null;
        invoice_date?: string | null;
        invoice_number?: string | null;
        items?: RawInvoiceLine[];
        error?: string;
      };
      if (!operationCurrent(scanScope)) return;
      if (!res.ok || !json.ok) {
        setPhase('error');
        setErrorText(scanErrorFor(lang, res.status, json.error));
        return;
      }
      const items = json.items ?? [];
      if (items.length === 0) {
        setPhase('error');
        setErrorText(ss.noLineItems);
        return;
      }
      const scannedVendor = (json.vendor_name ?? '').trim();
      setRows(items.map((raw, i) => buildRow(raw, i, display)));
      vendorRef.current = scannedVendor;
      setVendor(scannedVendor);
      setInvoiceDate((json.invoice_date ?? '').trim());
      const num = normalizeInvoiceReference(json.invoice_number);
      invoiceNumberRef.current = num || null;
      setInvoiceNumber(num || null);
      setBanner('');
      // Scan accepted — the staged files (and their thumbnails) are done with;
      // release them so we don't hold blob URLs through the review/commit phases.
      clearStaged();
      setPhase('review');

      // A valid invoice/reference is fail-closed: search a field-test-sized
      // history window and hard-block Save on a match OR if history could not
      // be verified. Missing/invalid references are blocked locally below.
      if (invoiceReferenceValidationCode(num) === null) {
        await verifyDuplicateInvoice(num, scannedVendor, scanScope);
      }
    } catch (err) {
      if (!operationCurrent(scanScope)) return;
      console.error('[scan-invoice] failed', err);
      setPhase('error');
      setErrorText(ss.uploadFailed);
    }
  };

  const normalizedInvoiceReference = normalizeInvoiceReference(invoiceNumber);
  const invoiceReferenceErrorCode = invoiceReferenceValidationCode(normalizedInvoiceReference);
  const invoiceReferenceReady = invoiceReferenceErrorCode === null;
  const invoiceReferenceMessage = invoiceReferenceErrorCode === 'invoice_reference_invalid'
    ? ss.invoiceReferenceInvalid
    : ss.invoiceReferenceRequired;
  const duplicateBlocked = numberedInvoiceSaveBlocked({
    invoiceNumber: invoiceReferenceReady ? normalizedInvoiceReference : null,
    checking: dupChecking,
    duplicate: dupWarn,
    checkFailed: dupCheckFailed,
  });
  const costsComplete = rows.every(reviewRowHasCompleteCost);
  const rowsReady = rows.every(reviewRowIsReady);
  const timezoneReady = useMemo(() => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }, [timezone]);
  const latestInvoiceDate = timezoneReady
    ? inventoryDateKeyInZone(new Date(), timezone)
    : '';
  const invoiceDateReady = isInvoiceCalendarDate(invoiceDate)
    && timezoneReady
    && invoiceDate <= latestInvoiceDate;
  const unconfirmedMatches = rows.filter((row) => row.decision === 'match' && !row.matchConfirmed).length;
  const incompleteNewItems = rows.filter((row) => !reviewRowHasCompleteNewItem(row)).length;
  const hasUnsavedChanges = retryLocked || invoiceReviewHasUnsavedWork({
    phase,
    hasStagedFile: staged.kind !== 'none',
    rowCount: rows.length,
  });

  // A hotel switch remounts InventoryShell. Protect staged photos and
  // in-flight/ambiguous delivery work before that remount can discard them.
  useEffect(() => {
    if (!open || !hasUnsavedChanges) return;
    const beforePropertyChange = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent;
      if (
        saveBoundaryScopeRef.current
        || phase === 'verifying'
        || phase === 'committing'
        || retryLocked
      ) {
        event.preventDefault();
        setBanner(ss.propertySwitchBlocked);
        return;
      }
      if (!window.confirm(ss.propertySwitchConfirm)) {
        event.preventDefault();
        return;
      }
      // Invalidate synchronously inside the confirmed event, before the
      // property context can render the new hotel. Late OCR/history responses
      // from this hotel are then inert even in the same microtask turn. The
      // confirmation is an explicit discard, so remove this hotel's persisted
      // review before allowing the context to complete the switch.
      if (reviewStorageInput) clearInventoryOverlayDraft(reviewStorageInput);
      invalidateOperations();
    };
    window.addEventListener(BEFORE_PROPERTY_CHANGE_EVENT, beforePropertyChange);
    return () => window.removeEventListener(BEFORE_PROPERTY_CHANGE_EVENT, beforePropertyChange);
  }, [
    hasUnsavedChanges,
    invalidateOperations,
    open,
    phase,
    reviewStorageInput,
    retryLocked,
    ss.propertySwitchBlocked,
    ss.propertySwitchConfirm,
  ]);

  const handleCommit = async () => {
    if (
      !user || !activePropertyId || saveBoundaryScopeRef.current
      || phase === 'verifying' || phase === 'committing'
      || (!retryLocked && (!invoiceReferenceReady || duplicateBlocked || !rowsReady || !invoiceDateReady))
    ) return;
    const commitScope = beginOperation(activePropertyId);
    const commitPropertyId = commitScope.propertyId;
    saveBoundaryScopeRef.current = commitScope;
    const releaseSaveBoundary = () => {
      const current = saveBoundaryScopeRef.current;
      if (current?.propertyId === commitScope.propertyId && current.sequence === commitScope.sequence) {
        saveBoundaryScopeRef.current = null;
      }
    };
    setBanner('');
    // Recheck the editable identity at the actual save boundary. An onBlur
    // lookup alone can race the Save click and let a newly typed duplicate
    // through before React paints the checking state.
    if (!retryLocked) {
      // Enter a hard state before awaiting. The ref above closes the immediate
      // event-loop gap; this phase locks the visible review controls.
      setPhase('verifying');
      const result = await verifyDuplicateInvoice(normalizedInvoiceReference, vendor, commitScope);
      if (!operationCurrent(commitScope)) {
        releaseSaveBoundary();
        if (
          operationCursorRef.current.open
          && operationCursorRef.current.propertyId === commitScope.propertyId
        ) setPhase('review');
        return;
      }
      if (result !== 'clear') {
        releaseSaveBoundary();
        setPhase('review');
        return;
      }
    }
    setPhase('committing');

    try {
      if (retryLocked) {
        await retryCommit(progressRef.current, { uid: user.uid, pid: commitPropertyId });
      } else {
        const plan = buildCommitPlan({
          propertyTimezone: timezone,
          vendorName: vendor,
          invoiceDate,
          invoiceNumber: normalizedInvoiceReference,
          lines: rows.map((r) => ({
            key: r.key,
            itemName: r.decision === 'create' ? r.newName : r.raw.item_name,
            decision: r.decision,
            matchedItemId: r.matchedItemId,
            matchConfirmed: r.decision !== 'match' || r.matchConfirmed,
            qty: r.qtyInput,
            quantityCases: r.raw.quantity_cases,
            unitCost: r.unitCostInput,
            // A manager-edited unit cost replaces hidden OCR math. Otherwise
            // the scanned line total remains authoritative for invoice rounding.
            totalCost: r.unitCostDirty ? null : r.raw.total_cost,
            onHandEstimate: onHandFor(r.matchedItemId),
            afterOverride: r.decision === 'match' && r.afterDirty ? r.afterInput : null,
            newItem: r.decision === 'create' ? {
              category: r.newCategory,
              customCategoryId: r.newCustomCategoryId,
              unit: r.newUnit,
              parLevel: r.newPar,
              setAside: r.newSetAside,
            } : undefined,
          })),
        });
        await executeCommit(plan, progressRef.current, {
          uid: user.uid,
          pid: commitPropertyId,
        });
      }
    } catch (e) {
      if (!operationCurrent(commitScope)) {
        releaseSaveBoundary();
        return;
      }
      if (isDefinitiveDeliveryFailure(e, retryLocked)) {
        releaseRejectedCommit(progressRef.current, commitPropertyId);
        setRetryLocked(false);
      } else if (progressRef.current.attempt) {
        setRecoveredLineCount(progressRef.current.attempt?.lines.length ?? rows.length);
        setRetryLocked(true);
      } else {
        // A validation error happened before an RPC envelope existed, so no
        // delivery outcome is ambiguous and the review can remain editable.
        setRetryLocked(false);
      }
      setBanner(ss.savingFailed(errMsg(e)));
      setPhase('review');
      releaseSaveBoundary();
      return;
    }
    if (!operationCurrent(commitScope)) {
      releaseSaveBoundary();
      return;
    }
    setRetryLocked(false);
    if (reviewStorageInput) clearInventoryOverlayDraft(reviewStorageInput);
    setPhase('done');
    releaseSaveBoundary();
  };

  const reviewing = phase === 'review' || phase === 'verifying' || phase === 'committing';
  const saveBusy = phase === 'verifying' || phase === 'committing';
  const actionable = rows.filter((r) => r.decision !== 'skip').length;
  const matchedCount = rows.filter((r) => r.decision === 'match').length;
  const createCount = rows.filter((r) => r.decision === 'create').length;

  return (
    <Overlay
      open={open}
      onClose={handleClose}
      hasUnsavedChanges={hasUnsavedChanges}
      eyebrow={ss.scanInvoice}
      italic={reviewing ? ss.whatArrived : phase === 'done' ? ss.saved : ss.dropOneIn}
      suffix={reviewing ? undefined : ss.autoUpdateStock}
      accent={T.sageDeep}
      width={reviewing ? 760 : 640}
      footer={
        reviewing ? (
          <>
            <Btn variant="ghost" size="md" onClick={handleClose} disabled={saveBusy}>
              {ss.cancel}
            </Btn>
            <Btn
              variant="primary"
              size="md"
              onClick={handleCommit}
              disabled={saveBusy || (!retryLocked && (actionable === 0 || !invoiceReferenceReady || duplicateBlocked || !rowsReady || !invoiceDateReady))}
            >
              {phase === 'verifying'
                ? (lang === 'es' ? 'Verificando factura…' : 'Verifying invoice…')
                : phase === 'committing'
                ? ss.adding
                : retryLocked
                  ? (lang === 'es' ? 'Reintentar la misma entrega' : 'Retry exact delivery')
                  : ss.addItems(actionable)}
            </Btn>
          </>
        ) : undefined
      }
    >
      <style>{`
        .scan-new-item-grid {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(90px, .65fr) minmax(80px, .5fr);
        }
        .scan-new-item-name { grid-column: span 2; }
        @media (max-width: 760px) {
          .scan-review-main {
            display: grid !important;
            grid-template-columns: 44px minmax(72px, 1fr) minmax(84px, 1fr);
            align-items: end !important;
          }
          .scan-review-picker { grid-column: 1; grid-row: 1; }
          .scan-review-name { grid-column: 2; grid-row: 1; }
          .scan-review-remove { grid-column: 3; grid-row: 1; justify-self: end; }
          .scan-review-qty { grid-column: 2; grid-row: 2; }
          .scan-review-cost { grid-column: 3; grid-row: 2; }
          .scan-review-qty input,
          .scan-review-cost input { width: 100% !important; }
          .scan-new-item-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            margin-left: 0 !important;
            margin-right: 0 !important;
          }
          .scan-new-item-grid input,
          .scan-new-item-grid button { min-height: 44px !important; }
        }
        @media (max-width: 480px) {
          .scan-new-item-grid { grid-template-columns: minmax(0, 1fr); }
          .scan-new-item-name { grid-column: auto; }
        }
      `}</style>
      {(phase === 'upload' || phase === 'reading') && (
        <StagingStep
          ss={ss}
          phase={phase}
          staged={staged}
          stageNote={stageNote}
          onFiles={addFiles}
          onRemovePage={removePage}
          onClearStaged={clearStaged}
          onScan={() => void handleScan()}
        />
      )}

      {phase === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 12,
              background: T.warmDim,
              border: `1px solid ${T.warm}33`,
              fontFamily: fonts.sans,
              fontSize: 13,
              color: T.warm,
              lineHeight: 1.5,
            }}
          >
            {errorText}
          </div>
          <div>
            <Btn variant="primary" size="md" onClick={() => { setPhase('upload'); setErrorText(''); }}>
              {ss.tryAnotherPhoto}
            </Btn>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '16px 18px',
              borderRadius: 12,
              background: T.sageDim,
              border: `1px solid ${T.sageDeep}33`,
              fontFamily: fonts.sans,
              fontSize: 14,
              color: T.forestText,
              lineHeight: 1.5,
            }}
          >
            {ss.savedMsg(recoveredLineCount || matchedCount + createCount)}
          </div>
          <div>
            <Btn variant="primary" size="md" onClick={handleClose}>
              {ss.done}
            </Btn>
          </div>
        </div>
      )}

      {reviewing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {dupWarn && (
            <div style={warmStrip}>
              {ss.dupWarn} {lang === 'es' ? 'No se puede guardar esta factura otra vez.' : 'This invoice cannot be saved again.'}
            </div>
          )}
          {dupChecking && (
            <div style={warmStrip}>
              {lang === 'es' ? 'Comprobando el historial de facturas…' : 'Checking invoice history…'}
            </div>
          )}
          {dupCheckFailed && (
            <div style={warmStrip}>
              {lang === 'es'
                ? 'No se pudo verificar el historial. Guardar está bloqueado para evitar una entrega duplicada.'
                : 'History could not be verified. Saving is blocked to prevent a duplicate delivery.'}
            </div>
          )}
          {!retryLocked && !costsComplete && (
            <div role="alert" style={warmStrip}>{ss.costsRequired}</div>
          )}
          {!retryLocked && !invoiceDateReady && (
            <div role="alert" style={warmStrip}>{ss.invoiceDateRequired}</div>
          )}
          {!retryLocked && unconfirmedMatches > 0 && (
            <div role="alert" style={warmStrip}>{ss.matchesRequired(unconfirmedMatches)}</div>
          )}
          {!retryLocked && incompleteNewItems > 0 && (
            <div role="alert" style={warmStrip}>{ss.newItemsRequired}</div>
          )}
          {banner && <div style={warmStrip}>{banner}</div>}

          <div className={overlayStyles.formGrid3} style={{ alignItems: 'start' }}>
            <label>
              <span className={overlayStyles.fieldLabel}>{ss.vendor}</span>
              <input
                className={overlayStyles.formControl}
                style={{ ...inputLg, minHeight: 44, marginTop: 6 }}
                value={vendor}
                disabled={retryLocked || saveBusy}
                onChange={(event) => {
                  if (saveBoundaryScopeRef.current) return;
                  vendorRef.current = event.target.value;
                  invalidateOperations();
                  setVendor(event.target.value);
                  setDupChecking(false);
                  setDupWarn(false);
                  setDupCheckFailed(false);
                }}
                onBlur={() => {
                  if (!saveBoundaryScopeRef.current && invoiceReferenceReady) {
                    void verifyDuplicateInvoice(normalizedInvoiceReference, vendor);
                  }
                }}
              />
            </label>
            <label htmlFor="scan-invoice-reference">
              <span className={overlayStyles.fieldLabel}>{ss.invoiceNumber}</span>
              <input
                id="scan-invoice-reference"
                className={overlayStyles.formControl}
                style={{
                  ...inputLg,
                  minHeight: 44,
                  marginTop: 6,
                  borderColor: !retryLocked && !invoiceReferenceReady ? T.warm : T.controlBorder,
                }}
                value={invoiceNumber ?? ''}
                disabled={retryLocked || saveBusy}
                required
                aria-required="true"
                aria-invalid={!retryLocked && !invoiceReferenceReady}
                aria-describedby="scan-invoice-reference-help"
                aria-errormessage={!retryLocked && !invoiceReferenceReady
                  ? 'scan-invoice-reference-help'
                  : undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={INVOICE_REFERENCE_MAX_LENGTH}
                onChange={(event) => {
                  if (saveBoundaryScopeRef.current) return;
                  const next = event.target.value;
                  invoiceNumberRef.current = next || null;
                  invalidateOperations();
                  setInvoiceNumber(next || null);
                  setDupChecking(false);
                  setDupWarn(false);
                  setDupCheckFailed(false);
                }}
                onBlur={() => {
                  if (saveBoundaryScopeRef.current) return;
                  const next = normalizeInvoiceReference(invoiceNumber);
                  invoiceNumberRef.current = next || null;
                  setInvoiceNumber(next || null);
                  if (invoiceReferenceValidationCode(next) === null) {
                    void verifyDuplicateInvoice(next, vendor);
                  }
                }}
              />
              <span
                id="scan-invoice-reference-help"
                role={!retryLocked && !invoiceReferenceReady ? 'alert' : undefined}
                style={{
                  display: 'block',
                  marginTop: 4,
                  fontFamily: fonts.sans,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: !retryLocked && !invoiceReferenceReady ? T.warm : T.ink3,
                }}
              >
                {!retryLocked && !invoiceReferenceReady
                  ? invoiceReferenceMessage
                  : ss.invoiceReferenceHint}
              </span>
            </label>
            <label>
              <span className={overlayStyles.fieldLabel}>{ss.invoiceDate}</span>
              <input
                type="date"
                max={latestInvoiceDate || undefined}
                className={overlayStyles.formControl}
                style={{ ...inputLg, minHeight: 44, marginTop: 6 }}
                value={invoiceDate}
                disabled={retryLocked || saveBusy}
                aria-invalid={!invoiceDateReady}
                onChange={(event) => setInvoiceDate(event.target.value)}
              />
            </label>
          </div>

          {!retryLocked && <fieldset
            disabled={saveBusy}
            style={{ display: 'flex', flexDirection: 'column', border: 0, margin: 0, minWidth: 0, padding: 0 }}
          >
            {rows.map((row) => (
              <ReviewRowView
                key={row.key}
                lang={lang}
                row={row}
                display={display}
                customCategories={customCategories}
                hiddenBuiltins={tabLayout?.hidden ?? []}
                onDecision={(v) => setDecision(row, v)}
                onQty={(v) => setQty(row, v)}
                onUnitCost={(v) => {
                  if (!numGuard(v)) return;
                  patchRow(row.key, { unitCostInput: v, unitCostDirty: true });
                }}
                onConfirmMatch={() => patchRow(row.key, { matchConfirmed: true, ambiguous: false })}
                onNewName={(v) => patchRow(row.key, { newName: v })}
                onNewCategory={(c) => patchRow(row.key, { newCategory: c })}
                onNewCustomCategoryId={(id) => patchRow(row.key, { newCustomCategoryId: id })}
                onNewUnit={(v) => patchRow(row.key, { newUnit: v })}
                onNewPar={(v) => {
                  if (!numGuard(v)) return;
                  patchRow(row.key, { newPar: v });
                }}
                onNewSetAside={(v) => {
                  if (!/^\d*$/.test(v)) return;
                  patchRow(row.key, { newSetAside: v });
                }}
                onSkip={() => patchRow(row.key, { decision: 'skip' })}
                onUnskip={() =>
                  patchRow(row.key, {
                    decision: row.matchedItemId && row.candidates.length > 0 ? 'match' : 'create',
                  })
                }
              />
            ))}
          </fieldset>}
        </div>
      )}
    </Overlay>
  );
}
