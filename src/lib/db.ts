// ═══════════════════════════════════════════════════════════════════════════
// Data access layer — Supabase/Postgres.
//
// This file is a re-export shim. All real implementation lives in
// src/lib/db/<domain>.ts modules. Callers continue to write
// `import { ... } from '@/lib/db'` exactly as before — nothing about the
// public function surface changes.
//
// History: this file was a 1588-line monolith from 2026-04-22 (the
// Firebase → Supabase rename of firestore.ts) through 2026-04-28, when it
// was split into 22 domain modules + this shim. See the founder audit
// notes in Second Brain/02 Projects/HotelOps AI/ for context.
//
// Where to add new code:
//   - New function in an existing domain → edit the matching db/<domain>.ts
//   - Brand-new domain (e.g., booking_events) → create db/<domain>.ts and
//     add a `export * from './db/<domain>';` line below.
//
// All `to*Row`/`from*Row` mappers continue to live in src/lib/db-mappers.ts
// and are imported by the domain modules directly. Don't add mappers here.
//
// The `uid` first arg on many functions is a legacy parameter from the old
// Firestore era, accepted for backward compatibility and ignored, because
// scoping is now by `property_id` plus RLS (authenticated user's JWT
// identifies them; service-role key bypasses RLS for scraper/cron/admin).
// ═══════════════════════════════════════════════════════════════════════════

export * from './db/properties';
export * from './db/staff';
export * from './db/public-areas';
export * from './db/laundry';
export * from './db/daily-logs';
export * from './db/rooms';
export * from './db/work-orders';
export * from './db/equipment';
export * from './db/preventive';
export * from './db/landscaping';
export * from './db/inventory';
export * from './db/inventory-counts';
export * from './db/inventory-orders';
export * from './db/ml-stubs';
export * from './db/inspections';
export * from './db/handoff-logs';
export * from './db/guest-requests';
export * from './db/plan-snapshots';
export * from './db/dashboard';
export * from './db/schedule-assignments';
export * from './db/shift-confirmations';
export * from './db/manager-notifications';
export * from './db/deep-cleaning';
export * from './db/housekeeper-helpers';
export * from './db/cleaning-events';
