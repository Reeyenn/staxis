'use client';

// ─── WalkthroughErrorBoundary ─────────────────────────────────────────────
// Catches exceptions thrown inside WalkthroughOverlay's render path and
// inside the run loop's React-state updates. Without this boundary, a
// thrown error would unmount the entire root-layout subtree (since the
// overlay is mounted high in the tree), taking the chat panel and the
// rest of the app with it.
//
// On a caught error:
//   - log to console (Sentry would pick this up via the global error
//     handler too, but a defensive direct log doesn't hurt)
//   - render a small dismissable banner so the user knows it crashed
//   - the overlay state inside is gone, but the partial-unique-active
//     run row will eventually be reaped by staxis_walkthrough_heal_stale
//     after 30 minutes; we accept that small window in favor of not
//     having the boundary try to do async cleanup
//
// RC5 R10 root-cause fix (2026-05-14).

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class WalkthroughErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error('[walkthrough] caught render-path exception', { error, componentStack: info.componentStack });
    // Sentry is wired globally via @sentry/nextjs; an uncaught render
    // exception that bubbles to global is what we'd see here. If we wanted
    // a dedicated Sentry tag we could captureException(error, {tags:{component:'walkthrough'}})
    // — left as a follow-up since the global handler picks this up too.
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: 'min(640px, 92vw)',
          background: 'var(--snow-warm, #B85C3D)',
          color: 'white',
          padding: '14px 18px',
          borderRadius: 14,
          boxShadow: '0 12px 32px rgba(31, 35, 28, 0.22)',
          zIndex: 9999,
          fontFamily: "var(--font-geist), -apple-system, sans-serif",
          fontSize: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div style={{ flex: 1 }}>
          Walkthrough crashed — refresh the page to retry.
        </div>
        <button
          onClick={this.reset}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: 'rgba(255, 255, 255, 0.15)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            padding: '6px 12px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }
}
