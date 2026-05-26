'use client';

/**
 * BackToPortfolioBreadcrumb — top-of-page breadcrumb shown on per-
 * property pages (Housekeeping, Maintenance, Inventory, Staff,
 * Front Desk) for users with access to 2+ properties.
 *
 * For single-property users the component renders nothing (no
 * portfolio = no breadcrumb noise). Multi-property users get a clear
 * "Portfolio › [Property Name] › Housekeeping" anchor at the top of
 * every main page so they can always return to the cross-property view
 * with a single click.
 *
 * Drop-in usage on any main page:
 *   <BackToPortfolioBreadcrumb section="Housekeeping" />
 *
 * The component does its own role/property-count gate, so the parent
 * never needs to add conditional rendering.
 */

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useProperty } from '@/contexts/PropertyContext';
import { ChevronRight, ArrowLeft } from 'lucide-react';

interface Props {
  /**
   * Section name shown as the rightmost breadcrumb crumb. Should match
   * the page's header (e.g. "Housekeeping", "Front Desk"). Falls back
   * to a generic "Operations" label if omitted.
   */
  section?: string;
  /**
   * Bilingual override for the section label. When provided, picks the
   * EN/ES variant based on the active language. Takes precedence over
   * `section` if both are supplied.
   */
  sectionLabel?: { en: string; es: string };
}

export function BackToPortfolioBreadcrumb({ section, sectionLabel }: Props) {
  const { isMultiProperty, returnToPortfolio } = usePortfolio();
  const { activeProperty } = useProperty();
  const { lang } = useLang();

  // Hide for single-property users entirely — keeps the layout tight
  // for the common case where there's nothing to switch between.
  if (!isMultiProperty) return null;

  const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
  const ink   = 'var(--snow-ink)';
  const ink2  = 'var(--snow-ink2)';
  const ink3  = 'var(--snow-ink3)';
  const rule  = 'var(--snow-rule)';
  const sage  = 'var(--snow-sage-deep)';

  const portfolioLabel = lang === 'es' ? 'Portafolio' : 'Portfolio';
  const fallbackSection = lang === 'es' ? 'Operaciones' : 'Operations';
  const sectionText =
    sectionLabel ? (lang === 'es' ? sectionLabel.es : sectionLabel.en)
                 : (section ?? fallbackSection);

  return (
    <div style={{
      borderBottom: `1px solid ${rule}`,
      background: 'var(--snow-bg)',
      padding: '10px clamp(16px, 3vw, 48px)',
      display: 'flex', alignItems: 'center', gap: '6px',
      fontFamily: sansFont, fontSize: '12px',
      whiteSpace: 'nowrap', overflowX: 'auto',
      scrollbarWidth: 'none',
    }}>
      <button
        type="button"
        onClick={returnToPortfolio}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: sage, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600,
          padding: '4px 8px', borderRadius: '6px',
          textDecoration: 'none',
        }}
        aria-label={lang === 'es' ? 'Volver al portafolio' : 'Back to portfolio'}
      >
        <ArrowLeft size={12} />
        {portfolioLabel}
      </button>
      <ChevronRight size={12} color={ink3} aria-hidden="true" />
      <button
        type="button"
        // Click the property name to open the in-Header switcher hint.
        // Without a separate switcher modal we route to /portfolio so
        // the operator can pick a different property visually. Simple,
        // unsurprising, no extra UI to maintain.
        onClick={returnToPortfolio}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: ink, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 500,
          padding: '4px 4px',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px',
        }}
      >
        {activeProperty?.name ?? (lang === 'es' ? 'Sin propiedad' : 'No property')}
      </button>
      <ChevronRight size={12} color={ink3} aria-hidden="true" />
      <span style={{ color: ink2, fontWeight: 500 }}>{sectionText}</span>
    </div>
  );
}
