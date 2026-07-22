'use client';

/* ───────────────────────────────────────────────────────────────────────
   SectionsModal — turn the 8 app sections on/off for one hotel.

   Opened from the Live hotels list (per-hotel "Sections" control). Writes the
   SAME properties.enabled_sections column the onboarding wizard writes, so the
   admin popup and the onboarding step are two faces of one setting.

   The contract (see @/lib/sections/registry): DEFAULT-ON. A section is ON
   unless it's explicitly `false`. On mount we GET /api/admin/sections, which
   coalesces the stored map into a full 8-key boolean map, and hydrate one
   toggle row per SECTION_LIST entry. Save POSTs the full 8-key map back.

   Reuses the shared Studio modal chrome (Backdrop + MODAL_CARD) and kit
   primitives (Btn / Caps), wrapped in `.admin-studio` so the studio CSS vars
   resolve even when opened from the legacy _snow-based Live tab — same guard
   CoveragePickerModal documents. English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Backdrop, MODAL_CARD } from './surface-kit';
import { Btn, Caps, FONT_SERIF, FONT_SANS, FONT_MONO, useRiseIn } from './kit';
import { SECTION_LIST, type AppSection } from '@/lib/sections/registry';

export interface SectionsModalProps {
  propertyId: string;
  currentSections?: Record<AppSection, boolean> | null;
  onClose: () => void;
  onSaved: () => void;
}

export function SectionsModal({
  propertyId,
  currentSections,
  onClose,
  onSaved,
}: SectionsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // null = still loading; otherwise the working full 8-key map.
  const [flags, setFlags] = useState<Record<AppSection, boolean> | null>(currentSections ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useRiseIn(cardRef, { dy: 26, dur: 440 });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetchWithAuth(`/api/admin/sections?propertyId=${encodeURIComponent(propertyId)}`);
      const json = await res.json();
      if (!json.ok) {
        setLoadError(json.error ?? 'Could not load section settings.');
        return;
      }
      setFlags(json.data?.sections ?? null);
    } catch (err) {
      setLoadError(`Network error: ${(err as Error).message}`);
    }
  }, [propertyId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (key: AppSection) => {
    setFlags((prev) => (prev ? { ...prev, [key]: !prev[key] } : prev));
  };

  const offCount = flags ? SECTION_LIST.filter((m) => flags[m.key] === false).length : 0;

  const save = async () => {
    if (!flags || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetchWithAuth('/api/admin/sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, sections: flags }),
      });
      const json = await res.json();
      if (!json.ok) {
        setSaveError(json.error ?? 'Could not save section settings. Please try again.');
        return;
      }
      onSaved();
    } catch (err) {
      setSaveError(`Network error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div
        ref={cardRef}
        className="admin-studio"
        onClick={(e) => e.stopPropagation()}
        style={{ ...MODAL_CARD, width: 480, fontFamily: FONT_SANS }}
      >
        <Caps>App sections</Caps>
        <h3 style={{
          fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400,
          letterSpacing: '-0.02em', margin: '6px 0 4px',
        }}>
          Turn sections <span style={{ fontStyle: 'italic' }}>on or off</span>
        </h3>
        <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 18px', lineHeight: 1.5 }}>
          Choose which parts of the app this hotel sees. A section that&apos;s off
          is fully hidden for everyone at this hotel, and its background work pauses.
          Everything is on by default.
        </p>

        {/* Loading / load-error / list */}
        {loadError ? (
          <div style={errorBox}>{loadError}</div>
        ) : flags === null ? (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <span className="spinner" style={{ width: 22, height: 22, display: 'inline-block' }} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SECTION_LIST.map((m) => {
              const on = flags[m.key] !== false;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggle(m.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '12px 14px', borderRadius: 12,
                    border: `1px solid ${on ? 'var(--forest)' : 'var(--rule)'}`,
                    background: on ? 'var(--forest-dim)' : 'transparent',
                    fontFamily: FONT_SANS, transition: 'background .15s, border-color .15s',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13.5, fontWeight: 600, color: 'var(--ink)',
                      letterSpacing: '-0.005em',
                    }}>
                      {m.label_en}
                    </div>
                    <div style={{
                      fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--dim)',
                      marginTop: 4, letterSpacing: '0.02em',
                    }}>
                      {m.desc_en}
                    </div>
                  </div>

                  {/* Switch track + knob */}
                  <span style={{
                    position: 'relative', flexShrink: 0,
                    width: 38, height: 22, borderRadius: 999,
                    background: on ? 'var(--forest)' : 'var(--rule-strong)',
                    transition: 'background .15s',
                  }}>
                    <span style={{
                      position: 'absolute', top: 3, left: on ? 19 : 3,
                      width: 16, height: 16, borderRadius: '50%',
                      background: '#fff', transition: 'left .15s',
                    }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {saveError && <div style={{ ...errorBox, marginTop: 14 }}>{saveError}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginRight: 'auto' }}>
            {flags === null ? '' : offCount === 0 ? 'All 8 sections on' : `${offCount} off`}
          </span>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={save}
            disabled={saving || flags === null}
          >
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </div>
    </Backdrop>
  );
}

const errorBox: React.CSSProperties = {
  padding: '11px 13px',
  background: 'var(--terracotta-dim)',
  border: '1px solid rgba(194,86,46,.3)',
  borderRadius: 12,
  color: 'var(--terracotta-deep)',
  fontSize: 12.5,
  fontFamily: FONT_SANS,
  lineHeight: 1.45,
};
