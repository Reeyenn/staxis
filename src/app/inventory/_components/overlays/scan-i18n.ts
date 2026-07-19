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
      whatArrived: 'Here’s what arrived',
      saved: 'Saved',
      dropOneIn: 'Drop one in',
      autoUpdateStock: 'auto-update stock',
      cancel: 'Cancel',
      adding: 'Adding…',
      addItems: (n: number) => `Add ${n} item${n === 1 ? '' : 's'}`,
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
      newItemOpt: (name: string) => `＋ New item: ${name}`,
      pickDifferent: 'Match to a different item',
      skipLine: 'Remove this line',
      putBack: 'Put back',
      goesIn: 'Goes in',
      twoCloseMatches: 'Two close matches — tap the name to confirm which.',
      qty: 'Qty',
      qtyReceived: 'How many arrived',
      unitCost: 'Unit $',
      costsRequired: 'Enter a unit cost for every received line before saving. This amount becomes the purchase ledger.',
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
      whatArrived: 'Esto es lo que llegó',
      saved: 'Guardado',
      dropOneIn: 'Suelta una aquí',
      autoUpdateStock: 'actualiza el stock',
      cancel: 'Cancelar',
      adding: 'Agregando…',
      addItems: (n: number) => `Agregar ${n} artículo${n === 1 ? '' : 's'}`,
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
      newItemOpt: (name: string) => `＋ Artículo nuevo: ${name}`,
      pickDifferent: 'Emparejar con otro artículo',
      skipLine: 'Quitar esta línea',
      putBack: 'Restaurar',
      goesIn: 'Va en',
      twoCloseMatches: 'Dos coincidencias cercanas — toca el nombre para confirmar cuál.',
      qty: 'Cant.',
      qtyReceived: 'Cuántos llegaron',
      unitCost: 'Costo $',
      costsRequired: 'Ingresa el costo unitario de cada línea recibida antes de guardar. Este monto entra al registro de compras.',
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
