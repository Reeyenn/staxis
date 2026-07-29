import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {
  ConcourseBarView,
  type AdminDestinationAction,
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
  adminDestination?: AdminDestinationAction,
) {
  return ConcourseBarView({
    items: [],
    adminDestination,
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

test('verified platform Admin is a separate exact destination, not the Home control', () => {
  let clicks = 0;
  const tree = renderBar(false, () => {}, 'Home', {
    label: 'Admin',
    ariaLabel: 'Open Staxis Admin',
    active: true,
    onClick: () => { clicks += 1; },
  });
  const adminButtons = labelledButtons(tree, 'Open Staxis Admin');

  assert.equal(adminButtons.length, 1);
  assert.match(String(adminButtons[0].props.className), /cx-admin-destination/);
  assert.equal(adminButtons[0].props['aria-current'], 'page');
  assert.equal(containsComponent(adminButtons[0], CxIcon, { name: 'admin' }), true);
  assert.equal(containsText(adminButtons[0].props.children, 'Admin'), true);
  assert.equal(adminButtons[0].props.onClick instanceof Function, true);
  (adminButtons[0].props.onClick as () => void)();
  assert.equal(clicks, 1);

  assert.equal(labelledButtons(tree, 'Home').length, 1);
  assert.equal(labelledButtons(renderBar(false), 'Open Staxis Admin').length, 0);
});
