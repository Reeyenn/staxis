// ─── Client-side image resize for Vision uploads ────────────────────────
//
// Anthropic Vision tokenizes images proportionally to their pixel area.
// A 4032×3024 phone JPEG (~12 MP) burns ~1500 image tokens; the same photo
// resized to 1600×1200 (~2 MP) burns ~400. For invoice text that's still
// readable, the smaller version costs ~25% as much.
//
// 1600px on the long edge is the sweet spot: small-font line items remain
// legible (we tested at 1200px and 10pt receipt-paper text degraded), but
// payload drops 80%+ vs. the raw camera roll.
//
// Browser-only: uses <canvas>. Node callers should reject oversized images
// at the byte-cap layer in src/lib/vision-extract.ts.

export interface ResizeOptions {
  /** Max length of the longer edge, in pixels. Default 1600. */
  maxEdge?: number;
  /** JPEG quality 0..1. Default 0.85. */
  quality?: number;
  /** Output mime. Default 'image/jpeg'. PNG defeats compression for photos. */
  mimeType?: 'image/jpeg' | 'image/webp';
}

export interface ResizedImage {
  /** Base64 (no data: prefix) ready for Vision payloads. */
  base64: string;
  mediaType: 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  /** Bytes of the resized blob (not the base64 string). */
  bytes: number;
}

/**
 * Resize an image File to fit within `maxEdge` on the longer side, encode
 * as JPEG, return base64 + dimensions. If the image is already smaller
 * than maxEdge, only the re-encode happens (still useful for stripping
 * EXIF and quality control).
 *
 * Throws on decode failure (corrupt file, HEIC without a decoder, etc.) —
 * caller should surface a "convert to JPEG" message.
 */
export async function resizeImageForVision(
  file: File,
  opts: ResizeOptions = {},
): Promise<ResizedImage> {
  const maxEdge = opts.maxEdge ?? 1600;
  const quality = opts.quality ?? 0.85;
  const mimeType = opts.mimeType ?? 'image/jpeg';

  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = scaleToFit(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, mimeType, quality);
    const base64 = await blobToBase64(blob);
    return { base64, mediaType: mimeType, width, height, bytes: blob.size };
  } finally {
    bitmap.close?.();
  }
}

function scaleToFit(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const longer = Math.max(w, h);
  if (longer <= maxEdge) return { width: w, height: h };
  const ratio = maxEdge / longer;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap is widely supported in modern browsers and respects
  // EXIF orientation when imageOrientation: 'from-image' is set. iPhone
  // photos arrive rotated unless we honor EXIF.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      type,
      quality,
    );
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked to avoid call-stack overflow on large arrays. 8KB chunks are
  // safe across all browsers.
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
