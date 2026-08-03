import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MessagePane } from '@/app/communications/_components/MessagePane';
import type { Me } from '@/app/communications/_components/comms-types-fe';
import type { ConversationDTO, MessageDTO } from '@/lib/comms/types';
import {
  captureMessageScrollAnchor,
  restoreMessageScrollAnchor,
} from '@/lib/comms/message-pagination';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'Event',
  'EventTarget', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/communications',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    ) ? candidate.bind(dom.window) : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, { configurable: true, writable: true, value: true });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function message(): MessageDTO {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    senderStaffId: 'staff-1',
    senderKind: 'staff',
    senderName: 'Ava Chen',
    body: 'The lobby is ready.',
    originalBody: 'The lobby is ready.',
    sourceLang: 'en',
    wasTranslated: false,
    msgType: 'text',
    attachmentKind: null,
    attachmentUrl: null,
    voiceDurationMs: null,
    handoffShift: null,
    handoffOutstanding: null,
    meta: {},
    createdAt: '2026-08-02T12:00:00.000Z',
    mine: false,
    requiresAck: false,
    mustAck: false,
    acked: false,
    ackCampaignId: null,
    parentMessageId: null,
    replyCount: 0,
    lastReplyAt: null,
    replyAuthorIds: [],
    pinned: false,
    ackCount: 0,
    ackedByMe: false,
  };
}

const conversation: ConversationDTO = {
  id: 'conversation-1',
  kind: 'channel',
  channelKey: 'front_desk',
  title: 'Front Desk',
  lastMessageAt: '2026-08-02T12:00:00.000Z',
  lastMessagePreview: 'The lobby is ready.',
  unread: 0,
  dept: 'front_desk',
  memberCount: 1,
};

const me: Me = {
  staffId: 'staff-me',
  role: 'front_desk',
  isManager: false,
  dept: 'front_desk',
  lang: 'en',
  displayName: 'Sam Lee',
};

function paneProps(overrides: Partial<React.ComponentProps<typeof MessagePane>> = {}) {
  return {
    pid: 'property-1',
    me,
    conversation,
    messages: [message()],
    messagesLoading: false,
    messagesError: null,
    onRetryMessages: () => {},
    messagesHasOlder: true,
    messagesOlderKnown: true,
    messagesOlderLoading: false,
    messagesOlderError: null,
    onLoadOlder: () => {},
    online: new Set<string>(),
    memberCount: 1,
    L: (english: string) => english,
    activeThreadId: null,
    activePanel: null,
    scrollRef: React.createRef<HTMLDivElement>(),
    onReloadThread: () => {},
    onReloadBoot: () => {},
    onOpenThread: () => {},
    onTogglePanel: () => {},
    onReactToggle: () => {},
    onPinToggle: () => {},
    onTurnIntoTask: () => {},
    onOpenSearch: () => {},
    ...overrides,
  };
}

function mount(context: TestContext, restore: () => void): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
  });
  return { container, root };
}

describe('communications older-message affordance', { concurrency: false }, () => {
  test('loads, locks, retries, and reports the end of older history', async (context) => {
    const restore = installBrowser();
    const { container, root } = mount(context, restore);
    let loads = 0;
    const onLoadOlder = () => { loads += 1; };

    await act(async () => {
      root.render(<MessagePane {...paneProps({ onLoadOlder })} />);
    });
    let button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Load older messages'));
    assert.ok(button);
    assert.equal(button.disabled, false);
    assert.equal(button.style.minHeight, '44px');
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(loads, 1);

    await act(async () => {
      root.render(<MessagePane {...paneProps({ onLoadOlder, messagesOlderLoading: true })} />);
    });
    button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Loading older messages'));
    assert.ok(button?.disabled);
    assert.equal(button?.getAttribute('aria-busy'), 'true');

    await act(async () => {
      root.render(<MessagePane {...paneProps({ onLoadOlder, messagesOlderError: 'offline' })} />);
    });
    assert.ok(container.querySelector('[role="alert"]'));
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Retry loading older messages"]');
    assert.ok(retry);
    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(loads, 2);

    await act(async () => {
      root.render(<MessagePane {...paneProps({ onLoadOlder, messagesHasOlder: false })} />);
    });
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'No older messages.');
  });

  test('anchors older-page insertion to a stable message when newer content is appended', (context) => {
    const restore = installBrowser();
    const { container } = mount(context, restore);
    const scrollBox = document.createElement('div');
    const current = document.createElement('div');
    const newer = document.createElement('div');
    current.dataset.messageId = 'current-message';
    newer.dataset.messageId = 'newer-message';
    scrollBox.append(current, newer);
    container.append(scrollBox);

    let currentRelativeTop = 40;
    Object.defineProperty(scrollBox, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 500, left: 0, right: 400, width: 400, height: 400 }),
    });
    Object.defineProperty(current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100 + currentRelativeTop, bottom: 180 + currentRelativeTop, left: 0, right: 300, width: 300, height: 80 }),
    });
    Object.defineProperty(newer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 420, bottom: 500, left: 0, right: 300, width: 300, height: 80 }),
    });

    scrollBox.scrollTop = 100;
    const anchor = captureMessageScrollAnchor(scrollBox);
    assert.deepEqual(anchor, { messageId: 'current-message', relativeTop: 40 });

    // Older rows move the current identity down; a poll/send append at the
    // bottom is present but does not participate in the adjustment.
    currentRelativeTop = 220;
    assert.equal(restoreMessageScrollAnchor(scrollBox, anchor!), true);
    assert.equal(scrollBox.scrollTop, 280);
  });

  test('desktop and housekeeper message lists use identity anchoring', () => {
    const desktop = readFileSync(join(
      process.cwd(),
      'src/app/communications/_components/CommsApp.tsx',
    ), 'utf8');
    const housekeeper = readFileSync(join(
      process.cwd(),
      'src/app/housekeeper/[id]/_components/redesign/MessagesTab.tsx',
    ), 'utf8');
    for (const source of [desktop, housekeeper]) {
      assert.match(source, /captureMessageScrollAnchor/);
      assert.match(source, /restoreMessageScrollAnchor/);
      assert.match(source, /beforeId/);
    }
  });
});
