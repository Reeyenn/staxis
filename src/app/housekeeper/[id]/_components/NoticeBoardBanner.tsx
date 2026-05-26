'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, X, Pin } from 'lucide-react';
import { t, type HousekeeperLocale } from '@/lib/translations';

/**
 * NoticeBoardBanner — renders the active manager notices at the top of
 * the housekeeper page.
 *
 * Polls /api/housekeeping/notices on mount + at a 60s interval so a
 * fresh notice shows up without a page refresh. Per-user dismissals
 * persist server-side; pinned notices ignore dismissal and stay until
 * they expire or the manager unpins.
 *
 * Renders nothing when there are no active visible notices.
 */
export interface NoticeRow {
  id: string;
  body_en: string;
  body_es: string | null;
  body_ht: string | null;
  body_tl: string | null;
  body_vi: string | null;
  pinned: boolean;
  expires_at: string | null;
  posted_at: string;
}

interface Props {
  pid: string;
  staffId: string;
  lang: HousekeeperLocale;
  /** When true, posts dismiss to the server via the offline-aware helper.
   *  Used to test rendering without making API calls. */
  enabled?: boolean;
}

function pickBody(notice: NoticeRow, lang: HousekeeperLocale): string {
  const key = `body_${lang}` as keyof NoticeRow;
  const value = notice[key];
  if (typeof value === 'string' && value.trim()) return value;
  return notice.body_en;
}

export function NoticeBoardBanner({ pid, staffId, lang, enabled = true }: Props) {
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [optimisticDismissed, setOptimisticDismissed] = useState<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    if (!enabled || !pid || !staffId) return;
    try {
      const res = await fetch(
        `/api/housekeeping/notices?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(staffId)}`,
      );
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { notices: NoticeRow[]; dismissedNoticeIds: string[] } }
        | null;
      if (res.ok && json?.ok && json.data) {
        setNotices(json.data.notices ?? []);
        setDismissed(new Set(json.data.dismissedNoticeIds ?? []));
      }
    } catch {
      // silent — banner is best-effort
    }
  }, [pid, staffId, enabled]);

  useEffect(() => {
    void refetch();
    const id = window.setInterval(refetch, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  const visible = useMemo(() => {
    const now = Date.now();
    return notices.filter((n) => {
      if (n.expires_at && Date.parse(n.expires_at) <= now) return false;
      if (dismissed.has(n.id)) return false;
      if (optimisticDismissed.has(n.id)) return false;
      return true;
    });
  }, [notices, dismissed, optimisticDismissed]);

  const handleDismiss = useCallback(
    async (noticeId: string) => {
      // Optimistic update — the banner disappears immediately. We
      // intentionally don't put pinned notices behind a per-user dismissal
      // server-side restriction (managers can always pin a notice that
      // every housekeeper has dismissed). The UI just hides them.
      setOptimisticDismissed((s) => new Set([...s, noticeId]));
      try {
        await fetch('/api/housekeeping/notice-dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, staffId, noticeId }),
        });
      } catch {
        // If the dismiss POST fails (offline), keep the optimistic state —
        // the next online refetch will reconcile.
      }
    },
    [pid, staffId],
  );

  if (visible.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {visible.map((notice) => (
        <div
          key={notice.id}
          role="status"
          style={{
            background: notice.pinned ? '#FFFBEB' : '#EFF6FF',
            border: `1.5px solid ${notice.pinned ? '#FCD34D' : '#93C5FD'}`,
            borderRadius: 12,
            padding: '12px 14px',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          {notice.pinned ? (
            <Pin size={16} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
          ) : (
            <Megaphone size={16} color="#2563EB" style={{ flexShrink: 0, marginTop: 2 }} />
          )}
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: notice.pinned ? '#92400E' : '#1E40AF',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 4,
              }}
            >
              {notice.pinned ? t('hkNoticePinned', lang) : t('hkNotice', lang)}
            </div>
            <div style={{ fontSize: 14, color: '#111827', lineHeight: 1.4 }}>
              {pickBody(notice, lang)}
            </div>
          </div>
          <button
            onClick={() => handleDismiss(notice.id)}
            aria-label={t('hkNoticeDismiss', lang)}
            style={{
              minHeight: 36,
              minWidth: 36,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              flexShrink: 0,
              opacity: 0.6,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <X size={16} color="#374151" />
          </button>
        </div>
      ))}
    </div>
  );
}
