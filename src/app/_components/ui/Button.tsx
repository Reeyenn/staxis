'use client';

import React from 'react';
import { UI_RADII } from './tokens';

export interface UiButtonSize {
  height: number;
  padding: string;
  fontSize: number;
}

export interface UiButtonVariant {
  background: string;
  color: string;
  border: string;
  fontWeight: number;
}

export interface UiButtonTheme {
  sizes: Record<string, UiButtonSize>;
  variants: Record<string, UiButtonVariant>;
  fontFamily: string;
  disabledOpacity: number;
  gap?: number;
  borderRadius?: number | string;
  flexShrink?: number;
  transition?: string;
  focusRing?: string;
}

export interface UiButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  theme: UiButtonTheme;
  variant?: string;
  size?: string;
  style?: React.CSSProperties;
}

const DEFAULT_BUTTON_SIZE: UiButtonSize = {
  height: 36,
  padding: '0 16px',
  fontSize: 13,
};
const DEFAULT_BUTTON_VARIANT: UiButtonVariant = {
  background: 'transparent',
  color: 'inherit',
  border: 'currentColor',
  fontWeight: 500,
};

/**
 * Geometry and interaction semantics for the light-surface pill buttons.
 *
 * The caller supplies its existing color/size map, so this primitive does not
 * invent a palette or silently reskin an area. It centralizes the native
 * button contract, disabled treatment, focus-visible ring, and shared layout.
 */
export const UiButton = React.forwardRef<HTMLButtonElement, UiButtonProps>(
  function UiButton(
    {
      theme,
      variant = 'ghost',
      size = 'md',
      type = 'button',
      disabled,
      className,
      style,
      children,
      ...rest
    },
    ref,
  ) {
    const buttonSize = theme.sizes[size] ?? theme.sizes.md ?? DEFAULT_BUTTON_SIZE;
    const buttonVariant = theme.variants[variant] ?? theme.variants.ghost ?? DEFAULT_BUTTON_VARIANT;

    return (
      <button
        ref={ref}
        {...rest}
        type={type}
        disabled={disabled}
        className={['stx-ui-button', className].filter(Boolean).join(' ') || undefined}
        style={{
          '--stx-ui-focus-ring': theme.focusRing,
          height: buttonSize.height,
          padding: buttonSize.padding,
          borderRadius: theme.borderRadius ?? UI_RADII.pill,
          background: buttonVariant.background,
          color: buttonVariant.color,
          border: `1px solid ${buttonVariant.border}`,
          fontFamily: theme.fontFamily,
          fontSize: buttonSize.fontSize,
          fontWeight: buttonVariant.fontWeight,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? theme.disabledOpacity : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.gap ?? 6,
          whiteSpace: 'nowrap',
          ...(theme.flexShrink !== undefined ? { flexShrink: theme.flexShrink } : {}),
          ...(theme.transition ? { transition: theme.transition } : {}),
          ...style,
        } as React.CSSProperties}
      >
        {children}
      </button>
    );
  },
);
