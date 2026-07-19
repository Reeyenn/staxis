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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import { listInventoryOrders } from '@/lib/db';
import {
  buildCommitPlan,
  buildNotesTag,
  invoiceDateFromReceivedAt,
  invoiceAlreadyRecorded,
} from '@/lib/inventory-invoice-commit';

import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';
import { type Lang } from '../inv-i18n';
import { numGuard } from './form-kit';
import { ssStrings, scanErrorFor } from './scan-i18n';
import { StagingStep, foldFiles, fileToBase64, type Staged } from './scan-staging';
import {
  buildRow,
  effectiveInvoiceUnitCost,
  reviewRowHasCompleteCost,
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

type ScanPhase = 'upload' | 'reading' | 'review' | 'committing' | 'done' | 'error';

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

// "2026-07-14" → "Jul 14, 2026" for the read-only invoice caption. Built from
// the date parts directly (a bare `new Date('YYYY-MM-DD')` parses as UTC and
// shows yesterday in western timezones). Non-ISO input passes through as-is.
function fmtInvoiceDate(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function ScanInvoiceSheet({ lang, open, onClose, display, timezone }: { lang: Lang; open: boolean; onClose: () => void; display: DisplayItem[]; timezone: string }) {
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

  // Per-line commit progress, so a retry after a partial failure resumes the
  // failed step and never double-inserts an order / re-creates an item.
  const progressRef = useRef(newCommitProgress());
  // `buildCommitPlan` falls back to "now" when the invoice has no date. Freeze
  // that fallback for this sheet session so retries send an identical payload.
  const commitNowRef = useRef(new Date());

  const byId = useMemo(() => {
    const m = new Map<string, DisplayItem>();
    for (const d of display) m.set(d.id, d);
    return m;
  }, [display]);

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
    setPhase(restored ? 'review' : 'upload');
    setErrorText('');
    clearStaged();
    setVendor(restored?.vendorName ?? '');
    setInvoiceDate(restored
      ? (invoiceDateFromReceivedAt(restored.receivedAt, timezone) ?? '')
      : '');
    setInvoiceNumber(null);
    setRows([]);
    setDupWarn(false);
    setDupChecking(false);
    setDupCheckFailed(false);
    setBanner(restored
      ? (lang === 'es'
          ? 'El resultado anterior no se pudo confirmar. Reintenta exactamente la misma entrega para resolverlo.'
          : 'The previous result could not be confirmed. Retry the exact same delivery to resolve it.')
      : '');
    setRetryLocked(!!restored);
    setRecoveredLineCount(restored?.lines.length ?? 0);
    progressRef.current = newCommitProgress(restored);
    commitNowRef.current = new Date();
  }, [open, activePropertyId, lang, timezone]);

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
    if (phase === 'committing' || retryLocked) return;
    clearStaged();
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
        body = JSON.stringify({ pid: activePropertyId, pages });
      } else {
        const pdfBase64 = await fileToBase64(cur.file);
        body = JSON.stringify({ pid: activePropertyId, pdfBase64 });
      }
      const res = await fetchWithAuth('/api/inventory/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        vendor_name?: string | null;
        invoice_date?: string | null;
        invoice_number?: string | null;
        items?: RawInvoiceLine[];
        error?: string;
      };
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
      setRows(items.map((raw, i) => buildRow(raw, i, display)));
      setVendor((json.vendor_name ?? '').trim());
      setInvoiceDate((json.invoice_date ?? '').trim());
      const num = (json.invoice_number ?? '').trim();
      setInvoiceNumber(num || null);
      setBanner('');
      // Scan accepted — the staged files (and their thumbnails) are done with;
      // release them so we don't hold blob URLs through the review/commit phases.
      clearStaged();
      setPhase('review');

      // A numbered invoice is fail-closed: search a field-test-sized history
      // window and hard-block Save on a match OR if history could not be
      // verified. There is deliberately no override during the field test.
      if (num) {
        setDupChecking(true);
        try {
          const tag = buildNotesTag(num, json.vendor_name ?? null);
          const orders = await listInventoryOrders(user.uid, activePropertyId, 2000);
          setDupWarn(invoiceAlreadyRecorded(orders.map((o) => o.notes), tag));
        } catch {
          setDupCheckFailed(true);
        } finally {
          setDupChecking(false);
        }
      }
    } catch (err) {
      console.error('[scan-invoice] failed', err);
      setPhase('error');
      setErrorText(ss.uploadFailed);
    }
  };

  const duplicateBlocked = numberedInvoiceSaveBlocked({
    invoiceNumber,
    checking: dupChecking,
    duplicate: dupWarn,
    checkFailed: dupCheckFailed,
  });
  const costsComplete = rows.every(reviewRowHasCompleteCost);

  const handleCommit = async () => {
    if (
      !user || !activePropertyId || phase === 'committing'
      || (!retryLocked && (duplicateBlocked || !costsComplete))
    ) return;
    setPhase('committing');
    setBanner('');

    try {
      if (retryLocked) {
        await retryCommit(progressRef.current, { uid: user.uid, pid: activePropertyId });
      } else {
        const plan = buildCommitPlan({
          propertyTimezone: timezone,
          vendorName: vendor,
          invoiceDate,
          invoiceNumber,
          lines: rows.map((r) => ({
            key: r.key,
            itemName: r.raw.item_name,
            decision: r.decision,
            matchedItemId: r.matchedItemId,
            qty: r.qtyInput,
            quantityCases: r.raw.quantity_cases,
            unitCost: r.unitCostInput,
            // A manager-edited unit cost replaces hidden OCR math. Otherwise
            // the scanned line total remains authoritative for invoice rounding.
            totalCost: r.unitCostDirty ? null : r.raw.total_cost,
            onHandEstimate: onHandFor(r.matchedItemId),
            afterOverride: r.decision === 'match' && r.afterDirty ? r.afterInput : null,
            newItem: r.decision === 'create' ? { category: r.newCategory, unit: r.newUnit, parLevel: r.newPar } : undefined,
          })),
        }, commitNowRef.current);
        await executeCommit(plan, progressRef.current, {
          uid: user.uid,
          pid: activePropertyId,
        });
      }
    } catch (e) {
      if (isDefinitiveDeliveryFailure(e, retryLocked)) {
        releaseRejectedCommit(progressRef.current, activePropertyId);
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
      return;
    }
    setRetryLocked(false);
    setPhase('done');
  };

  const reviewing = phase === 'review' || phase === 'committing';
  const actionable = rows.filter((r) => r.decision !== 'skip').length;
  const matchedCount = rows.filter((r) => r.decision === 'match').length;
  const createCount = rows.filter((r) => r.decision === 'create').length;

  return (
    <Overlay
      open={open}
      onClose={handleClose}
      eyebrow={ss.scanInvoice}
      italic={reviewing ? ss.whatArrived : phase === 'done' ? ss.saved : ss.dropOneIn}
      suffix={reviewing ? undefined : ss.autoUpdateStock}
      accent={T.sageDeep}
      width={reviewing ? 680 : 640}
      footer={
        reviewing ? (
          <>
            <Btn variant="ghost" size="md" onClick={handleClose} disabled={phase === 'committing'}>
              {ss.cancel}
            </Btn>
            <Btn
              variant="primary"
              size="md"
              onClick={handleCommit}
              disabled={phase === 'committing' || (!retryLocked && (actionable === 0 || duplicateBlocked || !costsComplete))}
            >
              {phase === 'committing'
                ? ss.adding
                : retryLocked
                  ? (lang === 'es' ? 'Reintentar la misma entrega' : 'Retry exact delivery')
                  : ss.addItems(actionable)}
            </Btn>
          </>
        ) : undefined
      }
    >
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
          {banner && <div style={warmStrip}>{banner}</div>}

          {/* Where it came from — read straight off the invoice, not a form. */}
          {(vendor || invoiceDate) && (
            <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.02em' }}>
              {[vendor, fmtInvoiceDate(invoiceDate, lang)].filter(Boolean).join(' · ')}
            </div>
          )}

          {!retryLocked && <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((row) => (
              <ReviewRowView
                key={row.key}
                lang={lang}
                row={row}
                display={display}
                onDecision={(v) => setDecision(row, v)}
                onQty={(v) => setQty(row, v)}
                onUnitCost={(v) => {
                  if (!numGuard(v)) return;
                  patchRow(row.key, { unitCostInput: v, unitCostDirty: true });
                }}
                onNewCategory={(c) => patchRow(row.key, { newCategory: c })}
                onSkip={() => patchRow(row.key, { decision: 'skip' })}
                onUnskip={() =>
                  patchRow(row.key, {
                    decision: row.matchedItemId && row.candidates.length > 0 ? 'match' : 'create',
                  })
                }
              />
            ))}
          </div>}
        </div>
      )}
    </Overlay>
  );
}
