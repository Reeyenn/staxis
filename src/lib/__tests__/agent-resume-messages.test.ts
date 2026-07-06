/**
 * toClaudeMessages resume path (newUser = null).
 *
 * When resuming after an approval decision, the history already ends with the
 * assistant tool_use turn + its complete tool_result rows — Anthropic needs
 * exactly that shape to continue generating. Passing newUser=null must NOT
 * append a trailing (empty, invalid) user turn.
 *
 * Also pins that a null newUser leaves the last message as the tool_result user
 * turn, and a string newUser still appends normally (fresh-turn behaviour is
 * unchanged).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toClaudeMessages, type AgentMessage } from '@/lib/agent/llm';

// A completed mutation turn: user asked, assistant proposed a tool, the tool
// result landed (persisted by the resolve route).
const RESOLVED_TURN: AgentMessage[] = [
  { role: 'user', content: 'message Maria the lobby needs a mop' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'send_message', args: { recipient: 'Maria', message: 'lobby needs a mop' } }] },
  { role: 'tool', toolCallId: 'call-1', result: { messageId: 'm1', recipient: 'Maria Garcia' } },
];

describe('toClaudeMessages resume path', () => {
  test('newUser=null does not append a trailing user turn', () => {
    const msgs = toClaudeMessages(RESOLVED_TURN, null);
    const last = msgs[msgs.length - 1];
    // The last message must be the tool_result user turn, not an empty new one.
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content), 'last user turn should carry tool_result blocks');
    const blocks = last.content as Array<{ type: string; tool_use_id?: string }>;
    assert.equal(blocks[0].type, 'tool_result');
    assert.equal(blocks[0].tool_use_id, 'call-1');
  });

  test('the assistant tool_use precedes its tool_result (valid Anthropic order)', () => {
    const msgs = toClaudeMessages(RESOLVED_TURN, null);
    const assistantIdx = msgs.findIndex((m) => m.role === 'assistant');
    const toolResultIdx = msgs.findIndex((m) =>
      m.role === 'user' && Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
    );
    assert.ok(assistantIdx >= 0 && toolResultIdx > assistantIdx, 'tool_use must come before tool_result');
  });

  test('a string newUser still appends a new user turn (fresh-turn unchanged)', () => {
    const msgs = toClaudeMessages(RESOLVED_TURN, 'and tell Carlos too');
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content, 'and tell Carlos too');
  });

  test('denied action replays as an error tool_result', () => {
    const denied: AgentMessage[] = [
      { role: 'user', content: 'send it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-9', name: 'send_message', args: {} }] },
      { role: 'tool', toolCallId: 'call-9', result: 'The user declined this action.' },
    ];
    const msgs = toClaudeMessages(denied, null);
    const last = msgs[msgs.length - 1] as { content: Array<{ type: string; content: string; tool_use_id: string }> };
    assert.equal(last.content[0].tool_use_id, 'call-9');
    assert.match(last.content[0].content, /declined/);
  });
});
