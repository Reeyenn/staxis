import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { ConcourseBarView } from '@/components/concourse/ConcourseBarView';
import { CxIcon, CxLogo } from '@/components/concourse/icons';

type ElementProps = Record<string, unknown> & { children?: React.ReactNode };

function visit(node: React.ReactNode, callback: (element: React.ReactElement<ElementProps>) => void) {
  if (!React.isValidElement<ElementProps>(node)) return;
  callback(node);
  React.Children.forEach(node.props.children, child => visit(child, callback));
}

function renderBar(showHome: boolean, onLogo = () => {}, homeLabel = 'Home') {
  return ConcourseBarView({
    items: [],
    gearActive: false,
    onGear: () => {},
    onLogo,
    homeLabel,
    settingsLabel: 'Settings',
    showHome,
  });
}

function labelledButtons(tree: React.ReactNode, label: string) {
  const matches: React.ReactElement<ElementProps>[] = [];
  visit(tree, element => {
    if (element.type === 'button' && element.props['aria-label'] === label) {
      matches.push(element);
    }
  });
  return matches;
}

function containsComponent(tree: React.ReactNode, component: React.ElementType, props: ElementProps = {}) {
  let found = false;
  visit(tree, element => {
    if (found || element.type !== component) return;
    found = Object.entries(props).every(([key, value]) => element.props[key] === value);
  });
  return found;
}

function containsText(tree: React.ReactNode, text: string) {
  let found = false;
  React.Children.forEach(tree, child => {
    if (found) return;
    if (typeof child === 'string' || typeof child === 'number') {
      found = String(child) === text;
      return;
    }
    if (React.isValidElement<ElementProps>(child)) {
      found = containsText(child.props.children, text);
    }
  });
  return found;
}

test('Home route shows one leftmost Staxis logo control', () => {
  const tree = renderBar(false);
  const buttons = labelledButtons(tree, 'Home');

  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.className, 'cx-pill');
  assert.equal(containsComponent(buttons[0], CxLogo), true);
  assert.equal(containsComponent(buttons[0], CxIcon, { name: 'back' }), false);
});

test('inner routes transform the same control into the contextual Home action', () => {
  let clicks = 0;
  const onLogo = () => { clicks += 1; };
  const tree = renderBar(true, onLogo);
  const buttons = labelledButtons(tree, 'Home');

  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.className, 'cx-pill cx-context-home');
  assert.equal(String(buttons[0].props.className).includes('cx-homebtn'), false);
  assert.equal(containsComponent(buttons[0], CxLogo), false);
  assert.equal(containsComponent(buttons[0], CxIcon, { name: 'back' }), true);

  const onClick = buttons[0].props.onClick;
  assert.equal(typeof onClick, 'function');
  assert.equal(onClick, onLogo);
  (onClick as () => void)();
  assert.equal(clicks, 1);
});

test('contextual Home action keeps the localized label', () => {
  const tree = renderBar(true, () => {}, 'Inicio');
  const buttons = labelledButtons(tree, 'Inicio');

  assert.equal(buttons.length, 1);
  assert.equal(containsComponent(buttons[0], CxIcon, { name: 'back' }), true);
  assert.equal(containsText(buttons[0], 'Inicio'), true);
});
