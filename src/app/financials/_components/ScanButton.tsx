'use client';

// Reusable "snap a document → Claude Vision extracts it" button. Used by the
// Checkbook (mode="invoice" → expense draft) and CapEx (mode="quote" → project
// draft). Resizes client-side before upload (cheaper Vision call) and posts to
// the property-scoped, rate-limited /api/financials/scan-* endpoints.

import React, { useRef, useState } from 'react';
import { resizeImageForVision } from '@/lib/image-resize';
import { finSend, Btn, T, FONT_SANS } from './fin-ui';
import { ft, scanErrorLabel } from './fin-i18n';

type Lang = 'en' | 'es';

export interface InvoiceDraft {
  vendor: string | null;
  invoiceDate: string | null;
  invoiceNumber: string | null;
  amountCents: number | null;
  department: string;
  summary: string | null;
}
export interface QuoteDraft {
  name: string | null;
  vendor: string | null;
  quoteCents: number | null;
  quoteDate: string | null;
  summary: string | null;
  lineItems: Array<{ label: string; amountCents: number | null }>;
}

export function ScanButton({
  mode,
  pid,
  lang,
  label,
  scanningLabel,
  failLabel,
  onInvoice,
  onQuote,
}: {
  mode: 'invoice' | 'quote';
  pid: string;
  lang: Lang;
  label: string;
  scanningLabel: string;
  failLabel: string;
  onInvoice?: (draft: InvoiceDraft, anomalyWarning: string | null) => void;
  onQuote?: (draft: QuoteDraft) => void;
}) {
  const S = ft(lang);
  const inputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setScanning(true);
    try {
      const resized = await resizeImageForVision(file);
      const endpoint = mode === 'invoice' ? '/api/financials/scan-invoice' : '/api/financials/scan-quote';
      const res = await finSend<{ draft: unknown; anomalyWarning?: string | null }>(endpoint, 'POST', {
        pid,
        imageBase64: resized.base64,
        mediaType: resized.mediaType,
      });
      if (res.error !== undefined) {
        setError(scanErrorLabel(S, failLabel, res.code, res.status, res.error));
        return;
      }
      if (!res.data) {
        setError(failLabel);
        return;
      }
      if (mode === 'invoice' && onInvoice) {
        onInvoice(res.data.draft as InvoiceDraft, res.data.anomalyWarning ?? null);
      } else if (mode === 'quote' && onQuote) {
        onQuote(res.data.draft as QuoteDraft);
      }
    } catch {
      setError(failLabel);
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      <Btn variant="ghost" disabled={scanning} onClick={() => inputRef.current?.click()}>
        <span aria-hidden style={{ fontSize: 15 }}>📷</span>
        {scanning ? scanningLabel : label}
      </Btn>
      {error && (
        <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm, marginLeft: 8 }}>{error}</span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          if (e.target) e.target.value = '';
        }}
      />
    </>
  );
}
