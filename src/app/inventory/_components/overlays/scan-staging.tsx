'use client';

// Staging half of the scan-invoice flow: the model for what's waiting to be
// scanned (photo pages OR a single PDF), the file-folding rules, and the
// upload-step UI. Extracted verbatim from ScanInvoiceSheet — the sheet keeps
// the state; this module owns the rules and the rendering.

import React, { useRef } from 'react';
import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import type { SsStrings } from './scan-i18n';

// Staging model for the upload step. The scan can carry EITHER a set of image
// pages (1..5) OR a single PDF — never both (the backend contract is one shape
// per request, and mixing a PDF with photos has no meaning). We keep the two
// in one discriminated union so the "no mixing" rule is impossible to violate.
export const MAX_PAGES = 5;
export const PDF_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — mirrors the route's file cap.
// One staged image page: the File plus an object-URL for its thumbnail. The URL
// is revoked when the page is removed or the sheet resets, so we don't leak.
export interface StagedPage { file: File; url: string; }
export type Staged =
  | { kind: 'none' }
  | { kind: 'images'; pages: StagedPage[] }
  | { kind: 'pdf'; file: File };

// A File is HEIC/HEIF if the browser reports the type or the name ends in the
// extension (Safari sometimes hands us an empty type). Anthropic Vision can't
// read these, and canvas decode fails silently on some devices — reject at pick
// time with a clear message rather than a generic "upload failed" later.
export function isHeic(file: File): boolean {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/heic' || t === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
}
export function isPdf(file: File): boolean {
  return (file.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name);
}
export function isImage(file: File): boolean {
  return (file.type || '').toLowerCase().startsWith('image/');
}

// Read a File as base64 with no data: prefix (the route wants the raw payload).
export function fileToBase64(file: File): Promise<string> {
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

// Fold newly-picked files into the staged set, enforcing the four rules:
//   1. PDF staged → picking anything more just shows the "PDF scans alone" note.
//   2. images staged + a PDF picked → same note (no mixing).
//   3. a single fresh PDF (nothing staged) → stage it, drop any pages.
//   4. images → append up to MAX_PAGES; extras beyond the cap are ignored w/ a note.
// HEIC and non-image/non-PDF files are rejected here with their own message.
// Pure w.r.t. the current staging (returns next=null for "unchanged"); the
// only side effect is minting object-URLs for accepted image pages.
export function foldFiles(
  cur: Staged,
  files: File[],
  ss: SsStrings,
): { next: Staged | null; note: string } {
  // A PDF is already staged — one PDF per scan, no appending.
  if (cur.kind === 'pdf') {
    return { next: null, note: ss.onePdfPerScan };
  }

  const pdf = files.find(isPdf);
  if (pdf) {
    // Mixing rule: a PDF can only be staged on its own. If images are already
    // staged (or the manager picked images + a PDF together), refuse the PDF.
    if (cur.kind === 'images' || files.some((f) => isImage(f) && !isPdf(f))) {
      return { next: null, note: ss.onePdfPerScan };
    }
    if (pdf.size > PDF_MAX_BYTES) {
      return { next: null, note: ss.pdfTooBig };
    }
    return { next: { kind: 'pdf', file: pdf }, note: '' };
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

  const next: Staged | null =
    additions.length > 0 ? { kind: 'images', pages: [...existing, ...additions] } : null;
  // Surface the most actionable message (order: bad type → HEIC → cap hit).
  const note = rejectedType
    ? ss.notAnImage
    : rejectedHeic
      ? ss.heicUnsupported
      : overflowed
        ? ss.maxPagesReached
        : '';
  return { next, note };
}

// ── Upload-step UI: empty dropzone → staging thumbnails / PDF card + scan ──
export function StagingStep({
  ss,
  phase,
  staged,
  stageNote,
  onFiles,
  onRemovePage,
  onClearStaged,
  onScan,
}: {
  ss: SsStrings;
  phase: 'upload' | 'reading';
  staged: Staged;
  stageNote: string;
  onFiles: (files: File[]) => void;
  onRemovePage: (idx: number) => void;
  onClearStaged: () => void;
  onScan: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const handlePick = () => fileRef.current?.click();

  // Drag-drop onto the dropzone / staging area — same append rules as picking.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (phase !== 'upload') return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Hidden picker — images (multi) AND PDFs. foldFiles enforces the
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
          if (files.length > 0) onFiles(files);
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
                    onClick={() => onRemovePage(i)}
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
                onClick={onClearStaged}
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
            <Btn variant="primary" size="md" onClick={onScan} disabled={phase === 'reading'}>
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
  );
}
