import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import type { RealtimeChannel } from '@supabase/supabase-js';

import { supabase } from '@/lib/db/_common';
import {
  subscribeTodayRoomWork,
  TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS,
} from '@/lib/db/today-room-work';

type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

interface FakeRealtimeChannel {
  name: string;
  state: string;
  emitChange: () => void;
  emitStatus: (status: ChannelStatus, error?: Error) => void;
}

interface RealtimeSurface {
  channel: (name: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => Promise<unknown>;
}

function installBrowserEvents(context: TestContext): {
  documentTarget: EventTarget;
  windowTarget: EventTarget;
  setHidden: (hidden: boolean) => void;
} {
  let hidden = true;
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  Object.defineProperty(documentTarget, 'hidden', {
    configurable: true,
    get: () => hidden,
  });

  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentTarget,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowTarget,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });

  context.after(() => {
    for (const [key, descriptor] of [
      ['document', previousDocument],
      ['window', previousWindow],
      ['navigator', previousNavigator],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  return {
    documentTarget,
    windowTarget,
    setHidden: (next) => { hidden = next; },
  };
}

function installRealtimeChannels(context: TestContext): {
  channels: FakeRealtimeChannel[];
  removed: FakeRealtimeChannel[];
} {
  const channels: FakeRealtimeChannel[] = [];
  const removed: FakeRealtimeChannel[] = [];
  const realtime = supabase as unknown as RealtimeSurface;

  context.mock.method(realtime, 'channel', (name: string) => {
    let change: (() => void) | null = null;
    let statusChange: ((status: ChannelStatus, error?: Error) => void) | null = null;
    const channel = {
      name,
      state: 'joining',
      on: (...args: unknown[]) => {
        change = args[2] as () => void;
        return channel;
      },
      subscribe: (callback?: (status: ChannelStatus, error?: Error) => void) => {
        statusChange = callback ?? null;
        return channel;
      },
      emitChange: () => { change?.(); },
      emitStatus: (status: ChannelStatus, error?: Error) => { statusChange?.(status, error); },
    };
    channels.push(channel);
    return channel as unknown as RealtimeChannel;
  });
  context.mock.method(realtime, 'removeChannel', async (channel: RealtimeChannel) => {
    removed.push(channel as unknown as FakeRealtimeChannel);
    return 'ok';
  });
  context.mock.method(console, 'error', () => undefined);

  return { channels, removed };
}

describe('today-room-work realtime recovery', () => {
  test('foreground, online, and channel failures catch up without an unbounded reconnect loop', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => context.mock.timers.reset());
    const browser = installBrowserEvents(context);
    const { channels, removed } = installRealtimeChannels(context);
    let changes = 0;

    const unsubscribe = subscribeTodayRoomWork('property-1', () => { changes += 1; });
    assert.equal(channels.length, 4, 'one independently recoverable channel per source table');
    assert.equal(new Set(channels.map((channel) => channel.name)).size, 4);

    browser.documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(changes, 0, 'a hidden tab must not issue a futile catch-up read');

    browser.setHidden(false);
    browser.documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(changes, 1, 'foregrounding catches up immediately');
    browser.windowTarget.dispatchEvent(new Event('online'));
    assert.equal(changes, 2, 'network restoration catches up immediately');

    let failedChannel = channels[0];
    failedChannel.emitStatus('CHANNEL_ERROR', new Error('socket lost'));
    await Promise.resolve();
    assert.equal(changes, 3, 'a realtime failure also triggers one coalesced snapshot catch-up');

    for (let index = 0; index < TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS.length; index += 1) {
      context.mock.timers.tick(TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS[index]);
      assert.equal(channels.length, 5 + index, `retry ${index + 1} creates exactly one replacement`);
      assert.ok(removed.includes(failedChannel), 'the failed generation is removed before replacement');
      failedChannel = channels.at(-1) as FakeRealtimeChannel;
      failedChannel.emitStatus('CHANNEL_ERROR', new Error(`socket lost ${index + 2}`));
      await Promise.resolve();
    }

    const channelsAfterBudget = channels.length;
    context.mock.timers.tick(120_000);
    assert.equal(
      channels.length,
      channelsAfterBudget,
      'consecutive failures stop after the bounded retry schedule',
    );

    browser.windowTarget.dispatchEvent(new Event('online'));
    assert.equal(channels.length, channelsAfterBudget + 1, 'an explicit recovery signal starts a fresh bounded run');
    assert.ok(removed.includes(failedChannel));
    const recoveredChannel = channels.at(-1) as FakeRealtimeChannel;
    const changesAfterOnline = changes;
    recoveredChannel.emitStatus('SUBSCRIBED');
    await Promise.resolve();
    assert.equal(changes, changesAfterOnline + 1, 'a recovered channel catches up once after joining');

    recoveredChannel.emitChange();
    assert.equal(changes, changesAfterOnline + 2, 'the replacement channel delivers future events');

    unsubscribe();
    const changesAfterUnsubscribe = changes;
    const channelsAfterUnsubscribe = channels.length;
    browser.documentTarget.dispatchEvent(new Event('visibilitychange'));
    browser.windowTarget.dispatchEvent(new Event('online'));
    recoveredChannel.emitChange();
    recoveredChannel.emitStatus('CHANNEL_ERROR', new Error('late callback'));
    context.mock.timers.tick(120_000);
    await Promise.resolve();
    assert.equal(changes, changesAfterUnsubscribe);
    assert.equal(channels.length, channelsAfterUnsubscribe, 'cleanup leaves no reconnect timer behind');
  });
});
