import { VisionSchemaError } from '@/lib/vision-extract';

/** One labelled assignment section read from a paper housekeeping board. */
export interface BoardSection {
  /** What the column/section is called on the board, if it is labelled. */
  label: string | null;
  /** Floor as written ("2", "2nd", "Building B"), if shown. */
  floor: string | null;
  /** Room range exactly as written ("201-218"), if shown. */
  roomRange: string | null;
  /** Individual room numbers legible in this section. */
  rooms: string[];
  /** First name only of whoever is assigned this section, if written. */
  staffFirstName: string | null;
}

export interface BoardExtraction {
  sections: BoardSection[];
  /** Distinct floors visible anywhere on the board. */
  floors: string[];
}

const MAX_SECTIONS = 40;
const MAX_ROOMS_PER_SECTION = 60;
const MAX_FLOORS = 20;
const MAX_FIELD_CHARS = 60;

function cleanField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().slice(0, MAX_FIELD_CHARS);
  return trimmed === '' ? null : trimmed;
}

function cleanList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const s = cleanField(raw);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Runtime shape check + normalisation of an untrusted vision-model answer.
 *
 * Throws VisionSchemaError when the top level is not the requested shape.
 * Fields below that boundary are normalised and capped so one malformed value
 * does not discard an otherwise useful board and oversized output cannot be
 * echoed to the browser.
 */
export function normalizeBoardExtraction(raw: unknown): BoardExtraction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VisionSchemaError('expected an object at top level');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.sections !== undefined && !Array.isArray(obj.sections)) {
    throw new VisionSchemaError('"sections" must be an array when present');
  }
  const sections: BoardSection[] = (Array.isArray(obj.sections) ? obj.sections : [])
    .slice(0, MAX_SECTIONS)
    .map((s): BoardSection => {
      const row = (s && typeof s === 'object' && !Array.isArray(s) ? s : {}) as Record<string, unknown>;
      return {
        label: cleanField(row.label),
        floor: cleanField(row.floor),
        roomRange: cleanField(row.roomRange),
        rooms: cleanList(row.rooms, MAX_ROOMS_PER_SECTION),
        staffFirstName: cleanField(row.staffFirstName),
      };
    })
    .filter((s) => s.label || s.floor || s.roomRange || s.staffFirstName || s.rooms.length > 0);

  return { sections, floors: cleanList(obj.floors, MAX_FLOORS) };
}
