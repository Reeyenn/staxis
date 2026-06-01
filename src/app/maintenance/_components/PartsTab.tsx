// Maintenance → Parts tab.
//
// A MIRRORED view of the maintenance-category inventory items (HVAC filters,
// light bulbs, etc.) shown right where engineers work. This is NOT a second
// copy of the data:
//
//   • Reads the SAME `inventory` table through the SAME anon-client read path
//     the Inventory page uses (subscribeToInventory), filtered to
//     category === 'maintenance'.
//   • Renders the SAME presentational pieces (ItemRow → StockBar / StatusPill)
//     and the SAME status/days transform (toDisplayItem) — so a part's stock,
//     status pill and "out in N days" are identical in both views.
//   • Edits go through the SAME write helpers (AddItemSheet → add/update/delete
//     InventoryItem). A count changed here shows on the Inventory page and
//     vice-versa.
//
// One source of truth, shown in two places. The Inventory page is unchanged —
// maintenance items still appear there alongside housekeeping + breakfast.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { subscribeToInventory } from '@/lib/db/inventory';
import {
  fetchOccupancyBundle,
  type OccupancyBundle,
} from '@/lib/inventory-estimate';
import {
  fetchDailyAverages,
  fetchMlPredictedRates,
  type DailyAverages,
} from '@/lib/inventory-predictions';
import type { InventoryItem } from '@/types';

import { T, FONT_SANS, FONT_SERIF } from './_mt-snow';
import { Btn, Caps } from '@/app/housekeeping/_components/_snow';

// Reused verbatim from the Inventory page — same rows, same look, same calc.
import { ItemRow } from '@/app/inventory/_components/ItemRow';
import { toDisplayItem } from '@/app/inventory/_components/adapter';
import type { DisplayItem } from '@/app/inventory/_components/types';
import { AddItemSheet } from '@/app/inventory/_components/overlays/AddItemSheet';

export function PartsTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  // The exact display inputs the Inventory page feeds toDisplayItem, so a
  // part's stock / status / days match across both views. All fail-soft: on a
  // fetch error the estimate falls back to the raw count, which still yields
  // the correct status pill.
  const [occupancy, setOccupancy] = useState<OccupancyBundle | null>(null);
  const [averages, setAverages] = useState<DailyAverages | null>(null);
  const [mlRateMap, setMlRateMap] = useState<Map<string, number>>(() => new Map());

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);

  // ── Live read — identical anon path to the Inventory page ───────────
  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoaded(false);
    const unsub = subscribeToInventory(user.uid, activePropertyId, (snap) => {
      setItems(snap);
      setLoaded(true);
    });
    return () => unsub();
  }, [user, activePropertyId]);

  // ── Occupancy / ML inputs (mirror Inventory exactly) ────────────────
  useEffect(() => {
    if (!activePropertyId) return;
    let cancelled = false;
    void (async () => {
      const since = new Date(Date.now() - 14 * 86_400_000);
      const [occ, avg, rates] = await Promise.all([
        fetchOccupancyBundle(activePropertyId, since).catch(() => null),
        fetchDailyAverages(activePropertyId, 14).catch(() => null),
        fetchMlPredictedRates(activePropertyId).catch(() => new Map<string, number>()),
      ]);
      if (cancelled) return;
      setOccupancy(occ);
      setAverages(avg);
      setMlRateMap(rates);
    })();
    return () => { cancelled = true; };
  }, [activePropertyId]);

  // ── Maintenance-only display items (same transform as Inventory) ────
  const parts: DisplayItem[] = useMemo(() => {
    const noneGraduated = new Set<string>();
    return items
      .filter((it) => it.category === 'maintenance')
      .map((it) =>
        toDisplayItem(it, {
          occupancy,
          dailyAverages: averages,
          mlRateMap,
          autoFillGraduated: noneGraduated,
        }),
      )
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [items, occupancy, averages, mlRateMap]);

  const openAdd = () => { setEditItem(null); setSheetOpen(true); };
  const openEdit = (d: DisplayItem) => { setEditItem(d.raw); setSheetOpen(true); };
  const closeSheet = () => { setSheetOpen(false); setEditItem(null); };

  const propertyName = activeProperty?.name ?? (es ? 'Mantenimiento' : 'Maintenance');

  return (
    <div
      style={{
        padding: '24px 48px 48px',
        background: T.bg,
        color: T.ink,
        fontFamily: FONT_SANS,
        minHeight: 'calc(100dvh - 130px)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 24,
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Caps>{es ? `Mantenimiento · ${propertyName}` : `Maintenance · ${propertyName}`}</Caps>
          <h1
            style={{
              fontFamily: FONT_SERIF,
              fontSize: 36,
              color: T.ink,
              margin: '4px 0 0',
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              fontWeight: 400,
            }}
          >
            <span style={{ fontStyle: 'italic' }}>{es ? 'Repuestos' : 'Parts'}</span>
          </h1>
          <p
            style={{
              fontFamily: FONT_SANS,
              fontSize: 12.5,
              color: T.ink2,
              margin: '6px 0 0',
              maxWidth: 460,
              lineHeight: 1.5,
            }}
          >
            {es
              ? 'Los mismos artículos de inventario de categoría mantenimiento — filtros, bombillas y más — aquí donde trabajas. Los cambios se reflejan también en Inventario.'
              : 'The same maintenance-category inventory items — filters, bulbs and more — right where you work. Changes show on the Inventory page too.'}
          </p>
        </div>
        <Btn variant="primary" size="md" onClick={openAdd}>
          {es ? '+ Añadir repuesto' : '+ Add part'}
        </Btn>
      </div>

      {/* Body */}
      {!loaded ? (
        <Spinner />
      ) : parts.length === 0 ? (
        <EmptyState es={es} onAdd={openAdd} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              marginBottom: 12,
              padding: '0 2px',
            }}
          >
            <span
              style={{
                fontFamily: FONT_SERIF,
                fontSize: 22,
                color: T.ink,
                fontStyle: 'italic',
                letterSpacing: '-0.02em',
              }}
            >
              {parts.length}{' '}
              {es
                ? parts.length === 1 ? 'repuesto' : 'repuestos'
                : parts.length === 1 ? 'part' : 'parts'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {parts.map((d) => (
              <ItemRow key={d.id} it={d} onClick={openEdit} />
            ))}
          </div>
        </>
      )}

      {/* Add / edit a part — the SAME overlay the Inventory page uses; a new
          part defaults to category 'maintenance' so it lands back in this view. */}
      <AddItemSheet
        open={sheetOpen}
        onClose={closeSheet}
        item={editItem}
        defaultCategory="maintenance"
      />
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 0' }}>
      <div
        className="animate-spin"
        style={{
          width: 26,
          height: 26,
          border: `2px solid ${T.rule}`,
          borderTopColor: T.ink,
          borderRadius: '50%',
        }}
      />
    </div>
  );
}

function EmptyState({ es, onAdd }: { es: boolean; onAdd: () => void }) {
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '56px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: T.ink2, fontStyle: 'italic' }}>
        {es ? 'Aún no hay repuestos de mantenimiento' : 'No maintenance parts yet'}
      </span>
      <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3, maxWidth: 360, lineHeight: 1.5 }}>
        {es
          ? 'Añade tu primer repuesto (filtros HVAC, bombillas…). Aparecerá aquí y en la página de Inventario.'
          : 'Add your first part (HVAC filters, light bulbs…). It’ll appear here and on the Inventory page.'}
      </span>
      <Btn variant="primary" size="md" onClick={onAdd}>
        {es ? '+ Añadir repuesto' : '+ Add part'}
      </Btn>
    </div>
  );
}
