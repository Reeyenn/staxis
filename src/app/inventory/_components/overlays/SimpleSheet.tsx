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

import { T, fonts, statusColor, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { ItemThumb } from '../ItemThumb';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

type Kind = 'scan' | 'ai';
type AiMode = 'off' | 'auto' | 'always-on';

interface SimpleSheetProps {
  lang: Lang;
  open: boolean;
  kind: Kind;
  onClose: () => void;
  aiMode: AiMode;
  onModeChange: (mode: AiMode) => void;
  display: DisplayItem[];
}

// Co-located strings for the scan-invoice + AI-helper sheets.
function ssStrings(lang: Lang) {
  return {
    en: {
      // scan
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
      choosePhoto: 'Choose photo…',
      pdfHint: 'PDF invoice? Screenshot the page and upload the image.',
      tryAnotherPhoto: 'Try another photo',
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
      // scan errors
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
      // AI helper
      aiHelper: 'AI Helper',
      howItWorks: 'How it works',
      andWhatItKnows: 'and what it knows',
      overview: 'Overview',
      usageRates: 'Usage rates',
      status: 'Status',
      aiIntro: "The AI watches your counts, occupancy, and order history, then learns how fast you use each item. Once it's confident, it starts ",
      fillingInCounts: 'filling in counts for you',
      youCanOverride: '. You can always override.',
      mode: 'Mode',
      off: 'Off',
      auto: 'Auto',
      alwaysOn: 'Always-on',
      modeAuto: 'Auto · the AI fills counts only for items where it’s confident.',
      modeAlwaysOn: 'Always-on · any prediction is pre-filled, even for less-trained items.',
      modeOff: 'Off · no auto-fill. Type every number yourself.',
      graduated: 'Graduated.',
      learning: 'Learning.',
      autoFilling: (a: number, b: number) => `Auto-filling ${a} of ${b} items.`,
      seeStatus: 'See status →',
      ratesIntro: "You don't enter usage rates yourself. The AI learns each one from your monthly counts and the property's occupancy. Override if something looks off.",
      noItemsYet: 'No items yet.',
      perRoom: ' per room',
      perDay: ' per day',
      learned: 'learned',
      learningTag: 'learning',
      statusIntro: "Three checks need to pass before the AI will fill counts for you. Once it graduates, it stays graduated as long as it's still hitting the bar.",
      countsLogged: 'Counts logged',
      needed: (n: number) => `${n} needed`,
      accuracy: 'Accuracy',
      populating: 'Populating…',
      pctOff: (n: string) => `${n}% off`,
      firstRetrain: 'first weekly retrain fills this in',
      underToPass: (n: number) => `under ${n}% to pass`,
      stableMonths: 'Stable months',
      stillLearning: 'Still learning.',
      autoFillingCounts: (a: number, b: number) => `Auto-filling counts on ${a} of ${b} items.`,
      remainingLearning: (n: number) => `The remaining ${n} are still learning — they’ll join once they hit the bar.`,
      passing: 'Passing',
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
      choosePhoto: 'Elegir foto…',
      pdfHint: '¿Factura en PDF? Toma una captura de la página y sube la imagen.',
      tryAnotherPhoto: 'Probar otra foto',
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
      aiHelper: 'Asistente IA',
      howItWorks: 'Cómo funciona',
      andWhatItKnows: 'y qué sabe',
      overview: 'Resumen',
      usageRates: 'Tasas de uso',
      status: 'Estado',
      aiIntro: 'La IA observa tus conteos, ocupación e historial de pedidos, luego aprende qué tan rápido usas cada artículo. Cuando tiene confianza, empieza a ',
      fillingInCounts: 'llenar los conteos por ti',
      youCanOverride: '. Siempre puedes corregir.',
      mode: 'Modo',
      off: 'Apagado',
      auto: 'Auto',
      alwaysOn: 'Siempre activo',
      modeAuto: 'Auto · la IA llena conteos solo para artículos en los que confía.',
      modeAlwaysOn: 'Siempre activo · cualquier predicción se prellenará, incluso para artículos menos entrenados.',
      modeOff: 'Apagado · sin autollenado. Escribe cada número tú mismo.',
      graduated: 'Graduado.',
      learning: 'Aprendiendo.',
      autoFilling: (a: number, b: number) => `Autollenando ${a} de ${b} artículos.`,
      seeStatus: 'Ver estado →',
      ratesIntro: 'No ingresas las tasas de uso tú mismo. La IA aprende cada una de tus conteos mensuales y la ocupación de la propiedad. Corrige si algo se ve mal.',
      noItemsYet: 'Aún no hay artículos.',
      perRoom: ' por habitación',
      perDay: ' por día',
      learned: 'aprendido',
      learningTag: 'aprendiendo',
      statusIntro: 'Tres comprobaciones deben pasar antes de que la IA llene conteos por ti. Una vez que se gradúa, sigue graduada mientras siga cumpliendo el estándar.',
      countsLogged: 'Conteos registrados',
      needed: (n: number) => `${n} necesarios`,
      accuracy: 'Precisión',
      populating: 'Cargando…',
      pctOff: (n: string) => `${n}% de error`,
      firstRetrain: 'el primer reentrenamiento semanal completa esto',
      underToPass: (n: number) => `menos de ${n}% para pasar`,
      stableMonths: 'Meses estables',
      stillLearning: 'Aún aprendiendo.',
      autoFillingCounts: (a: number, b: number) => `Autollenando conteos en ${a} de ${b} artículos.`,
      remainingLearning: (n: number) => `Los ${n} restantes aún están aprendiendo — se unirán cuando cumplan el estándar.`,
      passing: 'Cumple',
    },
  }[lang];
}

export function SimpleSheet({ lang, open, kind, onClose, aiMode, onModeChange, display }: SimpleSheetProps) {
  if (kind === 'scan') {
    return <ScanInvoiceSheet lang={lang} open={open} onClose={onClose} display={display} />;
  }
  return (
    <AIHelperSheet
      lang={lang}
      open={open}
      onClose={onClose}
      aiMode={aiMode}
      onModeChange={onModeChange}
      display={display}
    />
  );
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

function ScanInvoiceSheet({ lang, open, onClose, display }: { lang: Lang; open: boolean; onClose: () => void; display: DisplayItem[] }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ss = ssStrings(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<ScanPhase>('upload');
  const [errorText, setErrorText] = useState('');
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

  useEffect(() => {
    if (!open) return;
    setPhase('upload');
    setErrorText('');
    setVendor('');
    setInvoiceDate('');
    setInvoiceNumber(null);
    setRows([]);
    setDupWarn(false);
    setBanner('');
    progressRef.current = { createdIds: new Map(), orderedKeys: new Set(), stockedIds: new Set() };
  }, [open]);

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

  const handleFile = async (file: File) => {
    if (!user || !activePropertyId) return;
    setPhase('reading');
    setErrorText('');
    try {
      // Resize before upload — Vision bills per pixel area; 1600px long-edge
      // keeps small receipt text legible at ~1/4 the cost of a raw photo.
      const resized = await resizeImageForVision(file);
      const res = await fetchWithAuth('/api/inventory/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, imageBase64: resized.base64, mediaType: resized.mediaType }),
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
      onClose={onClose}
      eyebrow={ss.scanInvoice}
      italic={reviewing ? ss.reviewSave : phase === 'done' ? ss.saved : ss.dropOneIn}
      suffix={reviewing ? `${matchedCount} ${ss.matched} · ${createCount} ${ss.new} · ${skipCount} ${ss.skipped}` : ss.autoUpdateStock}
      accent={T.sageDeep}
      width={reviewing ? 900 : 640}
      footer={
        reviewing ? (
          <>
            <Btn variant="ghost" size="md" onClick={onClose} disabled={phase === 'committing'}>
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
          <div
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
              <Btn variant="primary" size="md" onClick={handlePick} disabled={phase === 'reading'}>
                {phase === 'reading' ? ss.reading : ss.choosePhoto}
              </Btn>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, marginTop: 12 }}>
              {ss.pdfHint}
            </div>
          </div>
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
            <Btn variant="primary" size="md" onClick={onClose}>
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

/* ──────────────────────────────────────────────────────────────────────
   AI Helper — Overview / Usage rates / Status tabs
   ────────────────────────────────────────────────────────────────────── */
type AIView = 'overview' | 'rates' | 'status';

interface AIStatusShape {
  aiMode: AiMode;
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsExpectedToGraduate: number;
  /**
   * Honesty-audit Phase 4: the field this UI cares about for the "% off"
   * accuracy card. validation_mae / mean_observed_rate — the real
   * activation gate ratio. Returns null for ~7 days post-Phase 2 ship
   * until the trainer populates hyperparameters.mean_observed_rate on
   * next weekly retrain; we render "Populating…" during that window.
   */
  currentMaeRatioVsMean: number | null;
  /** val_mae / train_mae — fit-tightness, NOT the activation gate.
   *  Kept on the type for forward compat but the UI no longer reads it
   *  for the "% off" card. */
  overfitRatio: number | null;
  lastInferenceAt: string | null;
  lastInferenceStale: boolean;
  predictionsLast7Days: number;
}

function AIHelperSheet({
  lang,
  open,
  onClose,
  aiMode,
  onModeChange,
  display,
}: {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  display: DisplayItem[];
}) {
  const { activePropertyId } = useProperty();
  const ss = ssStrings(lang);
  const [view, setView] = useState<AIView>('overview');
  const [stats, setStats] = useState<AIStatusShape | null>(null);
  const [totalCounts, setTotalCounts] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [statusRes, countsRes] = await Promise.all([
          fetchWithAuth(`/api/inventory/ai-status?propertyId=${activePropertyId}`, { cache: 'no-store' }),
          fetchWithAuth(
            `/api/inventory/accounting-summary?propertyId=${activePropertyId}`,
            { cache: 'no-store' },
          ).catch(() => null),
        ]);
        if (!cancelled && statusRes.ok) {
          const json = (await statusRes.json()) as { data?: AIStatusShape };
          if (json.data) setStats(json.data);
        }
        if (!cancelled && countsRes && countsRes.ok) {
          // accounting-summary doesn't include count count; approximate from
          // ai-status' daysSinceFirstCount × itemsTotal — not used.
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  // Lightweight "events logged" approximation. Without a dedicated count
  // anywhere, we use itemsWithModel × consecutivePasses ≈ count rows.
  // A future improvement: surface getInventoryDataFuelStats.totalCounts.
  useEffect(() => {
    setTotalCounts(stats ? stats.itemsWithModel : null);
  }, [stats]);

  // Honesty-audit Phase 4: read `currentMaeRatioVsMean` (the gate ratio) for
  // the "% off" card, not the misnamed-overfit `currentMaeRatio` we used to
  // ship. The "% off" label only makes semantic sense as the gate ratio —
  // before this change, the UI was multiplying an overfit ratio by 100 and
  // calling it "% off", which is the wrong number with a misleading label.
  // Pre-retrain window: stats may have null until next weekly training,
  // in which case maePctOrNull is null and the StatusCard shows "Populating".
  const maePctOrNull =
    stats?.currentMaeRatioVsMean != null ? stats.currentMaeRatioVsMean * 100 : null;
  const ml = {
    eventsLogged: totalCounts ?? 0,
    eventsNeeded: 30,
    maePctOrNull,
    maePct: maePctOrNull ?? 0,
    maeTarget: 10,
    consecutivePasses: Math.min(5, Math.floor((stats?.daysSinceFirstCount ?? 0) / 30)),
    passesNeeded: 5,
    autoFillEligibleItems: stats?.itemsGraduated ?? 0,
    totalItems: stats?.itemsTotal ?? display.length,
    graduated: (stats?.itemsGraduated ?? 0) > 0,
  };

  const views: Array<{ key: AIView; label: string }> = [
    { key: 'overview', label: ss.overview },
    { key: 'rates', label: ss.usageRates },
    { key: 'status', label: ss.status },
  ];

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={ss.aiHelper}
      italic={ss.howItWorks}
      suffix={ss.andWhatItKnows}
      accent={T.purple}
      width={640}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {views.map((v) => {
            const active = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? T.purple : 'transparent',
                  color: active ? '#fff' : T.ink2,
                  border: `1px solid ${active ? T.purple : T.rule}`,
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        {view === 'overview' && (
          <OverviewTab ss={ss} aiMode={aiMode} onModeChange={onModeChange} ml={ml} onSeeStatus={() => setView('status')} />
        )}
        {view === 'rates' && <RatesTab ss={ss} items={display} />}
        {view === 'status' && <StatusTab ss={ss} ml={ml} />}
      </div>
    </Overlay>
  );
}

type SS = ReturnType<typeof ssStrings>;

function OverviewTab({
  ss,
  aiMode,
  onModeChange,
  ml,
  onSeeStatus,
}: {
  ss: SS;
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  ml: { autoFillEligibleItems: number; totalItems: number; graduated: boolean };
  onSeeStatus: () => void;
}) {
  const modes: AiMode[] = ['off', 'auto', 'always-on'];
  const labelFor: Record<AiMode, string> = { off: ss.off, auto: ss.auto, 'always-on': ss.alwaysOn };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        {ss.aiIntro}<b style={{ color: T.ink }}>{ss.fillingInCounts}</b>{ss.youCanOverride}
      </p>
      <div>
        <Caps>{ss.mode}</Caps>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {modes.map((m) => {
            const active = aiMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                style={{
                  flex: 1,
                  padding: '12px 14px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  background: active ? T.ink : 'transparent',
                  color: active ? T.bg : T.ink,
                  border: `1px solid ${active ? T.ink : T.rule}`,
                  fontFamily: fonts.sans,
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: 'center',
                }}
              >
                {labelFor[m]}
              </button>
            );
          })}
        </div>
        <p style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, margin: '8px 0 0', fontStyle: 'italic' }}>
          {aiMode === 'auto' && ss.modeAuto}
          {aiMode === 'always-on' && ss.modeAlwaysOn}
          {aiMode === 'off' && ss.modeOff}
        </p>
      </div>
      <div
        style={{
          background: T.purpleDim,
          border: `1px solid ${T.purple}40`,
          borderRadius: 12,
          padding: '14px 16px',
          display: 'flex',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: T.purple,
            color: '#fff',
            fontFamily: fonts.mono,
            fontSize: 13,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          AI
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: fonts.serif, fontSize: 18, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em' }}>
            {ml.graduated ? ss.graduated : ss.learning}
          </span>
          <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginLeft: 6 }}>
            {ss.autoFilling(ml.autoFillEligibleItems, ml.totalItems)}
          </span>
        </div>
        <button
          type="button"
          onClick={onSeeStatus}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: fonts.mono,
            fontSize: 10,
            fontWeight: 600,
            color: T.purple,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {ss.seeStatus}
        </button>
      </div>
    </div>
  );
}

function RatesTab({ ss, items }: { ss: SS; items: DisplayItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        {ss.ratesIntro}
      </p>
      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px', maxHeight: 360, overflow: 'auto' }}>
        {items.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: fonts.serif, fontSize: 18, color: T.ink3, fontStyle: 'italic' }}>
            {ss.noItemsYet}
          </div>
        ) : (
          items.map((it, i) => (
            <div
              key={it.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr auto auto',
                gap: 12,
                padding: '10px 0',
                alignItems: 'center',
                borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
              }}
            >
              <ItemThumb thumb={it.thumb} cat={it.cat} size={28} />
              <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 500 }}>
                {it.name}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>
                {it.burn.toFixed(2)} {it.unit}
                {it.burnUnit === '/occ-room' ? ss.perRoom : ss.perDay}
              </span>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  color: it.graduated ? T.purple : T.ink3,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  minWidth: 80,
                  textAlign: 'right',
                }}
              >
                {it.graduated ? ss.learned : ss.learningTag}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatusTab({
  ss,
  ml,
}: {
  ss: SS;
  ml: {
    eventsLogged: number;
    eventsNeeded: number;
    /** Null during the post-Phase-2 backfill window (until next weekly
     *  retrain populates hyperparameters.mean_observed_rate). UI renders
     *  "Populating…" in that case instead of the misleading 0.0% off. */
    maePctOrNull: number | null;
    maePct: number;
    maeTarget: number;
    consecutivePasses: number;
    passesNeeded: number;
    autoFillEligibleItems: number;
    totalItems: number;
    graduated: boolean;
  };
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        {ss.statusIntro}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <StatusCard
          ss={ss}
          label={ss.countsLogged}
          big={String(ml.eventsLogged)}
          target={ss.needed(ml.eventsNeeded)}
          passing={ml.eventsLogged >= ml.eventsNeeded}
        />
        <StatusCard
          ss={ss}
          label={ss.accuracy}
          big={ml.maePctOrNull == null ? ss.populating : ss.pctOff(ml.maePctOrNull.toFixed(1))}
          target={
            ml.maePctOrNull == null
              ? ss.firstRetrain
              : ss.underToPass(ml.maeTarget)
          }
          passing={ml.maePctOrNull != null && ml.maePctOrNull > 0 && ml.maePctOrNull <= ml.maeTarget}
        />
        <StatusCard
          ss={ss}
          label={ss.stableMonths}
          big={String(ml.consecutivePasses)}
          target={ss.needed(ml.passesNeeded)}
          passing={ml.consecutivePasses >= ml.passesNeeded}
        />
      </div>
      <div
        style={{
          background: T.sageDim,
          border: `1px solid ${T.sageDeep}40`,
          borderRadius: 12,
          padding: '14px 16px',
          fontFamily: fonts.sans,
          fontSize: 13,
          color: T.forestText,
          lineHeight: 1.5,
        }}
      >
        <b>{ml.graduated ? ss.graduated : ss.stillLearning}</b>{' '}
        {ss.autoFillingCounts(ml.autoFillEligibleItems, ml.totalItems)}{' '}
        {ml.totalItems - ml.autoFillEligibleItems > 0 && (
          <>
            {ss.remainingLearning(ml.totalItems - ml.autoFillEligibleItems)}
          </>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  ss,
  label,
  big,
  target,
  passing,
}: {
  ss: SS;
  label: string;
  big: string;
  target: string;
  passing: boolean;
}) {
  const c = passing ? statusColor.good : statusColor.low;
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: T.ink2,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: 24,
          color: T.ink,
          letterSpacing: '-0.02em',
          fontStyle: 'italic',
          fontWeight: 400,
          lineHeight: 1,
        }}
      >
        {big}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: fonts.sans,
          fontSize: 11,
          color: c,
          fontWeight: 600,
        }}
      >
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: c }} />
        {passing ? ss.passing : target}
      </span>
    </div>
  );
}
