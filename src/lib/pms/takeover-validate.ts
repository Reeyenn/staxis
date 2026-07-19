/**
 * feature/cua-live-assist — pure request validators for the founder-takeover
 * routes (/api/admin/mapper/takeover, /takeover-command). Hand-rolled, no zod
 * (matches src/lib/api-validate.ts). Unit-tested in
 * src/lib/__tests__/takeover-validate.test.ts.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

export type TakeoverIntent = 'start' | 'skip';
export type TakeoverCommandKind = 'click' | 'finish' | 'cancel';
export type AssistAction = 'guidance' | 'unavailable' | 'takeover' | 'abort';

const INTENTS = new Set<TakeoverIntent>(['start', 'skip']);
const COMMANDS = new Set<TakeoverCommandKind>(['click', 'finish', 'cancel']);
const ASSIST_ACTIONS = new Set<AssistAction>(['guidance', 'unavailable', 'takeover', 'abort']);

function cleanNote(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 500) : null;
}

/** Pure request validation for POST /api/admin/mapper/assist. Kept outside
 * the route module because Next.js route files may export only HTTP handlers
 * and supported route configuration fields. */
export function validateAssistBody(body: unknown):
  | {
      ok: true;
      requestId: string;
      actionType: AssistAction;
      responseText: string | null;
      coordinate: { x: number; y: number } | null;
      screenshotPath: string | null;
    }
  | { ok: false; reason: string } {
  const b = body as {
    requestId?: unknown;
    actionType?: unknown;
    responseText?: unknown;
    responseCoordinate?: unknown;
    screenshotPath?: unknown;
  } | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'body must be a JSON object' };
  if (typeof b.requestId !== 'string' || !UUID_RE.test(b.requestId)) {
    return { ok: false, reason: 'requestId must be a uuid' };
  }
  if (typeof b.actionType !== 'string' || !ASSIST_ACTIONS.has(b.actionType as AssistAction)) {
    return { ok: false, reason: `actionType must be one of: ${[...ASSIST_ACTIONS].join(', ')}` };
  }
  const actionType = b.actionType as AssistAction;
  const responseText = typeof b.responseText === 'string' && b.responseText.trim().length > 0
    ? b.responseText
    : null;
  if ((actionType === 'guidance' || actionType === 'unavailable') && responseText === null) {
    return { ok: false, reason: 'responseText is required for guidance / unavailable' };
  }
  let coordinate: { x: number; y: number } | null = null;
  let screenshotPath: string | null = null;
  if (actionType === 'takeover') {
    const c = b.responseCoordinate as { x?: unknown; y?: unknown } | null | undefined;
    if (!c || typeof c !== 'object' || typeof c.x !== 'number' || typeof c.y !== 'number'
      || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return { ok: false, reason: 'takeover requires responseCoordinate {x, y} (numbers)' };
    }
    coordinate = { x: c.x, y: c.y };
    if (typeof b.screenshotPath !== 'string' || b.screenshotPath.trim().length === 0) {
      return { ok: false, reason: 'takeover requires screenshotPath (the screenshot the click was chosen on)' };
    }
    screenshotPath = b.screenshotPath;
  }
  return { ok: true, requestId: b.requestId, actionType, responseText, coordinate, screenshotPath };
}

/** Round and bounds-check a mapper-assist coordinate against its capture. */
export function validateCoordinateBounds(
  c: { x: number; y: number },
  viewportW: number,
  viewportH: number,
): { x: number; y: number } | null {
  return validateTakeoverCoordinate(c, viewportW, viewportH);
}

export function validateTakeoverStart(body: unknown):
  | { ok: true; jobId: string; intent: TakeoverIntent; targetKey: string | null; note: string | null }
  | { ok: false; reason: string } {
  const b = body as { jobId?: unknown; intent?: unknown; targetKey?: unknown; note?: unknown } | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'body must be a JSON object' };
  if (typeof b.jobId !== 'string' || !UUID_RE.test(b.jobId)) return { ok: false, reason: 'jobId must be a uuid' };
  if (typeof b.intent !== 'string' || !INTENTS.has(b.intent as TakeoverIntent)) {
    return { ok: false, reason: "intent must be 'start' or 'skip'" };
  }
  const targetKey =
    typeof b.targetKey === 'string' && /^[a-z0-9_]{1,64}$/i.test(b.targetKey) ? b.targetKey : null;
  return { ok: true, jobId: b.jobId, intent: b.intent as TakeoverIntent, targetKey, note: cleanNote(b.note) };
}

export function validateTakeoverCommand(body: unknown):
  | { ok: true; jobId: string; command: TakeoverCommandKind; coordinate: { x: number; y: number } | null; note: string | null; frameSeq: number | null }
  | { ok: false; reason: string } {
  const b = body as { jobId?: unknown; command?: unknown; coordinate?: unknown; note?: unknown; frameSeq?: unknown } | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'body must be a JSON object' };
  if (typeof b.jobId !== 'string' || !UUID_RE.test(b.jobId)) return { ok: false, reason: 'jobId must be a uuid' };
  if (typeof b.command !== 'string' || !COMMANDS.has(b.command as TakeoverCommandKind)) {
    return { ok: false, reason: "command must be one of: click, finish, cancel" };
  }
  const command = b.command as TakeoverCommandKind;

  let coordinate: { x: number; y: number } | null = null;
  let frameSeq: number | null = null;
  if (command === 'click') {
    const c = b.coordinate as { x?: unknown; y?: unknown } | null | undefined;
    if (!c || typeof c !== 'object' || typeof c.x !== 'number' || typeof c.y !== 'number' ||
        !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return { ok: false, reason: 'click requires coordinate {x, y} (finite numbers)' };
    }
    coordinate = { x: c.x, y: c.y };
    if (typeof b.frameSeq !== 'number' || !Number.isInteger(b.frameSeq) || b.frameSeq < 0) {
      return { ok: false, reason: 'click requires frameSeq (the frame the click was chosen on)' };
    }
    frameSeq = b.frameSeq;
  }
  return { ok: true, jobId: b.jobId, command, coordinate, note: cleanNote(b.note), frameSeq };
}

/**
 * Round + bounds-check a takeover click against the capture viewport. Click
 * coords are viewport CSS pixels (the takeover frame is a viewport-sized
 * capture). Null = out of bounds. Mirrors validateCoordinateBounds (assist
 * route) and validateCoord in cua-service/src/takeover.ts.
 */
export function validateTakeoverCoordinate(
  c: { x: number; y: number },
  viewportW: number,
  viewportH: number,
): { x: number; y: number } | null {
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  if (x < 0 || x >= viewportW || y < 0 || y >= viewportH) return null;
  return { x, y };
}
