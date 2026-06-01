'use client';

import React, { useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { OrderingMode } from '@/lib/ordering/types';

import { T, fonts, statusColor } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { apiSetMode } from '../ordering-api';

interface OrderingSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
  orderingMode: OrderingMode;
  onModeChange: (m: OrderingMode) => void;
}

export function OrderingSettingsPanel({
  open,
  onClose,
  canManage,
  orderingMode,
  onModeChange,
}: OrderingSettingsPanelProps) {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = lang === 'es' ? 'es' : 'en';

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tt = {
    eyebrow: { en: 'Ordering settings', es: 'Ajustes de pedidos' }[L],
    modeTitle: { en: 'Ordering mode', es: 'Modo de pedidos' }[L],
    simpleName: { en: 'Simple', es: 'Simple' }[L],
    simpleDesc: {
      en: 'Place an order from the reorder list and it emails the vendor right away. Track Sent → Received. No approval step.',
      es: 'Crea una orden desde la lista de reorden y se envía al proveedor de inmediato. Sigue Enviado → Recibido. Sin aprobación.',
    }[L],
    proName: { en: 'Pro', es: 'Pro' }[L],
    proDesc: {
      en: 'Orders get a PO number and start as "Needs approval". A manager approves before the order can be emailed. Best for management companies.',
      es: 'Las órdenes reciben un número de OC y empiezan como "Requiere aprobación". Un gerente aprueba antes de enviarse. Ideal para empresas gestoras.',
    }[L],
    current: { en: 'Current', es: 'Actual' }[L],
    use: { en: 'Use this', es: 'Usar este' }[L],
    saving: { en: 'Saving…', es: 'Guardando…' }[L],
    done: { en: 'Done', es: 'Listo' }[L],
    managerOnly: { en: 'Only managers can change ordering settings.', es: 'Solo gerentes pueden cambiar estos ajustes.' }[L],
  };

  const pick = async (mode: OrderingMode) => {
    if (!activePropertyId || saving || mode === orderingMode) return;
    setSaving(true);
    setError(null);
    try {
      await apiSetMode(activePropertyId, mode);
      onModeChange(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const modeCard = (mode: OrderingMode, name: string, desc: string) => {
    const active = orderingMode === mode;
    return (
      <div
        style={{
          flex: 1,
          background: T.paper,
          border: `1.5px solid ${active ? statusColor.good : T.rule}`,
          borderRadius: 14,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.serif, fontSize: 22, fontStyle: 'italic', color: T.ink }}>{name}</span>
          {active && (
            <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor.good, fontWeight: 700 }}>
              {tt.current}
            </span>
          )}
        </div>
        <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: 0, flex: 1 }}>{desc}</p>
        {canManage && !active && (
          <Btn variant="primary" size="sm" disabled={saving} onClick={() => pick(mode)}>
            {saving ? tt.saving : tt.use}
          </Btn>
        )}
      </div>
    );
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={tt.eyebrow}
      italic={orderingMode === 'pro' ? tt.proName : tt.simpleName}
      accent={statusColor.good}
      width={860}
      footer={<Btn variant="ghost" size="md" onClick={onClose}>{tt.done}</Btn>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && (
          <div style={{ background: T.paper, border: `1px solid ${statusColor.critical}`, borderLeft: `3px solid ${statusColor.critical}`, borderRadius: 10, padding: '10px 14px', fontFamily: fonts.sans, fontSize: 13, color: T.ink }}>
            {error}
          </div>
        )}
        {!canManage && (
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tt.managerOnly}</div>
        )}

        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.ink3, fontWeight: 600 }}>
            {tt.modeTitle}
          </span>
          <div style={{ display: 'flex', gap: 12 }}>
            {modeCard('simple', tt.simpleName, tt.simpleDesc)}
            {modeCard('pro', tt.proName, tt.proDesc)}
          </div>
        </section>
      </div>
    </Overlay>
  );
}
