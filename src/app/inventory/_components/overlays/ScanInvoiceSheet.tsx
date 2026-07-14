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
import { matchInvoiceLine } from '@/lib/inventory-match';
import {
  buildCommitPlan,
  buildNotesTag,
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
import { buildRow, ReviewRowView, type RawInvoiceLine, type ReviewRow } from './scan-review';
import { executeCommit, newCommitProgress, errMsg, type CommitFailure } from './scan-commit';

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

export function ScanInvoiceSheet({ lang, open, onClose, display }: { lang: Lang; open: boolean; onClose: () => void; display: DisplayItem[] }) {
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
  const [banner, setBanner] = useState('');

  // Per-line commit progress, so a retry after a partial failure resumes the
  // failed step and never double-inserts an order / re-creates an item.
  const progressRef = useRef(newCommitProgress());

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
    setPhase('upload');
    setErrorText('');
    clearStaged();
    setVendor('');
    setInvoiceDate('');
    setInvoiceNumber(null);
    setRows([]);
    setDupWarn(false);
    setBanner('');
    progressRef.current = newCommitProgress();
  }, [open]);

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
    if (!row.afterDirty && row.decision === 'match') {
      patch.afterInput = String(onHandFor(row.matchedItemId) + (Number(v) || 0));
    }
    patchRow(row.key, patch);
  };

  const setDecision = (row: ReviewRow, value: string) => {
    if (value === '__create__') {
      patchRow(row.key, { decision: 'create' });
    } else if (value === '__skip__') {
      patchRow(row.key, { decision: 'skip' });
    } else {
      patchRow(row.key, {
        decision: 'match',
        matchedItemId: value,
        // An explicit pick answers the "two close matches" question — clear it.
        ambiguous: false,
        afterDirty: false,
        afterInput: String(onHandFor(value) + (Number(row.qtyInput) || 0)),
      });
    }
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

      // Warning-only duplicate check (no invoice_number column to hard-guard on).
      try {
        const tag = buildNotesTag(num || null, json.vendor_name ?? null);
        const orders = await listInventoryOrders(user.uid, activePropertyId, 200);
        setDupWarn(invoiceAlreadyRecorded(orders.map((o) => o.notes), tag));
      } catch {
        /* non-blocking */
      }
    } catch (err) {
      console.error('[scan-invoice] failed', err);
      setPhase('error');
      setErrorText(ss.uploadFailed);
    }
  };

  const handleCommit = async () => {
    if (!user || !activePropertyId || phase === 'committing') return;
    setPhase('committing');
    setBanner('');
    const plan = buildCommitPlan({
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
        onHandEstimate: onHandFor(r.matchedItemId),
        afterOverride: r.decision === 'match' && r.afterDirty ? r.afterInput : null,
        newItem: r.decision === 'create' ? { category: r.newCategory, unit: r.newUnit, parLevel: r.newPar } : undefined,
      })),
    });

    let failures: CommitFailure[] = [];
    try {
      failures = await executeCommit(plan, progressRef.current, {
        uid: user.uid,
        pid: activePropertyId,
        nameExists: ss.nameExists,
      });
    } catch (e) {
      setBanner(ss.savingFailed(errMsg(e)));
      setPhase('review');
      return;
    }

    const prog = progressRef.current;
    if (failures.length === 0) {
      setPhase('done');
      return;
    }
    // Mark per-row outcomes; flip name-collisions back to a match decision.
    setRows((prev) =>
      prev.map((r) => {
        const f = failures.find((x) => x.lineKey === r.key);
        const committed = prog.orderedKeys.has(r.key) || prog.createdIds.has(r.key);
        if (f?.collision) {
          return { ...r, saved: committed, error: f.reason, decision: 'match', candidates: matchInvoiceLine(r.raw.item_name, display).candidates };
        }
        return { ...r, saved: committed, error: f?.reason };
      }),
    );
    setBanner(ss.needAttention(prog.orderedKeys.size, failures.length));
    setPhase('review');
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
      width={reviewing ? 560 : 640}
      footer={
        reviewing ? (
          <>
            <Btn variant="ghost" size="md" onClick={handleClose} disabled={phase === 'committing'}>
              {ss.cancel}
            </Btn>
            <Btn variant="primary" size="md" onClick={handleCommit} disabled={phase === 'committing' || actionable === 0}>
              {phase === 'committing' ? ss.adding : ss.addItems(actionable)}
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
            {ss.savedMsg(matchedCount + createCount)}
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
          {dupWarn && <div style={warmStrip}>{ss.dupWarn}</div>}
          {banner && <div style={warmStrip}>{banner}</div>}

          {/* Where it came from — read straight off the invoice, not a form. */}
          {(vendor || invoiceDate) && (
            <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.02em' }}>
              {[vendor, fmtInvoiceDate(invoiceDate, lang)].filter(Boolean).join(' · ')}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((row) => (
              <ReviewRowView
                key={row.key}
                lang={lang}
                row={row}
                onDecision={(v) => setDecision(row, v)}
                onQty={(v) => setQty(row, v)}
                onNewCategory={(c) => patchRow(row.key, { newCategory: c })}
                onSkip={() => patchRow(row.key, { decision: 'skip' })}
                onUnskip={() =>
                  patchRow(row.key, {
                    decision: row.matchedItemId && row.candidates.length > 0 ? 'match' : 'create',
                  })
                }
              />
            ))}
          </div>
        </div>
      )}
    </Overlay>
  );
}
