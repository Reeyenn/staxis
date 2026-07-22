import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ASK_EVENT,
  dispatchAskCommand,
  subscribeToAskCommands,
} from '@/components/agent/ask-command-bridge';

function fakeWindow(): Window {
  return new EventTarget() as unknown as Window;
}

describe('Ask Staxis command bridge', () => {
  test('replays a command submitted before the dynamic bar subscribes', () => {
    const target = fakeWindow();
    const received: string[] = [];

    assert.equal(dispatchAskCommand('  check arrivals  ', target), true);
    const unsubscribe = subscribeToAskCommands((text) => received.push(text), target);

    assert.deepEqual(received, ['check arrivals']);
    unsubscribe();
  });

  test('delivers live commands exactly once and does not replay consumed work', () => {
    const target = fakeWindow();
    const received: string[] = [];
    const unsubscribe = subscribeToAskCommands((text) => received.push(text), target);

    dispatchAskCommand('show low stock', target);
    unsubscribe();
    const unsubscribeAgain = subscribeToAskCommands((text) => received.push(text), target);

    assert.deepEqual(received, ['show low stock']);
    unsubscribeAgain();
  });

  test('coalesces rapid cold-load retries to the newest command', () => {
    const target = fakeWindow();
    const received: string[] = [];

    dispatchAskCommand('first attempt', target);
    dispatchAskCommand('second attempt', target);
    const unsubscribe = subscribeToAskCommands((text) => received.push(text), target);

    assert.deepEqual(received, ['second attempt']);
    unsubscribe();
  });

  test('accepts the legacy custom-event payload during rollout', () => {
    const target = fakeWindow();
    const received: string[] = [];
    const unsubscribe = subscribeToAskCommands((text) => received.push(text), target);
    const event = new Event(ASK_EVENT) as Event & { detail?: { text: string } };
    event.detail = { text: 'legacy command' };

    target.dispatchEvent(event);

    assert.deepEqual(received, ['legacy command']);
    unsubscribe();
  });

  test('rejects blank commands without dispatching', () => {
    const target = fakeWindow();
    let events = 0;
    target.addEventListener(ASK_EVENT, () => { events += 1; });

    assert.equal(dispatchAskCommand('   ', target), false);
    assert.equal(events, 0);
  });
});
