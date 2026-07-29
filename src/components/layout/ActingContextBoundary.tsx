'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useHotelActingContext } from '@/contexts/HotelActingContext';
import { portfolioHotelSurfacePolicy } from '@/lib/portfolio-ui/hotel-path-policy';
import styles from './ActingContextBoundary.module.css';

function StateShell(props: {
  title: string;
  detail: string;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);

  React.useLayoutEffect(() => {
    if (props.busy) titleRef.current?.focus({ preventScroll: true });
  }, [props.busy]);

  return (
    <main className={styles.page} aria-busy={props.busy || undefined}>
      <section
        className={styles.card}
        role={props.busy ? 'status' : 'alert'}
        aria-live={props.busy ? 'polite' : 'assertive'}
      >
        <div className={styles.mark} aria-hidden="true">S</div>
        <h1 ref={titleRef} className={styles.title} tabIndex={-1}>{props.title}</h1>
        <p className={styles.detail}>{props.detail}</p>
        {props.children ? <div className={styles.actions}>{props.children}</div> : null}
      </section>
    </main>
  );
}

/**
 * Fail-closed root boundary for explicit hotel acting contexts. Nothing below
 * it—including PropertyContext, Concourse, activity, translation or Ask—mounts
 * until the exact current URL and viewer have a fresh server verdict.
 */
export function ActingContextBoundary({ children }: { children: React.ReactNode }) {
  const acting = useHotelActingContext();
  const pathname = usePathname();
  const retryRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreRetryFocus = React.useRef(false);
  const checkingSeenRef = React.useRef(false);

  React.useLayoutEffect(() => {
    if (acting.status === 'checking') {
      checkingSeenRef.current = true;
      return;
    }
    if (acting.status !== 'allowed' || !checkingSeenRef.current) return;
    checkingSeenRef.current = false;
    // A child surface may intentionally restore focus in its own layout
    // effect. Preserve that decision; only repair focus when removal of the
    // checking shell left it on the document itself.
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body && document.contains(activeElement)) return;
    const heading = document.querySelector<HTMLElement>(
      '[data-staxis-page-heading], main h1, [role="main"] h1',
    );
    if (!heading) return;
    const hadTabIndex = heading.hasAttribute('tabindex');
    if (!hadTabIndex) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    if (!hadTabIndex) {
      heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
    }
  }, [acting.status]);

  React.useEffect(() => {
    if (acting.status !== 'error' || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    retryRef.current?.focus({ preventScroll: true });
  }, [acting.status]);

  if (acting.request.kind !== 'hotel' && acting.request.kind !== 'invalid') {
    return <>{children}</>;
  }

  if (acting.status === 'checking' || acting.status === 'inactive') {
    return (
      <StateShell
        busy
        title="Opening hotel"
        detail="Checking your current access before any hotel information is shown."
      />
    );
  }

  const returnTo = acting.request.kind === 'hotel' ? acting.request.returnTo : null;
  if (acting.status === 'error') {
    const changed = acting.httpStatus === 409;
    return (
      <StateShell
        title={changed ? 'Your access changed' : 'Hotel access could not be checked'}
        detail={changed
          ? 'The selected company or hotel scope changed while this page was opening. No hotel information was shown.'
          : 'No hotel information was shown. Check your connection and try again.'}
      >
        <button
          ref={retryRef}
          className={styles.primary}
          type="button"
          onClick={() => {
            restoreRetryFocus.current = true;
            acting.retry();
          }}
        >
          Try again
        </button>
        {returnTo ? <Link className={styles.secondary} href={returnTo}>Back to Portfolio</Link> : null}
      </StateShell>
    );
  }

  if (acting.status === 'denied') {
    const invalid = acting.httpStatus === 400;
    const signedOut = acting.httpStatus === 401;
    return (
      <StateShell
        title={signedOut ? 'Sign in required' : invalid ? 'This link is not valid' : 'Hotel unavailable'}
        detail={signedOut
          ? 'Sign in again before opening this hotel.'
          : invalid
            ? 'The acting context is incomplete or contains conflicting selectors.'
            : 'This hotel is outside your current scope, or your access was revoked.'}
      >
        {signedOut ? <Link className={styles.primary} href="/signin">Go to sign in</Link> : null}
        {returnTo ? <Link className={styles.secondary} href={returnTo}>Back to Portfolio</Link> : null}
      </StateShell>
    );
  }

  if (acting.context?.source === 'portfolio') {
    const surface = portfolioHotelSurfacePolicy(acting.context, pathname);
    const denied = surface.mode === 'denied';
    if (denied) return (
      <StateShell
        title="This hotel view is not available"
        detail="That destination contains private hotel detail or is outside your current portfolio capability."
      >
        {returnTo ? <Link className={styles.secondary} href={returnTo}>Back to Portfolio</Link> : null}
      </StateShell>
    );
    const hotelName = acting.context.property.name;
    const scopeLabel = `Hotel · ${hotelName}`;
    return (
      <>
        <div
          className={styles.scopeBanner}
          role="status"
          aria-label={`Current scope: ${scopeLabel}`}
        >
          <div className={styles.scopeCopy}>
            <span className={styles.scopeEyebrow}>Current scope</span>
            <strong>{scopeLabel}</strong>
            {!acting.context.standing.hotelMutationAllowed ? (
              <span className={styles.readOnly}>Read only</span>
            ) : null}
          </div>
          {returnTo ? (
            <Link className={styles.scopeBack} href={returnTo}>Back to Portfolio</Link>
          ) : null}
        </div>
        <div className={styles.srOnly} role="status" aria-live="polite">
          Hotel access confirmed. {hotelName} is ready.
        </div>
        {children}
      </>
    );
  }

  return acting.context?.source === 'local' ? (
    <>
      <div className={styles.srOnly} role="status" aria-live="polite">
        Hotel access confirmed. Page ready.
      </div>
      {children}
    </>
  ) : (
    <StateShell
      title="Hotel access could not be verified"
      detail="No hotel information was shown. Return to your portfolio and try again."
    >
      {returnTo ? <Link className={styles.secondary} href={returnTo}>Back to Portfolio</Link> : null}
    </StateShell>
  );
}
