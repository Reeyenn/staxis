'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BedDouble,
  Building2,
  Check,
  ChevronDown,
  Command,
  DollarSign,
  Grid2X2,
  House,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Package,
  PanelLeft,
  Search,
  Settings,
  Sparkles,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { LanguageMenu } from '@/components/i18n/LanguageMenu';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useCan } from '@/lib/capabilities/useCan';
import {
  SECTION_LIST,
  sectionForPath,
  type AppSection,
  type SectionMeta,
} from '@/lib/sections/registry';
import { useEnabledSections } from '@/lib/sections/useSectionEnabled';
import { roleLabel, type AppRole } from '@/lib/roles';
import './StaffShell.css';

export type StaffShellVariant = 'hotel-rail' | 'command-canvas';

export interface StaffShellPreference {
  variant: StaffShellVariant;
  setVariant: (variant: StaffShellVariant) => void;
}

export const STAFF_SHELL_PREFERENCE_KEY = 'staxis-staff-shell-variant';

const StaffShellPreferenceContext = createContext<StaffShellPreference>({
  variant: 'hotel-rail',
  setVariant: () => {},
});

export function useStaffShellPreference(): StaffShellPreference {
  return useContext(StaffShellPreferenceContext);
}

export interface StaffShellProps {
  children: React.ReactNode;
  /** Optional action rendered in the shell's review/activity position. */
  aiActivityAction?: React.ReactNode;
  /** Fixed assistant, voice, and feedback surfaces that need shell insets. */
  fixedSurfaces?: React.ReactNode;
  /** Controlled reviewer variant. Omit to use the persisted preference. */
  variant?: StaffShellVariant;
  defaultVariant?: StaffShellVariant;
  /** Temporary design-review control; disable once a direction is selected. */
  showReviewerSwitch?: boolean;
  onVariantChange?: (variant: StaffShellVariant) => void;
  /** Lets a parent coordinate fixed assistant/feedback surfaces with the shell. */
  onPreferenceChange?: (preference: StaffShellPreference) => void;
  /** Safe unsigned preview: sample identity/property and inert navigation. */
  previewMode?: boolean;
}

type OpenMenu = 'property' | 'profile' | null;

const ICONS: Record<AppSection, LucideIcon> = {
  staxis: Sparkles,
  dashboard: LayoutDashboard,
  housekeeping: BedDouble,
  communications: MessageSquareText,
  maintenance: Wrench,
  inventory: Package,
  staff: Users,
  financials: DollarSign,
};

const PREVIEW_PROPERTY = {
  id: 'preview-property',
  name: 'Harborlight Hotel',
};

const PREVIEW_USER = {
  displayName: 'Jordan Lee',
  role: 'General Manager',
};

function isShellVariant(value: string | null): value is StaffShellVariant {
  return value === 'hotel-rail' || value === 'command-canvas';
}

function labelFor(meta: SectionMeta, spanish: boolean) {
  return spanish ? meta.label_es : meta.label_en;
}

function descriptionFor(meta: SectionMeta, spanish: boolean) {
  return spanish ? meta.desc_es : meta.desc_en;
}

function localizedRole(role: AppRole, spanish: boolean) {
  if (!spanish) return roleLabel(role);
  return ({
    admin: 'Administración de Staxis',
    owner: 'Propietario',
    general_manager: 'Gerencia general',
    front_desk: 'Recepción',
    housekeeping: 'Limpieza',
    maintenance: 'Mantenimiento',
    staff: 'Personal',
  } satisfies Record<AppRole, string>)[role];
}

function previewHref(href: string, previewMode: boolean) {
  if (!previewMode) return href;
  return `#staff-shell-preview-${href.replace(/^\//, '').replaceAll('/', '-') || 'home'}`;
}

export function StaffShell({
  children,
  aiActivityAction,
  fixedSurfaces,
  variant: controlledVariant,
  defaultVariant = 'hotel-rail',
  showReviewerSwitch = true,
  onVariantChange,
  onPreferenceChange,
  previewMode = false,
}: StaffShellProps) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const { lang } = useLang();
  const { properties, activeProperty, setActivePropertyId } = useProperty();
  const can = useCan();
  const enabled = useEnabledSections();
  const spanish = lang === 'es';

  const [internalVariant, setInternalVariant] = useState<StaffShellVariant>(defaultVariant);
  const [hydratedPreference, setHydratedPreference] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const launcherCloseRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

  const variant = controlledVariant ?? internalVariant;

  useEffect(() => {
    if (controlledVariant) {
      setHydratedPreference(true);
      return;
    }
    const stored = window.localStorage.getItem(STAFF_SHELL_PREFERENCE_KEY);
    if (isShellVariant(stored)) setInternalVariant(stored);
    setHydratedPreference(true);
  }, [controlledVariant]);

  const setVariant = useCallback((next: StaffShellVariant) => {
    if (!controlledVariant) setInternalVariant(next);
    window.localStorage.setItem(STAFF_SHELL_PREFERENCE_KEY, next);
    onVariantChange?.(next);
    setLauncherOpen(false);
    setMobileMoreOpen(false);
  }, [controlledVariant, onVariantChange]);

  const preference = useMemo<StaffShellPreference>(
    () => ({ variant, setVariant }),
    [variant, setVariant],
  );

  useEffect(() => {
    if (hydratedPreference) onPreferenceChange?.(preference);
  }, [hydratedPreference, onPreferenceChange, preference]);

  useEffect(() => {
    setOpenMenu(null);
    setLauncherOpen(false);
    setMobileMoreOpen(false);
  }, [pathname]);

  const openAskCommand = useCallback(() => {
    window.dispatchEvent(new CustomEvent('staxis:open-command'));
  }, []);

  useEffect(() => {
    const onCommandKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      openAskCommand();
    };
    window.addEventListener('keydown', onCommandKey);
    return () => window.removeEventListener('keydown', onCommandKey);
  }, [openAskCommand]);

  useEffect(() => {
    if (!launcherOpen && !mobileMoreOpen) return;
    const activeClose = launcherOpen ? launcherCloseRef.current : mobileCloseRef.current;
    const prior = document.activeElement as HTMLElement | null;
    activeClose?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLauncherOpen(false);
        setMobileMoreOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.staff-launcher[role="dialog"]');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((node) => node.getClientRects().length > 0);
      if (focusable.length === 0) return;
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
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      prior?.focus();
    };
  }, [launcherOpen, mobileMoreOpen]);

  const sections = useMemo(() => SECTION_LIST.filter((meta) => {
    if (!enabled[meta.key]) return false;
    if (meta.key === 'financials' && !previewMode && !can('view_financials')) return false;
    return true;
  }), [can, enabled, previewMode]);

  const currentSection = sectionForPath(pathname);
  const currentMeta = currentSection ? sections.find((meta) => meta.key === currentSection) : null;
  const currentLabel = pathname.startsWith('/settings')
    ? (spanish ? 'Configuración' : 'Settings')
    : pathname.startsWith('/chat')
      ? (spanish ? 'Preguntar a Staxis' : 'Ask Staxis')
      : currentMeta
        ? labelFor(currentMeta, spanish)
        : (spanish ? 'Operaciones del hotel' : 'Hotel operations');

  const propertyOptions = previewMode && properties.length === 0
    ? [PREVIEW_PROPERTY]
    : properties.map((property) => ({ id: property.id, name: property.name }));
  const propertyName = activeProperty?.name
    ?? (previewMode ? PREVIEW_PROPERTY.name : (spanish ? 'Selecciona un hotel' : 'Select a hotel'));
  const displayName = user?.displayName || (previewMode ? PREVIEW_USER.displayName : (spanish ? 'Mi cuenta' : 'My account'));
  const displayRole = user?.role
    ? localizedRole(user.role, spanish)
    : (previewMode ? PREVIEW_USER.role : '');
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'ST';

  const workSection: AppSection = user?.role === 'maintenance'
    ? 'maintenance'
    : user?.role === 'front_desk'
      ? 'communications'
      : 'housekeeping';
  const workMeta = sections.find((meta) => meta.key === workSection)
    ?? sections.find((meta) => meta.key === 'dashboard')
    ?? sections[0];
  const dashboardMeta = sections.find((meta) => meta.key === 'dashboard') ?? sections[0];
  const staxisMeta = sections.find((meta) => meta.key === 'staxis') ?? sections[0];
  const communicationsMeta = sections.find((meta) => meta.key === 'communications') ?? sections[0];
  const mobileSecondaryMeta = communicationsMeta?.key === workMeta?.key
    ? (sections.find((meta) => meta.key === 'inventory') ?? sections.find((meta) => meta.key !== workMeta?.key))
    : communicationsMeta;

  const closeOverlays = () => {
    setLauncherOpen(false);
    setMobileMoreOpen(false);
  };

  const onPreviewLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (previewMode) event.preventDefault();
    closeOverlays();
  };

  const chooseProperty = (id: string) => {
    if (!previewMode) {
      setActivePropertyId(id);
      window.sessionStorage.setItem('hotelops-session-selected', '1');
    }
    setOpenMenu(null);
  };

  const handleSignOut = () => {
    setOpenMenu(null);
    if (!previewMode) void signOut();
  };

  return (
    <StaffShellPreferenceContext.Provider value={preference}>
      <div
        className={`staff-shell staff-shell--${variant}`}
        data-staff-shell-variant={variant}
        data-preference-ready={hydratedPreference ? 'true' : 'false'}
      >
        <a className="staff-shell__skip-link" href="#staff-shell-main">
          {spanish ? 'Saltar al contenido' : 'Skip to content'}
        </a>

        <header className="staff-topbar">
          <div className="staff-topbar__leading">
            {variant === 'command-canvas' && (
              <button
                type="button"
                className="staff-icon-button staff-topbar__launcher-button"
                onClick={() => setLauncherOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={launcherOpen}
                aria-label={spanish ? 'Abrir aplicaciones' : 'Open apps'}
              >
                <Grid2X2 size={19} />
              </button>
            )}

            <Link
              href={previewHref('/dashboard', previewMode)}
              onClick={onPreviewLink}
              className="staff-brand"
              aria-label={spanish ? 'Staxis, ir al panel' : 'Staxis, go to dashboard'}
            >
              <span className="staff-brand__mark" aria-hidden="true"><Sparkles size={16} /></span>
              <span className="staff-brand__name">Staxis</span>
            </Link>

            <div className="staff-property-control">
              <button
                type="button"
                className="staff-property-control__trigger"
                onClick={() => setOpenMenu(openMenu === 'property' ? null : 'property')}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'property'}
              >
                <Building2 size={15} aria-hidden="true" />
                <span>{propertyName}</span>
                {propertyOptions.length > 0 && <ChevronDown size={14} aria-hidden="true" />}
              </button>
              {openMenu === 'property' && (
                <ShellPopoverScrim onClose={() => setOpenMenu(null)} closeLabel={spanish ? 'Cerrar menú' : 'Close menu'}>
                  <div className="staff-popover staff-popover--property" role="menu" aria-label={spanish ? 'Hoteles' : 'Hotels'}>
                    <div className="staff-popover__heading">{spanish ? 'Hotel activo' : 'Active hotel'}</div>
                    {propertyOptions.map((property) => {
                      const active = property.name === propertyName;
                      return (
                        <button
                          key={property.id}
                          type="button"
                          role="menuitem"
                          className="staff-popover__row"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => chooseProperty(property.id)}
                        >
                          <Building2 size={16} />
                          <span>{property.name}</span>
                          {active && <Check size={15} className="staff-popover__check" />}
                        </button>
                      );
                    })}
                  </div>
                </ShellPopoverScrim>
              )}
            </div>
          </div>

          {variant === 'hotel-rail' ? (
            <div className="staff-topbar__page-title" aria-live="polite">
              <span>{currentLabel}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={openAskCommand}
              className="staff-command-bar"
              aria-label={spanish ? 'Preguntar a Staxis' : 'Ask Staxis'}
            >
              <Sparkles size={17} aria-hidden="true" />
              <span>{spanish ? 'Pregúntale cualquier cosa a Staxis…' : 'Ask Staxis anything about the hotel…'}</span>
              <kbd><Command size={12} /> K</kbd>
            </button>
          )}

          <div className="staff-topbar__actions">
            {showReviewerSwitch && (
              <ReviewerSwitch
                variant={variant}
                onChange={setVariant}
                spanish={spanish}
                className="staff-review-switch--topbar"
              />
            )}
            {aiActivityAction && <div className="staff-topbar__ai-action">{aiActivityAction}</div>}
            <div className="staff-topbar__desktop-utility"><LanguageMenu compact /></div>
            <div className="staff-topbar__desktop-utility"><ThemeToggle compact /></div>
            <Link
              href={previewHref('/settings', previewMode)}
              onClick={onPreviewLink}
              className={`staff-icon-button staff-topbar__desktop-utility${pathname.startsWith('/settings') ? ' is-active' : ''}`}
              aria-label={spanish ? 'Configuración' : 'Settings'}
              aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
            >
              <Settings size={18} />
            </Link>

            <div className="staff-profile-control">
              <button
                type="button"
                className="staff-profile-control__trigger"
                onClick={() => setOpenMenu(openMenu === 'profile' ? null : 'profile')}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'profile'}
                aria-label={spanish ? 'Menú de usuario' : 'User menu'}
              >
                {initials}
              </button>
              {openMenu === 'profile' && (
                <ShellPopoverScrim onClose={() => setOpenMenu(null)} closeLabel={spanish ? 'Cerrar menú' : 'Close menu'}>
                  <div className="staff-popover staff-popover--profile" role="menu" aria-label={spanish ? 'Cuenta' : 'Account'}>
                    <div className="staff-profile-summary">
                      <span className="staff-profile-summary__avatar" aria-hidden="true">{initials}</span>
                      <span>
                        <strong>{displayName}</strong>
                        {displayRole && <small>{displayRole}</small>}
                      </span>
                    </div>
                    <Link
                      role="menuitem"
                      href={previewHref('/settings', previewMode)}
                      onClick={(event) => { onPreviewLink(event); setOpenMenu(null); }}
                      className="staff-popover__row"
                    >
                      <Settings size={16} />
                      <span>{spanish ? 'Configuración' : 'Settings'}</span>
                    </Link>
                    <div className="staff-popover__theme"><ThemeToggle /></div>
                    <button type="button" role="menuitem" className="staff-popover__row staff-popover__row--danger" onClick={handleSignOut}>
                      <LogOut size={16} />
                      <span>{spanish ? 'Cerrar sesión' : 'Sign out'}</span>
                    </button>
                  </div>
                </ShellPopoverScrim>
              )}
            </div>
          </div>
        </header>

        <div className="staff-shell__body">
          {variant === 'hotel-rail' && (
            <aside className="staff-rail" aria-label={spanish ? 'Navegación principal' : 'Main navigation'}>
              <nav className="staff-rail__nav">
                <div className="staff-rail__section-label">{spanish ? 'Hoy' : 'Today'}</div>
                {sections.slice(0, 2).map((meta) => (
                  <RailLink
                    key={meta.key}
                    meta={meta}
                    spanish={spanish}
                    active={currentSection === meta.key}
                    previewMode={previewMode}
                    onPreviewLink={onPreviewLink}
                  />
                ))}

                <div className="staff-rail__section-label">{spanish ? 'Operaciones' : 'Operations'}</div>
                {sections.filter((meta) => !['staxis', 'dashboard', 'financials'].includes(meta.key)).map((meta) => (
                  <RailLink
                    key={meta.key}
                    meta={meta}
                    spanish={spanish}
                    active={currentSection === meta.key}
                    previewMode={previewMode}
                    onPreviewLink={onPreviewLink}
                  />
                ))}

                {sections.some((meta) => meta.key === 'financials') && (
                  <>
                    <div className="staff-rail__section-label">{spanish ? 'Administración' : 'Management'}</div>
                    {sections.filter((meta) => meta.key === 'financials').map((meta) => (
                      <RailLink
                        key={meta.key}
                        meta={meta}
                        spanish={spanish}
                        active={currentSection === meta.key}
                        previewMode={previewMode}
                        onPreviewLink={onPreviewLink}
                      />
                    ))}
                  </>
                )}
              </nav>

              <div className="staff-rail__footer">
                <button
                  type="button"
                  onClick={openAskCommand}
                  className="staff-rail__ask"
                >
                  <Sparkles size={18} />
                  <span>{spanish ? 'Preguntar a Staxis' : 'Ask Staxis'}</span>
                </button>
                <Link
                  href={previewHref('/settings', previewMode)}
                  onClick={onPreviewLink}
                  className={`staff-rail__link${pathname.startsWith('/settings') ? ' is-active' : ''}`}
                  aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
                >
                  <Settings size={19} />
                  <span>{spanish ? 'Configuración' : 'Settings'}</span>
                </Link>
              </div>
            </aside>
          )}

          <div id="staff-shell-main" className="staff-shell__main" tabIndex={-1}>
            {children}
          </div>
        </div>

        <MobileNavigation
          dashboard={dashboardMeta}
          work={workMeta}
          staxis={staxisMeta}
          communications={mobileSecondaryMeta}
          currentSection={currentSection}
          spanish={spanish}
          previewMode={previewMode}
          variant={variant}
          onPreviewLink={onPreviewLink}
          onMore={() => setMobileMoreOpen(true)}
        />

        {launcherOpen && (
          <WorkspaceLauncher
            title={spanish ? 'Aplicaciones del hotel' : 'Hotel workspaces'}
            subtitle={spanish ? 'Abre el área que necesitas.' : 'Open the area you need.'}
            sections={sections}
            currentSection={currentSection}
            spanish={spanish}
            previewMode={previewMode}
            onPreviewLink={onPreviewLink}
            onClose={() => setLauncherOpen(false)}
            closeRef={launcherCloseRef}
            showReviewerSwitch={showReviewerSwitch}
            variant={variant}
            setVariant={setVariant}
          />
        )}

        {mobileMoreOpen && (
          <WorkspaceLauncher
            title={spanish ? 'Más áreas' : (variant === 'command-canvas' ? 'Apps' : 'More areas')}
            subtitle={propertyName}
            sections={sections}
            currentSection={currentSection}
            spanish={spanish}
            previewMode={previewMode}
            onPreviewLink={onPreviewLink}
            onClose={() => setMobileMoreOpen(false)}
            closeRef={mobileCloseRef}
            mobileSheet
            showReviewerSwitch={showReviewerSwitch}
            variant={variant}
            setVariant={setVariant}
          />
        )}

        {fixedSurfaces}
      </div>
    </StaffShellPreferenceContext.Provider>
  );
}

function ShellPopoverScrim({ children, onClose, closeLabel }: { children: React.ReactNode; onClose: () => void; closeLabel: string }) {
  return (
    <>
      <button type="button" className="staff-popover-scrim" onClick={onClose} aria-label={closeLabel} />
      {children}
    </>
  );
}

function ReviewerSwitch({
  variant,
  onChange,
  spanish,
  className = '',
}: {
  variant: StaffShellVariant;
  onChange: (variant: StaffShellVariant) => void;
  spanish: boolean;
  className?: string;
}) {
  return (
    <div className={`staff-review-switch ${className}`} role="group" aria-label={spanish ? 'Diseño de navegación' : 'Navigation design'}>
      <button
        type="button"
        className={variant === 'hotel-rail' ? 'is-active' : ''}
        aria-pressed={variant === 'hotel-rail'}
        onClick={() => onChange('hotel-rail')}
        title={spanish ? 'Diseño con barra lateral' : 'Hotel Rail layout'}
      >
        <PanelLeft size={15} />
        <span>{spanish ? 'Barra' : 'Rail'}</span>
      </button>
      <button
        type="button"
        className={variant === 'command-canvas' ? 'is-active' : ''}
        aria-pressed={variant === 'command-canvas'}
        onClick={() => onChange('command-canvas')}
        title={spanish ? 'Diseño de comando' : 'Command Canvas layout'}
      >
        <Grid2X2 size={15} />
        <span>{spanish ? 'Lienzo' : 'Canvas'}</span>
      </button>
    </div>
  );
}

function RailLink({
  meta,
  spanish,
  active,
  previewMode,
  onPreviewLink,
}: {
  meta: SectionMeta;
  spanish: boolean;
  active: boolean;
  previewMode: boolean;
  onPreviewLink: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const Icon = ICONS[meta.key];
  return (
    <Link
      href={previewHref(meta.navHref, previewMode)}
      onClick={onPreviewLink}
      className={`staff-rail__link${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={labelFor(meta, spanish)}
    >
      <Icon size={19} />
      <span>{labelFor(meta, spanish)}</span>
      {previewMode && meta.key === 'staxis' && <span className="staff-rail__status-dot" aria-label={spanish ? 'Decisiones pendientes' : 'Pending decisions'} />}
    </Link>
  );
}

function MobileNavigation({
  dashboard,
  work,
  staxis,
  communications,
  currentSection,
  spanish,
  previewMode,
  variant,
  onPreviewLink,
  onMore,
}: {
  dashboard?: SectionMeta;
  work?: SectionMeta;
  staxis?: SectionMeta;
  communications?: SectionMeta;
  currentSection: AppSection | null;
  spanish: boolean;
  previewMode: boolean;
  variant: StaffShellVariant;
  onPreviewLink: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onMore: () => void;
}) {
  const items = [
    dashboard && { meta: dashboard, label: spanish ? 'Hoy' : 'Today', Icon: House },
    work && { meta: work, label: spanish ? 'Trabajo' : 'Work', Icon: ICONS[work.key] },
    staxis && { meta: staxis, label: 'Staxis', Icon: Sparkles, primary: true },
    communications && {
      meta: communications,
      label: communications.key === 'communications'
        ? (spanish ? 'Mensajes' : 'Messages')
        : labelFor(communications, spanish),
      Icon: ICONS[communications.key],
    },
  ].filter(Boolean) as Array<{ meta: SectionMeta; label: string; Icon: LucideIcon; primary?: boolean }>;

  return (
    <nav className="staff-mobile-nav" aria-label={spanish ? 'Navegación móvil' : 'Mobile navigation'}>
      {items.map(({ meta, label, Icon, primary }) => {
        const active = currentSection === meta.key;
        return (
          <Link
            key={`${meta.key}-${label}`}
            href={previewHref(meta.navHref, previewMode)}
            onClick={onPreviewLink}
            className={`staff-mobile-nav__item${active ? ' is-active' : ''}${primary ? ' is-primary' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="staff-mobile-nav__icon"><Icon size={primary ? 21 : 19} /></span>
            <span>{label}</span>
          </Link>
        );
      })}
      <button type="button" className="staff-mobile-nav__item" onClick={onMore} aria-haspopup="dialog">
        <span className="staff-mobile-nav__icon">{variant === 'command-canvas' ? <Grid2X2 size={19} /> : <Menu size={20} />}</span>
        <span>{variant === 'command-canvas' ? 'Apps' : (spanish ? 'Más' : 'More')}</span>
      </button>
    </nav>
  );
}

function WorkspaceLauncher({
  title,
  subtitle,
  sections,
  currentSection,
  spanish,
  previewMode,
  onPreviewLink,
  onClose,
  closeRef,
  mobileSheet = false,
  showReviewerSwitch,
  variant,
  setVariant,
}: {
  title: string;
  subtitle: string;
  sections: readonly SectionMeta[];
  currentSection: AppSection | null;
  spanish: boolean;
  previewMode: boolean;
  onPreviewLink: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onClose: () => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  mobileSheet?: boolean;
  showReviewerSwitch: boolean;
  variant: StaffShellVariant;
  setVariant: (variant: StaffShellVariant) => void;
}) {
  return (
    <div className={`staff-launcher${mobileSheet ? ' staff-launcher--sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby="staff-launcher-title">
      <button type="button" className="staff-launcher__scrim" onClick={onClose} aria-label={spanish ? 'Cerrar' : 'Close'} />
      <section className="staff-launcher__panel">
        <header className="staff-launcher__header">
          <div>
            <h2 id="staff-launcher-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button ref={closeRef} type="button" className="staff-icon-button" onClick={onClose} aria-label={spanish ? 'Cerrar' : 'Close'}>
            <X size={19} />
          </button>
        </header>

        <div className="staff-launcher__search" aria-hidden="true">
          <Search size={17} />
          <span>{spanish ? 'Elige un área del hotel' : 'Choose a hotel workspace'}</span>
        </div>

        <div className="staff-launcher__grid">
          {sections.map((meta, index) => {
            const Icon = ICONS[meta.key];
            const active = currentSection === meta.key;
            return (
              <Link
                key={meta.key}
                href={previewHref(meta.navHref, previewMode)}
                onClick={onPreviewLink}
                className={`staff-launcher-card${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                style={{ '--launcher-index': index } as React.CSSProperties}
              >
                <span className="staff-launcher-card__icon"><Icon size={21} /></span>
                <span className="staff-launcher-card__copy">
                  <strong>{labelFor(meta, spanish)}</strong>
                  <small>{descriptionFor(meta, spanish)}</small>
                </span>
                {previewMode && meta.key === 'staxis' && <span className="staff-launcher-card__badge">3</span>}
              </Link>
            );
          })}
        </div>

        <footer className="staff-launcher__footer">
          <Link href={previewHref('/settings', previewMode)} onClick={onPreviewLink} className="staff-launcher__utility">
            <Settings size={17} />
            <span>{spanish ? 'Configuración' : 'Settings'}</span>
          </Link>
          <div className="staff-launcher__utility-control"><LanguageMenu /></div>
          <div className="staff-launcher__utility-control"><ThemeToggle /></div>
          {showReviewerSwitch && (
            <ReviewerSwitch variant={variant} onChange={setVariant} spanish={spanish} className="staff-review-switch--launcher" />
          )}
        </footer>
      </section>
    </div>
  );
}
