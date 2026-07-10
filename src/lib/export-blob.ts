// Shared browser file-download helpers (staff-pages overhaul).
//
// Faithful extraction of the duplicated Content-Disposition download logic in
//   - settings/reports/page.tsx       handleExport()
//   - settings/activity-log/page.tsx  handleExport()
// (other areas adopt these later). Dependency-free — no React, no Next.

/**
 * Read the `filename="…"` parameter out of a Content-Disposition header.
 * Returns null when the header is missing or has no quoted filename — the
 * caller picks its own fallback (each call site keeps its exact current one).
 */
export function filenameFromDisposition(disposition: string | null | undefined): string | null {
  const m = /filename="([^"]+)"/.exec(disposition ?? '');
  return m?.[1] ?? null;
}

/**
 * Trigger a browser download of `blob` as `filename` — object URL + hidden
 * anchor click, with the URL revoked 250ms later (same delay the originals
 * shipped with, long enough for the click to start the download).
 */
export function exportBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 250);
}
