'use client';

// Optional equipment picker shared by the Work Order + Preventive create forms.
// Lets a manager/staffer attach the asset a work order or PM applies to. Keeps
// the link OPTIONAL — an empty selection leaves equipment_id null and existing
// flows work unchanged. Reads this property's assets through /api/maintenance/
// equipment (service-role; never the browser supabase client).

import React, { useEffect, useState } from 'react';
import { fetchEquipmentList } from '@/lib/db';
import type { Equipment } from '@/lib/equipment/types';
import { tr } from '@/lib/i18n-utils';
import { T, FONT_SANS } from './_mt-snow';

export function EquipmentPicker({
  pid, value, onChange, lang,
}: {
  pid: string;
  value: string | null;
  onChange: (id: string | null) => void;
  lang: string;
}) {
  const [items, setItems] = useState<Equipment[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await fetchEquipmentList(pid);
      if (alive) setItems(list);
    })();
    return () => { alive = false; };
  }, [pid]);

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      style={{
        height: 40, padding: '0 12px', borderRadius: 10,
        background: T.bg, border: `1px solid ${T.rule}`,
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none', cursor: 'pointer',
      }}
    >
      <option value="">{tr(lang, '— No asset —', '— Sin equipo —')}</option>
      {items.map((eq) => (
        <option key={eq.id} value={eq.id}>
          {eq.name}{eq.location ? ` · ${eq.location}` : ''}
        </option>
      ))}
    </select>
  );
}
