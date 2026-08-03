import React from 'react';
import { CONCOURSE_COLORS, UI_RADII, UI_SHADOWS } from './tokens';

export interface SurfaceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  surface?: string;
  border?: string;
  radius?: number | string;
  shadow?: string;
  padding?: string | number;
  maxWidth?: number | string;
}

/**
 * Parameterized light-surface card. Area wrappers pass their existing tokens
 * and may override geometry, so adopting it does not change a surface's
 * appearance or copy.
 */
export const SurfaceCard = React.forwardRef<HTMLDivElement, SurfaceCardProps>(
  function SurfaceCard(
    {
      surface = CONCOURSE_COLORS.paper,
      border = `1px solid ${CONCOURSE_COLORS.rule}`,
      radius = UI_RADII.card,
      shadow = UI_SHADOWS.card,
      padding = '20px 22px',
      maxWidth,
      style,
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        {...rest}
        style={{
          background: surface,
          border,
          borderRadius: radius,
          boxShadow: shadow,
          padding,
          ...(maxWidth !== undefined ? { maxWidth } : {}),
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);
