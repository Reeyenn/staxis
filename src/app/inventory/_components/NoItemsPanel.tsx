'use client';

import React from 'react';
import { T, fonts } from './tokens';
import { Serif } from './Serif';
import { Btn } from './Btn';
import { t, type Lang } from './inv-i18n';

// Empty-catalog panel — a brand-new hotel with zero inventory items. Quiet
// paper card inviting the first item, mirroring AiReportSheet's EmptyState
// idiom (serif headline + sans body). The button reuses the FilterBar "+ Add
// item" flow via the threaded onAdd callback, opening the AddItemSheet.
// Shared by the Ledger and the Board so the two views render an identical
// zero-state.
export function NoItemsPanel({ lang, onAdd }: { lang: Lang; onAdd?: () => void }) {
  const tx = t(lang);
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '48px 32px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Serif size={24}>{tx.noItemsYet}</Serif>
      <p
        style={{
          margin: 0,
          maxWidth: 420,
          fontFamily: fonts.sans,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: T.ink2,
        }}
      >
        {tx.noItemsBody}
      </p>
      {onAdd && (
        <Btn variant="primary" size="md" onClick={onAdd} style={{ marginTop: 4 }}>
          {tx.addItem}
        </Btn>
      )}
    </div>
  );
}
