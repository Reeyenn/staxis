import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { PropertyProvider } from '@/contexts/PropertyContext';
import { SyncProvider } from '@/contexts/SyncContext';

export const metadata: Metadata = {
  title: 'Staxis - Hotel Operations Platform',
  description: 'AI-powered operations platform for limited-service hotel owners and managers',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#F0F2F5',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Staxis" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          display=block (NOT swap) for the icon font.
          Why it matters: Material Symbols renders an icon by reading the
          literal text inside <span class="material-symbols-outlined">groups</span>
          and substituting a glyph via OpenType ligatures. With display=swap,
          the browser shows the FALLBACK text (the literal word "groups",
          "calendar_month", etc.) until the font finishes loading — that
          word-flash is what users were seeing as the "buggy" icon labels.
          display=block holds the text invisible for up to 3s while the
          font loads, so on cold-cache loads the icons appear correctly
          instead of flashing as English words first.

          Next.js wants us to use `next/font` for fonts and to set
          display=swap for performance. We deliberately ignore both rules
          here because (a) Material Symbols is an *icon* font, not a text
          font, and the flash-of-fallback-text is a UX bug for icons;
          (b) `next/font` doesn't support OpenType ligature swapping the
          way Material Symbols needs.
        */}
        {/* eslint-disable-next-line @next/next/google-font-display, @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block" />
      </head>
      <body>
        <SyncProvider>
          <AuthProvider>
            <LanguageProvider>
              <PropertyProvider>
                {children}
              </PropertyProvider>
            </LanguageProvider>
          </AuthProvider>
        </SyncProvider>
      </body>
    </html>
  );
}
