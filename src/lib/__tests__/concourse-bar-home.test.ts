import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {
  ConcourseBarView,
  type ViewSwitchAction,
} from '@/components/concourse/ConcourseBarView';
import { CxIcon, CxLogo } from '@/components/concourse/icons';

type ElementProps = Record<string, unknown> & { children?: React.ReactNode };

function visit(node: React.ReactNode, callback: (element: React.ReactElement<ElementProps>) => void) {
  if (!React.isValidElement<ElementProps>(node)) return;
  callback(node);
  React.Children.forEach(node.props.children, child => visit(child, callback));
}

function renderBar(
  showHome: boolean,
  onLogo = () => {},
  homeLabel = 'Home',
  viewSwitch?: ViewSwitchAction,
) {
  return ConcourseBarView({
    items: [],
    viewSwitch,
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

test('admin route switch is an always-labelled utility action', () => {
  let clicks = 0;
  const viewSwitch: ViewSwitchAction = {
    label: 'Admin View',
    ariaLabel: 'Switch to Admin View',
    icon: 'admin',
    onClick: () => { clicks += 1; },
  };
  const tree = renderBar(false, () => {}, 'Home', viewSwitch);
  const buttons = labelledButtons(tree, 'Switch to Admin View');

  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.className, 'cx-pill cx-utility-pill cx-view-switch');
  assert.equal(containsComponent(buttons[0], CxIcon, { name: 'admin' }), true);
  assert.equal(containsText(buttons[0], 'Admin View'), true);
  assert.equal(buttons[0].props['aria-current'], undefined);

  const onClick = buttons[0].props.onClick;
  assert.equal(onClick, viewSwitch.onClick);
  (onClick as () => void)();
  assert.equal(clicks, 1);
});

test('hotel route switch keeps its localized destination visible', () => {
  const tree = renderBar(false, () => {}, 'Inicio', {
    label: 'Vista del hotel',
    ariaLabel: 'Cambiar a la vista del hotel',
    icon: 'hotel',
    onClick: () => {},
  });
  const buttons = labelledButtons(tree, 'Cambiar a la vista del hotel');

  assert.equal(buttons.length, 1);
  assert.equal(containsComponent(buttons[0], CxIcon, { name: 'hotel' }), true);
  assert.equal(containsText(buttons[0], 'Vista del hotel'), true);
});
