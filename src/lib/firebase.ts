// ═══════════════════════════════════════════════════════════════════════════
// Legacy shim — `@/lib/firebase` no longer exists as a real Firebase client.
//
// The app moved off Firebase/Firestore onto Supabase (Postgres + Realtime +
// Auth) in April 2026. To avoid a scorched-earth rename of every page, this
// file stays put but now re-exports the Supabase browser client under the
// old names (`auth`, `db`). Any code that called real Firebase-only APIs
// (doc, getDoc, Timestamp, collectionGroup, onSnapshot, signInAnonymously,
// onAuthStateChanged, ...) has been rewritten in the page file itself —
// those imports come from `@/lib/firestore` (our data-access layer) or
// directly from `@/lib/supabase`.
//
// Why keep the file at all?
//   1. Grep-friendliness: any stray `import { auth } from '@/lib/firebase'`
//      in an un-migrated tree won't crash the build at import time.
//   2. Tests & dev tooling sometimes deep-import this path.
//   3. The rename would touch ~30 files and add zero runtime value — the
//      shim is cheaper and auditable (this file) in one place.
//
// Prefer `import { supabase } from '@/lib/supabase'` in new code.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase';

export const auth = supabase.auth;
export const db = supabase;

export default supabase;
