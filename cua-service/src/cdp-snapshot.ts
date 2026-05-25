/**
 * Direct CDP-based page-state capture.
 *
 * Replaces the per-element page.evaluate() round-trips in browser-tool.ts with
 * four parallel CDP calls:
 *   - DOMSnapshot.captureSnapshot — entire DOM + layout + computed styles in
 *     a single message
 *   - DOM.getDocument(depth: -1, pierce: true) — backendNodeIds + node tree
 *     (we already get most of this from DOMSnapshot; kept as the fallback
 *     identity source for OOPIF / cross-origin iframe enumeration)
 *   - Accessibility.getFullAXTree — role + accessible name per backendNodeId
 *   - Page.getLayoutMetrics — viewport bounds (CSS pixels)
 *
 * On heavy pages (canvas apps, frame-laden dashboards) this is 40-50% faster
 * than the Playwright accessibility-snapshot path because we send the page
 * one big request instead of N small ones. Browser Use's published numbers
 * on Online-Mind2Web confirm the ratio.
 *
 * On any CDP failure or 10s timeout we report `{ error }` and the caller
 * falls back to the legacy DOM_SCRIPT path. NEVER let CDP errors kill the
 * agent loop.
 *
 * Refs:
 *   - The YAML emitted to the agent uses `ref_<backendNodeId>` instead of
 *     `ref_<counter>`. backendNodeId is stable across re-snapshots of the
 *     same DOM, which lets the agent reuse a ref between read_page calls
 *     when the page hasn't navigated. It is NOT stable across navigations —
 *     callers must re-snapshot after every navigation.
 *   - Downstream consumers (mapper, recipe-runner) treat refs as opaque
 *     strings; recipe-runner only ever sees CSS selectors.
 *   - `resolveRefViaCDP` re-uses CDP's DOM.resolveNode to translate the
 *     backendNodeId in the ref back to a JS object handle without going
 *     through window.__claudeElementMap.
 */

import type { CDPSession, Page } from 'playwright';
import { log } from './log.js';

// Minimal CDP type definitions — we don't pull Protocol from playwright-core
// because it's not in the package's exports map. These mirror the shape of
// the responses we actually read; anything we don't touch is intentionally
// elided. If you find yourself reading a new field, add it here so we keep
// type checks honest.

namespace CDPTypes {
  export interface RareStringData { index: number[]; value: number[]; }
  export interface RareBooleanData { index: number[]; }
  export interface RareIntegerData { index: number[]; value: number[]; }
  export type Rectangle = number[];

  export interface NodeTreeSnapshot {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    nodeValue?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    textValue?: RareStringData;
    inputValue?: RareStringData;
    inputChecked?: RareBooleanData;
    optionSelected?: RareBooleanData;
    contentDocumentIndex?: RareIntegerData;
    isClickable?: RareBooleanData;
  }
  export interface LayoutTreeSnapshot {
    nodeIndex: number[];
    styles: number[][];
    bounds: Rectangle[];
    text?: number[];
  }
  export interface DocumentSnapshot {
    nodes: NodeTreeSnapshot;
    layout: LayoutTreeSnapshot;
    documentURL?: number;
  }
  export interface CaptureSnapshotResult {
    documents: DocumentSnapshot[];
    strings: string[];
  }

  export interface AXValue { type: string; value?: unknown; }
  export interface AXProperty { name: string; value: AXValue; }
  export interface AXNode {
    nodeId: string;
    ignored: boolean;
    role?: AXValue;
    name?: AXValue;
    description?: AXValue;
    value?: AXValue;
    properties?: AXProperty[];
    backendDOMNodeId?: number;
  }
  export interface AXTreeResult { nodes: AXNode[]; }

  export interface LayoutViewport {
    pageX: number; pageY: number; clientWidth: number; clientHeight: number;
  }
  export interface LayoutMetricsResult {
    layoutViewport?: LayoutViewport;
    cssLayoutViewport?: LayoutViewport;
  }

  export interface ResolveNodeResult {
    object?: { objectId?: string };
  }
  export interface RuntimeRemoteObject { value?: unknown; }
  export interface RuntimeExceptionDetails { text: string; }
  export interface CallFunctionOnResult {
    result: RuntimeRemoteObject;
    exceptionDetails?: RuntimeExceptionDetails;
  }
}

// ─── CDP session caching ──────────────────────────────────────────────────
//
// Playwright's BrowserContext.newCDPSession(page) allocates a fresh session
// every call. We want one session per Page for the lifetime of the page.
// WeakMap so a closed page can be GC'd. The page.once('close') listener
// detaches the session — leaving it attached leaks both an inspector tab on
// the Chromium side and the buffered protocol events.

const SESSIONS = new WeakMap<Page, Promise<CDPSession>>();

/**
 * Get-or-create a CDP session bound to this page. Cached for the page's
 * lifetime; auto-detached on page close.
 *
 * Adversarial-review fix F1: if newCDPSession rejects, the bad promise used
 * to live in the WeakMap forever and every retry returned the same rejection.
 * Now we evict on reject so the next caller gets a fresh attempt.
 */
export async function getCDPSession(page: Page): Promise<CDPSession> {
  const existing = SESSIONS.get(page);
  if (existing) return existing;
  const promise = page.context().newCDPSession(page);
  SESSIONS.set(page, promise);
  promise.catch(() => {
    // Don't poison the cache with a rejected attempt.
    if (SESSIONS.get(page) === promise) SESSIONS.delete(page);
  });
  page.once('close', () => {
    SESSIONS.delete(page);
    promise
      .then((s) => s.detach().catch(() => {}))
      .catch(() => {});
  });
  return promise;
}

// ─── Tunables ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 2_000;

// Computed styles we ask DOMSnapshot to materialize. Order matters — we
// index into the styles[] array by position. Match Browser Use's set so
// behavior is comparable between implementations.
const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
] as const;

// Position-in-styles[] of the styles we actually read.
const STYLE_INDEX = {
  display: 0,
  visibility: 1,
  opacity: 2,
  cursor: 6,
  pointerEvents: 7,
} as const;

// ─── Public types ────────────────────────────────────────────────────────

export type SnapshotSource = 'cdp';

export interface CDPSnapshotOptions {
  /** `'interactive'` keeps only interactive elements (button/link/input/etc.);
   *  empty or `'all'` keeps semantic and text-bearing elements too. */
  filter?: 'interactive' | 'all' | '';
  /** Hard cap on parallel CDP calls. Falls through to legacy on timeout. */
  timeoutMs?: number;
  /**
   * Skip Accessibility.getFullAXTree (the slowest CDP call on big pages).
   * When false, role/name come from tag-based heuristics, matching the
   * legacy dom.js output. Default false because we measured the AX tree
   * adds 50-70ms on Wikipedia-sized pages with no agent-visible value
   * (the YAML role column is the same for >95% of nodes either way).
   */
  includeAX?: boolean;
}

export interface CDPSnapshotResult {
  /** YAML-formatted accessibility tree matching the legacy DOM_SCRIPT shape. */
  pageContent: string;
  /** CSS-pixel viewport bounds. */
  viewport: { width: number; height: number };
  /** End-to-end wall time for the snapshot. */
  snapshotMs: number;
  /** Time spent in the CDP fetch (DOMSnapshot + AX + metrics). */
  fetchMs?: number;
  /** Time spent rendering the YAML from the fetched payload. */
  renderMs?: number;
  source: SnapshotSource;
  /** Non-fatal warnings (e.g., cross-origin iframe skipped). */
  warnings: string[];
}

export interface CDPSnapshotError {
  error: string;
  snapshotMs: number;
}

export interface ResolvedRefViaCDP {
  success: true;
  backendNodeId: number;
  coordinates: [number, number];
  elementInfo: string;
  attributes: { type: string; role: string; ariaLabel: string; text: string };
  isVisible: boolean;
  isInteractable: boolean;
  stableSelector: string | null;
}

export interface ResolveRefError {
  success: false;
  message: string;
}

export interface CDPFormInputResult {
  success: boolean;
  message?: string;
  /** Element type that received the value (`text`, `select`, `checkbox`, etc.). */
  elementType?: string;
  /** Value that ended up on the element after dispatch (mirrors form-input.js). */
  newValue?: string | boolean | number;
}

// ─── Snapshot capture ─────────────────────────────────────────────────────

/**
 * Capture a full DOM+layout+AX snapshot in one fused CDP round-trip set.
 *
 * On 10s timeout or any CDP send failure, returns `{ error }` so the caller
 * can fall back to the legacy Playwright path. The agent loop must NEVER
 * crash because CDP is unhappy.
 */
export async function captureCDPSnapshot(
  page: Page,
  opts: CDPSnapshotOptions = {},
): Promise<CDPSnapshotResult | CDPSnapshotError> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const filter = opts.filter ?? '';
  const includeAX = opts.includeAX ?? false;
  const start = Date.now();

  let session: CDPSession;
  try {
    session = await getCDPSession(page);
  } catch (err) {
    return {
      error: `cdp_session_failed: ${(err as Error).message}`,
      snapshotMs: Date.now() - start,
    };
  }

  // CDP domains have to be enabled before captureSnapshot/getFullAXTree
  // will return useful payloads. These calls are idempotent across the
  // session lifetime.
  try {
    const enables = [session.send('DOM.enable')];
    if (includeAX) enables.push(session.send('Accessibility.enable'));
    await Promise.all(enables);
  } catch (err) {
    return {
      error: `cdp_enable_failed: ${(err as Error).message}`,
      snapshotMs: Date.now() - start,
    };
  }

  let snapshot: CDPTypes.CaptureSnapshotResult;
  let axTree: CDPTypes.AXTreeResult = { nodes: [] };
  let metrics: CDPTypes.LayoutMetricsResult;

  const fetchStart = Date.now();
  try {
    // We DON'T call DOM.getDocument here — DOMSnapshot already gives us
    // backendNodeIds and the parent/child structure we need, and pulling
    // the doc tree separately doubles renderer-side work for no gain on
    // single-frame pages. Cross-origin iframes (OOPIFs) aren't in this
    // snapshot at all; we surface a warning instead.
    //
    // includeDOMRects is false: we use `bounds[]` which is always present
    // and gives us what we need (CSS layout box). The extra rect arrays
    // (offsetRects, scrollRects, clientRects) cost 2-3x payload size on
    // big pages and we don't read them.
    const ops: Array<Promise<unknown>> = [
      session.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...REQUIRED_COMPUTED_STYLES],
        includePaintOrder: false,
        includeDOMRects: false,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      }),
      session.send('Page.getLayoutMetrics'),
    ];
    if (includeAX) ops.push(session.send('Accessibility.getFullAXTree'));

    const result = (await raceTimeout(Promise.all(ops), timeoutMs, 'cdp_snapshot_timeout')) as unknown[];
    snapshot = result[0] as CDPTypes.CaptureSnapshotResult;
    metrics = result[1] as CDPTypes.LayoutMetricsResult;
    if (includeAX) axTree = result[2] as CDPTypes.AXTreeResult;
  } catch (err) {
    return {
      error: `cdp_send_failed: ${(err as Error).message}`,
      snapshotMs: Date.now() - start,
    };
  }
  const fetchMs = Date.now() - fetchStart;

  const renderStart = Date.now();
  const rendered = renderSnapshot({ snapshot, axTree, metrics, filter });
  const renderMs = Date.now() - renderStart;

  return {
    pageContent: rendered.pageContent,
    viewport: rendered.viewport,
    snapshotMs: Date.now() - start,
    fetchMs,
    renderMs,
    source: 'cdp',
    warnings: rendered.warnings,
  };
}

// ─── Snapshot rendering (DOM+AX fusion → YAML) ────────────────────────────

interface RenderInput {
  snapshot: CDPTypes.CaptureSnapshotResult;
  axTree: CDPTypes.AXTreeResult;
  metrics: CDPTypes.LayoutMetricsResult;
  filter: 'interactive' | 'all' | '';
}

interface RenderOutput {
  pageContent: string;
  viewport: { width: number; height: number };
  warnings: string[];
}

interface AxLookupEntry {
  role: string;
  name: string;
  description: string;
  value: string;
  properties: Map<string, unknown>;
}

/**
 * The DOMSnapshot payload is column-oriented (parallel arrays); to walk it as
 * a tree we materialize a sparse view of each node we actually care about.
 *
 * `nodes` length is the parent array's length; each entry tracks just what
 * we need to decide visibility/interactivity + emit a YAML line.
 */
interface NodeView {
  index: number;
  parent: number; // -1 for the root
  depth: number;
  nodeType: number;
  nodeName: string; // uppercase tag (DOMSnapshot returns uppercase for elements)
  backendNodeId: number;
  attributes: Map<string, string>;
  // From layout snapshot (if the node has one — text nodes & display:none don't)
  hasLayout: boolean;
  bounds: [number, number, number, number] | null; // [x,y,w,h] in document coords
  styles: { display: string; visibility: string; opacity: string; cursor: string; pointerEvents: string };
  // For text nodes — the rendered text. We hoist these into the parent's
  // "direct text" computation for getCleanName().
  text: string;
}

function renderSnapshot(input: RenderInput): RenderOutput {
  const { snapshot, axTree, metrics, filter } = input;
  const warnings: string[] = [];

  if (!snapshot.documents || snapshot.documents.length === 0) {
    return {
      pageContent: '',
      viewport: { width: 0, height: 0 },
      warnings: ['cdp_snapshot_no_documents'],
    };
  }

  const strings = snapshot.strings ?? [];
  const getStr = (idx: number | undefined): string =>
    idx == null || idx < 0 || idx >= strings.length ? '' : strings[idx];

  const axLookup = buildAxLookup(axTree);

  const viewport = {
    width: metrics.cssLayoutViewport?.clientWidth ?? metrics.layoutViewport?.clientWidth ?? 0,
    height: metrics.cssLayoutViewport?.clientHeight ?? metrics.layoutViewport?.clientHeight ?? 0,
  };
  const pageScrollX = metrics.cssLayoutViewport?.pageX ?? metrics.layoutViewport?.pageX ?? 0;
  const pageScrollY = metrics.cssLayoutViewport?.pageY ?? metrics.layoutViewport?.pageY ?? 0;

  const lines: string[] = [];

  // Walk every document in the snapshot. documents[0] is the top frame;
  // documents[1+] are same-origin iframes (CDP returns one entry per frame
  // in the renderer's process). Cross-origin iframes (OOPIFs) are NOT in
  // this list — we warn instead of silently dropping their contents.
  for (let docIdx = 0; docIdx < snapshot.documents.length; docIdx++) {
    const doc = snapshot.documents[docIdx];
    const docPrefix = docIdx === 0 ? '' : '  '; // nested frames indent inside their parent
    renderDocument({
      doc,
      docIdx,
      strings,
      getStr,
      axLookup,
      viewport,
      pageScrollX,
      pageScrollY,
      filter,
      lines,
      docPrefix,
      warnings,
    });
  }

  // dom.js strips lines that are just `- generic [ref=ref_N]` with no name.
  // Adversarial-review fix F2: original regex matched only counter-style
  // `ref_\d+`. CDP now emits `ref_b\d+`, so the unnamed-generic lines were
  // leaking into the YAML. Broadened to either ref shape.
  const filtered = lines.filter((line) => !/^\s*- generic \[ref=ref_[a-z]?\d+\]$/.test(line));

  return {
    pageContent: filtered.join('\n'),
    viewport,
    warnings,
  };
}

function buildAxLookup(
  axTree: CDPTypes.AXTreeResult,
): Map<number, AxLookupEntry> {
  const map = new Map<number, AxLookupEntry>();
  for (const node of axTree.nodes ?? []) {
    if (node.backendDOMNodeId == null) continue;
    if (node.ignored) continue;
    const properties = new Map<string, unknown>();
    for (const p of node.properties ?? []) {
      properties.set(p.name, p.value?.value);
    }
    map.set(node.backendDOMNodeId, {
      role: stringOf(node.role),
      name: stringOf(node.name),
      description: stringOf(node.description),
      value: stringOf(node.value),
      properties,
    });
  }
  return map;
}

function stringOf(v: CDPTypes.AXValue | undefined): string {
  if (!v) return '';
  if (v.value == null) return '';
  return typeof v.value === 'string' ? v.value : String(v.value);
}

interface RenderDocumentArgs {
  doc: CDPTypes.DocumentSnapshot;
  docIdx: number;
  strings: string[];
  getStr: (idx: number | undefined) => string;
  axLookup: Map<number, AxLookupEntry>;
  viewport: { width: number; height: number };
  pageScrollX: number;
  pageScrollY: number;
  filter: 'interactive' | 'all' | '';
  lines: string[];
  docPrefix: string;
  warnings: string[];
}

function renderDocument(args: RenderDocumentArgs): void {
  const { doc, getStr, axLookup, viewport, pageScrollX, pageScrollY, filter, lines, docPrefix, warnings } = args;

  const nodes = materializeNodes(doc, getStr);
  if (nodes.length === 0) {
    if (args.docIdx === 0) warnings.push('cdp_snapshot_empty_main_document');
    return;
  }

  // Children-by-parent for tree walk.
  const childrenOf = new Map<number, number[]>();
  for (const n of nodes) {
    if (n.parent < 0) continue;
    const arr = childrenOf.get(n.parent);
    if (arr) arr.push(n.index);
    else childrenOf.set(n.parent, [n.index]);
  }

  // Find the document root (parentIndex === -1). DOMSnapshot uses -1 as the
  // root marker; sometimes there are multiple roots (e.g., shadow roots).
  const roots = nodes.filter((n) => n.parent < 0).map((n) => n.index);

  for (const rootIdx of roots) {
    walkNode({
      index: rootIdx,
      depth: 0,
      nodes,
      childrenOf,
      axLookup,
      viewport,
      pageScrollX,
      pageScrollY,
      filter,
      lines,
      docPrefix,
      warnings,
    });
  }
}

function materializeNodes(
  doc: CDPTypes.DocumentSnapshot,
  getStr: (idx: number | undefined) => string,
): NodeView[] {
  const n = doc.nodes ?? {};
  const parentIndex = n.parentIndex ?? [];
  const nodeType = n.nodeType ?? [];
  const nodeName = n.nodeName ?? [];
  const nodeValue = n.nodeValue ?? [];
  const backendNodeId = n.backendNodeId ?? [];
  const attributes = n.attributes ?? [];

  const total = parentIndex.length;
  const views: NodeView[] = new Array(total);

  // Build attribute maps for each node. Attributes are stored as a flat
  // [name1, value1, name2, value2, ...] string-index list per node.
  for (let i = 0; i < total; i++) {
    const attrFlat = attributes[i] ?? [];
    const attrs = new Map<string, string>();
    for (let j = 0; j + 1 < attrFlat.length; j += 2) {
      attrs.set(getStr(attrFlat[j]).toLowerCase(), getStr(attrFlat[j + 1]));
    }
    views[i] = {
      index: i,
      parent: parentIndex[i] ?? -1,
      depth: 0,
      nodeType: nodeType[i] ?? 0,
      nodeName: getStr(nodeName[i]),
      backendNodeId: backendNodeId[i] ?? 0,
      attributes: attrs,
      hasLayout: false,
      bounds: null,
      styles: { display: '', visibility: '', opacity: '', cursor: '', pointerEvents: '' },
      text: nodeType[i] === 3 ? getStr(nodeValue[i]) : '', // 3 = TEXT_NODE
    };
  }

  // Layer in layout data — bounds + computed styles — for nodes that have a
  // LayoutObject. Nodes without layout (display:none, scripts, etc.) stay
  // hasLayout=false and will be filtered out as not-visible.
  const layout = doc.layout ?? {};
  const layoutNodeIdx = layout.nodeIndex ?? [];
  const layoutBounds = layout.bounds ?? [];
  const layoutStyles = layout.styles ?? [];

  for (let li = 0; li < layoutNodeIdx.length; li++) {
    const nodeIdx = layoutNodeIdx[li];
    const view = views[nodeIdx];
    if (!view) continue;
    view.hasLayout = true;
    const b = layoutBounds[li];
    if (b && b.length >= 4) {
      view.bounds = [b[0], b[1], b[2], b[3]];
    }
    const s = layoutStyles[li] ?? [];
    view.styles = {
      display: getStr(s[STYLE_INDEX.display]),
      visibility: getStr(s[STYLE_INDEX.visibility]),
      opacity: getStr(s[STYLE_INDEX.opacity]),
      cursor: getStr(s[STYLE_INDEX.cursor]),
      pointerEvents: getStr(s[STYLE_INDEX.pointerEvents]),
    };
  }

  return views;
}

interface WalkArgs {
  index: number;
  depth: number;
  nodes: NodeView[];
  childrenOf: Map<number, number[]>;
  axLookup: Map<number, AxLookupEntry>;
  viewport: { width: number; height: number };
  pageScrollX: number;
  pageScrollY: number;
  filter: 'interactive' | 'all' | '';
  lines: string[];
  docPrefix: string;
  warnings: string[];
}

function walkNode(args: WalkArgs): void {
  const { index, depth, nodes, childrenOf, filter, lines, docPrefix, warnings } = args;
  if (depth > 15) return; // dom.js cap — mirror it so output shape stays compatible

  const node = nodes[index];
  if (!node) return;

  const isElement = node.nodeType === 1;
  // Skip non-elements at this level — we only emit lines for ELEMENT_NODE.
  // Their text content is folded into the parent via the cleanName function.
  const include = isElement && shouldInclude(node, args);

  if (include) {
    const role = computeRole(node, args.axLookup);
    const name = computeCleanName(node, nodes, childrenOf, args.axLookup);
    // Prefix with `b` so CDP refs (backendNodeId-keyed) can't collide with
    // legacy DOM_SCRIPT refs (counter-keyed) when both paths run in the
    // same session — e.g. one snapshot succeeds via CDP, the next falls
    // back to legacy. resolveRefViaCDP only matches the `ref_b<int>`
    // shape; everything else routes to the legacy element.js path.
    const ref = `ref_b${node.backendNodeId}`;
    const indent = docPrefix + '  '.repeat(depth);
    let yaml = `${indent}- ${role}`;
    if (name) {
      const cleaned = name.replace(/\s+/g, ' ').slice(0, 100);
      yaml += ` "${cleaned.replace(/"/g, '\\"')}"`;
    }
    yaml += ` [ref=${ref}]`;
    const id = node.attributes.get('id');
    if (id) yaml += ` id="${id}"`;
    const href = node.attributes.get('href');
    if (href) yaml += ` href="${href}"`;
    const type = node.attributes.get('type');
    if (type) yaml += ` type="${type}"`;
    const placeholder = node.attributes.get('placeholder');
    if (placeholder) yaml += ` placeholder="${placeholder}"`;
    lines.push(yaml);
  }

  // Warn once per snapshot if we hit an iframe with cross-origin content —
  // DOMSnapshot won't include that document and the agent will see the
  // empty iframe as if it had no children.
  // Adversarial-review fix F6: route the iframe tag check through the same
  // lowercased path the rest of the file uses; the upstream DOMSnapshot
  // uppercase nodeName was bait for the next contributor.
  if (isElement) {
    const tag = node.nodeName.toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      const src = node.attributes.get('src') ?? '';
      if (src && !warnings.some((w) => w.startsWith('cdp_iframe_'))) {
        warnings.push(`cdp_iframe_present: ${src.slice(0, 80)} (cross-origin iframes are not snapshotted in this version)`);
      }
    }
  }

  const kids = childrenOf.get(index);
  if (!kids) return;
  const childDepth = include ? depth + 1 : depth;
  for (const childIdx of kids) {
    walkNode({ ...args, index: childIdx, depth: childDepth });
  }
}

// ─── Inclusion / role / name — port of dom.js + Browser Use heuristics ───

function shouldInclude(node: NodeView, args: WalkArgs): boolean {
  const tag = node.nodeName.toLowerCase();

  // Always skip script-y / non-rendered nodes regardless of filter.
  if (NON_RENDERED_TAGS.has(tag)) return false;
  if (node.attributes.get('aria-hidden') === 'true') return false;
  if (node.attributes.get('hidden') === '') return false;
  if (node.attributes.get('hidden') === 'true') return false;

  // Visibility — hasLayout + non-zero box + computed display/visibility.
  if (!isVisible(node)) return false;

  // For all but the 'all' filter, also require the node to overlap the
  // current viewport. The mapper's clickable workflow only cares about
  // what the user can see right now.
  if (args.filter !== 'all') {
    if (!isInViewport(node, args)) return false;
  }

  if (args.filter === 'interactive') {
    return isInteractive(node, args.axLookup);
  }

  // Default (no filter): keep interactive + semantic + text-bearing.
  if (isInteractive(node, args.axLookup)) return true;
  if (isSemantic(node)) return true;
  // Adversarial-review fix F3: legacy getCleanName walks TEXT_NODE children
  // to surface elements whose only "name" is the text content. The stub
  // attribute-only check was dropping <span>Sign in</span> etc. Now we look
  // at attributes first (cheap) and fall through to direct-text only when
  // needed.
  if (computeCleanNameStub(node).length > 0) return true;
  if (hasDirectText(node, args.nodes, args.childrenOf)) return true;

  // Generic divs / spans: keep iff they look like functional containers or
  // carry meaningful direct text. This mirrors dom.js's behavior so the
  // mapper's prompt-text expectations don't shift under it.
  const role = computeRole(node, args.axLookup);
  if (role === 'generic' && (tag === 'div' || tag === 'span')) {
    const id = (node.attributes.get('id') ?? '').toLowerCase();
    const className = (node.attributes.get('class') ?? '').toLowerCase();
    if (FUNCTIONAL_KEYWORDS.some((k) => id.includes(k) || className.includes(k))) return true;
    return false;
  }
  if (isContainerElement(node)) return true;
  return false;
}

function isVisible(node: NodeView): boolean {
  if (!node.hasLayout) return false;
  if (node.styles.display === 'none') return false;
  if (node.styles.visibility === 'hidden') return false;
  // Adversarial-review fix F5: opacity can be '0', '0.0', '0.0%', or any
  // value parsing to numeric zero. Use parseFloat to catch them all.
  const opacityNum = Number.parseFloat(node.styles.opacity);
  if (Number.isFinite(opacityNum) && opacityNum === 0) return false;
  const b = node.bounds;
  if (!b) return false;
  return b[2] > 0 && b[3] > 0;
}

function isInViewport(node: NodeView, args: WalkArgs): boolean {
  const b = node.bounds;
  if (!b) return false;
  const x = b[0] - args.pageScrollX;
  const y = b[1] - args.pageScrollY;
  const w = b[2];
  const h = b[3];
  return y < args.viewport.height && y + h > 0 && x < args.viewport.width && x + w > 0;
}

function isInteractive(node: NodeView, axLookup: Map<number, AxLookupEntry>): boolean {
  const tag = node.nodeName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (node.attributes.has('onclick')) return true;
  if (node.attributes.has('onmousedown')) return true;
  if (node.attributes.has('onmouseup')) return true;
  if (node.attributes.has('onkeydown')) return true;
  if (node.attributes.has('onkeyup')) return true;
  const tabindex = node.attributes.get('tabindex');
  if (tabindex != null && tabindex !== '') return true;
  if (node.attributes.get('contenteditable') === 'true') return true;
  if (node.styles.cursor === 'pointer' && node.styles.pointerEvents !== 'none') return true;

  const role = node.attributes.get('role') ?? '';
  if (INTERACTIVE_ROLES.has(role)) return true;

  const ax = axLookup.get(node.backendNodeId);
  if (ax) {
    if (INTERACTIVE_ROLES.has(ax.role)) return true;
    for (const key of AX_INTERACTIVE_PROPS) {
      if (ax.properties.has(key)) return true;
    }
  }
  return false;
}

function isSemantic(node: NodeView): boolean {
  const tag = node.nodeName.toLowerCase();
  if (SEMANTIC_TAGS.has(tag)) return true;
  if (node.attributes.has('role')) return true;
  return false;
}

function isContainerElement(node: NodeView): boolean {
  const role = node.attributes.get('role') ?? '';
  const tag = node.nodeName.toLowerCase();
  const id = (node.attributes.get('id') ?? '').toLowerCase();
  const className = (node.attributes.get('class') ?? '').toLowerCase();
  if (CONTAINER_ROLES.has(role)) return true;
  if (CONTAINER_TAGS.has(tag)) return true;
  for (const k of CONTAINER_KEYWORDS) {
    if (id.includes(k) || className.includes(k)) return true;
  }
  return false;
}

function computeRole(node: NodeView, axLookup: Map<number, AxLookupEntry>): string {
  const explicit = node.attributes.get('role');
  if (explicit) return explicit;

  // AX tree's role is the most authoritative; for native form controls it
  // already returns the right thing (textbox for <input type=text>, etc.).
  const ax = axLookup.get(node.backendNodeId);
  if (ax && ax.role) return ax.role;

  const tag = node.nodeName.toLowerCase();
  const type = node.attributes.get('type') ?? '';
  return ROLE_MAP[tag] ?? roleForInputType(tag, type) ?? 'generic';
}

function roleForInputType(tag: string, type: string): string | null {
  if (tag !== 'input') return null;
  if (type === 'submit' || type === 'button' || type === 'file') return 'button';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  return 'textbox';
}

function computeCleanName(
  node: NodeView,
  nodes: NodeView[],
  childrenOf: Map<number, number[]>,
  axLookup: Map<number, AxLookupEntry>,
): string {
  const ax = axLookup.get(node.backendNodeId);
  if (ax && ax.name) return ax.name;

  // Fallback to attribute-driven heuristics matching dom.js for parity with
  // the legacy YAML even when AX isn't computed (some shadow-DOM nodes).
  const aria = node.attributes.get('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const placeholder = node.attributes.get('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();
  const title = node.attributes.get('title');
  if (title && title.trim()) return title.trim();
  const alt = node.attributes.get('alt');
  if (alt && alt.trim()) return alt.trim();

  // For <input>, value text or submit-button caption.
  const tag = node.nodeName.toLowerCase();
  if (tag === 'input') {
    const type = node.attributes.get('type') ?? '';
    const value = node.attributes.get('value') ?? '';
    if ((type === 'submit' || type === 'button') && value.trim()) return value.trim();
  }

  // Direct text of this node — concat TEXT_NODE children.
  const kids = childrenOf.get(node.index);
  if (kids) {
    let directText = '';
    for (const c of kids) {
      const cv = nodes[c];
      if (cv && cv.nodeType === 3) directText += cv.text;
    }
    const trimmed = directText.trim();
    if (trimmed && trimmed.length >= 3) {
      return trimmed.length > 50 ? trimmed.slice(0, 50) + '...' : trimmed;
    }
  }

  return '';
}

// computeCleanNameStub — the inclusion check only needs to know whether the
// name is non-empty, not what it is. Avoids paying for substring/regex when
// we're going to throw the result away.
function computeCleanNameStub(node: NodeView): string {
  return (
    node.attributes.get('aria-label') ??
    node.attributes.get('placeholder') ??
    node.attributes.get('title') ??
    node.attributes.get('alt') ??
    ''
  );
}

/**
 * True iff the node has at least 3 chars of direct text content (TEXT_NODE
 * children only). Mirrors the >= 3-char threshold dom.js uses to decide
 * whether to keep a text-bearing generic element.
 */
function hasDirectText(
  node: NodeView,
  nodes: NodeView[],
  childrenOf: Map<number, number[]>,
): boolean {
  const kids = childrenOf.get(node.index);
  if (!kids) return false;
  let len = 0;
  for (const c of kids) {
    const cv = nodes[c];
    if (cv && cv.nodeType === 3) {
      len += cv.text.trim().length;
      if (len >= 3) return true;
    }
  }
  return false;
}

// ─── Constant tables ──────────────────────────────────────────────────────

const NON_RENDERED_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript', 'template']);
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary', 'option', 'optgroup']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'textbox',
  'combobox', 'slider', 'spinbutton', 'listbox', 'search', 'searchbox', 'row',
  'cell', 'gridcell', 'switch', 'treeitem', 'menu',
]);
const AX_INTERACTIVE_PROPS = ['focusable', 'editable', 'settable', 'checked', 'expanded', 'pressed', 'selected', 'required', 'autocomplete', 'keyshortcuts'];
const SEMANTIC_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);
const CONTAINER_TAGS = new Set(['form', 'fieldset', 'nav']);
const CONTAINER_ROLES = new Set(['search', 'form', 'group', 'toolbar', 'navigation']);
const CONTAINER_KEYWORDS = ['search', 'form', 'menu', 'nav'];
const FUNCTIONAL_KEYWORDS = ['search', 'dropdown', 'menu', 'modal', 'dialog', 'popup', 'toolbar', 'sidebar', 'content', 'text'];
const ROLE_MAP: Record<string, string> = {
  a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  img: 'image', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  section: 'region', article: 'article', aside: 'complementary', form: 'form',
  table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label',
};

// ─── Ref resolution ───────────────────────────────────────────────────────

/**
 * Resolve a CDP-style ref (`ref_<backendNodeId>`) back to an actionable
 * description: coordinates, attributes, and a synthesized stable selector.
 *
 * Uses CDP's DOM.resolveNode + Runtime.callFunctionOn so we don't need to
 * round-trip through window.__claudeElementMap. If anything fails, returns
 * an error object — caller falls back to the legacy element.js path.
 */
export async function resolveRefViaCDP(
  page: Page,
  ref: string,
  opts: { timeoutMs?: number } = {},
): Promise<ResolvedRefViaCDP | ResolveRefError> {
  // Only `ref_b<int>` belongs to the CDP path. Counter-style legacy refs
  // (`ref_5`) MUST route to element.js — DOM.resolveNode would happily
  // resolve any random backendNodeId, giving the agent a different element
  // than the one it just saw in read_page.
  const m = ref.match(/^ref_b(\d+)$/);
  if (!m) {
    return { success: false, message: `ref_format_mismatch: "${ref}" is not ref_b<backendNodeId>` };
  }
  const backendNodeId = Number.parseInt(m[1], 10);
  if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) {
    return { success: false, message: `ref_format_mismatch: backendNodeId not a positive int` };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let session: CDPSession;
  try {
    session = await getCDPSession(page);
  } catch (err) {
    return { success: false, message: `cdp_session_failed: ${(err as Error).message}` };
  }

  let resolved: CDPTypes.ResolveNodeResult;
  try {
    resolved = await raceTimeout(
      session.send('DOM.resolveNode', { backendNodeId }),
      timeoutMs,
      'cdp_resolveNode_timeout',
    );
  } catch (err) {
    return { success: false, message: `cdp_resolveNode_failed: ${(err as Error).message}` };
  }
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    return { success: false, message: 'cdp_resolveNode_no_object_id' };
  }

  // Adversarial-review fix F4: previously releaseObject lived after the
  // race result, so a timeout skipped it and leaked the renderer-side
  // remote-object handle. Try/finally guarantees we release whether the
  // race wins, loses, or the inspect throws.
  try {
    const callResult = await raceTimeout(
      session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: ELEMENT_INSPECT_FN,
        returnByValue: true,
        awaitPromise: false,
      }),
      timeoutMs,
      'cdp_callFunctionOn_timeout',
    );
    if (callResult.exceptionDetails) {
      return { success: false, message: `inspect_threw: ${callResult.exceptionDetails.text}` };
    }
    const value = callResult.result?.value as ElementInspectResult | undefined;
    if (!value) {
      return { success: false, message: 'inspect_returned_no_value' };
    }
    if (!value.success) {
      return { success: false, message: value.message ?? 'inspect_failed' };
    }
    return {
      success: true,
      backendNodeId,
      coordinates: value.coordinates,
      elementInfo: value.elementInfo,
      attributes: value.attributes,
      isVisible: value.isVisible,
      isInteractable: value.isInteractable,
      stableSelector: value.stableSelector,
    };
  } catch (err) {
    return { success: false, message: `cdp_callFunctionOn_failed: ${(err as Error).message}` };
  } finally {
    void session
      .send('Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

interface ElementInspectResult {
  success: boolean;
  message?: string;
  coordinates: [number, number];
  elementInfo: string;
  attributes: { type: string; role: string; ariaLabel: string; text: string };
  isVisible: boolean;
  isInteractable: boolean;
  stableSelector: string | null;
}

// Stringified function body executed against the resolved DOM node (`this`).
// Mirrors element.js + synthesizeStableSelector from browser-tool.ts so we
// keep one canonical inspect-shape for the agent and recipe replay.
//
// IMPORTANT: this runs in the page's main world. The function must NOT close
// over any TypeScript bindings — it's serialized via CDP and rehydrated as a
// string. Keep it self-contained.
const ELEMENT_INSPECT_FN = `function() {
  try {
    const el = this;
    if (!el || el.nodeType !== 1) {
      return { success: false, message: 'not_an_element', coordinates: [0,0], elementInfo: '', attributes: { type: '', role: '', ariaLabel: '', text: '' }, isVisible: false, isInteractable: false, stableSelector: null };
    }
    if (!document.contains(el)) {
      return { success: false, message: 'detached_from_dom', coordinates: [0,0], elementInfo: '', attributes: { type: '', role: '', ariaLabel: '', text: '' }, isVisible: false, isInteractable: false, stableSelector: null };
    }
    try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (_) {}
    void el.offsetHeight;
    const rect = el.getBoundingClientRect();
    const clickX = rect.left + rect.width / 2;
    const clickY = rect.top + rect.height / 2;
    const tag = el.tagName.toLowerCase();
    const className = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    const elementInfo = tag +
      (el.id ? '#' + el.id : '') +
      (className ? '.' + className.split(' ').filter(function(c){return c;}).join('.') : '');
    const text = el.textContent ? el.textContent.substring(0, 100) : '';

    // Stable selector synthesis (mirrors browser-tool.ts/synthesizeStableSelector).
    let stableSelector = null;
    const looksGenerated = function(s) {
      return /^[0-9]/.test(s) ||
        /[a-f0-9]{8}-[a-f0-9]{4}/.test(s) ||
        s.indexOf(':') >= 0 ||
        s.length > 40;
    };
    const id = el.getAttribute('id');
    if (id && !looksGenerated(id)) {
      try { stableSelector = '#' + CSS.escape(id); } catch (_) { stableSelector = '#' + id; }
    }
    if (!stableSelector) {
      const dataAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
      for (let i = 0; i < dataAttrs.length; i++) {
        const v = el.getAttribute(dataAttrs[i]);
        if (v) {
          const esc = (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v).replace(/"/g, '\\\\"');
          stableSelector = '[' + dataAttrs[i] + '="' + esc + '"]';
          break;
        }
      }
    }
    if (!stableSelector && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      const name = el.getAttribute('name');
      const type = el.getAttribute('type');
      if (name) {
        const esc = (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : name);
        stableSelector = tag + '[name="' + esc + '"]';
      } else if (type) {
        stableSelector = tag + '[type="' + type + '"]';
      }
    }
    if (!stableSelector) {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.length < 60) {
        const esc = (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(aria) : aria).replace(/"/g, '\\\\"');
        stableSelector = '[aria-label="' + esc + '"]';
      }
    }
    if (!stableSelector) {
      const tcontent = (el.textContent || '').trim();
      if (tcontent && tcontent.length < 50 && tcontent.indexOf('\\n') < 0 && (tag === 'button' || tag === 'a' || tag === 'label')) {
        stableSelector = tag + ':has-text("' + tcontent.replace(/"/g, '\\\\"') + '")';
      }
    }

    return {
      success: true,
      coordinates: [clickX, clickY],
      elementInfo: elementInfo,
      attributes: {
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        text: text,
      },
      isVisible: rect.width > 0 && rect.height > 0,
      isInteractable: !el.disabled && el.style.display !== 'none' && el.style.visibility !== 'hidden',
      stableSelector: stableSelector,
    };
  } catch (err) {
    return { success: false, message: 'inspect_error: ' + (err && err.message ? err.message : 'unknown'), coordinates: [0,0], elementInfo: '', attributes: { type: '', role: '', ariaLabel: '', text: '' }, isVisible: false, isInteractable: false, stableSelector: null };
  }
}`;

// ─── Form input (CDP-side mirror of browser-utils/form-input.js) ─────────
//
// Adversarial-review fix (Codex pass): the `form_input` action in
// browser-tool.ts dispatched directly through FORM_INPUT_SCRIPT, which
// looks the element up in `window.__claudeElementMap`. CDP-emitted refs
// (`ref_b<backendNodeId>`) never land in that map, so a CDP-mode session
// would silently fail to fill any form field — and then never record the
// `{kind: 'fill', selector, value}` step a recipe needs to replay.
//
// formInputViaCDP performs the same set-value-and-dispatch logic, but
// operates against the backendNodeId-resolved object. Returns the same
// shape FORM_INPUT_SCRIPT does so the caller can keep its branch logic.

export async function formInputViaCDP(
  page: Page,
  ref: string,
  value: string | number | boolean,
  opts: { timeoutMs?: number } = {},
): Promise<CDPFormInputResult> {
  const m = ref.match(/^ref_b(\d+)$/);
  if (!m) {
    return { success: false, message: `ref_format_mismatch: "${ref}" is not ref_b<backendNodeId>` };
  }
  const backendNodeId = Number.parseInt(m[1], 10);
  if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) {
    return { success: false, message: 'ref_format_mismatch: backendNodeId not a positive int' };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let session: CDPSession;
  try {
    session = await getCDPSession(page);
  } catch (err) {
    return { success: false, message: `cdp_session_failed: ${(err as Error).message}` };
  }

  let resolved: CDPTypes.ResolveNodeResult;
  try {
    resolved = await raceTimeout(
      session.send('DOM.resolveNode', { backendNodeId }),
      timeoutMs,
      'cdp_resolveNode_timeout',
    );
  } catch (err) {
    return { success: false, message: `cdp_resolveNode_failed: ${(err as Error).message}` };
  }
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    return { success: false, message: 'cdp_resolveNode_no_object_id' };
  }

  try {
    const callResult = await raceTimeout(
      session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: FORM_INPUT_FN,
        arguments: [{ value }],
        returnByValue: true,
        awaitPromise: false,
      }),
      timeoutMs,
      'cdp_callFunctionOn_timeout',
    );
    if (callResult.exceptionDetails) {
      return { success: false, message: `form_input_threw: ${callResult.exceptionDetails.text}` };
    }
    const out = callResult.result?.value as CDPFormInputResult | undefined;
    if (!out) return { success: false, message: 'form_input_returned_no_value' };
    return out;
  } catch (err) {
    return { success: false, message: `cdp_form_input_failed: ${(err as Error).message}` };
  } finally {
    void session.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

// Stringified function body executed against the resolved DOM node (`this`).
// Mirrors browser-utils/form-input.js so the same set-and-dispatch behavior
// applies on both paths. Self-contained (CDP serializes the source).
const FORM_INPUT_FN = `function(inputValue) {
  try {
    const el = this;
    if (!el || el.nodeType !== 1 || !document.contains(el)) {
      return { success: false, message: 'detached_from_dom' };
    }
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    const dispatch = function(){
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const valueStr = String(inputValue);
      let optionFound = false;
      for (let i = 0; i < options.length; i++) {
        if (options[i].value === valueStr || options[i].text === valueStr) {
          el.selectedIndex = i;
          optionFound = true;
          break;
        }
      }
      if (!optionFound) {
        return { success: false, message: 'option_not_found: "' + valueStr + '"' };
      }
      try { el.focus(); } catch (_) {}
      dispatch();
      return { success: true, elementType: 'select', newValue: el.value };
    }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      if (typeof inputValue !== 'boolean') {
        return { success: false, message: 'checkbox_requires_boolean' };
      }
      el.checked = inputValue;
      try { el.focus(); } catch (_) {}
      dispatch();
      return { success: true, elementType: 'checkbox', newValue: el.checked };
    }
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      el.checked = true;
      try { el.focus(); } catch (_) {}
      dispatch();
      return { success: true, elementType: 'radio', newValue: el.checked };
    }
    if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')) {
      const num = Number(inputValue);
      if (!Number.isFinite(num) && String(inputValue) !== '') {
        return { success: false, message: el.type + '_requires_numeric' };
      }
      el.value = String(inputValue);
      try { el.focus(); } catch (_) {}
      dispatch();
      return { success: true, elementType: el.type, newValue: el.value };
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = String(inputValue);
      try { el.focus(); } catch (_) {}
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
      dispatch();
      const tag = el instanceof HTMLTextAreaElement ? 'textarea' : (el.type || 'text');
      return { success: true, elementType: tag, newValue: el.value };
    }
    return { success: false, message: 'unsupported_element_type: ' + el.tagName };
  } catch (err) {
    return { success: false, message: 'form_input_error: ' + (err && err.message ? err.message : 'unknown') };
  }
}`;

// ─── Utilities ────────────────────────────────────────────────────────────

async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
