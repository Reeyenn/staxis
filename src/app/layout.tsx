import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { PropertyProvider } from '@/contexts/PropertyContext';
import { SyncProvider } from '@/contexts/SyncContext';

export const metadata: Metadata = {
  title: 'HotelOps AI — Hotel Operations Platform',
  description: 'AI-powered operations platform for limited-service hotel owners and managers',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#060c14',
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
        <meta name="apple-mobile-web-app-title" content="HotelOps AI" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
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
