'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Megaphone, Pin, X, Trash2 } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { t } from '@/lib/translations';

/**
 * NoticeBoardPoster — manager surface that lives at the top of the
 * /housekeeping Schedule tab.
 *
 * Manager types an English announcement (the primary language manager
 * dashboards always render). The server auto-translates it into Spanish on
 * post (see /api/housekeeping/notices), so Spanish-speaking housekeepers see
 * their language without anyone hand-typing a translation.
 *
 * The active notices list shows below the composer so the manager can
 * delete or unpin existing posts.
 */

interface NoticeRow {
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

const EXPIRY_OPTIONS = [
  { key: 'none',  hours: null,        label: 'hkNoticePostNoExpiry' },
  { key: '1h',    hours: 1,           label: 'hkNoticePostExpires1h' },
  { key: '1d',    hours: 24,          label: 'hkNoticePostExpires1d' },
  { key: '3d',    hours: 72,          label: 'hkNoticePostExpires3d' },
  { key: '1w',    hours: 24 * 7,      label: 'hkNoticePostExpires1w' },
  { key: '1m',    hours: 24 * 30,     label: 'hkNoticePostExpires1m' },
] as const;

export function NoticeBoardPoster() {
  const { lang } = useLang();
  const { activePropertyId } = useProperty();

  const [bodyEn, setBodyEn] = useState('');
  const [pinned, setPinned] = useState(false);
  const [expiryKey, setExpiryKey] = useState<(typeof EXPIRY_OPTIONS)[number]['key']>('1d');
  const [posting, setPosting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [notices, setNotices] = useState<NoticeRow[]>([]);

  const refetch = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      // Manager-side list endpoint — uses requireSession +
      // userHasPropertyAccess instead of the (pid, staffId) tuple the
      // housekeeper-side GET requires.
      const res = await fetch(
        `/api/housekeeping/notices/manager-list?pid=${encodeURIComponent(activePropertyId)}`,
      );
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { notices: NoticeRow[] } }
        | null;
      if (json?.ok && json.data) {
        setNotices(json.data.notices ?? []);
      }
    } catch {
      // best-effort
    }
  }, [activePropertyId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const handlePost = useCallback(async () => {
    if (!activePropertyId || !bodyEn.trim() || posting) return;
    setPosting(true);
    try {
      const opt = EXPIRY_OPTIONS.find((e) => e.key === expiryKey);
      const expiresAt = opt?.hours == null
        ? null
        : new Date(Date.now() + opt.hours * 3600 * 1000).toISOString();
      const res = await fetch('/api/housekeeping/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          body_en: bodyEn.trim(),
          pinned,
          expires_at: expiresAt,
        }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      showToast(t('hkNoticePosted', lang));
      setBodyEn('');
      setPinned(false);
      setExpiryKey('1d');
      void refetch();
    } catch {
      showToast("Couldn't post notice");
    } finally {
      setPosting(false);
    }
  }, [activePropertyId, bodyEn, pinned, expiryKey, posting, refetch, showToast, lang]);

  const handleDelete = useCallback(
    async (noticeId: string) => {
      if (!activePropertyId) return;
      try {
        await fetch(
          `/api/housekeeping/notices?id=${encodeURIComponent(noticeId)}&pid=${encodeURIComponent(activePropertyId)}`,
          { method: 'DELETE' },
        );
        void refetch();
      } catch {
        // ignore
      }
    },
    [activePropertyId, refetch],
  );

  return (
    <section
      style={{
        background: '#FFFFFF',
        border: '1px solid rgba(31,35,28,.08)',
        borderRadius: 16,
        boxShadow: '0 6px 16px -14px rgba(31,42,32,.35)',
        padding: '16px 18px',
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        fontFamily: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Megaphone size={18} color="#3E5C48" />
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: '#1F231C' }}>
          {t('hkNoticePostTitle', lang)}
        </h3>
      </div>

      <textarea
        value={bodyEn}
        onChange={(e) => setBodyEn(e.target.value)}
        placeholder={t('hkNoticePostBody', lang)}
        rows={2}
        maxLength={1000}
        style={{
          width: '100%',
          padding: 12,
          border: '1px solid rgba(31,35,28,.14)',
          borderRadius: 12,
          fontSize: 14,
          fontFamily: 'inherit',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: '#5C625C',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
          <Pin size={13} color="#8C6A33" />
          {t('hkNoticePostPin', lang)}
        </label>

        <span style={{ fontSize: 12, color: '#5C625C' }}>
          {t('hkNoticePostExpires', lang)}:
        </span>
        <select
          value={expiryKey}
          onChange={(e) => setExpiryKey(e.target.value as typeof expiryKey)}
          style={{
            padding: '6px 10px',
            border: '1px solid rgba(31,35,28,.14)',
            borderRadius: 999,
            fontSize: 13,
            fontFamily: 'inherit',
            color: '#5C625C',
            background: 'white',
          }}
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {t(opt.label, lang)}
            </option>
          ))}
        </select>

        <button
          onClick={handlePost}
          disabled={!bodyEn.trim() || posting}
          style={{
            marginLeft: 'auto',
            padding: '8px 16px',
            background: !bodyEn.trim() || posting ? 'rgba(62,92,72,.35)' : '#3E5C48',
            color: 'white',
            border: 'none',
            borderRadius: 999,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: !bodyEn.trim() || posting ? 'not-allowed' : 'pointer',
          }}
        >
          {posting ? '...' : t('hkNoticePostSubmit', lang)}
        </button>
      </div>

      {notices.length > 0 && (
        <div
          style={{
            marginTop: 4,
            borderTop: '1px solid rgba(31,35,28,.08)',
            paddingTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {notices.slice(0, 5).map((n) => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 10px',
                background: n.pinned ? 'rgba(201,150,68,.14)' : 'rgba(31,35,28,.03)',
                border: `1px solid ${n.pinned ? 'rgba(201,150,68,.45)' : 'rgba(31,35,28,.08)'}`,
                borderRadius: 10,
              }}
            >
              {n.pinned && <Pin size={12} color="#8C6A33" style={{ marginTop: 3 }} />}
              <div style={{ flex: 1, fontSize: 13, color: '#1F231C', lineHeight: 1.4 }}>
                {n.body_en}
                {n.expires_at && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#8A9187' }}>
                    ({new Date(n.expires_at).toLocaleString()})
                  </span>
                )}
              </div>
              <button
                onClick={() => handleDelete(n.id)}
                aria-label={lang === 'es' ? 'Eliminar aviso' : 'Delete notice'}
                style={{
                  minHeight: 32,
                  minWidth: 32,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.5,
                }}
              >
                <Trash2 size={14} color="#8A9187" />
              </button>
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1F231C',
            color: 'white',
            padding: '10px 16px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 70,
          }}
        >
          <X
            size={14}
            style={{ marginRight: 6, cursor: 'pointer' }}
            onClick={() => setToast(null)}
          />
          {toast}
        </div>
      )}
    </section>
  );
}
