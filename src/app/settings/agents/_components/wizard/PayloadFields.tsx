'use client';

// Schema-driven inputs for a selected action (custom path). Renders one field
// per inputSchema property; required fields are marked with *. Values are stored
// under config.templateParams.payloads[actionKey] and read by the custom planner.

import React from 'react';
import { T, fonts } from '../_tokens';
import type { Lang } from '../../_lib/strings';
import type { AgentActionMeta } from '@/lib/agents/types';

type SchemaProp = { type?: string; description?: string; items?: { type?: string } };

const fieldInput: React.CSSProperties = {
  border: `1px solid ${T.rule}`, borderRadius: 8, padding: '7px 10px',
  fontFamily: fonts.sans, fontSize: 13, color: T.ink, background: T.paper, outline: 'none',
};

export function PayloadFields({
  meta, payload, onChange, lang,
}: {
  meta: AgentActionMeta;
  payload: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
  lang: Lang;
}) {
  const props = (meta.inputSchema.properties ?? {}) as Record<string, SchemaProp>;
  const required = meta.inputSchema.required ?? [];
  const keys = Object.keys(props);
  if (keys.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {keys.map((field) => {
        const p = props[field];
        const isReq = required.includes(field);
        const v = payload[field];
        return (
          <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.ink3 }}>
              {field}{isReq ? ' *' : ''}
            </span>
            {p.type === 'boolean' ? (
              <input type="checkbox" checked={v === true} onChange={(e) => onChange(field, e.target.checked)} style={{ alignSelf: 'flex-start' }} />
            ) : p.type === 'number' ? (
              <input
                type="number"
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => onChange(field, e.target.value === '' ? undefined : Number(e.target.value))}
                style={fieldInput}
              />
            ) : p.type === 'array' ? (
              <input
                value={Array.isArray(v) ? (v as unknown[]).join(', ') : ''}
                placeholder={lang === 'es' ? 'separa con comas' : 'comma-separated'}
                onChange={(e) => {
                  const raw = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                  const items = p.items?.type === 'number'
                    ? raw.map(Number).filter((n) => Number.isFinite(n))
                    : raw;
                  onChange(field, items.length ? items : undefined);
                }}
                style={fieldInput}
              />
            ) : (
              <input
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => onChange(field, e.target.value === '' ? undefined : e.target.value)}
                style={fieldInput}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
