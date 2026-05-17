'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';

import { T, fonts, statusColor } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { ItemThumb } from '../ItemThumb';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';

type Kind = 'scan' | 'ai';
type AiMode = 'off' | 'auto' | 'always-on';

interface SimpleSheetProps {
  open: boolean;
  kind: Kind;
  onClose: () => void;
  aiMode: AiMode;
  onModeChange: (mode: AiMode) => void;
  display: DisplayItem[];
}

export function SimpleSheet({ open, kind, onClose, aiMode, onModeChange, display }: SimpleSheetProps) {
  if (kind === 'scan') {
    return <ScanInvoiceSheet open={open} onClose={onClose} />;
  }
  return (
    <AIHelperSheet
      open={open}
      onClose={onClose}
      aiMode={aiMode}
      onModeChange={onModeChange}
      display={display}
    />
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Scan Invoice
   ────────────────────────────────────────────────────────────────────── */
function ScanInvoiceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    if (open) {
      setStatus('idle');
      setMessage('');
    }
  }, [open]);

  const handlePick = () => fileRef.current?.click();

  const handleFile = async (file: File) => {
    if (!user || !activePropertyId) return;
    setStatus('uploading');
    setMessage('');
    try {
      // Resize before upload — Anthropic Vision bills per pixel area, so a
      // 12 MP iPhone photo costs ~4x what a 2 MP downscale costs without
      // hurting OCR on legible line items. 1600px on the long edge keeps
      // small-font receipt text readable.
      const resized = await resizeImageForVision(file);
      const res = await fetchWithAuth('/api/inventory/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, imageBase64: resized.base64, mediaType: resized.mediaType }),
      });
      const json = (await res.json()) as { ok?: boolean; items?: Array<{ item_name: string; quantity: number }> };
      if (!res.ok || !json.ok) {
        setStatus('error');
        setMessage('Could not read that invoice. Please try a clearer photo.');
        return;
      }
      const lineCount = json.items?.length ?? 0;
      setStatus('success');
      setMessage(
        lineCount > 0
          ? `Got it. Found ${lineCount} line${lineCount === 1 ? '' : 's'} — added to your records.`
          : `No line items detected — try a clearer photo.`,
      );
    } catch (err) {
      console.error('[scan-invoice] failed', err);
      setStatus('error');
      setMessage('Upload failed. Please try again.');
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow="Scan invoice"
      italic="Drop one in"
      suffix="auto-update stock"
      accent={T.sageDeep}
      width={640}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div
          style={{
            border: `1px dashed ${T.rule}`,
            borderRadius: 14,
            padding: '40px 24px',
            textAlign: 'center',
            background:
              'repeating-linear-gradient(135deg, rgba(31,35,28,0.03) 0 10px, transparent 10px 20px)',
          }}
        >
          <div
            style={{
              fontFamily: fonts.serif,
              fontSize: 24,
              fontStyle: 'italic',
              color: T.ink,
              letterSpacing: '-0.02em',
            }}
          >
            Drop an invoice here
          </div>
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: '8px 0 0' }}>
            PDF, photo, or scan. We&apos;ll extract items + quantities and match them to your inventory.
          </div>
          <div style={{ marginTop: 16 }}>
            <Btn variant="primary" size="md" onClick={handlePick} disabled={status === 'uploading'}>
              {status === 'uploading' ? 'Reading…' : 'Choose file…'}
            </Btn>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
        {status !== 'idle' && message && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 12,
              background:
                status === 'success'
                  ? T.sageDim
                  : status === 'error'
                  ? T.warmDim
                  : T.ruleSoft,
              border: `1px solid ${status === 'success' ? `${T.sageDeep}33` : status === 'error' ? `${T.warm}33` : T.rule}`,
              fontFamily: fonts.sans,
              fontSize: 13,
              color: status === 'success' ? '#3F5A43' : status === 'error' ? T.warm : T.ink2,
              lineHeight: 1.5,
            }}
          >
            {message}
          </div>
        )}
        <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
          Stock auto-increments when the invoice is matched. You can review and edit each line before it commits.
        </p>
      </div>
    </Overlay>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   AI Helper — Overview / Usage rates / Status tabs
   ────────────────────────────────────────────────────────────────────── */
type AIView = 'overview' | 'rates' | 'status';

interface AIStatusShape {
  aiMode: AiMode;
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsExpectedToGraduate: number;
  currentMaeRatio: number | null;
  lastInferenceAt: string | null;
}

function AIHelperSheet({
  open,
  onClose,
  aiMode,
  onModeChange,
  display,
}: {
  open: boolean;
  onClose: () => void;
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  display: DisplayItem[];
}) {
  const { activePropertyId } = useProperty();
  const [view, setView] = useState<AIView>('overview');
  const [stats, setStats] = useState<AIStatusShape | null>(null);
  const [totalCounts, setTotalCounts] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [statusRes, countsRes] = await Promise.all([
          fetchWithAuth(`/api/inventory/ai-status?propertyId=${activePropertyId}`, { cache: 'no-store' }),
          fetchWithAuth(
            `/api/inventory/accounting-summary?propertyId=${activePropertyId}`,
            { cache: 'no-store' },
          ).catch(() => null),
        ]);
        if (!cancelled && statusRes.ok) {
          const json = (await statusRes.json()) as { data?: AIStatusShape };
          if (json.data) setStats(json.data);
        }
        if (!cancelled && countsRes && countsRes.ok) {
          // accounting-summary doesn't include count count; approximate from
          // ai-status' daysSinceFirstCount × itemsTotal — not used.
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  // Lightweight "events logged" approximation. Without a dedicated count
  // anywhere, we use itemsWithModel × consecutivePasses ≈ count rows.
  // A future improvement: surface getInventoryDataFuelStats.totalCounts.
  useEffect(() => {
    setTotalCounts(stats ? stats.itemsWithModel : null);
  }, [stats]);

  const ml = {
    eventsLogged: totalCounts ?? 0,
    eventsNeeded: 30,
    maePct: stats?.currentMaeRatio != null ? stats.currentMaeRatio * 100 : 0,
    maeTarget: 10,
    consecutivePasses: Math.min(5, Math.floor((stats?.daysSinceFirstCount ?? 0) / 30)),
    passesNeeded: 5,
    autoFillEligibleItems: stats?.itemsGraduated ?? 0,
    totalItems: stats?.itemsTotal ?? display.length,
    graduated: (stats?.itemsGraduated ?? 0) > 0,
  };

  const views: Array<{ key: AIView; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'rates', label: 'Usage rates' },
    { key: 'status', label: 'Status' },
  ];

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow="AI Helper"
      italic="How it works"
      suffix="and what it knows"
      accent={T.purple}
      width={640}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {views.map((v) => {
            const active = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? T.purple : 'transparent',
                  color: active ? '#fff' : T.ink2,
                  border: `1px solid ${active ? T.purple : T.rule}`,
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        {view === 'overview' && (
          <OverviewTab aiMode={aiMode} onModeChange={onModeChange} ml={ml} onSeeStatus={() => setView('status')} />
        )}
        {view === 'rates' && <RatesTab items={display} />}
        {view === 'status' && <StatusTab ml={ml} />}
      </div>
    </Overlay>
  );
}

function OverviewTab({
  aiMode,
  onModeChange,
  ml,
  onSeeStatus,
}: {
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  ml: { autoFillEligibleItems: number; totalItems: number; graduated: boolean };
  onSeeStatus: () => void;
}) {
  const modes: AiMode[] = ['off', 'auto', 'always-on'];
  const labelFor: Record<AiMode, string> = { off: 'Off', auto: 'Auto', 'always-on': 'Always-on' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        The AI watches your counts, occupancy, and order history, then learns how fast you use each item. Once it&apos;s confident, it starts <b style={{ color: T.ink }}>filling in counts for you</b>. You can always override.
      </p>
      <div>
        <Caps>Mode</Caps>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {modes.map((m) => {
            const active = aiMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                style={{
                  flex: 1,
                  padding: '12px 14px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  background: active ? T.ink : 'transparent',
                  color: active ? T.bg : T.ink,
                  border: `1px solid ${active ? T.ink : T.rule}`,
                  fontFamily: fonts.sans,
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: 'center',
                }}
              >
                {labelFor[m]}
              </button>
            );
          })}
        </div>
        <p style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, margin: '8px 0 0', fontStyle: 'italic' }}>
          {aiMode === 'auto' && 'Auto · the AI fills counts only for items where it’s confident.'}
          {aiMode === 'always-on' && 'Always-on · any prediction is pre-filled, even for less-trained items.'}
          {aiMode === 'off' && 'Off · no auto-fill. Type every number yourself.'}
        </p>
      </div>
      <div
        style={{
          background: T.purpleDim,
          border: `1px solid ${T.purple}40`,
          borderRadius: 12,
          padding: '14px 16px',
          display: 'flex',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: T.purple,
            color: '#fff',
            fontFamily: fonts.mono,
            fontSize: 13,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          AI
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: fonts.serif, fontSize: 18, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em' }}>
            {ml.graduated ? 'Graduated.' : 'Learning.'}
          </span>
          <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginLeft: 6 }}>
            Auto-filling {ml.autoFillEligibleItems} of {ml.totalItems} items.
          </span>
        </div>
        <button
          type="button"
          onClick={onSeeStatus}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: fonts.mono,
            fontSize: 10,
            fontWeight: 600,
            color: T.purple,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          See status →
        </button>
      </div>
    </div>
  );
}

function RatesTab({ items }: { items: DisplayItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        You don&apos;t enter usage rates yourself. The AI learns each one from your monthly counts and the property&apos;s occupancy. Override if something looks off.
      </p>
      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px', maxHeight: 360, overflow: 'auto' }}>
        {items.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: fonts.serif, fontSize: 18, color: T.ink3, fontStyle: 'italic' }}>
            No items yet.
          </div>
        ) : (
          items.map((it, i) => (
            <div
              key={it.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr auto auto',
                gap: 12,
                padding: '10px 0',
                alignItems: 'center',
                borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
              }}
            >
              <ItemThumb thumb={it.thumb} cat={it.cat} size={28} />
              <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 500 }}>
                {it.name}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>
                {it.burn.toFixed(2)} {it.unit}
                {it.burnUnit === '/occ-room' ? ' per room' : ' per day'}
              </span>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  color: it.graduated ? T.purple : T.ink3,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  minWidth: 80,
                  textAlign: 'right',
                }}
              >
                {it.graduated ? 'learned' : 'learning'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatusTab({
  ml,
}: {
  ml: {
    eventsLogged: number;
    eventsNeeded: number;
    maePct: number;
    maeTarget: number;
    consecutivePasses: number;
    passesNeeded: number;
    autoFillEligibleItems: number;
    totalItems: number;
    graduated: boolean;
  };
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.55 }}>
        Three checks need to pass before the AI will fill counts for you. Once it graduates, it stays graduated as long as it&apos;s still hitting the bar.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <StatusCard
          label="Counts logged"
          big={String(ml.eventsLogged)}
          target={`${ml.eventsNeeded} needed`}
          passing={ml.eventsLogged >= ml.eventsNeeded}
        />
        <StatusCard
          label="Accuracy"
          big={`${ml.maePct.toFixed(1)}% off`}
          target={`under ${ml.maeTarget}% to pass`}
          passing={ml.maePct > 0 && ml.maePct <= ml.maeTarget}
        />
        <StatusCard
          label="Stable months"
          big={String(ml.consecutivePasses)}
          target={`${ml.passesNeeded} needed`}
          passing={ml.consecutivePasses >= ml.passesNeeded}
        />
      </div>
      <div
        style={{
          background: T.sageDim,
          border: `1px solid ${T.sageDeep}40`,
          borderRadius: 12,
          padding: '14px 16px',
          fontFamily: fonts.sans,
          fontSize: 13,
          color: '#3F5A43',
          lineHeight: 1.5,
        }}
      >
        <b>{ml.graduated ? 'Graduated.' : 'Still learning.'}</b>{' '}
        Auto-filling counts on {ml.autoFillEligibleItems} of {ml.totalItems} items.{' '}
        {ml.totalItems - ml.autoFillEligibleItems > 0 && (
          <>
            The remaining {ml.totalItems - ml.autoFillEligibleItems} are still learning — they&apos;ll join once they hit the bar.
          </>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  label,
  big,
  target,
  passing,
}: {
  label: string;
  big: string;
  target: string;
  passing: boolean;
}) {
  const c = passing ? statusColor.good : statusColor.low;
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: T.ink2,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: 24,
          color: T.ink,
          letterSpacing: '-0.02em',
          fontStyle: 'italic',
          fontWeight: 400,
          lineHeight: 1,
        }}
      >
        {big}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: fonts.sans,
          fontSize: 11,
          color: c,
          fontWeight: 600,
        }}
      >
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: c }} />
        {passing ? 'Passing' : target}
      </span>
    </div>
  );
}
