/**
 * Magic-byte sniffing for uploaded inspection photos.
 *
 * The upload routes previously trusted `file.type` (the multipart
 * Content-Type header), which the client controls and can spoof
 * trivially:
 *
 *   fd.set('file', new File([evilBlob], 'x.jpg', { type: 'image/jpeg' }));
 *
 * Server then stores the bytes under that Content-Type, the signed URL
 * serves them as image/jpeg, and the browser may interpret them as
 * something else (HTML, SVG with JS, …) depending on the bytes inside.
 *
 * This module looks at the first ~32 bytes and confirms the file is
 * one of the three formats we accept. The check is conservative —
 * we'd rather reject a valid edge case (truncated jpg with weird
 * markers) than accept a polyglot.
 *
 * Codex M4 — defense-in-depth on the private inspection-photos bucket.
 * Even though it's private + signed-URL only, an attacker with photo
 * upload access who then steals a manager session could exploit a
 * mis-typed content-type for XSS via the storage CDN.
 */

export type DetectedMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | null;

/**
 * Inspect the leading bytes and return the detected MIME, or null if
 * the bytes don't match any of our allowed formats. Pure function.
 *
 *  JPEG:  FF D8 FF
 *  PNG:   89 50 4E 47 0D 0A 1A 0A
 *  WebP:  "RIFF" .... "WEBP"  (52 49 46 46 _ _ _ _ 57 45 42 50)
 */
export function detectImageMime(bytes: Uint8Array): DetectedMimeType {
  if (!bytes || bytes.length < 12) return null;

  // JPEG — SOI marker. Spec allows the third byte to be any FF-followed
  // marker, but in practice it's always FF for SOF/APPn. Keep this loose
  // to match what cameras and browsers actually emit.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG — fixed 8-byte signature.
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP — "RIFF" then 4 bytes file size then "WEBP".
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * True if the declared Content-Type (from multipart) matches the
 * actual bytes. Used by the upload routes to reject mismatch.
 *
 * Treats `image/jpg` (technically invalid but commonly used by some
 * clients) as equivalent to `image/jpeg`.
 */
export function declaredMimeMatchesBytes(declared: string, bytes: Uint8Array): boolean {
  const detected = detectImageMime(bytes);
  if (!detected) return false;
  const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared;
  return detected === normalizedDeclared;
}

/**
 * Lightweight structural validation that the bytes look like a real
 * image and not a polyglot (e.g. `FF D8 FF` followed by HTML/JS).
 *
 * Without pulling in a full image decoder we can still rule out the
 * common polyglot patterns by checking:
 *   - Minimum file size for a plausibly-real image (1 KB).
 *   - JPEG ends with EOI marker (FF D9). Real cameras always emit it
 *     and the EOI cannot appear mid-stream in valid JPEG data.
 *   - PNG ends with IEND chunk + CRC (00 00 00 00 49 45 4E 44 AE 42 60 82).
 *     Last 8 bytes of any valid PNG are exactly that signature.
 *   - WebP has its size field at bytes 4..7 in little-endian; that
 *     value must match the actual byte length minus 8.
 *
 * Returns true if the file passes the structural check for its
 * detected MIME, false otherwise. Pure function.
 *
 * Codex M2 follow-up — defense-in-depth on top of magic-byte detection.
 * The content-type override on storage still does most of the work
 * (browsers won't execute `<script>` in an image/jpeg response), but
 * this closes the polyglot vector and ensures any downstream consumer
 * (proxy, exporter, manual download) sees a real image.
 */
export function looksStructurallyValid(detected: DetectedMimeType, bytes: Uint8Array): boolean {
  if (!detected) return false;
  if (bytes.length < 1024) return false;

  if (detected === 'image/jpeg') {
    // EOI marker. Must be the last two bytes.
    const n = bytes.length;
    if (n < 4) return false;
    return bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
  }

  if (detected === 'image/png') {
    // IEND + CRC: 00 00 00 00 49 45 4E 44 AE 42 60 82
    const n = bytes.length;
    if (n < 12) return false;
    return (
      bytes[n - 12] === 0x00 &&
      bytes[n - 11] === 0x00 &&
      bytes[n - 10] === 0x00 &&
      bytes[n - 9] === 0x00 &&
      bytes[n - 8] === 0x49 &&
      bytes[n - 7] === 0x45 &&
      bytes[n - 6] === 0x4e &&
      bytes[n - 5] === 0x44 &&
      bytes[n - 4] === 0xae &&
      bytes[n - 3] === 0x42 &&
      bytes[n - 2] === 0x60 &&
      bytes[n - 1] === 0x82
    );
  }

  if (detected === 'image/webp') {
    // RIFF chunk size field at bytes 4..7 (little-endian) must match
    // file length minus 8.
    if (bytes.length < 12) return false;
    const declared =
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    return declared === bytes.length - 8;
  }

  return false;
}
