// ═══════════════════════════════════════════════════════════════════════════
// Knowledge chunking — split a document's text into overlapping passages.
//
// Why chunk: embedding a whole 50-page manual into ONE vector blurs every
// topic together, and returning a 100 KB blob to the assistant blows the tool
// size cap. Chunking lets vector search return the EXACT relevant paragraph
// with a section ref, and keeps each tool result small.
//
// Pure + deterministic (no I/O, no env) so it unit-tests trivially and the
// same passage boundaries reproduce on re-index.
// ═══════════════════════════════════════════════════════════════════════════

export interface TextChunk {
  /** 0-based position of this chunk within the document. */
  index: number;
  /** The passage text (trimmed). */
  content: string;
  /** Best-guess section/heading this passage sits under, or null. */
  section: string | null;
  /** Character length of `content` (denormalized for the DB row). */
  charCount: number;
}

export interface ChunkOptions {
  /** Soft target size per chunk, in characters. */
  targetChars?: number;
  /** Overlap carried from the end of one chunk into the next (context glue). */
  overlapChars?: number;
  /** Hard ceiling on chunk count (cost/scale guard). Extra text is dropped
   *  and the caller can mark the doc `partial`. */
  maxChunks?: number;
}

/** Default hard ceiling on chunk count (cost/scale guard). Exported so the
 *  indexer can mark a doc `partial` when its text would exceed the cap rather
 *  than silently dropping the tail behind a green "ready" badge. */
export const DEFAULT_MAX_CHUNKS = 400;
const DEFAULTS = { targetChars: 1000, overlapChars: 150, maxChunks: DEFAULT_MAX_CHUNKS } as const;

/** Detect a heading line so chunks can carry a section ref.
 *  Conservative on purpose — over-detecting headings mislabels passages. */
function headingOf(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  // Markdown ATX heading: "# Title", "### Sub".
  const md = t.match(/^#{1,6}\s+(.{1,80})$/);
  if (md) return md[1].trim().replace(/[#\s]+$/, '');
  // Short, punctuation-free line that is ALL CAPS or Title-ends-with-colon.
  if (t.length <= 60 && !/[.?!]$/.test(t)) {
    const letters = t.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 3) {
      const isUpper = t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(t);
      const endsColon = /:$/.test(t);
      if (isUpper || endsColon) return t.replace(/:$/, '').trim();
    }
  }
  return null;
}

/** Split a too-long block on sentence boundaries, falling back to words, so a
 *  single giant paragraph never produces a chunk far over target. */
function splitLongBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars) return [block];
  const out: string[] = [];
  // Sentence-ish boundaries (keep the delimiter). Works for EN + ES.
  const sentences = block.match(/[^.!?¿¡\n]+[.!?]*\s*/g) ?? [block];
  let buf = '';
  for (const s of sentences) {
    if (buf && (buf.length + s.length) > targetChars) {
      out.push(buf.trim());
      buf = '';
    }
    if (s.length > targetChars) {
      // A single monster "sentence" (e.g. a CSV row, a base64 dump) — hard
      // split on whitespace/word boundaries.
      const words = s.split(/(\s+)/);
      for (const w of words) {
        if (buf.length + w.length > targetChars && buf.trim()) {
          out.push(buf.trim());
          buf = '';
        }
        buf += w;
      }
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/**
 * Split text into overlapping, section-tagged passages.
 *
 * Strategy: paragraph-aware accumulation. Blocks (paragraphs) are packed into
 * a chunk until the next would exceed `targetChars`; the next chunk seeds with
 * the trailing `overlapChars` of the previous one so a fact split across a
 * boundary is still retrievable from both sides. Headings update the active
 * section label carried onto subsequent chunks.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const targetChars = opts.targetChars ?? DEFAULTS.targetChars;
  const overlapChars = opts.overlapChars ?? DEFAULTS.overlapChars;
  const maxChunks = opts.maxChunks ?? DEFAULTS.maxChunks;

  // Normalize CRLF and non-breaking spaces (U+00A0, common in pasted/Word
  // text) to plain newlines/spaces. NBSP built via fromCharCode to dodge a
  // literal-unicode-in-source hazard.
  const NBSP = String.fromCharCode(0x00a0);
  const normalized = text.replace(/\r\n?/g, '\n').split(NBSP).join(' ');
  // Paragraph blocks (blank-line separated). Single newlines stay inside a block.
  const rawBlocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  const chunks: TextChunk[] = [];
  let buf = '';
  let bufSection: string | null = null;
  let currentSection: string | null = null;

  const flush = () => {
    const content = buf.trim();
    if (!content) { buf = ''; return; }
    chunks.push({ index: chunks.length, content, section: bufSection, charCount: content.length });
    // Seed the next buffer with an overlap tail for cross-boundary context.
    buf = overlapChars > 0 ? content.slice(-overlapChars) : '';
    bufSection = currentSection;
  };

  for (const block of rawBlocks) {
    if (chunks.length >= maxChunks) break;

    // A heading-only block updates the active section and is also kept inline
    // so the heading text is itself searchable.
    const maybeHeading = block.includes('\n') ? null : headingOf(block);
    if (maybeHeading) {
      currentSection = maybeHeading;
      if (!bufSection) bufSection = currentSection;
    }

    const pieces = splitLongBlock(block, targetChars);
    for (const piece of pieces) {
      if (chunks.length >= maxChunks) break;
      if (!bufSection) bufSection = currentSection;
      // If adding this piece would overflow and we already have real content,
      // flush first so chunks stay near target size.
      if (buf.trim() && (buf.length + piece.length + 2) > targetChars) {
        flush();
      }
      buf += (buf && !buf.endsWith('\n') ? '\n\n' : '') + piece;
    }
  }
  if (chunks.length < maxChunks) flush();

  return chunks;
}
