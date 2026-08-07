'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Import a file — pick, review, confirm. Three states, one screen.
//
// THE ONE RULE THIS SCREEN ENFORCES VISUALLY
// The manager must know, before they tap Save, whether these numbers are about
// to become their shelf or their history. That sentence is the first thing on
// the review step, full width, above the list, and it is recomputed from the
// date field on every keystroke by the SAME pure function the server commits
// with. Two copies of a rule drift; one function called from both ends cannot.
//
// The browser still gets no vote on the outcome: the server recomputes the
// mode at commit time and refuses a plan that would write stock from an old
// sheet. What this screen owns is the promise, not the decision.
//
// Nothing on the read step saves anything. The only write in this file is the
// Save button on the review step.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Overlay } from './Overlay';
import { Btn } from '../Btn';
import { T, fonts } from '../tokens';
import { t, type Lang } from '../inv-i18n';
import { readEnvelope } from '@/lib/api-envelope';
import { fetchWithAuth } from '@/lib/api-fetch';
import { formatCents } from '@/lib/inventory-import/money';
import { decideAsOfMode, modeSentenceFor } from '@/lib/inventory-import/draft';
import type { ImportDraft, DraftLine } from '@/lib/inventory-import/draft';
import type { NormalizedOccupancyMonth } from '@/lib/inventory-import/occupancy';

type ImportKind = 'inventory' | 'occupancy';

interface InventoryReadResult {
  kind: 'inventory';
  sourceName: string;
  sourceKind: string;
  asOfDateDetected: string | null;
  asOfEvidence: string | null;
  draft: ImportDraft;
  customCategories: Array<{ id: string; name: string }>;
  /** Today at the HOTEL. The mode sentence is recomputed against this every
   *  time the date field changes, so it can never describe a date the manager
   *  has already replaced. */
  todayLocal: string;
  truncated: boolean;
}

interface OccupancyReadResult {
  kind: 'occupancy';
  sourceName: string;
  sourceKind: string;
  layout: string | null;
  months: NormalizedOccupancyMonth[];
  monthRange: string;
  issues: Array<{ input: string; reason: string }>;
  skipped: Array<{ rowIndex: number; reason: string; text: string }>;
  skippedSentence: string;
  truncated: boolean;
}

type ReadResult = InventoryReadResult | OccupancyReadResult;

interface ImportSheetProps {
  open: boolean;
  onClose: () => void;
  pid: string;
  lang: Lang;
  /** Called after a successful save so the page reloads its rows. */
  onImported: () => void;
}

const ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.txt,.md,.pdf,.jpg,.jpeg,.png,.webp,.gif,.docx';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export default function ImportSheet({ open, onClose, pid, lang, onImported }: ImportSheetProps) {
  const tx = t(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<ImportKind>('inventory');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  // Lines the manager took off the list. Kept rather than forgotten so the
  // saved batch records that they were dropped ON PURPOSE, which is a different
  // fact from a row we never read.
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [asOfDate, setAsOfDate] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const requestIdRef = useRef<string>('');

  const reset = useCallback(() => {
    setResult(null); setLines([]); setRemovedKeys(new Set()); setError(null); setPasted(''); setSaved(null);
    requestIdRef.current = '';
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const closeAll = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const runRead = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const res = await fetchWithAuth('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, action: 'read', kind, ...payload }),
      });
      const env = await readEnvelope<ReadResult>(res);
      if (env.error !== undefined) { setError(env.error); return; }
      const data = env.data;
      setResult(data);
      setRemovedKeys(new Set());
      if (data.kind === 'inventory') {
        setLines(data.draft.lines);
        setAsOfDate(data.draft.asOfDate);
      }
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [pid, kind]);

  const onPickFile = useCallback(async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 4 MB. Save it as a CSV, or split it, and try again.');
      return;
    }
    const base64 = await fileToBase64(file);
    await runRead({ fileName: file.name, mimeType: file.type || null, fileBase64: base64 });
  }, [runRead]);


  const commit = useCallback(async () => {
    if (!result) return;
    setBusy(true); setError(null);
    if (!requestIdRef.current) {
      requestIdRef.current = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      const body: Record<string, unknown> = {
        pid,
        action: 'commit',
        kind: result.kind,
        sourceName: result.sourceName,
        sourceKind: result.sourceKind,
        requestId: requestIdRef.current,
      };
      if (result.kind === 'inventory') {
        body.asOfDate = asOfDate;
        body.skippedSummary = result.draft.skippedSentence;
        body.skipped = result.draft.skipped;
        body.lines = lines.map((l) => ({
          key: l.key, rowIndex: l.rowIndex, name: l.name, unit: l.unit,
          category: l.category, customCategoryId: l.customCategoryId,
          unitCostCents: l.unitCostCents, vendorName: l.vendorName,
          quantity: l.quantity, parLevel: l.parLevel, asOfDate: l.asOfDate,
          historyPoints: l.historyPoints,
          decision: removedKeys.has(l.key)
            ? 'skip'
            : (l.action === 'merge' ? 'merge' : l.action),
          mergeItemId: l.merge?.itemId ?? null,
        }));
      } else {
        body.skippedSummary = result.skippedSentence;
        body.months = result.months.map((m) => ({
          month: m.monthStart,
          occupancy_pct: m.occupancyPct,
          rooms_sold: m.roomsSoldMonth,
          rooms_available: m.roomsAvailableMonth,
        }));
      }
      const res = await fetchWithAuth('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const env = await readEnvelope<{ batch: { itemCount: number } | null }>(res);
      if (env.error !== undefined) { setError(env.error); return; }
      setSaved(result.kind === 'inventory'
        ? `Saved ${env.data.batch?.itemCount ?? 0} items.`
        : `Saved ${result.months.length} months of occupancy.`);
      onImported();
    } catch {
      setError('We could not save that import. Try again.');
    } finally {
      setBusy(false);
    }
  }, [pid, result, lines, removedKeys, asOfDate, onImported]);

  const dropLine = useCallback((key: string) => {
    setRemovedKeys((prev) => new Set(prev).add(key));
  }, []);

  const header = useMemo(() => (result ? tx.importReview : tx.importTitle), [result, tx]);

  return (
    <Overlay
      open={open}
      onClose={closeAll}
      width={860}
      eyebrow="Inventory"
      title={header}
      hasUnsavedChanges={Boolean(result) && !saved}
      footer={result && !saved ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="md" onClick={reset}>{tx.importCancel}</Btn>
          <Btn variant="primary" size="md" onClick={commit} disabled={busy}>
            {busy ? 'Saving' : tx.importConfirm}
          </Btn>
        </div>
      ) : null}
    >
      {error ? (
        <p style={{ ...bodyStyle, color: T.terra, marginBottom: 12 }} role="alert">{error}</p>
      ) : null}

      {saved ? (
        <div>
          <p style={bodyStyle}>{saved}</p>
          <div style={{ marginTop: 16 }}>
            <Btn variant="ghost" size="md" onClick={closeAll}>Done</Btn>
          </div>
        </div>
      ) : !result ? (
        <div>
          <p style={{ ...bodyStyle, marginBottom: 16 }}>{tx.importIntro}</p>

          <div role="group" aria-label="What are you importing" style={{ display: 'inline-flex', border: `1px solid ${T.rule}`, borderRadius: 999, padding: 3, marginBottom: 16 }}>
            {(['inventory', 'occupancy'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                style={{
                  padding: '7px 13px', cursor: 'pointer', border: 'none', borderRadius: 999,
                  background: kind === k ? T.ink : 'transparent',
                  color: kind === k ? T.bg : T.ink2,
                  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: kind === k ? 600 : 500,
                }}
              >
                {k === 'inventory' ? tx.importKindInventory : tx.importKindOccupancy}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            />
            <Btn variant="primary" size="md" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? tx.importReading : tx.importPickFile}
            </Btn>
          </div>

          <label style={{ ...labelStyle, display: 'block', marginBottom: 6 }}>{tx.importPasteLabel}</label>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={6}
            style={{
              width: '100%', padding: 12, borderRadius: 12, border: `1px solid ${T.rule}`,
              fontFamily: fonts.sans, fontSize: 13, color: T.ink, resize: 'vertical',
            }}
          />
          <div style={{ marginTop: 8 }}>
            <Btn
              variant="ghost"
              size="md"
              onClick={() => void runRead({ text: pasted })}
              disabled={busy || pasted.trim().length === 0}
            >
              {busy ? tx.importReading : 'Read this'}
            </Btn>
          </div>

          <PastImports pid={pid} open={open} tx={tx} onChanged={onImported} />
        </div>
      ) : result.kind === 'inventory' ? (
        <InventoryReview
          result={result}
          lines={lines.filter((l) => !removedKeys.has(l.key))}
          asOfDate={asOfDate}
          onAsOfDate={setAsOfDate}
          onDrop={dropLine}
          tx={tx}
        />
      ) : (
        <OccupancyReview result={result} />
      )}
    </Overlay>
  );
}

// ─── Past imports, and the one button that takes one back out ──────────────

interface BatchRow {
  id: string;
  kind: 'inventory' | 'occupancy';
  sourceName: string;
  asOfDate: string;
  importedAt: string;
  itemCount: number;
  undoneAt: string | null;
}

function PastImports({
  pid, open, tx, onChanged,
}: {
  pid: string;
  open: boolean;
  tx: ReturnType<typeof t>;
  onChanged: () => void;
}) {
  const [batches, setBatches] = useState<BatchRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/inventory/import?pid=${encodeURIComponent(pid)}`, { cache: 'no-store' });
      const env = await readEnvelope<{ batches: BatchRow[] }>(res);
      if (env.error !== undefined) { setBatches([]); return; }
      setBatches(env.data.batches);
    } catch {
      setBatches([]);
    }
  }, [pid]);

  React.useEffect(() => { if (open) void load(); }, [open, load]);

  const remove = useCallback(async (batchId: string) => {
    setBusyId(batchId); setError(null);
    try {
      const res = await fetchWithAuth('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, action: 'undo', batchId }),
      });
      const env = await readEnvelope<unknown>(res);
      if (env.error !== undefined) { setError(env.error); return; }
      await load();
      onChanged();
    } catch {
      setError('We could not remove that import. Try again.');
    } finally {
      setBusyId(null);
    }
  }, [pid, load, onChanged]);

  if (!batches || batches.length === 0) return null;

  return (
    <div style={{ marginTop: 24, borderTop: `1px solid ${T.rule}`, paddingTop: 16 }}>
      <p style={{ ...labelStyle, marginBottom: 8 }}>{tx.importHistoryTitle}</p>
      {error ? <p style={{ ...subtleStyle, color: T.terra, marginBottom: 8 }}>{error}</p> : null}
      {batches.map((b) => (
        <div
          key={b.id}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '8px 0', borderBottom: `1px solid ${T.rule}`,
          }}
        >
          <div>
            <p style={{ ...bodyStyle, margin: 0 }}>{b.sourceName}</p>
            <p style={{ ...subtleStyle, margin: 0 }}>
              {b.kind === 'occupancy' ? 'Occupancy' : 'Inventory'} as of {b.asOfDate}
              {b.undoneAt ? ' (removed)' : ` · ${b.itemCount} items`}
            </p>
          </div>
          {b.undoneAt ? null : (
            <button
              type="button"
              onClick={() => void remove(b.id)}
              disabled={busyId === b.id}
              style={{
                border: `1px solid ${T.rule}`, borderRadius: 999, padding: '6px 12px',
                background: 'transparent', color: T.ink2, cursor: 'pointer',
                fontFamily: fonts.sans, fontSize: 12.5,
              }}
            >
              {busyId === b.id ? 'Removing' : tx.importRemove}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Review: inventory ─────────────────────────────────────────────────────

function InventoryReview({
  result, lines, asOfDate, onAsOfDate, onDrop, tx,
}: {
  result: InventoryReadResult;
  lines: DraftLine[];
  asOfDate: string;
  onAsOfDate: (d: string) => void;
  onDrop: (key: string) => void;
  tx: ReturnType<typeof t>;
}) {
  const { draft } = result;
  // Recomputed from the date field, never read off the draft: the manager can
  // change the date after the read, and a sentence that still described the
  // old one would be the exact lie this feature is built to avoid.
  const mode = decideAsOfMode(asOfDate, result.todayLocal);
  const modeSentence = modeSentenceFor(mode, asOfDate, result.todayLocal);
  const historyOnly = mode === 'history_only';
  return (
    <div>
      <p
        data-testid="import-mode-sentence"
        style={{
          ...bodyStyle,
          padding: '10px 14px',
          borderRadius: 12,
          background: historyOnly ? 'rgba(201,150,68,0.10)' : 'rgba(62,92,72,0.08)',
          border: `1px solid ${historyOnly ? 'rgba(201,150,68,0.35)' : 'rgba(62,92,72,0.25)'}`,
          marginBottom: 14,
        }}
      >
        {modeSentence}
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={labelStyle} htmlFor="import-as-of">{tx.importAsOfLabel}</label>
        <input
          id="import-as-of"
          type="date"
          value={asOfDate}
          onChange={(e) => onAsOfDate(e.target.value)}
          style={{
            height: 34, padding: '0 10px', borderRadius: 999,
            border: `1px solid ${T.rule}`, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
          }}
        />
        {result.asOfEvidence ? (
          <span style={{ ...subtleStyle }}>Read from: {result.asOfEvidence}</span>
        ) : (
          <span style={{ ...subtleStyle }}>We could not find a date on this sheet.</span>
        )}
      </div>

      {draft.skippedSentence ? (
        <p data-testid="import-skipped-sentence" style={{ ...subtleStyle, marginBottom: 12 }}>
          {draft.skippedSentence}
        </p>
      ) : null}

      {draft.unitConflicts.length > 0 ? (
        <div data-testid="import-unit-conflicts" style={{ marginBottom: 14 }}>
          {draft.unitConflicts.map((c) => (
            <p key={c.itemKey} style={{ ...subtleStyle, color: T.terra }}>
              {c.itemName}: {c.message}
            </p>
          ))}
        </div>
      ) : null}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fonts.sans, fontSize: 13 }}>
          <thead>
            <tr>
              {['Item', 'Unit', 'Price', 'Count', 'What happens', ''].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td style={tdStyle}>{l.name}</td>
                <td style={tdStyle}>{l.unit}</td>
                <td style={tdStyle}>{l.unitCostCents === null ? '' : formatCents(l.unitCostCents)}</td>
                <td style={tdStyle}>{l.quantity === null ? '' : l.quantity}</td>
                <td style={tdStyle}>
                  {l.action === 'merge' && l.merge
                    ? `${tx.importMerge} ${l.merge.itemName}`
                    : tx.importCreate}
                  {historyOnly && l.quantity !== null ? ' (history only)' : ''}
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => onDrop(l.key)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      color: T.ink2, fontFamily: fonts.sans, fontSize: 12.5,
                    }}
                  >
                    {tx.importSkip}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Review: occupancy ─────────────────────────────────────────────────────

function OccupancyReview({ result }: { result: OccupancyReadResult }) {
  return (
    <div>
      <p style={{ ...bodyStyle, marginBottom: 14 }}>
        {result.months.length === 0
          ? 'We could not find any months in that file.'
          : `Found ${result.months.length} months: ${result.monthRange}. These go into your history so the AI can learn how fast you use things.`}
      </p>
      {result.skippedSentence ? (
        <p style={{ ...subtleStyle, marginBottom: 12 }}>{result.skippedSentence}</p>
      ) : null}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fonts.sans, fontSize: 13 }}>
          <thead>
            <tr>
              {['Month', 'Occupancy', 'Rooms sold'].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.months.map((m) => (
              <tr key={m.monthStart}>
                <td style={tdStyle}>{m.monthStart.slice(0, 7)}</td>
                <td style={tdStyle}>{m.occupancyPct === null ? '' : `${m.occupancyPct}%`}</td>
                <td style={tdStyle}>{m.roomsSoldMonth ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Shared styles ─────────────────────────────────────────────────────────

const bodyStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.55, color: T.ink,
};
const subtleStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 1.5, color: T.ink2,
};
const labelStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: T.ink2,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${T.rule}`,
  fontSize: 11.5, fontWeight: 600, color: T.ink2, whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = {
  padding: '8px 10px', borderBottom: `1px solid ${T.rule}`, color: T.ink, verticalAlign: 'top',
};
