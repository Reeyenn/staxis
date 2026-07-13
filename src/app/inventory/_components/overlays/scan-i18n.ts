// Co-located strings for the scan-invoice sheet. (Split out of the retired
// SimpleSheet when the AI-helper overlay became the /inventory/ai screen —
// the scan-invoice feature is NOT an AI-cockpit surface, it's plain invoice
// OCR, so it keeps living as an overlay on the manual inventory page.)
// One dictionary, shared by the sheet + its staging/review/commit modules.

import type { Lang } from '../inv-i18n';

export function ssStrings(lang: Lang) {
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

export type SsStrings = ReturnType<typeof ssStrings>;

export function scanErrorFor(lang: Lang, status: number, err?: string): string {
  const ss = ssStrings(lang);
  if (status === 422) return ss.errTooMany;
  if (status === 400) return ss.errBadImage;
  if (status === 429) return ss.errRateLimit;
  if (status === 503) return ss.errUnavailable;
  return err ? ss.errReadInvoice(err) : ss.errReadInvoiceGeneric;
}
