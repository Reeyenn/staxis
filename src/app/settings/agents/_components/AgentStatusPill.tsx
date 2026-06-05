'use client';

// Status pill + money/guest transparency badges. Color is never the only signal
// — each pill/badge carries text.

import React from 'react';
import { DollarSign, MessageSquare } from 'lucide-react';
import { Pill } from './_tokens';
import { agentStatusTone, agentStatusLabel, actionBadges } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { AgentStatus } from '@/lib/agents/types';

export function AgentStatusPill({ status, lang }: { status: AgentStatus; lang: Lang }) {
  return <Pill tone={agentStatusTone(status)}>{agentStatusLabel(status, lang)}</Pill>;
}

export function MoneyGuestBadges({
  spendsMoney, contactsGuest, lang,
}: {
  spendsMoney: boolean;
  contactsGuest: boolean;
  lang: Lang;
}) {
  const badges = actionBadges({ spendsMoney, contactsGuest });
  if (badges.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
      {badges.includes('money') && (
        <Pill tone="caramel"><DollarSign size={11} /> {s(lang, 'spendsMoney')}</Pill>
      )}
      {badges.includes('guest') && (
        <Pill tone="purple"><MessageSquare size={11} /> {s(lang, 'contactsGuest')}</Pill>
      )}
    </span>
  );
}
