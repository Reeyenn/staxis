// ─── DOM snapshot utility ────────────────────────────────────────────────
// Walks the current page and produces a list of interactive elements with
// stable synthetic IDs, accessible names, ARIA roles, and bounding rects.
// The list goes to Claude so it can pick the next target by ID. A
// separate Map keeps the live DOM node refs for the animator — those
// don't get serialized.
//
// RC4 root-cause hardening (2026-05-14):
//   - Widened the selector: now catches <summary> disclosure widgets
//     and `[tabindex]` keyboard-focusables (was missing).
//   - Filters out elements with `pointer-events: none` (or any ancestor
//     with the same) — they look interactive but the user can't click.
//   - Sorts by in-viewport first so the cap doesn't truncate the
//     buttons currently on screen in favor of off-screen ones.
//   - Computes a `parentSection` qualifier for every element (the
//     closest semantic ancestor's label/heading). Used for (a) Claude
//     disambiguation of duplicate names like two "Save" buttons in
//     different modals, (b) Phase D's cross-snapshot repetition
//     fingerprint.
//
// Selector strategy (per the plan):
//   Primary  — visible text + role + bounding rect (no codebase changes).
//   Fallback — `data-staxis-id="..."` attribute on specific buttons we
//              had to tag because their accessible name was empty.
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
  /** Accessible name: aria-label, visible text, placeholder, etc.
   *  When two elements in the same snapshot share a name, the qualifier
   *  is appended here as "(inside <parentSection>)" so Claude can pick
   *  the right one. The unqualified raw name lives in `rawName` for
   *  the cross-snapshot fingerprint (Phase D). */
  name: string;
  /** Raw accessible name without any duplicate-disambiguation qualifier. */
  rawName: string;
  /** Closest semantic-ancestor label/heading text. Used for fingerprinting
   *  and for the disambiguation qualifier when names collide. */
  parentSection?: string;
  /** data-staxis-id value if the element opted in to ID-based targeting. */
  staxisId?: string;
  /** Bounding rect in viewport coordinates (CSS pixels). */
  rect: { x: number; y: number; width: number; height: number };
  /** True if the element is currently inside the viewport. */
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
  // <summary> drives <details> disclosure — clickable but invisible to the
  // old selector. Added 2026-05-14.
  'summary',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="link"]',
  '[role="tab"]:not([aria-disabled="true"])',
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="checkbox"]:not([aria-disabled="true"])',
  '[role="switch"]:not([aria-disabled="true"])',
  '[onclick]',
  // Keyboard-focusables. Filter out tabindex="-1" (programmatic focus only,
  // usually not a user target).
  '[tabindex]:not([tabindex="-1"])',
  '[data-staxis-id]',
].join(',');

const MIN_AREA_PX = 12;
const MAX_ELEMENTS = 100; // hard cap so giant lists don't bloat the prompt
const QUALIFIER_MAX_CHARS = 40;

export function snapshotInteractiveElements(doc: Document = document): DomSnapshot {
  const seen = new WeakSet<Element>();
  type Candidate = Omit<SnapshotElement, 'id'> & { node: HTMLElement; domOrder: number };
  const candidates: Candidate[] = [];

  const nodes = Array.from(doc.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  let domOrder = 0;

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

    const rawName = accessibleName(node);
    const staxisId = node.getAttribute('data-staxis-id') ?? undefined;

    if (!rawName && !staxisId) continue;

    const parentSection = findParentSection(node);
    candidates.push({
      node,
      domOrder: domOrder++,
      tag: node.tagName.toLowerCase(),
      role: computedRole(node),
      name: rawName.slice(0, 160),
      rawName: rawName.slice(0, 160),
      ...(parentSection ? { parentSection: parentSection.slice(0, QUALIFIER_MAX_CHARS) } : {}),
      ...(staxisId ? { staxisId: staxisId.slice(0, 80) } : {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      inViewport: rect.top < doc.documentElement.clientHeight && rect.bottom > 0,
    });
  }

  // Sort by in-viewport first (so the cap doesn't truncate visible buttons
  // in favor of off-screen ones), then by DOM order to keep navigation /
  // header up top.
  candidates.sort((a, b) => {
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    return a.domOrder - b.domOrder;
  });

  // Cap.
  const capped = candidates.slice(0, MAX_ELEMENTS);

  // Disambiguate duplicate names: for any (rawName) group of size >= 2,
  // append "(inside <parentSection>)" to each element's `name`. If a
  // collision still exists after the parent qualifier (two same-name
  // buttons in the same dialog), fall back to a position-based suffix.
  const nameGroups = new Map<string, Candidate[]>();
  for (const c of capped) {
    const key = c.rawName || `__staxis_${c.staxisId ?? ''}`;
    const arr = nameGroups.get(key);
    if (arr) arr.push(c); else nameGroups.set(key, [c]);
  }
  for (const [, group] of nameGroups) {
    if (group.length <= 1) continue;
    for (const c of group) {
      const qualifier = c.parentSection;
      if (qualifier) {
        c.name = `${c.rawName} (inside ${qualifier})`;
      }
    }
    // Detect remaining collisions after qualifier — append position suffix.
    const stillCollide = new Map<string, Candidate[]>();
    for (const c of group) {
      const arr = stillCollide.get(c.name);
      if (arr) arr.push(c); else stillCollide.set(c.name, [c]);
    }
    for (const [, sub] of stillCollide) {
      if (sub.length <= 1) continue;
      sub.forEach((c, i) => {
        c.name = `${c.name} (#${i + 1})`;
      });
    }
  }

  // Assign synthetic IDs in the final (sorted, capped, disambiguated) order
  // and build the byId map.
  const byId = new Map<string, HTMLElement>();
  const elements: SnapshotElement[] = capped.map((c, i) => {
    const id = `el_${i}`;
    byId.set(id, c.node);
    const { node: _node, domOrder: _o, ...rest } = c;
    void _node; void _o;
    return { id, ...rest };
  });

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

/**
 * `pointer-events: none` makes an element unclickable even though it's
 * visible. Walk the ancestor chain — a parent's pointer-events: none
 * disables clicks on every descendant too.
 */
function hasPointerEventsNone(el: HTMLElement): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  let cursor: HTMLElement | null = el;
  while (cursor) {
    const style = win.getComputedStyle(cursor);
    if (style.pointerEvents === 'none') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hidden) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (parseFloat(style.opacity) === 0) return false;
  if (hasPointerEventsNone(el)) return false;
  return true;
}

/**
 * The closest semantic ancestor label/heading for `el`. Used for both
 * dup-name disambiguation and Phase D's fingerprint. Returns a string
 * <= QUALIFIER_MAX_CHARS, or undefined if no useful ancestor exists.
 *
 * Priority:
 *   1. [role="dialog"] / aside / section / nav with aria-label
 *   2. The same containers with an aria-labelledby pointing at a real id
 *   3. The same containers with a heading (h1-h6) descendant — use the heading text
 *   4. The closest <fieldset> with a <legend>
 *   5. nothing
 */
function findParentSection(el: HTMLElement): string | undefined {
  const containerSelector = '[role="dialog"], aside, section, nav, fieldset, [role="region"], [role="tabpanel"]';
  let cursor: HTMLElement | null = el.parentElement;
  while (cursor) {
    if (cursor.matches(containerSelector)) {
      // aria-label first
      const ariaLabel = cursor.getAttribute('aria-label');
      if (ariaLabel?.trim()) return ariaLabel.trim();
      // aria-labelledby
      const labelledBy = cursor.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = cursor.ownerDocument.getElementById(labelledBy.split(/\s+/)[0]);
        if (ref?.textContent?.trim()) return ref.textContent.trim().replace(/\s+/g, ' ');
      }
      // Heading inside the container (h1-h6)
      const heading = cursor.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading?.textContent?.trim()) return heading.textContent.trim().replace(/\s+/g, ' ');
      // fieldset → legend
      if (cursor.tagName === 'FIELDSET') {
        const legend = cursor.querySelector(':scope > legend');
        if (legend?.textContent?.trim()) return legend.textContent.trim().replace(/\s+/g, ' ');
      }
    }
    cursor = cursor.parentElement;
  }
  return undefined;
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
    case 'summary':  return 'button';
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
