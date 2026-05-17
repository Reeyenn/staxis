// Client-safe env module. Subset of vars that are safe to ship to the
// browser — all prefixed `NEXT_PUBLIC_`. Importable from client components
// (no `server-only` guard).
//
// The explicit destructure into the safeParse input is intentional: it lets
// Next.js statically inline each `process.env.NEXT_PUBLIC_X` reference at
// build time. A spread (`...process.env`) would defeat that and ship the
// raw env object to the client.

import { z } from 'zod';

const ClientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.string().url().default('https://getstaxis.com'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: z.string().optional(),
  NEXT_PUBLIC_VERCEL_ENV: z.string().optional(),
});

const parsed = ClientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL:
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_BASE_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
});

if (!parsed.success) {
  const flat = parsed.error.flatten().fieldErrors;
  const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
  // eslint-disable-next-line no-console
  console.error('❌ Client env vars failed validation:\n' + lines.join('\n'));
  throw new Error(
    'Invalid client environment. Missing/invalid: ' + Object.keys(flat).join(', ')
  );
}

export const clientEnv = parsed.data;
