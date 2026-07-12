'use client';

// Performance column of the Quality & Performance tab — the presentational
// half split out of QualityTab.tsx (June-2026 "Command" layout). Pure view
// components; the events/flagged loaders, leaderboard derivation, and the
// real CSV export stay in the QualityTab orchestrator. Verbatim moves — no
// behavior change.

import React from 'react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Card, HousekeeperDot,
} from './_snow';
import { tr, fmtDec, type StaffStats } from './quality-shared';
import type { StaffMember } from '@/types';

export function Leaderboard({
  rows, loading, lang, paceFor, staffShape,
}: {
  rows: StaffStats[];
  loading: boolean;
  lang: 'en' | 'es';
  paceFor: (s: StaffStats) => 'fast' | 'on' | 'slow';
  staffShape: (s: { staffId: string; name: string }) => Pick<StaffMember, 'id' | 'name'>;
}) {
  const cols = '24px 1fr 44px 58px 84px';
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
        padding: '10px 0', borderBottom: `1px solid ${T.ruleSoft}`,
      }}>
        <Caps size={9}>#</Caps>
        <Caps size={9}>{tr(lang, 'Crew', 'Limpiadora')}</Caps>
        <Caps size={9}>{tr(lang, 'Rooms', 'Cuartos')}</Caps>
        <Caps size={9}>{tr(lang, 'Avg', 'Tiempo')}</Caps>
        <Caps size={9}>{tr(lang, 'Pace', 'Ritmo')}</Caps>
      </div>
      {loading && (
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '18px 0' }}>
          {tr(lang, 'Loading…', 'Cargando…')}
        </p>
      )}
      {!loading && rows.length === 0 && (
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '18px 0', fontStyle: 'italic' }}>
          {tr(lang, 'Not enough data in this period yet.', 'Sin datos suficientes en este período.')}
        </p>
      )}
      {rows.map((r, i) => {
        const pace = paceFor(r);
        return (
          <div key={r.staffId} style={{
            display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
            padding: '11px 0', borderTop: `1px solid ${T.ruleSoft}`,
          }}>
            <span style={{
              fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22,
              color: i < 3 ? T.ink : T.ink3, lineHeight: 1, letterSpacing: '-0.02em',
            }}>{i + 1}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <HousekeeperDot staff={staffShape(r)} size={30} />
              <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink }}>{r.total}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink, fontWeight: 600 }}>{fmtDec(r.avgMins)}</span>
            <span>
              {pace === 'fast' && <Pill tone="sage">↑ {tr(lang, 'Fast', 'Rápido')}</Pill>}
              {pace === 'slow' && <Pill tone="warm">↓ {tr(lang, 'Slow', 'Lento')}</Pill>}
              {pace === 'on' && <Pill tone="neutral">· {tr(lang, 'On pace', 'En ritmo')}</Pill>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function EfficiencyCard({
  typeAvgs, eligibleCount, lang,
}: {
  typeAvgs: {
    overall: number | null; checkout: number | null; s1: number | null; s2: number | null;
    shareCheckout: number; shareS1: number; shareS2: number;
  };
  eligibleCount: number;
  lang: 'en' | 'es';
}) {
  const rows = [
    { l: tr(lang, 'Checkout', 'Salida'),       sub: tr(lang, 'full turnover', 'cambio total'), v: typeAvgs.checkout, tone: T.warm,        share: typeAvgs.shareCheckout },
    { l: tr(lang, 'Stay · light', 'Estadía · 1'), sub: tr(lang, 'day 1', 'día 1'),             v: typeAvgs.s1,       tone: T.sageDeep,    share: typeAvgs.shareS1 },
    { l: tr(lang, 'Stay · full', 'Estadía · 2'),  sub: tr(lang, 'day 2+', 'día 2+'),           v: typeAvgs.s2,       tone: T.caramelDeep, share: typeAvgs.shareS2 },
  ];
  return (
    <Card padding="20px 22px">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.rule}`,
      }}>
        <Caps>{tr(lang, 'Cleaning efficiency', 'Eficiencia de limpieza')}</Caps>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
          {eligibleCount} {tr(lang, 'cleans', 'limpiezas')}
        </span>
      </div>
      {/* Overall hero */}
      <div style={{ paddingBottom: 12, borderBottom: `1px solid ${T.ruleSoft}` }}>
        <Caps size={9}>{tr(lang, 'Overall avg', 'Promedio general')}</Caps>
        <div style={{ marginTop: 6 }}>
          <span style={{ fontFamily: FONT_SERIF, fontSize: 40, color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400 }}>
            {typeAvgs.overall != null ? (
              <>
                <span style={{ fontStyle: 'italic' }}>{typeAvgs.overall.toFixed(1)}</span>
                <span style={{ fontSize: 20, color: T.ink2, fontStyle: 'italic' }}>m</span>
              </>
            ) : '—'}
          </span>
        </div>
      </div>
      {/* Per-type */}
      {rows.map((e, i) => (
        <div key={e.l} style={{ padding: '12px 0', borderBottom: i < rows.length - 1 ? `1px solid ${T.ruleSoft}` : 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{e.l}</span>
              <Caps size={9} tracking="0.06em">{e.sub}</Caps>
            </div>
            <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: e.tone, letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400 }}>
              {e.v != null ? (
                <>
                  <span style={{ fontStyle: 'italic' }}>{e.v.toFixed(1)}</span>
                  <span style={{ fontSize: 13, color: T.ink2, fontStyle: 'italic' }}>m</span>
                </>
              ) : '—'}
            </span>
          </div>
          <div style={{ height: 5, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round(e.share * 100)}%`, background: e.tone, borderRadius: 999 }} />
          </div>
          <Caps size={9} tracking="0.06em" style={{ marginTop: 4, display: 'inline-block' }}>
            {Math.round(e.share * 100)}% {tr(lang, 'of cleans', 'de limpiezas')}
          </Caps>
        </div>
      ))}
    </Card>
  );
}
