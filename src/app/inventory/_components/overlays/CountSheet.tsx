'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryCountBatch,
  addInventoryOrder,
  updateInventoryItem,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
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

type Entry = { value: string; autoFilled: boolean };

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
          data?: { currentMaeRatio: number | null };
        };
        const ratio = json.data?.currentMaeRatio;
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
      next[d.id] = { value: prefill, autoFilled: auto };
    }
    setEntries(next);
  }, [open, display, autoFillById, aiMode]);

  const setEntry = (id: string, val: string) =>
    setEntries((prev) => ({ ...prev, [id]: { value: val, autoFilled: false } }));

  if (!open) return null;

  const total = display.length;
  const filled = display.filter((d) => {
    const e = entries[d.id];
    return e && e.value !== '' && !Number.isNaN(Number(e.value));
  }).length;
  const auto = display.filter((d) => entries[d.id]?.autoFilled).length;
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
                    entry={entries[d.id] || { value: '', autoFilled: false }}
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
            value={entry.value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="—"
            style={{
              width: '100%',
              height: 42,
              padding: '0 14px',
              borderRadius: 10,
              boxSizing: 'border-box',
              background: entry.autoFilled ? T.purpleDim : T.bg,
              border: `1px solid ${entry.autoFilled ? `${T.purple}44` : T.rule}`,
              fontFamily: fonts.serif,
              fontSize: 20,
              fontStyle: 'italic',
              color: T.ink,
              letterSpacing: '-0.02em',
              outline: 'none',
            }}
          />
          {entry.autoFilled && (
            <span
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                fontFamily: fonts.mono,
                fontSize: 9,
                fontWeight: 600,
                color: T.purple,
                background: `${T.purple}22`,
                padding: '2px 6px',
                borderRadius: 4,
                letterSpacing: '0.08em',
              }}
            >
              AUTO
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

function todayStamp(): string {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
