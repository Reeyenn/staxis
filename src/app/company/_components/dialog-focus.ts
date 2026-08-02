import type { RefObject } from 'react';

type DialogFocusRef = RefObject<HTMLElement | null>;

function isUsableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element
      && element.isConnected
      && element !== element.ownerDocument.body
      && !element.matches(':disabled')
      && element.getAttribute('aria-disabled') !== 'true',
  );
}

export function restoreDialogFocus(
  returnFocusRef: DialogFocusRef | undefined,
  fallbackFocusRef: DialogFocusRef | undefined,
  previousFocusElement: HTMLElement | null,
): void {
  const returnFocusElement = returnFocusRef?.current ?? null;
  const fallbackFocusElement = fallbackFocusRef?.current ?? null;
  const target = isUsableFocusTarget(returnFocusElement)
    ? returnFocusElement
    : isUsableFocusTarget(previousFocusElement)
      ? previousFocusElement
      : isUsableFocusTarget(fallbackFocusElement)
        ? fallbackFocusElement
        : null;

  target?.focus({ preventScroll: true });
}
