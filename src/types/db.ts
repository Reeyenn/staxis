// Convenience aliases for the supabase-generated `Database` shape.
//
// Use `Tables<'rooms'>` instead of inline `Database['public']['Tables']['rooms']['Row']`,
// and `Inserts<'rooms'>` for insert payloads. Same shape, less noise at the call site.
//
// Regenerate the underlying database.types.ts with `npm run db:types` after any
// schema migration.

import type { Database } from './database.types';

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type Inserts<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type Updates<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];

export type { Database, Json } from './database.types';
