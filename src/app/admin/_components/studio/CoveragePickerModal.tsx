'use client';

/* ───────────────────────────────────────────────────────────────────────
   CoveragePickerModal — assign a hotel to a learned PMS coverage.

   Opened from the Live hotels list for any hotel with no system detected
   (properties.pms_type IS NULL), and reusable anywhere a hotel needs its
   coverage (re-)picked.

   It GETs the coverage list from /api/admin/pms-coverage, shows every
   LEARNED coverage (a pms_family with an active knowledge file) as a radio
   option labelled by its displayName + live-feed count, pre-selects the
   hotel's current pms_family if it already has one, and on confirm POSTs
   /api/admin/coverage/assign { propertyId, pmsFamily }.

   The 409 'no_active_map' error (a family with no active map) is surfaced
   as a friendly inline message rather than a hard failure — that family is
   simply not a valid target yet.

   Reuses the shared Studio modal chrome (Backdrop + MODAL_CARD) and kit
   primitives (Btn / Pill / Caps / Dot). The content is wrapped in
   `.admin-studio` so the studio CSS vars resolve even when this modal is
   opened from a surface that isn't itself under that scope (e.g. the legacy
   _snow-based Live hotels tab) — same guard the pms-inbox page documents.
   English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Backdrop, MODAL_CARD } from './surface-kit';
import {
  Btn, Pill, Caps, Dot, FONT_SERIF, FONT_SANS, FONT_MONO, riseIn,
} from './kit';

// ── Shape of the coverage list this modal consumes ───────────────────────
// Mirrors the additive fields the GET /api/admin/pms-coverage backend adds.
// Only the fields this modal reads are typed; the rest of the row is ignored.
interface PerFeed {
  key: string;
  label: string;
  state: 'live' | 'learning' | 'unavailable';
}
interface CoverageRow {
  pmsType: string;            // the pms_family key
  label: string;             // registry label (fallback for displayName)
  displayName: string;       // COALESCE(display_name, registry label)
  coveragePct: number;
  perFeed: PerFeed[];
  recipe: { id: string } | null;  // null = never learned (no active map)
}

export interface CoveragePickerModalProps {
  propertyId: string;
  currentPmsFamily?: string | null;
  onClose: () => void;
  onAssigned: () => void;
}

export function CoveragePickerModal({
  propertyId,
  currentPmsFamily,
  onClose,
  onAssigned,
}: CoveragePickerModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const [rows, setRows] = useState<CoverageRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(currentPmsFamily ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { riseIn(cardRef.current, { dy: 26, dur: 440 }); }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetchWithAuth('/api/admin/pms-coverage');
      const json = await res.json();
      if (!json.ok) {
        setLoadError(json.error ?? 'Could not load coverage options.');
        return;
      }
      // The route returns one row per PMS family under `data.pmsTypes`.
      const all: CoverageRow[] = json.data?.pmsTypes ?? [];
      setRows(all);
    } catch (err) {
      setLoadError(`Network error: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Only families that have actually been learned (an active knowledge file)
  // are valid assignment targets — assigning to a never-learned family would
  // strand the hotel (the backend 409s on it too; we just don't show it).
  const learned = (rows ?? []).filter((r) => r.recipe !== null);

  const confirm = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, pmsFamily: selected }),
      });
      const json = await res.json();
      if (!json.ok) {
        if (json.code === 'no_active_map') {
          setSaveError("That system isn't ready yet — it has no learned coverage to run from. Pick one that's live, or learn it first.");
        } else {
          setSaveError(json.error ?? 'Could not assign coverage. Please try again.');
        }
        return;
      }
      onAssigned();
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
        style={{ ...MODAL_CARD, width: 460, fontFamily: FONT_SANS }}
      >
        <Caps>Assign coverage</Caps>
        <h3 style={{
          fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400,
          letterSpacing: '-0.02em', margin: '6px 0 4px',
        }}>
          Pick a <span style={{ fontStyle: 'italic' }}>system</span>
        </h3>
        <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 18px', lineHeight: 1.5 }}>
          Choose which property-management system this hotel runs on. We&apos;ll start
          watching its feeds right away.
        </p>

        {/* Loading / load-error / empty / list */}
        {loadError ? (
          <div style={errorBox}>{loadError}</div>
        ) : rows === null ? (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <span className="spinner" style={{ width: 22, height: 22, display: 'inline-block' }} />
          </div>
        ) : learned.length === 0 ? (
          <div style={{
            padding: '24px 18px', textAlign: 'center',
            border: '1px dashed var(--rule)', borderRadius: 12,
            color: 'var(--dim)', fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13,
          }}>
            No systems have been learned yet — finish onboarding a PMS first, then
            you can assign hotels to it.
          </div>
        ) : (
          <div role="radiogroup" aria-label="Available coverage" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {learned.map((r) => {
              const isSel = selected === r.pmsType;
              const liveCount = r.perFeed.filter((f) => f.state === 'live').length;
              const totalFeeds = r.perFeed.length || 5;
              return (
                <button
                  key={r.pmsType}
                  type="button"
                  role="radio"
                  aria-checked={isSel}
                  onClick={() => setSelected(r.pmsType)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '12px 14px', borderRadius: 12,
                    border: `1px solid ${isSel ? 'var(--forest)' : 'var(--rule)'}`,
                    background: isSel ? 'var(--forest-dim)' : 'transparent',
                    fontFamily: FONT_SANS, transition: 'background .15s, border-color .15s',
                  }}
                >
                  {/* Radio dial */}
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${isSel ? 'var(--forest)' : 'var(--rule-strong)'}`,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {isSel && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--forest)' }} />}
                  </span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13.5, fontWeight: 600, color: 'var(--ink)',
                      letterSpacing: '-0.005em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {r.displayName || r.label || r.pmsType}
                    </div>
                    <div style={{
                      fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--dim)',
                      marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, letterSpacing: '0.04em',
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Dot tone={liveCount > 0 ? 'forest' : 'muted'} size={7} />
                        {liveCount}/{totalFeeds} feeds live
                      </span>
                    </div>
                  </div>

                  {currentPmsFamily === r.pmsType && (
                    <Pill tone="neutral" style={{ fontSize: 10 }}>CURRENT</Pill>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {saveError && <div style={{ ...errorBox, marginTop: 14 }}>{saveError}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={confirm}
            disabled={!selected || saving || learned.length === 0}
          >
            {saving ? 'Assigning…' : 'Assign'}
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
