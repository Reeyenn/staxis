'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Download, LogOut, Menu, X } from 'lucide-react';
import type { BarItem } from './ConcourseBarView';
import { CxIcon, CxLogo, CX_ICON_PATHS } from './icons';
import styles from './MobileConcourseNav.module.css';

interface MobileConcourseNavProps {
  items: BarItem[];
  propertyOptions: ReadonlyArray<{ value: string; label: string }>;
  activePropertyId: string | null;
  languageOptions: ReadonlyArray<{ value: string; label: string }>;
  activeLocale: string;
  userName: string;
  userMeta: string;
  userInitial: string;
  homeLabel: string;
  menuLabel: string;
  closeLabel: string;
  navigationLabel: string;
  sectionsLabel: string;
  accountLabel: string;
  propertyLabel: string;
  languageLabel: string;
  accountMenuLabel: string;
  settingsLabel: string;
  signOutLabel: string;
  installLabel: string;
  showInstallAction: boolean;
  settingsActive: boolean;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onPropertyChange: (propertyId: string) => void;
  onLanguageChange: (locale: string) => void;
  onInstall: (returnFocusElement: HTMLButtonElement | null) => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Phone-only Concourse chrome. It intentionally owns its dialog state so
 * the desktop account menu and its install/property/language behavior remain
 * completely unchanged. */
export function MobileConcourseNav({
  items,
  propertyOptions,
  activePropertyId,
  languageOptions,
  activeLocale,
  userName,
  userMeta,
  userInitial,
  homeLabel,
  menuLabel,
  closeLabel,
  navigationLabel,
  sectionsLabel,
  accountLabel,
  propertyLabel,
  languageLabel,
  accountMenuLabel,
  settingsLabel,
  signOutLabel,
  installLabel,
  showInstallAction,
  settingsActive,
  onHome,
  onSettings,
  onSignOut,
  onPropertyChange,
  onLanguageChange,
  onInstall,
}: MobileConcourseNavProps) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const activeTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const drawerId = React.useId();

  React.useEffect(() => setMounted(true), []);

  const closeDrawer = React.useCallback((restoreFocus = true) => {
    if (restoreFocus) {
      // Move focus before aria-hidden is committed so a focused control is
      // never left inside the now-hidden drawer for even one frame.
      (activeTriggerRef.current ?? triggerRef.current)?.focus({ preventScroll: true });
    }
    setOpen(false);
  }, []);

  const openDrawer = React.useCallback((trigger: HTMLButtonElement) => {
    activeTriggerRef.current = trigger;
    setOpen(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousOverscrollBehavior = body.style.overscrollBehavior;
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';

    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));
      if (focusable.length === 0) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      body.style.overflow = previousOverflow;
      body.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [closeDrawer, open]);

  // A phone rotated into a desktop-sized viewport should never leave an
  // invisible modal holding the body scroll lock.
  React.useEffect(() => {
    const desktop = window.matchMedia('(min-width: 761px)');
    const handleDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && panelRef.current?.contains(activeElement)) {
          activeElement.blur();
        }
        setOpen(false);
      }
    };
    desktop.addEventListener('change', handleDesktop);
    return () => desktop.removeEventListener('change', handleDesktop);
  }, []);

  const selectItem = (item: BarItem) => {
    closeDrawer();
    item.onClick();
  };

  const selectSettings = () => {
    closeDrawer();
    onSettings();
  };

  const signOut = () => {
    closeDrawer();
    onSignOut();
  };

  const changeProperty = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const propertyId = event.target.value;
    closeDrawer();
    onPropertyChange(propertyId);
  };

  const changeLanguage = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = event.target.value;
    closeDrawer();
    onLanguageChange(nextLocale);
  };

  const install = () => {
    const returnFocusElement = activeTriggerRef.current ?? triggerRef.current;
    closeDrawer();
    onInstall(returnFocusElement);
  };

  const overlay = (
    <div
      className={`${styles.overlay}${open ? ` ${styles.overlayOpen}` : ''}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={styles.scrim}
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={() => closeDrawer()}
      />
      <aside
        id={drawerId}
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={navigationLabel}
      >
        <div className={styles.drawerHeader}>
          <div className={styles.drawerBrand} aria-label="Staxis">
            <CxLogo size={20} color="currentColor" />
            <span>Staxis</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.closeButton}
            onClick={() => closeDrawer()}
            aria-label={closeLabel}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.identity}>
          <div className={styles.userName}>{userName}</div>
          <div className={styles.userMeta}>{userMeta}</div>
        </div>

        <div className={styles.drawerScroll}>
          <div className={styles.eyebrow}>{sectionsLabel}</div>
          <nav className={styles.sectionList} aria-label={sectionsLabel}>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`${styles.navRow}${item.active ? ` ${styles.navRowActive}` : ''}`}
                onClick={() => selectItem(item)}
                aria-current={item.active ? 'page' : undefined}
              >
                <span className={styles.iconChip} aria-hidden="true">
                  <CxIcon
                    name={item.key as keyof typeof CX_ICON_PATHS}
                    size={17}
                  />
                </span>
                <span className={styles.rowLabel}>{item.label}</span>
                {typeof item.badge === 'number' && item.badge > 0 ? (
                  <span className={styles.badge} aria-label={`${item.badge}`}>
                    {item.badge}
                  </span>
                ) : null}
                <ChevronRight className={styles.chevron} size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            ))}
          </nav>

          <div className={styles.divider} aria-hidden="true" />

          <div className={styles.eyebrow}>{accountLabel}</div>
          <div className={styles.accountControls}>
            {propertyOptions.length > 1 ? (
              <label className={styles.accountControl}>
                <span>{propertyLabel}</span>
                <select
                  value={activePropertyId ?? ''}
                  onChange={changeProperty}
                  aria-label={propertyLabel}
                >
                  {!activePropertyId ? <option value="" disabled>{propertyLabel}</option> : null}
                  {propertyOptions.map((property) => (
                    <option key={property.value} value={property.value}>{property.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={styles.accountControl}>
              <span>{languageLabel}</span>
              <select value={activeLocale} onChange={changeLanguage} aria-label={languageLabel}>
                {languageOptions.map((language) => (
                  <option key={language.value} value={language.value}>{language.label}</option>
                ))}
              </select>
            </label>
          </div>

          {showInstallAction ? (
            <button type="button" className={styles.installRow} onClick={install}>
              <Download size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>{installLabel}</span>
            </button>
          ) : null}

          <div className={styles.divider} aria-hidden="true" />

          <button
            type="button"
            className={`${styles.navRow}${settingsActive ? ` ${styles.navRowActive}` : ''}`}
            onClick={selectSettings}
            aria-current={settingsActive ? 'page' : undefined}
          >
            <span className={styles.iconChip} aria-hidden="true">
              <CxIcon name="gear" size={17} />
            </span>
            <span className={styles.rowLabel}>{settingsLabel}</span>
            <ChevronRight className={styles.chevron} size={14} strokeWidth={2} aria-hidden="true" />
          </button>

          <button
            type="button"
            className={`${styles.navRow} ${styles.signOutRow}`}
            onClick={signOut}
          >
            <span className={`${styles.iconChip} ${styles.signOutChip}`} aria-hidden="true">
              <LogOut size={17} strokeWidth={1.8} />
            </span>
            <span className={styles.rowLabel}>{signOutLabel}</span>
          </button>
        </div>
      </aside>
    </div>
  );

  return (
    <>
      <header className={styles.mobileHeader}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.menuButton}
          onClick={(event) => openDrawer(event.currentTarget)}
          aria-label={menuLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={drawerId}
        >
          <Menu size={20} strokeWidth={1.9} aria-hidden="true" />
        </button>

        <button type="button" className={styles.topBrand} onClick={onHome} aria-label={homeLabel}>
          <CxLogo size={20} color="currentColor" />
          <span>Staxis</span>
        </button>

        <button
          type="button"
          className={styles.avatar}
          onClick={(event) => openDrawer(event.currentTarget)}
          aria-label={accountMenuLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={drawerId}
        >
          {userInitial}
        </button>
      </header>
      {mounted ? createPortal(overlay, document.body) : null}
    </>
  );
}
