'use client';

// Optional equipment picker shared by the Work Order + Preventive create forms.
// Lets a manager/staffer attach the asset a work order or PM applies to. Keeps
// the link OPTIONAL — an empty selection leaves equipment_id null and existing
// flows work unchanged. Reads this property's assets through /api/maintenance/
// equipment (service-role; never the browser supabase client).

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { Equipment } from '@/lib/equipment/types';
import { T, FONT_SANS, Btn } from './_mt-snow';

// Throws on failure, deliberately. The shared fetchEquipmentList helper flattens
// any API error into an empty array, which made a dead load look exactly like a
// hotel that has logged no assets: the dropdown offered "(No asset)" and nothing
// else, so the work order was filed unlinked and never reached the asset's
// service history. Same loader shape the registry screen uses for the same
// reason (silent-empty-state bug class).
async function loadEquipmentList(pid: string): Promise<Equipment[]> {
  const res = await fetchWithAuth(`/api/maintenance/equipment?pid=${encodeURIComponent(pid)}`);
  const json = (await res.json().catch(() => null)) as
    { ok?: boolean; data?: { equipment: Equipment[] }; error?: string } | null;
  if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error || `http ${res.status}`);
  return json.data.equipment;
}

export function EquipmentPicker({
  pid, value, onChange, lang,
}: {
  pid: string;
  value: string | null;
  onChange: (id: string | null) => void;
  lang: string;
}) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    void (async () => {
      try {
        const list = await loadEquipmentList(pid);
        if (!alive) return;
        setItems(list);
        setStatus('ready');
      } catch {
        if (!alive) return;
        setItems([]);
        setStatus('error');
      }
    })();
    return () => { alive = false; };
  }, [pid, retryKey]);

  if (status === 'error') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '10px 12px', borderRadius: 10,
        border: '1px solid rgba(184,92,61,0.24)', background: 'rgba(184,92,61,0.07)',
        fontFamily: FONT_SANS, fontSize: 12.5, color: T.warm,
      }}>
        <span>{"Couldn't load your equipment list."}</span>
        <Btn variant="ghost" size="sm" onClick={() => setRetryKey((k) => k + 1)}>↻ {'Retry'}</Btn>
      </div>
    );
  }

  return (
    <select
      value={value ?? ''}
      disabled={status === 'loading'}
      onChange={(e) => onChange(e.target.value || null)}
      style={{
        height: 40, padding: '0 12px', borderRadius: 10,
        background: T.bg, border: `1px solid ${T.rule}`,
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none',
        cursor: status === 'loading' ? 'wait' : 'pointer',
      }}
    >
      <option value="">{status === 'loading' ? 'Loading your equipment…' : '(No asset)'}</option>
      {items.map((eq) => (
        <option key={eq.id} value={eq.id}>
          {eq.name}{eq.location ? ` · ${eq.location}` : ''}
        </option>
      ))}
    </select>
  );
}
