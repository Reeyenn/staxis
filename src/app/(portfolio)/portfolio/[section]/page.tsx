import { notFound, redirect } from 'next/navigation';

import { PortfolioSectionClient } from '@/app/portfolio/[section]/PortfolioSectionClient';
import { companyScopeHref } from '@/lib/portfolio-ui/acting-scope';
import { isPortfolioUiSection } from '@/lib/portfolio-ui/contracts';
import { isPortfolioUiUuid } from '@/lib/portfolio-ui/context';

export const dynamic = 'force-dynamic';

export default async function PortfolioSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  if (section === 'communications') {
    // The old company-wide module is retired. Preserve only a valid company
    // selector so the personal Messages inbox can resolve its exact hotel
    // coverage; never carry portfolio filters or arbitrary query state across.
    const query = searchParams ? await searchParams : undefined;
    const organizationId = typeof query?.organizationId === 'string'
      && isPortfolioUiUuid(query.organizationId)
      ? query.organizationId
      : null;
    redirect(organizationId
      ? companyScopeHref('/communications', organizationId)
      : '/communications');
  }
  if (section !== 'staxis' && !isPortfolioUiSection(section)) notFound();
  return <PortfolioSectionClient section={section} />;
}
