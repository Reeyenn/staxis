'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { NotebookPen, Trash2 } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useTodayStr } from '@/lib/use-today-str';
import { t } from '@/lib/translations';
import { T, FONT_SANS } from './_snow';

/**
 * ManagerNotesEditor — renders inside the RoomsTab room-detail modal.
 *
 * Manager types a free-text note for a specific room on today's date.
 * Notes are visible to the housekeeper on the matching job card. The
 * editor below also lists the active notes so the manager can delete
 * yesterday's stragglers.
 */
interface Props {
  roomNumber: string;
  /** Optional callback fired after a successful post; lets the parent
   *  refresh anything that depends on the note list. */
  onChange?: () => void;
}

interface NoteRow {
  id: string;
  note_text: string;
  posted_at: string;
  expires_at: string | null;
}

export function ManagerNotesEditor({ roomNumber, onChange }: Props) {
  const { lang } = useLang();
  const { activePropertyId } = useProperty();
  const today = useTodayStr();

  const [draft, setDraft] = useState('');
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [posting, setPosting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!activePropertyId || !roomNumber) return;
    try {
      // Manager-side list endpoint — uses requireSession +
      // userHasPropertyAccess (the housekeeper-side GET on the sibling
      // route requires a staffId tuple that managers don't have).
      const res = await fetch(
        `/api/housekeeping/room-notes/manager-list?pid=${encodeURIComponent(activePropertyId)}&date=${encodeURIComponent(today)}`,
      );
      if (!res.ok) {
        setNotes([]);
        setLoaded(true);
        return;
      }
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { byRoom: Record<string, NoteRow[]> } }
        | null;
      if (json?.ok && json.data) {
        setNotes(json.data.byRoom[roomNumber] ?? []);
        setLoaded(true);
      }
    } catch {
      // ignore
    }
  }, [activePropertyId, roomNumber, today]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  const handlePost = useCallback(async () => {
    if (!activePropertyId || !draft.trim() || posting) return;
    setPosting(true);
    try {
      const res = await fetch('/api/housekeeping/room-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          room_number: roomNumber,
          business_date: today,
          note_text: draft.trim(),
          note_lang: lang,
        }),
      });
      if (!res.ok) throw new Error('post failed');
      setDraft('');
      showToast(t('mgrNotesSaved', lang));
      void refetch();
      onChange?.();
    } catch {
      showToast("Couldn't save note");
    } finally {
      setPosting(false);
    }
  }, [activePropertyId, draft, roomNumber, today, lang, posting, refetch, showToast, onChange]);

  const handleDelete = useCallback(
    async (noteId: string) => {
      if (!activePropertyId) return;
      try {
        await fetch(
          `/api/housekeeping/room-notes?id=${encodeURIComponent(noteId)}&pid=${encodeURIComponent(activePropertyId)}`,
          { method: 'DELETE' },
        );
        void refetch();
        onChange?.();
      } catch {
        // ignore
      }
    },
    [activePropertyId, refetch, onChange],
  );

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: 'rgba(31,35,28,0.03)',
        border: `1px solid ${T.rule}`,
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <NotebookPen size={16} color={T.ink2} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: T.ink }}>
          {t('mgrNotesTitle', lang)}
        </span>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('mgrNotesPlaceholder', lang)}
        rows={2}
        maxLength={1000}
        style={{
          width: '100%',
          padding: 10,
          background: T.paper,
          border: '1px solid rgba(31,35,28,0.14)',
          borderRadius: 10,
          fontSize: 13,
          color: T.ink,
          fontFamily: FONT_SANS,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      <button
        onClick={handlePost}
        disabled={!draft.trim() || posting}
        style={{
          alignSelf: 'flex-end',
          padding: '6px 16px',
          background: !draft.trim() || posting ? 'rgba(31,35,28,0.18)' : '#3E5C48',
          color: 'white',
          border: 'none',
          borderRadius: 999,
          fontFamily: FONT_SANS,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: !draft.trim() || posting ? 'not-allowed' : 'pointer',
        }}
      >
        {posting ? '...' : t('mgrNotesAdd', lang)}
      </button>

      {loaded && notes.length === 0 && (
        <div style={{ fontSize: 12, color: T.ink3, textAlign: 'center', padding: '4px 0' }}>
          {t('mgrNotesEmpty', lang)}
        </div>
      )}

      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {notes.map((n) => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                padding: '8px 10px',
                background: T.paper,
                border: `1px solid ${T.rule}`,
                borderRadius: 10,
              }}
            >
              <div style={{ flex: 1, fontSize: 12, color: T.ink, lineHeight: 1.4 }}>
                {n.note_text}
                <div style={{ fontSize: 10, color: T.ink3, marginTop: 2 }}>
                  {new Date(n.posted_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
              <button
                onClick={() => handleDelete(n.id)}
                aria-label={t('mgrNotesDelete', lang)}
                style={{
                  minHeight: 28,
                  minWidth: 28,
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
                <Trash2 size={12} color={T.ink3} />
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
            background: T.ink,
            color: 'white',
            padding: '8px 14px',
            borderRadius: 999,
            fontSize: 12,
            zIndex: 80,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
