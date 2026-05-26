# Portfolio layer — plug-in guide for new modules

This directory hosts the **portfolio foundation**: the contract every backend module (housekeeping, maintenance, inventory, staff, labor) plugs into to surface its per-property KPIs on the cross-property `/portfolio` page.

The page itself owns the grid layout, the property switcher, the summary banner, and the anomaly indicators. **Modules don't reimplement any of that.** They ship one adapter + one tile-body React component, and the rest is shared.

---

## Architecture at a glance

```
┌─ /portfolio page ──────────────────────────────────────────────────┐
│  PortfolioContext  ── knows accessible properties + current view   │
│  PortfolioSummaryBanner ── totals + anomaly count                  │
│  PropertyTile (× N)     ── one card per property                   │
│    ↳ <HousekeepingTileBody data={hkData} />  ← per-module body     │
│    ↳ <MaintenanceTileBody  data={mxData} />  ← future module       │
│  AnomalyList            ── plain-English deviation list            │
└────────────────────────────────────────────────────────────────────┘
                                ↓ data via /api/portfolio/*
┌─ src/lib/portfolio/ ───────────────────────────────────────────────┐
│  types.ts             ← shared contract                            │
│  registry.ts          ← adapter registry (singleton map)           │
│  aggregator.ts        ← portfolio-wide averages + totals           │
│  anomaly-detector.ts  ← % deviation flagging                       │
│  adapters/                                                         │
│    housekeeping-tile.ts   ← first adapter (server-side fetcher)    │
│    {your-module}-tile.ts  ← yours goes here                        │
└────────────────────────────────────────────────────────────────────┘
```

---

## Adding a new module — checklist

When you ship a new backend module (e.g., maintenance), follow these
five steps. Total work: ~150 lines of TypeScript + ~80 lines of JSX.

### 1. Extend the discriminated union in `types.ts`

Add your per-property payload interface, then widen `PortfolioTileData`:

```ts
export interface MaintenanceTileData {
  propertyId: string;
  property: Pick<Property, 'id' | 'name' | 'totalRooms'>;
  openTickets: number;
  pmCompletionRate: number | null;
  // ... whatever KPIs your module surfaces
  accuracyLabel: AccuracyLabel;
}

export type PortfolioTileData =
  | ({ module: 'housekeeping' } & HousekeepingTileData)
  | ({ module: 'maintenance'  } & MaintenanceTileData);   // ← new
```

### 2. Add your moduleId to `PortfolioModuleId`

Already done if the id is one of `housekeeping | maintenance | inventory | staff | labor`. If you're introducing a brand-new module category, widen the union here.

### 3. Write the server-side adapter at `adapters/{module}-tile.ts`

Pattern:

```ts
import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerAdapter } from '../registry';
import type {
  PortfolioTileAdapter,
  MaintenanceTileData,
} from '../types';

async function fetchMaintenanceTileData(propertyId: string): Promise<MaintenanceTileData> {
  // ... read from your module's tables under supabaseAdmin ...
  return { ... };
}

export const maintenanceTileAdapter: PortfolioTileAdapter<
  { module: 'maintenance' } & MaintenanceTileData
> = {
  moduleId: 'maintenance',
  moduleLabel: { en: 'Maintenance', es: 'Mantenimiento' },
  fetchTileData: async (propertyId) => ({
    module: 'maintenance',
    ...(await fetchMaintenanceTileData(propertyId)),
  }),
  anomalyFlag: (_data, _avg) => null,   // or return module-specific anomalies
};

registerAdapter(maintenanceTileAdapter);
```

**Adapter contract rules:**

- `fetchTileData` runs **server-side** under supabaseAdmin. No RLS, no
  client auth — the API route batches cross-property reads.
- `fetchTileData` **never throws**. On partial failure, return a
  degraded payload with `accuracyLabel: 'capacity_unavailable'` so the
  page can still render the property tile.
- `anomalyFlag` is a **pure function**. Return `null` to defer to the
  generic detector. Return an array to ADD module-specific anomalies.
- Numeric fields use `null` (not `0` or `-1`) to signal "no data". The
  aggregator treats nulls as "exclude from average"; the tile UI
  renders `—` so nulls aren't confused with real zeros.

### 4. Auto-register at module load by adding the import to `index.ts`

```ts
// src/lib/portfolio/index.ts
import './adapters/housekeeping-tile';
import './adapters/maintenance-tile';   // ← new
```

### 5. Add a tile-body component + switch case in `PropertyTile.tsx`

```tsx
// src/app/portfolio/_components/PropertyTile.tsx
function PropertyTileBody({ data }: { data: PortfolioTileData }) {
  switch (data.module) {
    case 'housekeeping': return <HousekeepingTileBody data={data} />;
    case 'maintenance':  return <MaintenanceTileBody  data={data} />;   // ← new
  }
}
```

The tile **frame** (header with property name, accuracy label chip,
click-to-switch handler, anomaly border) is shared across modules. Your
body just describes the KPI rows.

### 6. Wire your module into the API route

Add your moduleId to the batched fetcher at
`/api/portfolio/housekeeping-tiles` (rename → `/api/portfolio/tiles`
when more than one module ships) so the page can fetch your data
alongside housekeeping in a single round-trip.

---

## Existing pieces — quick reference

### `types.ts`
- `PortfolioTileAdapter` — adapter interface
- `PortfolioTileData` — discriminated tile-data union
- `HousekeepingTileData` — first module's payload
- `AccuracyLabel` — three-state confidence label
- `PortfolioAnomaly` — anomaly record
- `PortfolioModuleAverages` — per-module average baseline
- `PortfolioSummary` — banner totals

### `registry.ts`
- `registerAdapter(adapter)` — idempotent; throws on duplicate-id collision
- `getAdapter(moduleId)` — single lookup
- `listAdapters()` — all registered, in registration order
- `__resetRegistryForTests()` — test hook only

### `aggregator.ts`
- `computeModuleAverages(tiles)` — per-module averages (nulls ignored)
- `computeSummary(tiles, anomalyCount)` — banner totals (nulls = 0)

### `anomaly-detector.ts`
- `ANOMALY_THRESHOLD_PCT` — 15% (yellow flag)
- `SEVERE_THRESHOLD_PCT` — 30% (red flag)
- `detectAnomalies(tiles, averages)` — generic entry point
- `detectHousekeepingAnomalies(tile, avg)` — module-specific impl

---

## Cross-property authorization

Every API route under `/api/portfolio/*`:

1. Calls `requireSession(req)` to get the logged-in user.
2. For each `propertyId` in scope, calls `userHasPropertyAccess(userId, pid)`.
3. Filters out any property the caller doesn't own before fanning out to adapters.

This means a logged-in user with access to Hotel A and Hotel B never
sees data for Hotel C even if they manually pass `Hotel C's id` in the
request. The check happens **per property, per request** — there's no
"trust the URL" shortcut.

---

## Greenfield notes (as of 2026-05-26)

- The `accounts.property_access uuid[]` array already supports multi-
  property. **No new join table.** Migration count stays where it is.
- Cost-tracking columns (`staff.hourly_wage_cents`,
  `properties.daily_labor_budget_cents`) are on a separate branch and
  not yet merged. The housekeeping adapter reads the legacy
  `staff.hourly_wage` (numeric dollars) and `properties.weekly_budget`
  (numeric dollars / 7 = daily fallback) until cost-tracking lands;
  swap the read paths in `housekeeping-tile.ts` when it does.
- The portfolio nav link is gated on `properties.length >= 2` — single-
  property users see no clutter. Post-login routing sends 2+-property
  users to `/portfolio`, single-property users to `/dashboard`.
