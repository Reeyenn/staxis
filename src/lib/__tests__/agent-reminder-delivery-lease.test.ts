import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const store = readFileSync(join(process.cwd(), 'src/lib/reminders/store.ts'), 'utf8');
const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/0333_agent_reminder_delivery_leases.sql'),
  'utf8',
);

describe('agent reminder crash-safe delivery', () => {
  it('uses a reclaimable token lease and finalizes only its own claim', () => {
    assert.match(store, /DELIVERY_LEASE_MS/);
    assert.match(store, /claimed_at\.lt/);
    assert.match(store, /claim_token:\s*claimToken/);
    assert.match(store, /\.eq\(['"]claim_token['"],\s*claimToken\)/);
  });

  it('deduplicates the Communications side effect by reminder id', () => {
    assert.match(store, /agent_reminder_id:\s*r\.id/);
    assert.match(store, /code\?\:\s*string[\s\S]*23505/);
    assert.match(store, /contains\(['"]meta['"],\s*\{\s*agent_reminder_id:\s*r\.id\s*\}\)/);
    assert.match(store, /existing\.data\.conversation_id\s*!==\s*conversationId/);
    assert.match(migration, /unique index[\s\S]*comms_messages_agent_reminder_uq/i);
    assert.match(migration, /meta\s*->>\s*'agent_reminder_id'/);
  });

  it('keeps fired_at as a post-delivery terminal marker', () => {
    const deliveryOffset = store.indexOf('await deliverReminder(r)');
    const finalizeOffset = store.indexOf('fired_at: new Date().toISOString()', deliveryOffset);
    assert.ok(deliveryOffset >= 0 && finalizeOffset > deliveryOffset);
  });

  it('surfaces lease-acquisition and partial batch failures', () => {
    assert.match(store, /error:\s*claimError/);
    assert.match(store, /if \(claimError\)[\s\S]*failed \+= 1/);
    const route = readFileSync(
      join(process.cwd(), 'src/app/api/cron/process-agent-schedules/route.ts'),
      'utf8',
    );
    assert.match(route, /reminders\.failed\s*>\s*0\s*\|\|\s*recurringTodos\.failed\s*>\s*0/);
  });
});
