import { notFound } from 'next/navigation';

import { PortfolioSectionClient } from '@/app/portfolio/[section]/PortfolioSectionClient';
import { isPortfolioUiSection } from '@/lib/portfolio-ui/contracts';

export const dynamic = 'force-dynamic';

export default async function PortfolioSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section !== 'staxis' && !isPortfolioUiSection(section)) notFound();
  return <PortfolioSectionClient section={section} />;
}
