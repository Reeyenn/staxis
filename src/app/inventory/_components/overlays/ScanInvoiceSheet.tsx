'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  addInventoryItem,
  addInventoryOrder,
  updateInventoryItem,
  listInventoryOrders,
} from '@/lib/db';
import type { InventoryCategory } from '@/types';
import { matchInvoiceLine, type MatchCandidate } from '@/lib/inventory-match';
import {
  buildCommitPlan,
  buildNotesTag,
  invoiceAlreadyRecorded,
  type CommitPlan,
} from '@/lib/inventory-invoice-commit';

import { T, fonts, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

// Co-located strings for the scan-invoice sheet. (Split out of the retired
// SimpleSheet when the AI-helper overlay became the /inventory/ai screen —
// the scan-invoice feature is NOT an AI-cockpit surface, it's plain invoice
// OCR, so it keeps living as an overlay on the manual inventory page.)
function ssStrings(lang: Lang) {
  return {
    en: {
      scanInvoice: 'Scan invoice',
      reviewSave: 'Review & save',
      saved: 'Saved',
      dropOneIn: 'Drop one in',
      matched: 'matched',
      new: 'new',
      skipped: 'skipped',
      autoUpdateStock: 'auto-update stock',
      cancel: 'Cancel',
      saving: 'Saving…',
      saveLines: (n: number) => `Save ${n} line${n === 1 ? '' : 's'}`,
      dropInvoicePhoto: 'Drop an invoice photo here',
      dropHint: "A photo or screenshot. We'll read the lines and match them to your inventory — you confirm before anything saves.",
      reading: 'Reading…',
      choosePhoto: 'Choose file…',
      pdfHint: 'PDF invoices work too — pick the file and we’ll read every page.',
      tryAnotherPhoto: 'Try another photo',
      // Staging step — one or more pages / a single PDF before scanning.
      pageN: (n: number) => `Page ${n}`,
      addAnotherPage: '＋ Add another page',
      removePage: (n: number) => `Remove page ${n}`,
      removePdf: 'Remove PDF',
      scanInvoiceAction: 'Scan invoice',
      maxPagesReached: 'That’s the limit — 5 pages per scan.',
      onePdfPerScan: 'A PDF scans on its own — remove it to add photo pages instead.',
      pdfTooBig: 'That PDF is too large (over 4 MB). Photograph the pages and add them instead.',
      heicUnsupported: 'That photo format (HEIC) can’t be read here — use a JPG or PNG, or take a fresh photo.',
      notAnImage: 'That file isn’t a photo or PDF — pick an image or a PDF.',
      savedMsg: (n: number) => `Saved. Stock updated and the delivery logged for ${n} item${n === 1 ? '' : 's'}.`,
      done: 'Done',
      dupWarn: "This invoice looks like it may already be recorded. You can still save it if it's a new delivery.",
      vendor: 'Vendor',
      supplier: 'Supplier',
      invoiceDate: 'Invoice date',
      createNew: '＋ Create new item',
      skipLine: 'Skip this line',
      twoCloseMatches: 'Two close matches — confirm which.',
      qtyReceived: 'Qty received',
      unitCost: 'Unit cost ($)',
      onHand: (n: number) => `On hand ≈${n} → new on-hand`,
      checkSuffix: ' ⚠ check',
      newItemCategory: 'New item category',
      unit: 'Unit',
      par: 'Par',
      errTooMany: 'Too many line items to scan at once. Split the invoice into pages and rescan.',
      errBadImage: 'Couldn’t read that image. Try a clearer, well-lit photo.',
      errRateLimit: 'Too many scans this hour — please try again shortly.',
      errUnavailable: 'Scanning is temporarily unavailable. Try again in a moment.',
      errReadInvoice: (e: string) => `Couldn’t read that invoice (${e}).`,
      errReadInvoiceGeneric: 'Couldn’t read that invoice. Please try a clearer photo.',
      noLineItems: 'No line items detected — try a clearer photo.',
      uploadFailed: 'Upload failed. Please try again.',
      savingFailed: (e: string) => `Saving failed: ${e}`,
      nameExists: 'That name already exists — match it to the existing item instead.',
      needAttention: (saved: number, n: number) => `${saved} saved, ${n} need attention — fix and Save again.`,
      cases: (n: number, pack: number) => `${n} case${n === 1 ? '' : 's'} × ${pack}`,
    },
    es: {
      scanInvoice: 'Escanear factura',
      reviewSave: 'Revisar y guardar',
      saved: 'Guardado',
      dropOneIn: 'Suelta una aquí',
      matched: 'coincidencias',
      new: 'nuevos',
      skipped: 'omitidos',
      autoUpdateStock: 'actualiza el stock',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      saveLines: (n: number) => `Guardar ${n} línea${n === 1 ? '' : 's'}`,
      dropInvoicePhoto: 'Suelta una foto de la factura aquí',
      dropHint: 'Una foto o captura. Leemos las líneas y las emparejamos con tu inventario — tú confirmas antes de que se guarde algo.',
      reading: 'Leyendo…',
      choosePhoto: 'Elegir archivo…',
      pdfHint: 'También sirven las facturas en PDF — elige el archivo y leemos todas las páginas.',
      tryAnotherPhoto: 'Probar otra foto',
      // Paso de preparación — una o varias páginas / un solo PDF antes de escanear.
      pageN: (n: number) => `Página ${n}`,
      addAnotherPage: '＋ Agregar otra página',
      removePage: (n: number) => `Quitar página ${n}`,
      removePdf: 'Quitar PDF',
      scanInvoiceAction: 'Escanear factura',
      maxPagesReached: 'Ese es el límite — 5 páginas por escaneo.',
      onePdfPerScan: 'Un PDF se escanea solo — quítalo para agregar páginas de fotos.',
      pdfTooBig: 'Ese PDF es demasiado grande (más de 4 MB). Fotografía las páginas y agrégalas.',
      heicUnsupported: 'Ese formato de foto (HEIC) no se puede leer aquí — usa un JPG o PNG, o toma una foto nueva.',
      notAnImage: 'Ese archivo no es una foto ni un PDF — elige una imagen o un PDF.',
      savedMsg: (n: number) => `Guardado. Stock actualizado y entrega registrada para ${n} artículo${n === 1 ? '' : 's'}.`,
      done: 'Listo',
      dupWarn: 'Esta factura parece que ya está registrada. Puedes guardarla de todas formas si es una entrega nueva.',
      vendor: 'Proveedor',
      supplier: 'Proveedor',
      invoiceDate: 'Fecha de factura',
      createNew: '＋ Crear artículo nuevo',
      skipLine: 'Omitir esta línea',
      twoCloseMatches: 'Dos coincidencias cercanas — confirma cuál.',
      qtyReceived: 'Cant. recibida',
      unitCost: 'Costo unitario ($)',
      onHand: (n: number) => `Disponible ≈${n} → nuevo disponible`,
      checkSuffix: ' ⚠ revisar',
      newItemCategory: 'Categoría del nuevo artículo',
      unit: 'Unidad',
      par: 'Par',
      errTooMany: 'Demasiadas líneas para escanear de una vez. Divide la factura en páginas y vuelve a escanear.',
      errBadImage: 'No se pudo leer la imagen. Intenta una foto más clara y bien iluminada.',
      errRateLimit: 'Demasiados escaneos esta hora — inténtalo de nuevo en un momento.',
      errUnavailable: 'El escaneo no está disponible por ahora. Inténtalo de nuevo en un momento.',
      errReadInvoice: (e: string) => `No se pudo leer la factura (${e}).`,
      errReadInvoiceGeneric: 'No se pudo leer la factura. Intenta una foto más clara.',
      noLineItems: 'No se detectaron líneas — intenta una foto más clara.',
      uploadFailed: 'Falló la subida. Inténtalo de nuevo.',
      savingFailed: (e: string) => `Falló al guardar: ${e}`,
      nameExists: 'Ese nombre ya existe — emparéjalo con el artículo existente.',
      needAttention: (saved: number, n: number) => `${saved} guardados, ${n} requieren atención — corrige y Guarda de nuevo.`,
      cases: (n: number, pack: number) => `${n} caja${n === 1 ? '' : 's'} × ${pack}`,
    },
  }[lang];
}

/* ──────────────────────────────────────────────────────────────────────
   Scan Invoice — upload → review/match → commit
   Snap an invoice, Claude Vision reads the lines, we match each to an
   inventory item, the manager confirms, and we write the received stock +
   log the delivery. See plan §Feature 1.
   ────────────────────────────────────────────────────────────────────── */
type ScanPhase = 'upload' | 'reading' | 'review' | 'committing' | 'done' | 'error';
type LineDecision = 'match' | 'create' | 'skip';

interface RawInvoiceLine {
  item_name: string;
  quantity: number;
  quantity_cases: number | null;
  pack_size: number | null;
  unit_cost: number | null;
  total_cost: number | null;
}

interface ReviewRow {
  key: string;
  raw: RawInvoiceLine;
  decision: LineDecision;
  matchedItemId: string | null;
  candidates: MatchCandidate[];
  ambiguous: boolean;
  qtyInput: string;
  unitCostInput: string;
  afterInput: string;   // resulting on-hand for a matched line (editable)
  afterDirty: boolean;  // operator overrode the resulting stock
  newCategory: InvCat;
  newUnit: string;
  newPar: string;
  saved: boolean;
  error?: string;
}

const numGuard = (v: string) => v === '' || /^\d*\.?\d*$/.test(v);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Staging model for the upload step. The scan can carry EITHER a set of image
// pages (1..5) OR a single PDF — never both (the backend contract is one shape
// per request, and mixing a PDF with photos has no meaning). We keep the two
// in one discriminated union so the "no mixing" rule is impossible to violate.
const MAX_PAGES = 5;
const PDF_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — mirrors the route's file cap.
// One staged image page: the File plus an object-URL for its thumbnail. The URL
// is revoked when the page is removed or the sheet resets, so we don't leak.
interface StagedPage { file: File; url: string; }
type Staged =
  | { kind: 'none' }
  | { kind: 'images'; pages: StagedPage[] }
  | { kind: 'pdf'; file: File };

// A File is HEIC/HEIF if the browser reports the type or the name ends in the
// extension (Safari sometimes hands us an empty type). Anthropic Vision can't
// read these, and canvas decode fails silently on some devices — reject at pick
// time with a clear message rather than a generic "upload failed" later.
function isHeic(file: File): boolean {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/heic' || t === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
}
function isPdf(file: File): boolean {
  return (file.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name);
}
function isImage(file: File): boolean {
  return (file.type || '').toLowerCase().startsWith('image/');
}

// Read a File as base64 with no data: prefix (the route wants the raw payload).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function scanErrorFor(lang: Lang, status: number, err?: string): string {
  const ss = ssStrings(lang);
  if (status === 422) return ss.errTooMany;
  if (status === 400) return ss.errBadImage;
  if (status === 429) return ss.errRateLimit;
  if (status === 503) return ss.errUnavailable;
  return err ? ss.errReadInvoice(err) : ss.errReadInvoiceGeneric;
}

function buildRow(raw: RawInvoiceLine, i: number, display: DisplayItem[]): ReviewRow {
  const m = matchInvoiceLine(raw.item_name, display);
  const qty = raw.quantity > 0 ? raw.quantity : 1;
  const matchedItemId = m.best?.id ?? null;
  const onHand = matchedItemId
    ? Math.max(0, Math.round(display.find((d) => d.id === matchedItemId)?.estimated ?? 0))
    : 0;
  return {
    key: `${i}-${raw.item_name.slice(0, 24)}`,
    raw,
    decision: m.candidates.length > 0 ? 'match' : 'create',
    matchedItemId,
    candidates: m.candidates,
    ambiguous: m.ambiguous,
    qtyInput: String(qty),
    unitCostInput: raw.unit_cost != null ? String(raw.unit_cost) : '',
    afterInput: String(onHand + qty),
    afterDirty: false,
    newCategory: 'housekeeping',
    newUnit: 'each',
    newPar: '0',
    saved: false,
  };
}

export function ScanInvoiceSheet({ lang, open, onClose, display }: { lang: Lang; open: boolean; onClose: () => void; display: DisplayItem[] }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ss = ssStrings(lang);
  const fileRef = useRef<HTMLInputElement>(null);

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
  const progressRef = useRef<{ createdIds: Map<string, string>; orderedKeys: Set<string>; stockedIds: Set<string> }>({
    createdIds: new Map(),
    orderedKeys: new Set(),
    stockedIds: new Set(),
  });

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
    progressRef.current = { createdIds: new Map(), orderedKeys: new Set(), stockedIds: new Set() };
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
        afterDirty: false,
        afterInput: String(onHandFor(value) + (Number(row.qtyInput) || 0)),
      });
    }
  };

  const handlePick = () => fileRef.current?.click();

  // Fold newly-picked files into the staged set, enforcing the four rules:
  //   1. PDF staged → picking anything more just shows the "PDF scans alone" note.
  //   2. images staged + a PDF picked → same note (no mixing).
  //   3. a single fresh PDF (nothing staged) → stage it, drop any pages.
  //   4. images → append up to MAX_PAGES; extras beyond the cap are ignored w/ a note.
  // HEIC and non-image/non-PDF files are rejected here with their own message.
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setStageNote('');
    const cur = stagedRef.current;

    // A PDF is already staged — one PDF per scan, no appending.
    if (cur.kind === 'pdf') {
      setStageNote(ss.onePdfPerScan);
      return;
    }

    const pdf = files.find(isPdf);
    if (pdf) {
      // Mixing rule: a PDF can only be staged on its own. If images are already
      // staged (or the manager picked images + a PDF together), refuse the PDF.
      if (cur.kind === 'images' || files.some((f) => isImage(f) && !isPdf(f))) {
        setStageNote(ss.onePdfPerScan);
        return;
      }
      if (pdf.size > PDF_MAX_BYTES) {
        setStageNote(ss.pdfTooBig);
        return;
      }
      setStaged({ kind: 'pdf', file: pdf });
      return;
    }

    // Image path — validate each, then append respecting the 5-page cap.
    const existing = cur.kind === 'images' ? cur.pages : [];
    const room = MAX_PAGES - existing.length;
    const additions: StagedPage[] = [];
    let rejectedHeic = false;
    let rejectedType = false;
    let overflowed = false;
    for (const f of files) {
      if (!isImage(f)) { rejectedType = true; continue; }
      if (isHeic(f)) { rejectedHeic = true; continue; }
      if (additions.length >= room) { overflowed = true; continue; }
      additions.push({ file: f, url: URL.createObjectURL(f) });
    }

    if (additions.length > 0) {
      setStaged({ kind: 'images', pages: [...existing, ...additions] });
    }
    // Surface the most actionable message (order: bad type → HEIC → cap hit).
    if (rejectedType) setStageNote(ss.notAnImage);
    else if (rejectedHeic) setStageNote(ss.heicUnsupported);
    else if (overflowed) setStageNote(ss.maxPagesReached);
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

  // Drag-drop onto the dropzone / staging area — same append rules as picking.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (phase !== 'upload') return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) addFiles(files);
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

  async function executeCommit(plan: CommitPlan) {
    const prog = progressRef.current;
    const failures: Array<{ lineKey?: string; reason: string; collision?: boolean }> = [];
    const uid = user!.uid;
    const pid = activePropertyId!;

    for (const c of plan.creates) {
      if (prog.createdIds.has(c.createKey)) continue;
      try {
        const id = await addInventoryItem(uid, pid, {
          propertyId: pid,
          name: c.name,
          category: c.category as InventoryCategory,
          currentStock: c.initialStock,
          parLevel: c.parLevel,
          unit: c.unit,
          unitCost: c.unitCost,
          vendorName: plan.vendorName,
          lastCountedAt: plan.receivedAt,
        });
        prog.createdIds.set(c.createKey, id);
      } catch (e) {
        const collision = (e as { code?: string })?.code === '23505' || /duplicate key|unique/i.test(errMsg(e));
        failures.push({
          lineKey: c.createKey,
          collision,
          reason: collision ? ss.nameExists : errMsg(e),
        });
      }
    }

    for (const o of plan.orders) {
      if (prog.orderedKeys.has(o.lineKey)) continue;
      const itemId = o.itemId ?? (o.createKey ? prog.createdIds.get(o.createKey) : undefined);
      if (!itemId) continue; // its create failed — skip the order
      try {
        await addInventoryOrder(uid, pid, {
          propertyId: pid,
          itemId,
          itemName: o.itemName,
          quantity: o.quantity,
          quantityCases: o.quantityCases ?? undefined,
          unitCost: o.unitCost ?? undefined,
          vendorName: plan.vendorName,
          orderedAt: null,
          receivedAt: plan.receivedAt,
          notes: plan.notesTag,
        });
        prog.orderedKeys.add(o.lineKey);
      } catch (e) {
        failures.push({ lineKey: o.lineKey, reason: errMsg(e) });
      }
    }

    for (const s of plan.stockUpdates) {
      if (prog.stockedIds.has(s.itemId)) continue;
      try {
        await updateInventoryItem(uid, pid, s.itemId, { currentStock: s.finalStock, lastCountedAt: plan.receivedAt });
        prog.stockedIds.add(s.itemId);
      } catch (e) {
        failures.push({ reason: errMsg(e) });
      }
    }
    return failures;
  }

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

    let failures: Awaited<ReturnType<typeof executeCommit>> = [];
    try {
      failures = await executeCommit(plan);
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
  const skipCount = rows.filter((r) => r.decision === 'skip').length;

  return (
    <Overlay
      open={open}
      onClose={handleClose}
      eyebrow={ss.scanInvoice}
      italic={reviewing ? ss.reviewSave : phase === 'done' ? ss.saved : ss.dropOneIn}
      suffix={reviewing ? `${matchedCount} ${ss.matched} · ${createCount} ${ss.new} · ${skipCount} ${ss.skipped}` : ss.autoUpdateStock}
      accent={T.sageDeep}
      width={reviewing ? 900 : 640}
      footer={
        reviewing ? (
          <>
            <Btn variant="ghost" size="md" onClick={handleClose} disabled={phase === 'committing'}>
              {ss.cancel}
            </Btn>
            <Btn variant="primary" size="md" onClick={handleCommit} disabled={phase === 'committing' || actionable === 0}>
              {phase === 'committing' ? ss.saving : ss.saveLines(actionable)}
            </Btn>
          </>
        ) : undefined
      }
    >
      {(phase === 'upload' || phase === 'reading') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Hidden picker — images (multi) AND PDFs. addFiles enforces the
              1-PDF / max-5-images / no-mixing rules; the same rules apply to
              drag-drop below. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) addFiles(files);
              e.target.value = '';
            }}
          />

          {staged.kind === 'none' ? (
            // ── Empty dropzone ──────────────────────────────────────────────
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              style={{
                border: `1px dashed ${T.rule}`,
                borderRadius: 14,
                padding: '40px 24px',
                textAlign: 'center',
                background: 'repeating-linear-gradient(135deg, rgba(24,22,17,0.03) 0 10px, transparent 10px 20px)',
              }}
            >
              <div style={{ fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.02em' }}>
                {ss.dropInvoicePhoto}
              </div>
              <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: '8px 0 0' }}>
                {ss.dropHint}
              </div>
              <div style={{ marginTop: 16 }}>
                <Btn variant="primary" size="md" onClick={handlePick}>
                  {ss.choosePhoto}
                </Btn>
              </div>
              <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, marginTop: 12 }}>
                {ss.pdfHint}
              </div>
            </div>
          ) : (
            // ── Staging view: thumbnails / PDF card + add + scan ────────────
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
            >
              {staged.kind === 'images' ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {staged.pages.map((p, i) => (
                    <div
                      key={p.url}
                      style={{
                        position: 'relative',
                        width: 128,
                        borderRadius: 12,
                        border: `1px solid ${T.rule}`,
                        background: T.paper,
                        overflow: 'hidden',
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.url}
                        alt={ss.pageN(i + 1)}
                        style={{ display: 'block', width: '100%', height: 128, objectFit: 'cover' }}
                      />
                      <button
                        type="button"
                        aria-label={ss.removePage(i + 1)}
                        onClick={() => removePage(i)}
                        disabled={phase === 'reading'}
                        style={{
                          position: 'absolute',
                          top: 6,
                          right: 6,
                          width: 24,
                          height: 24,
                          borderRadius: 12,
                          border: 'none',
                          background: 'rgba(24,22,17,0.72)',
                          color: '#FFFFFF',
                          fontFamily: fonts.sans,
                          fontSize: 15,
                          lineHeight: 1,
                          cursor: phase === 'reading' ? 'not-allowed' : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        ×
                      </button>
                      <div
                        style={{
                          padding: '6px 8px',
                          fontFamily: fonts.mono,
                          fontSize: 10.5,
                          letterSpacing: '0.04em',
                          color: T.ink2,
                          borderTop: `1px solid ${T.ruleSoft}`,
                        }}
                      >
                        {ss.pageN(i + 1)}
                      </div>
                    </div>
                  ))}

                  {staged.pages.length < MAX_PAGES && (
                    <button
                      type="button"
                      onClick={handlePick}
                      disabled={phase === 'reading'}
                      style={{
                        width: 128,
                        height: 158,
                        borderRadius: 12,
                        border: `1px dashed ${T.rule}`,
                        background: T.bg,
                        color: T.ink2,
                        fontFamily: fonts.sans,
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: phase === 'reading' ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        padding: '0 10px',
                      }}
                    >
                      {ss.addAnotherPage}
                    </button>
                  )}
                </div>
              ) : (
                // Single PDF card — document glyph + name + size. No add button.
                <div
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '16px 18px',
                    borderRadius: 12,
                    border: `1px solid ${T.rule}`,
                    background: T.paper,
                  }}
                >
                  <svg width="34" height="42" viewBox="0 0 34 42" fill="none" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M3 3.5A2.5 2.5 0 0 1 5.5 1h16L31 10.5V38.5A2.5 2.5 0 0 1 28.5 41H5.5A2.5 2.5 0 0 1 3 38.5V3.5Z" fill={T.ruleSoft} stroke={T.rule} strokeWidth="1.5" />
                    <path d="M21.5 1v9.5H31" stroke={T.rule} strokeWidth="1.5" fill="none" />
                    <text x="17" y="30" textAnchor="middle" fontFamily={fonts.mono} fontSize="8.5" fontWeight="700" fill={T.terra}>PDF</text>
                  </svg>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {staged.file.name}
                    </div>
                    <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, marginTop: 3 }}>
                      {(staged.file.size / (1024 * 1024)).toFixed(2)} MB
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={ss.removePdf}
                    onClick={clearStaged}
                    disabled={phase === 'reading'}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      border: `1px solid ${T.rule}`,
                      background: T.bg,
                      color: T.ink2,
                      fontFamily: fonts.sans,
                      fontSize: 15,
                      lineHeight: 1,
                      cursor: phase === 'reading' ? 'not-allowed' : 'pointer',
                      flex: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {stageNote && (
                <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                  {stageNote}
                </div>
              )}

              <div>
                <Btn variant="primary" size="md" onClick={handleScan} disabled={phase === 'reading'}>
                  {phase === 'reading' ? ss.reading : ss.scanInvoiceAction}
                </Btn>
              </div>
            </div>
          )}

          {/* Note shown on the empty dropzone too (e.g. rejected a lone bad file). */}
          {staged.kind === 'none' && stageNote && (
            <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
              {stageNote}
            </div>
          )}
        </div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {dupWarn && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: T.warmDim,
                border: `1px solid ${T.warm}33`,
                fontFamily: fonts.sans,
                fontSize: 12.5,
                color: T.warm,
              }}
            >
              {ss.dupWarn}
            </div>
          )}
          {banner && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: T.warmDim,
                border: `1px solid ${T.warm}33`,
                fontFamily: fonts.sans,
                fontSize: 12.5,
                color: T.warm,
              }}
            >
              {banner}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <Caps>{ss.vendor}</Caps>
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder={ss.supplier} style={inputSm} />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <Caps>{ss.invoiceDate}</Caps>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputSm} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((row) => (
              <ReviewRowView
                key={row.key}
                lang={lang}
                row={row}
                onHand={onHandFor(row.matchedItemId)}
                matchedCounted={row.matchedItemId ? byId.get(row.matchedItemId)?.counted ?? 0 : 0}
                onDecision={(v) => setDecision(row, v)}
                onQty={(v) => setQty(row, v)}
                onUnitCost={(v) => { if (numGuard(v)) patchRow(row.key, { unitCostInput: v }); }}
                onAfter={(v) => { if (numGuard(v)) patchRow(row.key, { afterInput: v, afterDirty: true }); }}
                onNewCategory={(c) => patchRow(row.key, { newCategory: c })}
                onNewUnit={(v) => patchRow(row.key, { newUnit: v })}
                onNewPar={(v) => { if (numGuard(v)) patchRow(row.key, { newPar: v }); }}
              />
            ))}
          </div>
        </div>
      )}
    </Overlay>
  );
}

const inputSm: React.CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 12px',
  borderRadius: 9,
  boxSizing: 'border-box',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans,
  fontSize: 13.5,
  color: T.ink,
  outline: 'none',
};

function ReviewRowView({
  lang,
  row,
  onHand,
  matchedCounted,
  onDecision,
  onQty,
  onUnitCost,
  onAfter,
  onNewCategory,
  onNewUnit,
  onNewPar,
}: {
  lang: Lang;
  row: ReviewRow;
  onHand: number;
  matchedCounted: number;
  onDecision: (v: string) => void;
  onQty: (v: string) => void;
  onUnitCost: (v: string) => void;
  onAfter: (v: string) => void;
  onNewCategory: (c: InvCat) => void;
  onNewUnit: (v: string) => void;
  onNewPar: (v: string) => void;
}) {
  const ss = ssStrings(lang);
  const skipped = row.decision === 'skip';
  const selectValue = row.decision === 'create' ? '__create__' : row.decision === 'skip' ? '__skip__' : row.matchedItemId ?? '__create__';
  // Loud if we'd re-baseline to roughly just the received qty even though the
  // item has stored stock — usually a stale usage rate, worth a second look.
  const staleEstimate = row.decision === 'match' && onHand === 0 && matchedCounted > 0;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;

  return (
    <div
      style={{
        border: `1px solid ${row.error ? `${T.warm}55` : T.rule}`,
        borderRadius: 12,
        padding: '12px 14px',
        background: skipped ? T.ruleSoft : row.saved ? T.sageDim : T.paper,
        opacity: skipped ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 13, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.saved && '✓ '}
            {row.raw.item_name}
          </div>
          {caseCaption && <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3 }}>{caseCaption}</div>}
        </div>
        <select value={selectValue} onChange={(e) => onDecision(e.target.value)} style={{ ...inputSm, width: 'auto', flex: '1 1 200px', cursor: 'pointer' }}>
          {row.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({Math.round(c.score * 100)}%)
            </option>
          ))}
          <option value="__create__">{ss.createNew}</option>
          <option value="__skip__">{ss.skipLine}</option>
        </select>
      </div>

      {row.ambiguous && row.decision === 'match' && (
        <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.caramel }}>{ss.twoCloseMatches}</div>
      )}
      {row.error && <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.warm }}>{row.error}</div>}

      {!skipped && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '0 0 92px' }}>
            <span style={miniLabel}>{ss.qtyReceived}</span>
            <input value={row.qtyInput} inputMode="decimal" onChange={(e) => onQty(e.target.value)} style={inputSm} />
          </label>
          <label style={{ flex: '0 0 100px' }}>
            <span style={miniLabel}>{ss.unitCost}</span>
            <input value={row.unitCostInput} inputMode="decimal" placeholder="—" onChange={(e) => onUnitCost(e.target.value)} style={inputSm} />
          </label>

          {row.decision === 'match' && (
            <label style={{ flex: '1 1 160px' }}>
              <span style={miniLabel}>
                {ss.onHand(onHand)}{staleEstimate ? ss.checkSuffix : ''}
              </span>
              <input
                value={row.afterInput}
                inputMode="decimal"
                onChange={(e) => onAfter(e.target.value)}
                style={{ ...inputSm, borderColor: staleEstimate ? `${T.warm}66` : T.rule }}
              />
            </label>
          )}

          {row.decision === 'create' && (
            <>
              <label style={{ flex: '0 0 150px' }}>
                <span style={miniLabel}>{ss.newItemCategory}</span>
                <select value={row.newCategory} onChange={(e) => onNewCategory(e.target.value as InvCat)} style={{ ...inputSm, cursor: 'pointer' }}>
                  {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((c) => (
                    <option key={c} value={c}>
                      {catLabelFor(lang, c)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: '0 0 90px' }}>
                <span style={miniLabel}>{ss.unit}</span>
                <input value={row.newUnit} onChange={(e) => onNewUnit(e.target.value)} style={inputSm} />
              </label>
              <label style={{ flex: '0 0 80px' }}>
                <span style={miniLabel}>{ss.par}</span>
                <input value={row.newPar} inputMode="decimal" onChange={(e) => onNewPar(e.target.value)} style={inputSm} />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const miniLabel: React.CSSProperties = {
  display: 'block',
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: T.ink3,
  marginBottom: 4,
  fontWeight: 600,
};
