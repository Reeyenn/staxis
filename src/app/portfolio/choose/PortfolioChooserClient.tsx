'use client';

import React from 'react';
import { useRouter } from 'next/navigation';

import { ScopeChooser, type PortfolioScopeOption } from '@/components/portfolio';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useProperty } from '@/contexts/PropertyContext';
import { buildPortfolioHotelSecondaryLabels } from '@/lib/portfolio-ui/context';

function shortId(value: string): string {
  return value.replaceAll('-', '').slice(0, 8).toUpperCase();
}

export function PortfolioChooserClient() {
  const portfolio = usePortfolio();
  const { properties } = useProperty();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const data = portfolio.data;

  const companyChoices = React.useMemo<PortfolioScopeOption[]>(() => {
    const contexts = data?.contexts ?? [];
    const nameCounts = new Map<string, number>();
    for (const context of contexts) {
      const key = (context.organizationName ?? 'Company').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    return contexts.map((context) => {
      const name = context.organizationName ?? 'Company';
      const key = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      const collisionSuffix = (nameCounts.get(key) ?? 0) > 1
        ? ` · Company ${shortId(context.organizationId)}`
        : '';
      return {
        id: context.organizationId,
        kind: 'portfolio' as const,
        eyebrow: 'Portfolio',
        name,
        secondaryLabel: `${context.hotelCount} authorized ${context.hotelCount === 1 ? 'hotel' : 'hotels'}${collisionSuffix}`,
        status: context.chat.state === 'unavailable'
          ? { label: 'Some services unavailable', tone: 'warning' as const }
          : null,
        facts: [
          // Never render the raw stored word. It used to fall through to the
          // bare token for anything that was not `vp`, which put "finance" on
          // screen as a role nobody had chosen.
          {
            label: 'Acting role',
            value: context.companyRole === 'owner' ? 'Owner' : 'Regional Manager',
          },
        ],
      };
    });
  }, [data?.contexts]);

  // With more than one company the first decision is deliberately the company,
  // never a flat hotel chooser. Inside one company, the same screen can also
  // make a deliberate hotel acting-context switch. Hotels outside every
  // company context (a legacy independent assignment or a property-scope job)
  // remain available after that first company choice, without flattening the
  // other companies' hotel names into the chooser.
  const companySelected = data?.selection.state === 'selected' && !!data.selectedCompany;
  const hotelChoices = React.useMemo<PortfolioScopeOption[]>(() => {
    if ((data?.contexts.length ?? 0) > 1 && !companySelected) return [];
    const companyHotelIds = new Set((data?.hotels ?? []).map((hotel) => hotel.propertyId));
    const labelSources = [
      ...(data?.hotels ?? []),
      ...properties
        .filter((hotel) => !companyHotelIds.has(hotel.id))
        .map((hotel) => ({ propertyId: hotel.id, name: hotel.name })),
    ];
    const secondaryLabels = buildPortfolioHotelSecondaryLabels(labelSources);
    const choices: PortfolioScopeOption[] = (data?.hotels ?? []).map((hotel) => ({
        id: hotel.propertyId,
        kind: 'hotel' as const,
        eyebrow: 'Hotel',
        name: hotel.name,
        secondaryLabel: secondaryLabels[hotel.propertyId],
        status: hotel.status === 'critical'
          ? { label: 'Critical issue', tone: 'critical' as const }
          : hotel.status === 'attention'
            ? { label: 'Needs attention', tone: 'warning' as const }
            : hotel.status === 'unknown'
              ? { label: 'Status unavailable', tone: 'neutral' as const }
              : { label: 'Hotel context', tone: 'neutral' as const },
      }));
    const shown = new Set(choices.map((choice) => choice.id));
    const allCompanyHotelIds = new Set(
      (data?.contexts ?? []).flatMap((context) => context.hotelIds),
    );
    for (const hotel of properties) {
      if (shown.has(hotel.id) || allCompanyHotelIds.has(hotel.id)) continue;
      choices.push({
        id: hotel.id,
        kind: 'hotel',
        eyebrow: 'Hotel · Separate assignment',
        name: hotel.name,
        secondaryLabel: secondaryLabels[hotel.id],
        status: { label: 'Hotel context', tone: 'neutral' },
      });
    }
    return choices;
  }, [companySelected, data?.contexts, data?.hotels, properties]);

  const allChoices = [...companyChoices, ...hotelChoices];
  const normalized = query.trim().toLocaleLowerCase();
  const choices = normalized
    ? allChoices.filter((choice) => `${choice.name} ${choice.secondaryLabel} ${choice.eyebrow}`.toLocaleLowerCase().includes(normalized))
    : allChoices;

  const select = (choice: PortfolioScopeOption) => {
    if (choice.kind === 'portfolio') {
      router.push(`/portfolio?organizationId=${encodeURIComponent(choice.id)}`);
      return;
    }
    const previousCompany = data?.selectedCompany?.organizationId ?? data?.contexts[0]?.organizationId;
    const returnTo = previousCompany
      ? `/portfolio?organizationId=${encodeURIComponent(previousCompany)}`
      : '/portfolio/choose';
    const params = new URLSearchParams({ scope: 'hotel', propertyId: choice.id, returnTo });
    if (previousCompany && data?.selectedCompany?.hotelIds.includes(choice.id)) {
      params.set('organizationId', previousCompany);
    }
    router.push(`/home?${params.toString()}`);
  };

  return (
    <ScopeChooser
      variant="page"
      eyebrow="Acting context"
      title={(data?.contexts.length ?? 0) > 1 && !companySelected
        ? 'Choose a management company'
        : 'Choose how you’re working'}
      description={(data?.contexts.length ?? 0) > 1 && !companySelected
        ? 'Each company remains separate. Choose one before viewing hotels or portfolio totals.'
        : 'Your role and write permissions do not change when you switch context.'}
      choices={choices}
      selectedId={data?.selectedCompany?.organizationId ?? null}
      onSelect={select}
      search={{
        value: query,
        label: 'Search contexts',
        placeholder: (data?.contexts.length ?? 0) > 1 && !companySelected
          ? 'Company name'
          : 'Company or hotel name',
        onChange: setQuery,
      }}
      state={portfolio.loading
        ? 'loading'
        : portfolio.error
          ? 'error'
          : allChoices.length === 0
            ? 'empty'
            : choices.length === 0
              ? 'empty'
            : 'ready'}
      stateContent={portfolio.error ? {
        title: 'Your contexts could not be loaded',
        description: portfolio.error,
        guidance: 'No company or hotel has been selected.',
        action: { label: 'Try again', onActivate: () => void portfolio.reload() },
      } : allChoices.length === 0 ? {
        title: 'No active context is available',
        description: 'Your access may be pending or recently revoked.',
        guidance: 'Ask a company owner or Staxis administrator to review your access.',
      } : choices.length === 0 ? {
        title: 'No contexts match this search',
        description: 'Your authorized contexts have not changed.',
        guidance: 'Try another company or hotel name.',
        action: { label: 'Clear search', onActivate: () => setQuery('') },
      } : undefined}
    />
  );
}
