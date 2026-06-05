'use client';

// Snow page chrome for the Agents screens (back link + serif title + eyebrow),
// plus the manager-gate and no-property fallbacks. Matches settings/wages.

import React from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { T, fonts, Caps } from './_tokens';
import { s, type Lang } from '../_lib/strings';

export function PageShell({
  eyebrow, title, lang, backHref = '/settings', backLabel, headerRight, children,
}: {
  eyebrow: string;
  title: string;
  lang: Lang;
  backHref?: string;
  backLabel: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%', padding: '24px 48px 48px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <Link href={backHref} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: fonts.sans, fontSize: 12, color: T.ink2, textDecoration: 'none', marginBottom: 14 }}>
          <ChevronLeft size={14} /> {backLabel}
        </Link>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
          <div>
            <Caps>{eyebrow}</Caps>
            <h1 style={{ fontFamily: fonts.serif, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.1, fontWeight: 400 }}>
              <span style={{ fontStyle: 'italic' }}>{title}</span>
            </h1>
          </div>
          {headerRight}
        </div>
        {children}
      </div>
    </div>
  );
}

export function AccessDenied({ lang }: { lang: Lang }) {
  return (
    <div style={{ padding: 24, fontFamily: fonts.sans, color: T.ink2 }}>{s(lang, 'managerOnly')}</div>
  );
}

export function NoProperty({ lang }: { lang: Lang }) {
  return (
    <div style={{ padding: '20px 0', fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2 }}>{s(lang, 'selectProperty')}</div>
  );
}
