/**
 * Snapshot of the voice-surface tool catalog.
 *
 * Plan v2 F-AI-15: today no agent tool declares `surfaces: ['voice']`,
 * so `getToolsForRole(role, 'voice')` returns an empty list for every
 * role. That's the secure default — a malicious voice nonce can't
 * trigger SMS sends, room mutations, or anything else even if the rest
 * of the voice-brain hardening regressed.
 *
 * This test exists to make sure any future tool that opts into voice
 * triggers an explicit security review. If you're hitting a regression
 * here, the right path is to:
 *   1. Confirm the new tool actually needs voice (most don't — voice
 *      is for spoken Q&A, not destructive operations).
 *   2. Audit its arg validation + property scope.
 *   3. Update the snapshot list below.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getToolsForRole } from '@/lib/agent/tools';
// Side-effect import: register all tools against the catalog.
import '@/lib/agent/tools/index';

const ROLES = ['owner', 'admin', 'general_manager', 'housekeeping', 'maintenance', 'staff'] as const;

describe('voice surface tool catalog (Plan v2 F-AI-15)', () => {
  for (const role of ROLES) {
    test(`role=${role} sees zero tools on the voice surface`, () => {
      const tools = getToolsForRole(role as never, 'voice');
      // EXPECTED EMPTY. If you're adding a voice-callable tool, this test
      // is the canary — make sure you've audited the new tool's arg
      // validation and property scope, then update this assertion (and
      // ideally enumerate the tool names so the next reviewer sees
      // exactly what's exposed to voice).
      assert.deepEqual(
        tools.map((t) => t.name),
        [],
        `Voice surface gained a tool for role=${role}. ` +
          'Stop and audit before updating this snapshot — see comment in voice-surface-tools.test.ts.',
      );
    });
  }
});
