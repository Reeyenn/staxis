/**
 * CalloutBanner — manager-facing summary of any sick callouts active today.
 *
 * Rendered at the top of the Schedule tab content. When any housekeeper
 * has called out, shows a one-line summary with a Revert button + a
 * "View detail" toggle for the per-pickup breakdown.
 *
 * The banner is self-fetching (polls /api/housekeeping/callout/status
 * every 30s) so the parent ScheduleTab doesn't need to thread callout
 * data through its render path. Keeps the merge conflict surface in
 * ScheduleTab.tsx to a single import + a single render line.
 *
 * Empty state: render nothing at all (returns null) so the banner
 * doesn't take up vertical space on a normal day.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { T, FONT_SANS, FONT_MONO, Btn, Pill, Caps } from './_snow';
import type { CalloutBannerEntry } from '@/lib/sick-callout/types';

interface Props {
  /** Date the manager is viewing (Schedule tab is date-aware). */
  shiftDate?: string;
}

const POLL_INTERVAL_MS = 30_000;

export function CalloutBanner({ shiftDate }: Props) {
  const { lang } = useLang();
  const { activePropertyId } = useProperty();

  const [entries, setEntries] = useState<CalloutBannerEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dateParam = shiftDate ?? new Date().toISOString().slice(0, 10);

  const refresh = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/callout/status?pid=${encodeURIComponent(activePropertyId)}&date=${encodeURIComponent(dateParam)}`,
      );
      if (!res.ok) {
        // Don't show "0 callouts" on a transient failure — keep whatever
        // we had. Surface a small inline notice instead.
        setError(lang === 'es' ? 'No se pudo cargar el banner' : 'Could not load banner');
        return;
      }
      const body = (await res.json()) as {
        ok: boolean;
        data?: { entries: CalloutBannerEntry[] };
      };
      if (body.ok && body.data) {
        setEntries(body.data.entries ?? []);
        setError(null);
      }
    } catch {
      setError(lang === 'es' ? 'No se pudo cargar el banner' : 'Could not load banner');
    }
  }, [activePropertyId, dateParam, lang]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const onRevert = useCallback(
    async (calloutId: string, staffName: string) => {
      if (!activePropertyId) return;
      const confirmMsg =
        lang === 'es'
          ? `¿Revertir la ausencia de ${staffName}? Volverá a su turno y las habitaciones regresarán a su lista (excepto las ya iniciadas).`
          : `Revert ${staffName}'s callout? They'll be back on shift, rooms returned to their queue (except any already started).`;
      if (!window.confirm(confirmMsg)) return;
      setRevertingId(calloutId);
      try {
        const res = await fetchWithAuth('/api/housekeeping/callout/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: activePropertyId, calloutId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const msg = body?.error ?? (lang === 'es' ? 'No se pudo revertir' : 'Could not revert');
          window.alert(msg);
          return;
        }
        // Codex review 2026-05-24, Probe 6: optimistically remove the
        // reverted callout from local state BEFORE the refresh. If the
        // refresh fails (transient network, server hiccup), the manager
        // doesn't see a stale "still called out" banner — they see the
        // truth their click just established. The next poll will sync
        // any drift. We also surface the refresh failure inline so the
        // manager knows the data may not be fully current.
        setEntries((prev) => prev.filter((e) => e.callout_id !== calloutId));
        try {
          await refresh();
        } catch {
          // refresh already swallows errors into setError; nothing more
          // to do here.
        }
      } finally {
        setRevertingId(null);
      }
    },
    [activePropertyId, lang, refresh],
  );

  if (entries.length === 0 && !error) return null;

  return (
    <div
      style={{
        background: T.warmDim,
        border: `1px solid ${T.warm}`,
        borderRadius: 14,
        padding: '14px 18px',
        marginBottom: 18,
        fontFamily: FONT_SANS,
        color: T.ink,
      }}
      role="alert"
      aria-live="polite"
    >
      {error && entries.length === 0 ? (
        <div style={{ fontSize: 13, color: T.ink2 }}>{error}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Surface refresh errors inline even when we have stale entries,
              so the manager knows the data on screen may be lagging
              (Codex review 2026-05-24, Probe 6). */}
          {error ? (
            <div style={{ fontSize: 12, color: T.warm }}>
              {error}
            </div>
          ) : null}
          {entries.map((entry) => (
            <CalloutRow
              key={entry.callout_id}
              entry={entry}
              expanded={expandedId === entry.callout_id}
              onToggleExpand={() =>
                setExpandedId(expandedId === entry.callout_id ? null : entry.callout_id)
              }
              onRevert={() => onRevert(entry.callout_id, entry.staff_name)}
              reverting={revertingId === entry.callout_id}
              lang={lang}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CalloutRow({
  entry,
  expanded,
  onToggleExpand,
  onRevert,
  reverting,
  lang,
}: {
  entry: CalloutBannerEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  onRevert: () => void;
  reverting: boolean;
  lang: 'en' | 'es';
}) {
  const pickupsLine = entry.pickups
    .filter((p) => p.count > 0)
    .map((p) => `${p.staff_name} +${p.count}`)
    .join(', ');

  const headlineEn = `${entry.staff_name} called out today — ${entry.total_redistributed} room${entry.total_redistributed === 1 ? '' : 's'} redistributed across the team.${pickupsLine ? ` ${pickupsLine}.` : ''}`;
  const headlineEs = `${entry.staff_name} se reportó enfermo hoy — ${entry.total_redistributed} habitación${entry.total_redistributed === 1 ? '' : 'es'} repartida${entry.total_redistributed === 1 ? '' : 's'} entre el equipo.${pickupsLine ? ` ${pickupsLine}.` : ''}`;

  const sourceLabel: Record<typeof entry.reported_by, { en: string; es: string }> = {
    self: { en: 'self-reported', es: 'auto-reporte' },
    manager: { en: 'manager-marked', es: 'marcado por manager' },
    sms: { en: 'via SMS', es: 'por SMS' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Pill tone="warm">{lang === 'es' ? 'AUSENCIA' : 'CALLOUT'}</Pill>
            <Caps c={T.ink2} size={10}>
              {sourceLabel[entry.reported_by][lang === 'es' ? 'es' : 'en']}
            </Caps>
            {entry.reason ? (
              <span
                style={{
                  fontSize: 11,
                  fontFamily: FONT_MONO,
                  textTransform: 'uppercase',
                  color: T.ink2,
                  letterSpacing: '0.08em',
                }}
              >
                · {entry.reason}
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, color: T.ink }}>
            {lang === 'es' ? headlineEs : headlineEn}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <Btn size="sm" variant="ghost" onClick={onToggleExpand}>
            {expanded
              ? lang === 'es'
                ? 'Ocultar detalle'
                : 'Hide detail'
              : lang === 'es'
              ? 'Ver detalle'
              : 'View detail'}
          </Btn>
          <Btn
            size="sm"
            variant="paper"
            onClick={onRevert}
            disabled={reverting}
          >
            {reverting
              ? lang === 'es'
                ? 'Revirtiendo…'
                : 'Reverting…'
              : lang === 'es'
              ? 'Revertir ausencia'
              : 'Revert callout'}
          </Btn>
        </div>
      </div>
      {expanded ? (
        <div
          style={{
            background: T.bg,
            border: `1px solid ${T.ruleSoft}`,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 13,
            color: T.ink2,
            lineHeight: 1.6,
          }}
        >
          {entry.total_redistributed === 0 ? (
            <div>
              {lang === 'es'
                ? 'No había habitaciones asignadas a esta persona al momento de la ausencia.'
                : 'No rooms were assigned to this housekeeper at the time of the callout.'}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 4 }}>
                {lang === 'es' ? 'Reparto por persona:' : 'Pickups by housekeeper:'}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {entry.pickups.map((p) => (
                  <li key={`${p.staff_id ?? 'unassigned'}`}>
                    {p.staff_name}: <strong>{p.count}</strong>{' '}
                    {lang === 'es' ? 'habitación(es)' : 'room(s)'}
                  </li>
                ))}
              </ul>
              {entry.redistributed_at ? (
                <div style={{ marginTop: 6, fontSize: 11, color: T.ink3 }}>
                  {lang === 'es' ? 'Repartido a las ' : 'Redistributed at '}
                  {new Date(entry.redistributed_at).toLocaleTimeString(
                    lang === 'es' ? 'es-US' : 'en-US',
                    { hour: 'numeric', minute: '2-digit' },
                  )}
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 11, color: T.ink3 }}>
                  {lang === 'es' ? 'Reparto pendiente…' : 'Redistribution pending…'}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
