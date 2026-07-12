'use client';

// Inspections column of the Quality & Performance tab — the presentational
// half split out of QualityTab.tsx (June-2026 "Command" layout). Pure view
// components; all state, polling, and the /api/housekeeping/inspections/*
// calls stay in the QualityTab orchestrator. Nothing here changed behavior —
// these are verbatim moves of the sub-components that used to live inline.

import React, { useEffect, useMemo } from 'react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Card,
} from './_snow';
import {
  tr, fmtDec, relAgo, categoryLabel,
  type SeverityValue, type ItemDraft,
} from './quality-shared';
import type {
  Inspection,
  InspectionChecklist,
  InspectionChecklistItem,
  InspectionHistoryEntry,
  InspectionQueueRoom,
  InspectionStats,
} from '@/types/inspections';

export function StatBand({ stats, lang }: { stats: InspectionStats | null; lang: 'en' | 'es' }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cardBase: React.CSSProperties = {
    border: `1px solid ${T.rule}`, borderRadius: 16, padding: '15px 18px',
    display: 'flex', flexDirection: 'column', gap: 7, background: T.paper,
  };
  const valStyle: React.CSSProperties = {
    fontFamily: FONT_SERIF, fontSize: 40, lineHeight: 0.9, color: T.ink,
    letterSpacing: '-0.02em', fontWeight: 400,
  };
  const reClean = stats?.reCleanRatePct ?? 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
      {/* Pass rate today — hero */}
      <div style={{
        ...cardBase,
        background: 'linear-gradient(135deg, rgba(92,122,96,0.10), rgba(92,122,96,0.02))',
        borderColor: 'rgba(92,122,96,0.22)',
      }}>
        <Caps>{tr(lang, 'Pass rate · today', 'Aprobación · hoy')}</Caps>
        <span style={{ ...valStyle, color: T.sageDeep }}>{stats ? pct(stats.todayPassRate) : '—'}</span>
        <div style={{ height: 6, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: stats ? pct(stats.todayPassRate) : '0%', background: T.sage, borderRadius: 999 }} />
        </div>
      </div>
      {/* Pass rate 7d */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Pass rate · 7d', 'Aprobación · 7d')}</Caps>
        <span style={valStyle}>{stats ? pct(stats.weekPassRate) : '—'}</span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'trailing week', 'semana previa')}</Caps>
      </div>
      {/* Re-clean rate */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Re-clean rate', 'Tasa re-limpieza')}</Caps>
        <span style={{ ...valStyle, color: reClean > 12 ? T.warm : T.ink }}>
          {stats ? reClean.toFixed(0) : '—'}<small style={{ fontSize: 18, color: T.ink2 }}>%</small>
        </span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'sent back', 'devueltas')}</Caps>
      </div>
      {/* Avg inspection */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Avg inspection', 'Inspección prom.')}</Caps>
        <span style={valStyle}>{stats ? fmtDec(stats.avgInspectionDurationSec / 60) : '—'}</span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'per room', 'por habitación')}</Caps>
      </div>
    </div>
  );
}

export function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 12px', borderRadius: 999,
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500, cursor: 'pointer',
      }}
    >{label}</button>
  );
}

export function QueueRow({ row, lang, onInspect }: { row: InspectionQueueRoom; lang: 'en' | 'es'; onInspect: () => void }) {
  const recheck = row.reason === 'pending_recheck';
  const ago = relAgo(row.completedAt);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 13px', border: `1px solid ${T.rule}`, borderRadius: 12, background: T.paper,
    }}>
      <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 24, color: T.ink, lineHeight: 1, minWidth: 46, letterSpacing: '-0.02em' }}>
        {row.roomNumber}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Pill tone={recheck ? 'warm' : 'sage'}>
            {recheck ? tr(lang, 'Re-check', 'Reinspección') : tr(lang, 'Pending', 'Pendiente')}
          </Pill>
          {row.priorFailCount > 0 && (
            <Pill tone="red">{row.priorFailCount} {tr(lang, 'fail', 'fallo')}</Pill>
          )}
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.housekeeperName ?? tr(lang, 'Unassigned', 'Sin asignar')}
          {' · '}
          {ago ? tr(lang, `cleaned ${ago} ago`, `limpiada hace ${ago}`) : tr(lang, 'just cleaned', 'recién limpiada')}
        </div>
      </div>
      <Btn variant="primary" size="sm" onClick={onInspect}>
        {tr(lang, 'Inspect', 'Inspeccionar')} →
      </Btn>
    </div>
  );
}

export function HistoryCard({ rows, lang }: { rows: InspectionHistoryEntry[]; lang: 'en' | 'es' }) {
  return (
    <Card padding="18px 22px 14px">
      <Caps style={{ marginBottom: 10, display: 'block' }}>{tr(lang, 'Recent inspections', 'Inspecciones recientes')}</Caps>
      {rows.length === 0 ? (
        <div style={{ color: T.ink3, fontFamily: FONT_SANS, fontSize: 12 }}>
          {tr(lang, 'Nothing yet.', 'Nada por ahora.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.slice(0, 6).map((r) => {
            const ago = relAgo(r.completedAt);
            return (
              <div key={r.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderTop: `1px solid ${T.ruleSoft}`,
              }}>
                <div style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{r.roomNumber}</span>
                  {r.inspectorName && <span style={{ color: T.ink3 }}> · {r.inspectorName.split(' ')[0]}</span>}
                  <span style={{ color: T.ink3 }}> · {ago ? tr(lang, `${ago} ago`, `hace ${ago}`) : tr(lang, 'just now', 'recién')}</span>
                </div>
                <Pill tone={r.result === 'pass' ? 'sage' : r.escalated ? 'red' : 'caramel'}>
                  {r.result === 'pass' ? tr(lang, 'Pass', 'Aprob.') : tr(lang, 'Fail', 'Falló')}
                  {r.failedItemCount > 0 && ` · ${r.failedItemCount}`}
                </Pill>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─── Inspection drawer ───────────────────────────────────────────────────────

export function InspectDrawer({
  active, submitting, lang, onClose, onState, onNote, onUpload, onNotes, onSubmit,
}: {
  active: { inspection: Inspection; checklist: InspectionChecklist; drafts: Map<string, ItemDraft>; notes: string };
  submitting: boolean;
  lang: 'en' | 'es';
  onClose: () => void;
  onState: (id: string, st: SeverityValue) => void;
  onNote: (id: string, n: string) => void;
  onUpload: (id: string, file: File) => void;
  onNotes: (n: string) => void;
  onSubmit: (r: 'pass' | 'fail') => void;
}) {
  // Escape closes (and cancels) the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byCategory = useMemo(() => {
    const m = new Map<string, InspectionChecklistItem[]>();
    for (const it of active.checklist.items) {
      const arr = m.get(it.category) ?? [];
      arr.push(it);
      m.set(it.category, arr);
    }
    return m;
  }, [active.checklist.items]);

  const allDecided = active.checklist.items.every((it) => active.drafts.get(it.id)?.state != null);
  const anyFail = active.checklist.items.some((it) => {
    const st = active.drafts.get(it.id)?.state;
    return st === 'minor' || st === 'major' || st === 'critical';
  });

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(24,22,17,0.34)', zIndex: 1000, display: 'flex' }}
    >
      <div style={{
        marginLeft: 'auto', width: 'min(460px, 96vw)', height: '100%', background: T.paper,
        padding: '22px 24px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Caps>{tr(lang, 'Inspect room', 'Inspeccionar habitación')}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 40, color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, margin: '2px 0 4px' }}>
              {active.inspection.roomNumber}
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {active.checklist.name} · {active.checklist.items.length} {tr(lang, 'checks', 'puntos')}
            </span>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>{tr(lang, 'Close', 'Cerrar')}</Btn>
        </div>

        {/* Checklist */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {Array.from(byCategory.entries()).map(([category, items]) => (
            <div key={category}>
              <Caps style={{ display: 'block', margin: '12px 0 8px' }}>{categoryLabel(category, lang)}</Caps>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((item) => (
                  <ChecklistRow
                    key={item.id}
                    item={item}
                    draft={active.drafts.get(item.id) ?? { state: null, note: '', photoUrl: null, photoPath: null, uploading: false }}
                    lang={lang}
                    onState={(st) => onState(item.id, st)}
                    onNote={(n) => onNote(item.id, n)}
                    onFile={(f) => onUpload(item.id, f)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Overall note */}
        <textarea
          placeholder={tr(lang, 'Optional note to housekeeper / manager', 'Nota opcional para la limpieza / gerente')}
          value={active.notes}
          onChange={(e) => onNotes(e.target.value)}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12,
            border: `1px solid ${T.rule}`, fontFamily: FONT_SANS, fontSize: 13, color: T.ink, resize: 'vertical',
          }}
        />

        {/* Sticky submit bar */}
        <div style={{
          position: 'sticky', bottom: 0, background: T.paper, paddingTop: 10,
          borderTop: `1px solid ${T.rule}`, display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center',
        }}>
          {!allDecided && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {tr(lang, 'Mark every check to submit', 'Marca cada punto para enviar')}
            </span>
          )}
          {allDecided && !anyFail && (
            <Btn variant="sage" size="lg" onClick={() => onSubmit('pass')} disabled={submitting}>
              {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, '✓ Pass — room ready', '✓ Aprobar — lista')}
            </Btn>
          )}
          {allDecided && anyFail && (
            <Btn variant="primary" size="lg" onClick={() => onSubmit('fail')} disabled={submitting} style={{ background: T.warm, borderColor: T.warm }}>
              {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Send for re-clean →', 'Enviar a re-limpieza →')}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({
  item, draft, lang, onState, onNote, onFile,
}: {
  item: InspectionChecklistItem;
  draft: ItemDraft;
  lang: 'en' | 'es';
  onState: (st: SeverityValue) => void;
  onNote: (n: string) => void;
  onFile: (f: File) => void;
}) {
  const label = lang === 'es' && item.labelEs ? item.labelEs : item.label;
  const isFail = draft.state === 'minor' || draft.state === 'major' || draft.state === 'critical';
  const isCritical = draft.state === 'critical';
  return (
    <div style={{
      border: `1px solid ${isFail ? (isCritical ? 'rgba(160,74,44,0.35)' : 'rgba(184,92,61,0.35)') : T.rule}`,
      borderRadius: 12, padding: '11px 13px',
      background: isFail ? (isCritical ? T.redDim : T.warmDim) : T.paper,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink }}>
          {label}
          {item.requiresPhotoOnFail && (
            <span style={{ marginLeft: 6, color: T.warm, fontSize: 9, fontFamily: FONT_MONO }}>
              {tr(lang, 'PHOTO', 'FOTO')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <SevButton label={tr(lang, 'Pass', 'Aprob.')} active={draft.state === 'pass'} tone="sage" onClick={() => onState('pass')} />
          <SevButton label={tr(lang, 'Minor', 'Menor')} active={draft.state === 'minor'} tone="warm" onClick={() => onState('minor')} />
          <SevButton label={tr(lang, 'Major', 'Mayor')} active={draft.state === 'major'} tone="warm" onClick={() => onState('major')} />
          <SevButton label={tr(lang, 'Critical', 'Crítico')} active={draft.state === 'critical'} tone="red" onClick={() => onState('critical')} />
        </div>
      </div>
      {isFail && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            placeholder={tr(lang, 'Note (what to fix)', 'Nota (qué corregir)')}
            value={draft.note}
            onChange={(e) => onNote(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 10,
              border: `1px solid ${T.rule}`, background: T.paper, fontFamily: FONT_SANS, fontSize: 12, color: T.ink,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999,
              border: `1px solid ${T.rule}`, background: T.paper, fontFamily: FONT_SANS, fontSize: 12, color: T.ink, cursor: 'pointer',
            }}>
              {draft.uploading
                ? tr(lang, 'Uploading…', 'Subiendo…')
                : draft.photoUrl
                  ? tr(lang, 'Replace photo', 'Cambiar foto')
                  : tr(lang, 'Add photo', 'Agregar foto')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              />
            </label>
            {draft.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', border: `1px solid ${T.rule}` }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SevButton({
  label, active, tone, onClick,
}: {
  label: string; active: boolean; tone: 'sage' | 'warm' | 'red'; onClick: () => void;
}) {
  const palette = {
    sage: { bg: T.sageDim, fg: T.sageDeep },
    warm: { bg: T.warmDim, fg: T.warm },
    red:  { bg: T.redDim,  fg: T.red },
  }[tone];
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 9px', borderRadius: 999,
        background: active ? palette.bg : 'transparent',
        color: active ? palette.fg : T.ink3,
        border: `1px solid ${active ? palette.fg : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{label}</button>
  );
}
