#!/usr/bin/env node
/* eslint-disable no-console */

// ═══════════════════════════════════════════════════════════════════════════
// reset-admin-password.js
//
// One-off utility to reset the admin (reeyen@staxis.local) password without
// running the full seeder (which would only touch password if the user
// didn't exist, and would require STAXIS_ADMIN_PASSWORD in .env.local).
//
// Uses the Supabase admin API to update the password in place — does not
// touch the accounts row, the property, or anything else. Safe to run any
// number of times.
//
// Usage (preferred — password from env, no shell-history leak):
//   read -s -p "New password: " p; STAXIS_NEW_ADMIN_PASSWORD="$p" \
//     node scripts/reset-admin-password.js; unset p
//
// 2026-05-12 (Codex audit): previously accepted the password as argv[2],
// which leaks the secret into shell history (~/.bash_history,
// ~/.zsh_history), `ps aux` listings, and any terminal recording.
// Now we read from STAXIS_NEW_ADMIN_PASSWORD env var so the secret
// never appears on a command line.
//
// Prereqs in .env.local:
//   NEXT_PUBLIC_SUPABASE_URL=https://<proj>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... (service_role, NOT anon)
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Inline .env.local loader — matches seed-supabase.js so this works
// straight out of `npm install` without dotenv.
(function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const ADMIN_EMAIL = 'reeyen@staxis.local';
const newPassword = process.env.STAXIS_NEW_ADMIN_PASSWORD;

if (!newPassword) {
  console.error(
    '\n✗ Set STAXIS_NEW_ADMIN_PASSWORD in the environment, do not pass it as an argument.\n' +
    '  Recommended (no shell-history leak):\n' +
    '    read -s -p "New password: " p; STAXIS_NEW_ADMIN_PASSWORD="$p" \\\n' +
    '      node scripts/reset-admin-password.js; unset p\n',
  );
  process.exit(1);
}
// Refuse to honour a legacy argv[2] usage — fail loudly with a pointer
// so anyone with the old habit doesn't accidentally leak the secret.
if (process.argv[2]) {
  console.error(
    '\n✗ Refusing to read the password from argv (it would land in shell history).\n' +
    '  Set STAXIS_NEW_ADMIN_PASSWORD in the environment instead — see the usage block at the top of this file.\n',
  );
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('\n✗ Password must be at least 6 characters (Supabase default minimum).\n');
  process.exit(1);
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('\n✗ Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env.local.\n');
  process.exit(1);
}

const supa = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

(async () => {
  console.log(`\n━━━ Reset password for ${ADMIN_EMAIL} ━━━`);
  console.log(`Target: ${SUPA_URL}\n`);

  const { data: list, error: listErr } = await supa.auth.admin.listUsers();
  if (listErr) {
    console.error('✗ Failed to list users:', listErr.message);
    process.exit(1);
  }

  const user = list.users.find(u => u.email === ADMIN_EMAIL);
  if (!user) {
    console.error(`✗ No user found with email ${ADMIN_EMAIL}.`);
    console.error('  Run `npm run seed` first to create the admin user.\n');
    process.exit(1);
  }

  console.log(`Found user: id=${user.id}`);
  console.log('Updating password…');

  const { error: updErr } = await supa.auth.admin.updateUserById(user.id, {
    password: newPassword,
  });
  if (updErr) {
    console.error('✗ Password update failed:', updErr.message);
    process.exit(1);
  }

  console.log('\n✓ Password updated.');
  console.log(`  Sign in at https://hotelops-ai.vercel.app/signin`);
  console.log(`  Username: reeyen`);
  console.log(`  Password: (the one you just set)\n`);
})();
