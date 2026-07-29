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
      dropHint: "A photo or screenshot. We'll read the lines and match them to your inventory. You confirm before anything saves.",
      reading: 'Reading…',
      choosePhoto: 'Choose file…',
      pdfHint: 'PDF invoices work too. Pick the file and we’ll read every page.',
      tryAnotherPhoto: 'Try another photo',
      // Staging step — one or more pages / a single PDF before scanning.
      pageN: (n: number) => `Page ${n}`,
      addAnotherPage: '＋ Add another page',
      removePage: (n: number) => `Remove page ${n}`,
      removePdf: 'Remove PDF',
      scanInvoiceAction: 'Scan invoice',
      maxPagesReached: 'That’s the limit. 5 pages per scan.',
      onePdfPerScan: 'A PDF scans on its own. Remove it to add photo pages instead.',
      pdfTooBig: 'That PDF is too large (over 4 MB). Photograph the pages and add them instead.',
      heicUnsupported: 'That photo format (HEIC) can’t be read here. Use a JPG or PNG, or take a fresh photo.',
      notAnImage: 'That file isn’t a photo or PDF. Pick an image or a PDF.',
      savedMsg: (n: number) => `Saved. Stock updated and the delivery logged for ${n} item${n === 1 ? '' : 's'}.`,
      done: 'Done',
      dupWarn: 'This invoice or reference number is already recorded for this vendor.',
      vendor: 'Vendor',
      invoiceNumber: 'Invoice or reference number',
      invoiceReferenceHint: 'Required to prevent the same scanned invoice from being received twice.',
      invoiceReferenceRequired: 'Enter the invoice number or another unique reference shown on this invoice before saving.',
      invoiceReferenceInvalid: 'Use 80 characters or fewer. “@”, “·”, hidden formatting, and punctuation-only references are not allowed.',
      newItemOpt: (name: string) => `＋ New item: ${name}`,
      pickDifferent: 'Match to a different item',
      skipLine: 'Remove this line',
      putBack: 'Put back',
      goesIn: 'Goes in',
      twoCloseMatches: 'Two close matches. Tap the name to confirm which.',
      reviewSuggestedMatch: 'This suggested match is not reliable enough to save automatically.',
      confirmMatch: 'Confirm this match',
      qty: 'Qty',
      qtyReceived: 'How many arrived',
      unitCost: 'Unit $',
      invoiceDate: 'Invoice date',
      invoiceDateRequired: 'Confirm a valid invoice date before saving. It decides which hotel accounting month receives this delivery.',
      costsRequired: 'Enter a unit cost for every received line before saving. This amount becomes the purchase ledger.',
      matchesRequired: (n: number) => `Confirm or rematch ${n} suggested invoice line${n === 1 ? '' : 's'} before saving.`,
      newItemsRequired: 'Complete the name, category, unit, par level, and set-aside amount for every new inventory item.',
      newItemName: 'New item name',
      category: 'Category',
      unit: 'Unit',
      parLevel: 'Par level',
      setAside: 'Set aside',
      completeNewItem: 'Complete every new item field. Set aside must be a whole number from zero up to the received quantity.',
      discardConfirm: 'Discard this scanned invoice and all reviewed line changes?',
      propertySwitchConfirm: 'Switch hotels and discard the invoice work currently on this screen?',
      propertySwitchBlocked: 'Hotel switching is paused while this delivery is saving or awaiting a safe retry.',
      errTooMany: 'Too many line items to scan at once. Split the invoice into pages and rescan.',
      errBadImage: 'Couldn’t read that image. Try a clearer, well-lit photo.',
      errRateLimit: 'Too many scans this hour. Please try again shortly.',
      errUnavailable: 'Scanning is temporarily unavailable. Try again in a moment.',
      errReadInvoice: (e: string) => `Couldn’t read that invoice (${e}).`,
      errReadInvoiceGeneric: 'Couldn’t read that invoice. Please try a clearer photo.',
      noLineItems: 'No line items detected. Try a clearer photo.',
      uploadFailed: 'Upload failed. Please try again.',
      savingFailed: (e: string) => `Saving failed: ${e}`,
      nameExists: 'That name already exists. Match it to the existing item instead.',
      needAttention: (saved: number, n: number) => `${saved} saved, ${n} need attention. Fix and Save again.`,
      cases: (n: number, pack: number) => `${n} case${n === 1 ? '' : 's'} × ${pack}`,
    },

  }['en'];
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
