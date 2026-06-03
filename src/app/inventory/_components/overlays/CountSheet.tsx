'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryCountBatch,
  addInventoryOrder,
  updateInventoryItem,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  buildNameToIdMap,
  mergePhotoCounts,
  type PhotoCount,
  type MergedFill,
} from '@/lib/photo-count-merge';
import type { InventoryItem, InventoryCount } from '@/types';
import type { AutoFillItem } from '@/lib/db/ml-inventory-cockpit';

import { T, fonts, statusColor, catLabel, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { ItemThumb } from '../ItemThumb';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import type { DisplayItem } from '../types';

interface CountSheetProps {
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
  autoFill: AutoFillItem[];
  aiMode: 'off' | 'auto' | 'always-on';
}

// A count entry and where its value came from. `manual` = typed by the user
// (or untouched); `ai` = prefilled from the ML prediction; `photo` = filled
// from a shelf photo (carries the model's confidence for visual flagging).
// Precedence on display: manual edit > photo > ai.
type FillSource = 'manual' | 'ai' | 'photo';
type Entry = { value: string; source: FillSource; confidence?: 'high' | 'medium' | 'low' };

export function CountSheet({ open, onClose, items, display, autoFill, aiMode }: CountSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saving, setSaving] = useState(false);
  const [mae, setMae] = useState<number | null>(null);

  const autoFillById = useMemo(() => {
    const m = new Map<string, AutoFillItem>();
    for (const f of autoFill) m.set(f.itemId, f);
    return m;
  }, [autoFill]);

  // Load MAE % for the header caption when the sheet opens.
  // Honesty-audit Phase 4: read currentMaeRatioVsMean (the real gate ratio)
  // — the "% off" caption only makes sense as gate ratio, not overfit. May
  // be null for ~7 days post-Phase-2 ship until next weekly retrain
  // populates hyperparameters.mean_observed_rate; we leave the caption
  // empty in that window rather than showing a misleading number.
  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/ai-status?propertyId=${activePropertyId}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: { currentMaeRatioVsMean: number | null };
        };
        const ratio = json.data?.currentMaeRatioVsMean;
        if (!cancelled && typeof ratio === 'number') setMae(ratio * 100);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  // Build defaults whenever opened. Auto-fill rule:
  //   off       → blank
  //   auto      → graduated items get predicted, else blank
  //   always-on → any prediction gets used
  useEffect(() => {
    if (!open) return;
    const next: Record<string, Entry> = {};
    for (const d of display) {
      const f = autoFillById.get(d.id);
      let prefill: string = '';
      let auto = false;
      if (f && aiMode !== 'off') {
        const shouldFill = aiMode === 'always-on' || f.graduated;
        if (shouldFill && Number.isFinite(f.predictedCurrentStock)) {
          prefill = String(Math.max(0, Math.round(f.predictedCurrentStock)));
          auto = true;
        }
      }
      next[d.id] = { value: prefill, source: auto ? 'ai' : 'manual' };
    }
    setEntries(next);
  }, [open, display, autoFillById, aiMode]);

  const setEntry = (id: string, val: string) =>
    setEntries((prev) => ({ ...prev, [id]: { value: val, source: 'manual' } }));

  // Apply shelf-photo counts onto the entries. Photo overrides an AI prefill on
  // the items it covers; items the photo didn't return are left untouched.
  const applyPhotoFills = (fills: MergedFill[]) =>
    setEntries((prev) => {
      const next: Record<string, Entry> = { ...prev };
      for (const f of fills) next[f.itemId] = { value: f.value, source: 'photo', confidence: f.confidence };
      return next;
    });

  if (!open) return null;

  const total = display.length;
  const filled = display.filter((d) => {
    const e = entries[d.id];
    return e && e.value !== '' && !Number.isNaN(Number(e.value));
  }).length;
  const auto = display.filter((d) => entries[d.id]?.source === 'ai').length;
  const pct = total > 0 ? Math.round((100 * filled) / total) : 0;

  const cats: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      const now = new Date();
      const rows: Array<Omit<InventoryCount, 'id'>> = [];
      const stockUps: Array<{ item: InventoryItem; delta: number }> = [];
      for (const d of display) {
        const e = entries[d.id];
        if (!e || e.value === '') continue;
        const n = Number(e.value);
        if (!Number.isFinite(n)) continue;
        const variance = Number.isFinite(d.estimated) ? n - d.estimated : undefined;
        rows.push({
          propertyId: activePropertyId,
          itemId: d.id,
          itemName: d.name,
          countedStock: n,
          estimatedStock: Number.isFinite(d.estimated) ? d.estimated : undefined,
          variance,
          varianceValue:
            variance !== undefined && d.unitCost > 0 ? variance * d.unitCost : undefined,
          unitCost: d.unitCost || undefined,
          countedAt: now,
          countedBy: user.displayName || user.username || 'team',
        });

        // If counted stock is HIGHER than what was on file, log a restock event.
        // (Means someone received stock between counts and forgot to log it.)
        const delta = n - d.counted;
        if (delta > 0) stockUps.push({ item: d.raw, delta });
      }

      if (rows.length === 0) {
        setSaving(false);
        return;
      }

      // 1. Batch count log.
      await addInventoryCountBatch(user.uid, activePropertyId, rows);

      // 2. Restock events for stock-ups.
      await Promise.all(
        stockUps.map(({ item, delta }) =>
          addInventoryOrder(user.uid, activePropertyId, {
            propertyId: activePropertyId,
            itemId: item.id,
            itemName: item.name,
            quantity: delta,
            unitCost: item.unitCost,
            totalCost: item.unitCost ? item.unitCost * delta : undefined,
            vendorName: item.vendorName,
            orderedAt: null,
            receivedAt: now,
            notes: 'Auto-logged from count (stock-up)',
          }),
        ),
      );

      // 3. Persist new currentStock on each item.
      await Promise.all(
        rows.map((r) =>
          updateInventoryItem(user.uid, activePropertyId, r.itemId, {
            currentStock: r.countedStock,
            lastCountedAt: now,
          }),
        ),
      );

      // 4. Fire-and-forget: ML post-count processing + SMS alerts.
      const itemIds = rows.map((r) => r.itemId);
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, itemIds }),
      }).catch(() => {});
      // Trigger SMS only for items that landed in critical territory.
      const criticalItemIds = display
        .filter((d) => {
          const counted = Number(entries[d.id]?.value);
          if (!Number.isFinite(counted) || d.par <= 0) return false;
          return counted / d.par < 0.5;
        })
        .map((d) => d.id);
      if (criticalItemIds.length > 0) {
        void fetchWithAuth('/api/inventory/check-alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: activePropertyId, criticalItemIds }),
        }).catch(() => {});
      }

      onClose();
    } catch (err) {
      console.error('[count-sheet] save failed', err);
      alert('Saving the count failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: T.bg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '18px 48px',
          borderBottom: `1px solid ${T.rule}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 24,
          flexWrap: 'wrap',
          background: T.paper,
        }}
      >
        <div>
          <Caps>Count mode</Caps>
          <h2
            style={{
              fontFamily: fonts.serif,
              fontSize: 26,
              color: T.ink,
              margin: '2px 0 0',
              letterSpacing: '-0.02em',
              fontWeight: 400,
              lineHeight: 1.1,
            }}
          >
            <span style={{ fontStyle: 'italic' }}>Walk & tally</span>
            <span style={{ color: T.ink3 }}> · {todayStamp()}</span>
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  color: T.ink2,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                }}
              >
                Progress
              </span>
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>
                {filled}/{total} · {pct}%
              </span>
            </div>
            <span
              style={{
                height: 6,
                borderRadius: 6,
                background: T.rule,
                overflow: 'hidden',
                display: 'block',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${pct}%`,
                  background: statusColor.good,
                  borderRadius: 6,
                  transition: 'width .25s',
                }}
              />
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: T.ink3,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              {auto} AI-prefilled{mae !== null ? ` · MAE ${mae.toFixed(1)}%` : ''}
            </span>
          </div>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || filled === 0}>
            {saving ? 'Saving…' : '✓ Save count'}
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '24px 48px 80px' }}>
        <PhotoCountPanel display={display} pid={activePropertyId} onFills={applyPhotoFills} />

        {auto > 0 && (
          <div
            style={{
              background: T.purpleDim,
              border: `1px solid ${T.purple}33`,
              borderRadius: 12,
              padding: '12px 16px',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 22,
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: T.purple,
                color: '#fff',
                fontFamily: fonts.mono,
                fontSize: 11,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              AI
            </span>
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: 13,
                color: T.ink2,
                flex: 1,
                lineHeight: 1.45,
              }}
            >
              The model has <b style={{ color: T.ink }}>graduated for {auto} items</b> — those start prefilled with the prediction. Tap the number to change it. The rest you&apos;ll enter yourself.
            </span>
          </div>
        )}

        {cats.map((cat) => {
          const catItems = display.filter((d) => d.cat === cat);
          if (catItems.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 30 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <CatIcon cat={cat} size={24} />
                <span
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 15,
                    color: T.ink,
                    fontWeight: 600,
                  }}
                >
                  {catLabel[cat]}
                </span>
                <span style={{ flex: 1, height: 1, background: T.rule }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {catItems.map((d) => (
                  <CountRow
                    key={d.id}
                    d={d}
                    entry={entries[d.id] || { value: '', source: 'manual' }}
                    onChange={(v) => setEntry(d.id, v)}
                    autoFill={autoFillById.get(d.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CountRow({
  d,
  entry,
  onChange,
  autoFill,
}: {
  d: DisplayItem;
  entry: Entry;
  onChange: (v: string) => void;
  autoFill?: AutoFillItem;
}) {
  const expected =
    autoFill && Number.isFinite(autoFill.predictedCurrentStock)
      ? Math.max(0, Math.round(autoFill.predictedCurrentStock))
      : null;
  const valNum = Number(entry.value);
  const variance =
    entry.value !== '' && Number.isFinite(valNum) && expected !== null
      ? valNum - expected
      : null;
  const fill = fillStyle(entry);
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '12px 18px',
        display: 'grid',
        gridTemplateColumns: '40px minmax(180px, 1.4fr) 130px 220px 80px',
        gap: 18,
        alignItems: 'center',
      }}
    >
      <ItemThumb thumb={d.thumb} cat={d.cat} size={36} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 600 }}>
          {d.name}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink3,
            letterSpacing: '0.04em',
          }}
        >
          par {d.par} · last {d.counted}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {expected !== null ? (
          <>
            <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
              Predicted <b style={{ color: T.ink }}>{expected}</b>
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: T.purple,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              AI · ±{(d.burn * 1.4).toFixed(1)}
            </span>
          </>
        ) : (
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, fontStyle: 'italic' }}>
            No prediction yet
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="number"
            min="0"
            inputMode="decimal"
            value={entry.value}
            // Reject anything that isn't empty or a non-negative decimal in progress.
            // Blocks "-5", "abc", "NaN", scientific notation at type-time so the
            // count we save can't be a negative or non-finite number.
            onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) onChange(v); }}
            placeholder="—"
            style={{
              width: '100%',
              height: 42,
              padding: '0 14px',
              borderRadius: 10,
              boxSizing: 'border-box',
              background: fill.bg,
              border: `1px solid ${fill.border}`,
              fontFamily: fonts.serif,
              fontSize: 20,
              fontStyle: 'italic',
              color: T.ink,
              letterSpacing: '-0.02em',
              outline: 'none',
            }}
          />
          {fill.badge && (
            <span
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                fontFamily: fonts.mono,
                fontSize: 9,
                fontWeight: 600,
                color: fill.badge.color,
                background: `${fill.badge.color}22`,
                padding: '2px 6px',
                borderRadius: 4,
                letterSpacing: '0.08em',
              }}
            >
              {fill.badge.text}
            </span>
          )}
        </div>
        {variance !== null && expected !== null && (
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              fontWeight: 600,
              color: Math.abs(variance) > expected * 0.05 ? statusColor.critical : T.ink2,
            }}
          >
            {variance > 0 ? '+' : ''}
            {variance}
          </span>
        )}
      </div>
      <Btn
        variant="ghost"
        size="sm"
        onClick={() => onChange('')}
        style={{ height: 30, fontSize: 11, padding: '0 10px' }}
      >
        Skip
      </Btn>
    </div>
  );
}

type FillVisual = { bg: string; border: string; badge: { text: string; color: string } | null };

// Maps an entry's source + confidence to its input styling + corner badge.
// AI = purple AUTO; photo = sage/caramel/warm by confidence, with low
// deliberately loud (warm + ⚠) so a shaky guess is never quietly trusted.
function fillStyle(entry: Entry): FillVisual {
  if (entry.source === 'ai') {
    return { bg: T.purpleDim, border: `${T.purple}44`, badge: { text: 'AUTO', color: T.purple } };
  }
  if (entry.source === 'photo') {
    if (entry.confidence === 'high') return { bg: T.sageDim, border: `${T.sageDeep}44`, badge: { text: 'PHOTO', color: T.sageDeep } };
    if (entry.confidence === 'medium') return { bg: `${T.caramel}14`, border: `${T.caramel}55`, badge: { text: 'PHOTO', color: T.caramelDeep } };
    return { bg: T.warmDim, border: `${T.warm}55`, badge: { text: 'PHOTO ⚠', color: T.warm } };
  }
  return { bg: T.bg, border: T.rule, badge: null };
}

function photoCountErrorFor(status: number, detail?: string): string {
  if (status === 422) return 'Too many items for one photo — scan one shelf or category at a time.';
  if (status === 400) return 'Couldn’t read that image. Try a clearer, well-lit photo.';
  if (status === 429) return 'Too many photo scans this hour — please try again shortly.';
  if (status === 503) return 'Photo counting is briefly unavailable — enter counts manually for now.';
  return detail || 'Couldn’t count that photo. Please try again.';
}

function PhotoCountPanel({
  display,
  pid,
  onFills,
}: {
  display: DisplayItem[];
  pid: string | null;
  onFills: (fills: MergedFill[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cats = useMemo(
    () => (['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).filter((c) => display.some((d) => d.cat === c)),
    [display],
  );
  const [scope, setScope] = useState<InvCat | 'all'>(cats[0] ?? 'all');
  const [status, setStatus] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [lowCount, setLowCount] = useState(0);

  const scoped = scope === 'all' ? display : display.filter((d) => d.cat === scope);

  const handleFile = async (file: File) => {
    if (!pid) return;
    if (scoped.length === 0) {
      setStatus('error');
      setMessage('No items in this group to count.');
      return;
    }
    setStatus('reading');
    setMessage('');
    setLowCount(0);
    try {
      // Scope the item list to the chosen category so we stay well within the
      // route's input budget and keep the Vision cost down (one shelf ≈ one category).
      const resized = await resizeImageForVision(file);
      const res = await fetchWithAuth('/api/inventory/photo-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, imageBase64: resized.base64, mediaType: resized.mediaType, itemNames: scoped.map((d) => d.name) }),
      });
      const json = (await res.json()) as { ok?: boolean; counts?: PhotoCount[]; error?: string; detail?: string };
      if (!res.ok || !json.ok) {
        setStatus('error');
        setMessage(photoCountErrorFor(res.status, json.detail || json.error));
        return;
      }
      const { filled, unmatched } = mergePhotoCounts(json.counts ?? [], buildNameToIdMap(scoped));
      onFills(filled);
      const low = filled.filter((f) => f.confidence === 'low').length;
      setLowCount(low);
      setStatus('done');
      setMessage(
        `Filled ${filled.length} of ${scoped.length} item${scoped.length === 1 ? '' : 's'}` +
          (unmatched.length > 0 ? ` · ${unmatched.length} not recognized` : '') +
          '. Review the numbers and Save.',
      );
    } catch (err) {
      console.error('[photo-count] failed', err);
      setStatus('error');
      setMessage('Couldn’t read that photo — try a clearer, well-lit shot.');
    }
  };

  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '12px 16px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        marginBottom: 22,
      }}
    >
      <span style={{ fontFamily: fonts.serif, fontSize: 17, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.02em' }}>
        Count by photo
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, flex: '1 1 200px', minWidth: 0 }}>
        Snap a shelf — we&apos;ll fill the counts for you to review. Nothing saves until you hit Save count.
      </span>
      {cats.length > 1 && (
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as InvCat | 'all')}
          style={{
            height: 34,
            padding: '0 10px',
            borderRadius: 8,
            background: T.bg,
            border: `1px solid ${T.rule}`,
            fontFamily: fonts.sans,
            fontSize: 13,
            color: T.ink,
            cursor: 'pointer',
          }}
        >
          <option value="all">All visible</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {catLabel[c]}
            </option>
          ))}
        </select>
      )}
      <Btn variant="ghost" size="md" onClick={() => fileRef.current?.click()} disabled={status === 'reading'}>
        {status === 'reading' ? 'Reading…' : '📷 Choose photo'}
      </Btn>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      {status !== 'idle' && message && (
        <div
          style={{
            flexBasis: '100%',
            fontFamily: fonts.sans,
            fontSize: 12.5,
            color: status === 'error' ? T.warm : lowCount > 0 ? T.caramelDeep : T.forestText,
          }}
        >
          {message}
          {lowCount > 0 && status === 'done' ? ` ${lowCount} low-confidence — please verify (flagged in red).` : ''}
        </div>
      )}
    </div>
  );
}

function todayStamp(): string {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
