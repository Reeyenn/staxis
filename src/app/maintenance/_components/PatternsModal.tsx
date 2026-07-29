'use client';

/**
 * The shell around the patterns panel: the fetch, the language, and the house
 * modal. Everything the manager READS lives in ./PatternsPanel.tsx, which has
 * no hooks and is therefore directly testable — see the note in its header.
 */

import React from 'react';

import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';

import { Modal, Btn } from './_mt-snow';
import {
  MaintenancePatternsBody,
  panelText,
  type PanelLang,
  type PatternsPayload,
  type PatternsReadState,
} from './PatternsPanel';

export function PatternsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const readerLang: PanelLang = 'en';

  // Fetched only while the popup is open. A manager who never presses the
  // button never asks the server for any of this, and the Maintenance tab
  // costs exactly what it cost before.
  const { data, error, loading } = useApiResource<PatternsPayload>(
    `/api/findings?propertyId=${activePropertyId}&lens=maintenance`,
    { enabled: open && !!activePropertyId },
  );

  const state: PatternsReadState = error
    ? 'failed'
    : (loading || !data) ? 'loading' : 'ready';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={panelText('title', readerLang)}
      subtitle={panelText('subtitle', readerLang)}
      width={760}
      footer={<Btn variant="ghost" onClick={onClose}>{panelText('close', readerLang)}</Btn>}
    >
      <MaintenancePatternsBody state={state} payload={data} lang={readerLang} />
    </Modal>
  );
}
