// ─── DOM snapshot utility ────────────────────────────────────────────────
// Walks the current page and produces a list of interactive elements with
// stable synthetic IDs, accessible names, ARIA roles, and bounding rects.
// The list goes to Claude so it can pick the next target by ID. A
// separate Map keeps the live DOM node refs for the animator — those
// don't get serialized.
//
// Selector strategy (per the plan):
//   Primary  — visible text + role + bounding rect (no codebase changes).
//   Fallback — `data-staxis-id="..."` attribute on specific buttons we
//              had to tag because their accessible name was empty.
//
// Both surfaces flow through `accessibleName()` and `byId` so Claude
// can pick by either.
//
// Filters:
//   - element must be visible (display, visibility, opacity)
//   - bounding rect must have non-trivial area (>= 12x12)
//   - skip disabled
//   - skip empty accessible name AND empty data-staxis-id (Claude can't
//     reliably refer to it)
//   - skip elements outside the viewport with no `offsetParent`
//
// The function returns a snapshot at a point in time — re-call after the
// page navigates or rerenders.

export interface SnapshotElement {
  /** Stable within a single snapshot. NOT stable across snapshots. */
  id: string;
  /** Lowercase tag name: 'button', 'a', 'input', etc. */
  tag: string;
  /** ARIA role, computed (button, link, textbox, checkbox, …). */
  role: string;
  /** Accessible name: aria-label, visible text, placeholder, etc. */
  name: string;
  /** data-staxis-id value if the element opted in to ID-based targeting. */
  staxisId?: string;
  /** Bounding rect in viewport coordinates (CSS pixels). */
  rect: { x: number; y: number; width: number; height: number };
  /** Truthy if the element is currently inside the viewport. */
  inViewport: boolean;
}

export interface DomSnapshot {
  url: string;
  pageTitle: string;
  viewport: { width: number; height: number };
  elements: SnapshotElement[];
  /** id → live DOM node. NOT serialized; used by the animator. */
  byId: Map<string, HTMLElement>;
}

const INTERACTIVE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="link"]',
  '[role="tab"]:not([aria-disabled="true"])',
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="checkbox"]:not([aria-disabled="true"])',
  '[role="switch"]:not([aria-disabled="true"])',
  '[onclick]',
  '[data-staxis-id]',
].join(',');

const MIN_AREA_PX = 12;
const MAX_ELEMENTS = 80; // hard cap so giant lists don't bloat the prompt

export function snapshotInteractiveElements(doc: Document = document): DomSnapshot {
  const byId = new Map<string, HTMLElement>();
  const elements: SnapshotElement[] = [];
  const seen = new WeakSet<Element>();

  const nodes = Array.from(doc.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  let idCounter = 0;

  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);

    if (!isVisible(node)) continue;

    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_AREA_PX || rect.height < MIN_AREA_PX) continue;

    // Skip if element is laid out off-screen (negative or far-positive
    // coords) — these are typically hidden via off-canvas positioning.
    if (rect.bottom < -100 || rect.right < -100) continue;
    if (rect.top > doc.documentElement.clientHeight + 2000) continue;

    const name = accessibleName(node);
    const staxisId = node.getAttribute('data-staxis-id') ?? undefined;

    if (!name && !staxisId) continue;

    const id = `el_${idCounter++}`;
    byId.set(id, node);
    elements.push({
      id,
      tag: node.tagName.toLowerCase(),
      role: computedRole(node),
      name: name.slice(0, 160),
      ...(staxisId ? { staxisId: staxisId.slice(0, 80) } : {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      inViewport: rect.top < doc.documentElement.clientHeight && rect.bottom > 0,
    });

    if (elements.length >= MAX_ELEMENTS) break;
  }

  return {
    url: typeof window !== 'undefined' ? window.location.pathname + window.location.search : '',
    pageTitle: doc.title,
    viewport: {
      width: doc.documentElement.clientWidth,
      height: doc.documentElement.clientHeight,
    },
    elements,
    byId,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hidden) return false;
  // offsetParent === null means display:none somewhere in the ancestor chain
  // (with some exceptions for position:fixed elements; getBoundingClientRect
  // catches those).
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (parseFloat(style.opacity) === 0) return false;
  return true;
}

function accessibleName(el: HTMLElement): string {
  // aria-label has highest priority
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // aria-labelledby — look up referenced elements
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      if (ref?.textContent?.trim()) parts.push(ref.textContent.trim());
    }
    if (parts.length) return parts.join(' ');
  }

  // For form inputs, look up the <label for> association
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.id) {
      const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim();
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent?.trim()) {
      // Strip the input's own text contribution from the label
      const clone = wrappingLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
      if (clone.textContent?.trim()) return clone.textContent.trim();
    }
    if (el instanceof HTMLInputElement && el.placeholder?.trim()) return el.placeholder.trim();
    if (el instanceof HTMLTextAreaElement && el.placeholder?.trim()) return el.placeholder.trim();
  }

  // alt for images
  if (el instanceof HTMLImageElement && el.alt?.trim()) return el.alt.trim();

  // title attribute
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  // Visible text content — collapse whitespace, strip non-printable.
  const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;

  return '';
}

function computedRole(el: HTMLElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':   return 'button';
    case 'a':        return el.hasAttribute('href') ? 'link' : 'generic';
    case 'select':   return 'combobox';
    case 'textarea': return 'textbox';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'range')    return 'slider';
      return 'textbox';
    }
    default: return tag;
  }
}

function cssEscape(s: string): string {
  // Per CSS.escape spec; small inline version for environments where it's missing.
  if (typeof window !== 'undefined' && typeof window.CSS?.escape === 'function') {
    return window.CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
}

/**
 * Strip the byId map and return only the JSON-serializable parts of a
 * snapshot. Used when posting to /api/walkthrough/step.
 */
export function serializeSnapshot(snap: DomSnapshot): Omit<DomSnapshot, 'byId'> {
  return {
    url: snap.url,
    pageTitle: snap.pageTitle,
    viewport: snap.viewport,
    elements: snap.elements,
  };
}
