// ═══════════════════════════════════════════════════════════════════════════
// Legacy shim — `@/lib/firebase-admin` no longer exists as a real Firebase
// Admin SDK. The app moved off Firebase/Firestore onto Supabase (Postgres +
// Realtime + Auth) in April 2026. This file preserves two legacy imports so
// any un-migrated API route keeps compiling:
//
//   import admin from '@/lib/firebase-admin';
//   import { verifyFirebaseAuth } from '@/lib/firebase-admin';
//
// Both are aliased onto their Supabase equivalents in @/lib/supabase-admin.
//
//   admin              → supabaseAdmin (service-role client, bypasses RLS)
//   verifyFirebaseAuth → verifySupabaseAdmin (preflight read with the key)
//
// `admin.firestore().collection(...)` style calls will NOT work through
// this shim. If you find such a call, that's a page that still needs to be
// migrated — open the page and rewrite it to use supabaseAdmin.from(...).
//
// Prefer `import { supabaseAdmin, verifySupabaseAdmin } from '@/lib/supabase-admin'`
// in new code.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin, verifySupabaseAdmin } from './supabase-admin';

export const verifyFirebaseAuth = verifySupabaseAdmin;

export default supabaseAdmin;
