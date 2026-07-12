// Manager Recognition — give + browse staff kudos (manager-only Staff tab).
//
// A manager picks a staff member, writes a short recognition (optionally
// tagged), and it's saved via POST /api/staff/kudos. The feed below shows
// recent kudos across the property. Delivery is IN-APP ONLY — the recipient
// sees their recognition in their own My Shifts view (no SMS).
//
// Reads/writes go through /api/staff/kudos (service-role) — staff_kudos is
// deny-all to anon + authenticated (migration 0251). The Staff page is already
// manager-only; the API route re-checks the management role on every call.

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { StaffMember } from '@/types';
import { T, fonts, Btn, Caps, Card, asDeptKey, deptMeta } from './_tokens';
import { StaffAvatar, PageHeader } from './_people';
import { inputStyle } from './_fields';

type Lang = 'en' | 'es';

type KudosCategory = 'guest-praise' | 'teamwork' | 'above-and-beyond' | 'attendance';

interface Kudos {
  id: string;
  staffId: string;
  givenBy: string | null;
  givenByName: string | null;
  message: string;
  category: string | null;
  createdAt: string | null;
}

const CATEGORY_META: Record<KudosCategory, { en: string; es: string; tone: string; dim: string }> = {
  'guest-praise':     { en: 'Guest praise',   es: 'Elogio de huésped', tone: '#8C6A33', dim: 'rgba(201,150,68,0.14)' },
  'teamwork':         { en: 'Teamwork',       es: 'Trabajo en equipo', tone: '#5C7A60', dim: 'rgba(92,122,96,0.12)' },
  'above-and-beyond': { en: 'Above & beyond', es: 'Excepcional',       tone: '#7B6A97', dim: 'rgba(123,106,151,0.12)' },
  'attendance':       { en: 'Attendance',     es: 'Asistencia',        tone: '#3A5670', dim: 'rgba(58,86,112,0.12)' },
};
const CATEGORY_ORDER: KudosCategory[] = ['guest-praise', 'teamwork', 'above-and-beyond', 'attendance'];

const MSG_MAX = 500;

function catLabel(cat: string | null, lang: Lang): string | null {
  if (!cat || !(cat in CATEGORY_META)) return null;
  const m = CATEGORY_META[cat as KudosCategory];
  return lang === 'es' ? m.es : m.en;
}

function timeAgo(iso: string | null, lang: Lang): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return lang === 'es' ? 'ahora' : 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return lang === 'es' ? `hace ${mins} min` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return lang === 'es' ? `hace ${hrs} h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return lang === 'es' ? `hace ${days} d` : `${days}d ago`;
  const weeks = Math.round(days / 7);
  return lang === 'es' ? `hace ${weeks} sem` : `${weeks}w ago`;
}

export function ManagerRecognition() {
  const { activePropertyId, staff } = useProperty();
  const { lang } = useLang() as { lang: Lang };
  const pid = activePropertyId ?? '';

  const [recipientId, setRecipientId] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [category, setCategory] = useState<KudosCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<Kudos[]>([]);
  const [loading, setLoading] = useState(true);

  // Active staff, sorted by department then name — the pool you can recognize.
  const recipients = useMemo(() => {
    const ord: Record<string, number> = { housekeeping: 0, front_desk: 1, maintenance: 2, other: 3 };
    return [...staff].filter(s => s.isActive !== false).sort((a, b) => {
      const oa = ord[asDeptKey(a.department)] ?? 3;
      const ob = ord[asDeptKey(b.department)] ?? 3;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
  }, [staff]);

  const nameById = useMemo(() => {
    const m = new Map<string, StaffMember>();
    for (const s of staff) m.set(s.id, s);
    return m;
  }, [staff]);

  const loadFeed = useCallback(async () => {
    if (!pid) return;
    try {
      const res = await fetchWithAuth(`/api/staff/kudos?hotelId=${pid}&scope=feed`);
      if (!res.ok) { setLoading(false); return; }
      const body = (await res.json()) as { data?: { kudos?: Kudos[] } };
      setFeed(body?.data?.kudos ?? []);
    } catch {
      /* keep last feed on transient error */
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => { setLoading(true); void loadFeed(); }, [loadFeed]);

  const canGive = !!recipientId && message.trim().length > 0 && !busy;

  const give = async () => {
    if (!canGive || !pid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/staff/kudos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId: pid,
          staffId: recipientId,
          message: message.trim(),
          ...(category ? { category } : {}),
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || (lang === 'es' ? 'No se pudo guardar' : 'Could not save'));
      }
      // Reset the form and refresh the feed.
      setMessage('');
      setCategory(null);
      setRecipientId('');
      await loadFeed();
    } catch (e) {
      setError(e instanceof Error ? e.message : (lang === 'es' ? 'No se pudo guardar' : 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '24px 48px 48px',
    }}>
      <style>{`
        .kudos-layout { display: grid; grid-template-columns: 380px 1fr; gap: 20px; align-items: start; }
        @media (max-width: 900px) { .kudos-layout { grid-template-columns: 1fr; } }
      `}</style>

      <PageHeader
        title={lang === 'es' ? 'Reconocimiento' : 'Recognition'}
        eyebrow={lang === 'es' ? 'Personal · Reconocimiento' : 'Staff · Recognition'}
        sub={lang === 'es'
          ? 'Celebra el buen trabajo. Tu equipo verá su reconocimiento al abrir Personal — sin mensajes de texto.'
          : 'Celebrate great work. Your team sees their recognition when they open Staff — no texting.'}
        right={<Caps>{feed.length} {lang === 'es' ? 'en total' : 'given'}</Caps>}
      />

      <div className="kudos-layout">
        {/* ── Give a recognition ── */}
        <Card style={{ padding: '20px 22px' }}>
          <Caps size={10}>{lang === 'es' ? 'Dar reconocimiento' : 'Give recognition'}</Caps>

          {/* Recipient */}
          <div style={{ marginTop: 14 }}>
            <FieldLabel>{lang === 'es' ? 'Para' : 'To'}</FieldLabel>
            <select
              value={recipientId}
              onChange={e => setRecipientId(e.target.value)}
              style={{
                ...inputStyle, marginTop: 6,
                appearance: 'none',
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%235C625C' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E\")",
                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 14px center', paddingRight: 36,
              }}
            >
              <option value="">{lang === 'es' ? 'Elige un miembro del personal…' : 'Choose a staff member…'}</option>
              {recipients.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} · {deptMeta[asDeptKey(s.department)].label}
                </option>
              ))}
            </select>
          </div>

          {/* Category (optional) */}
          <div style={{ marginTop: 14 }}>
            <FieldLabel>{lang === 'es' ? 'Categoría (opcional)' : 'Category (optional)'}</FieldLabel>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {CATEGORY_ORDER.map(c => {
                const m = CATEGORY_META[c];
                const sel = category === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(sel ? null : c)}
                    style={{
                      padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
                      border: sel ? `1px solid ${m.tone}` : `1px solid ${T.rule}`,
                      background: sel ? m.dim : 'transparent',
                      color: sel ? m.tone : T.ink2,
                      fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                    }}
                  >{lang === 'es' ? m.es : m.en}</button>
                );
              })}
            </div>
          </div>

          {/* Message */}
          <div style={{ marginTop: 14 }}>
            <FieldLabel>{lang === 'es' ? 'Mensaje' : 'Message'}</FieldLabel>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value.slice(0, MSG_MAX))}
              rows={4}
              placeholder={lang === 'es'
                ? 'p. ej. Excelente trabajo limpiando el lobby después del evento.'
                : 'e.g. Amazing job turning the lobby around after the event.'}
              style={{ ...inputStyle, marginTop: 6, resize: 'vertical', lineHeight: 1.5 }}
            />
            <div style={{
              display: 'flex', justifyContent: 'flex-end', marginTop: 4,
              fontFamily: fonts.mono, fontSize: 10, color: T.ink3,
            }}>{message.length}/{MSG_MAX}</div>
          </div>

          {error && (
            <div role="alert" style={{
              marginTop: 10, padding: '10px 14px',
              background: 'rgba(160,74,44,0.08)', border: '1px solid rgba(160,74,44,0.25)',
              borderRadius: 12, color: '#A04A2C', fontFamily: fonts.sans, fontSize: 13,
            }}>{error}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <Btn variant="primary" size="md" onClick={give} disabled={!canGive}>
              {busy
                ? (lang === 'es' ? 'Guardando…' : 'Giving…')
                : (lang === 'es' ? '★ Dar reconocimiento' : '★ Give recognition')}
            </Btn>
          </div>
        </Card>

        {/* ── Feed ── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <Caps size={10}>{lang === 'es' ? 'Reconocimientos recientes' : 'Recent recognition'}</Caps>
          </div>

          {loading ? (
            <div style={{
              padding: '40px 0', textAlign: 'center',
              fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.08em',
            }}>{lang === 'es' ? 'CARGANDO…' : 'LOADING…'}</div>
          ) : feed.length === 0 ? (
            <Card style={{ textAlign: 'center', padding: '34px 22px' }}>
              <div style={{ fontFamily: fonts.serif, fontSize: 20, fontStyle: 'italic', color: T.ink3 }}>
                {lang === 'es' ? 'Aún no hay reconocimientos.' : 'No recognition yet.'}
              </div>
              <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, marginTop: 6 }}>
                {lang === 'es' ? 'Sé el primero en reconocer a alguien.' : 'Be the first to recognize someone.'}
              </div>
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {feed.map(k => (
                <KudosCard key={k.id} kudos={k} recipient={nameById.get(k.staffId) ?? null} lang={lang} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KudosCard({ kudos, recipient, lang }: { kudos: Kudos; recipient: StaffMember | null; lang: Lang }) {
  const cat = catLabel(kudos.category, lang);
  const catTone = kudos.category && kudos.category in CATEGORY_META
    ? CATEGORY_META[kudos.category as KudosCategory]
    : null;
  const recipientName = recipient?.name ?? (lang === 'es' ? 'Personal' : 'Staff');
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
      padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
    }}>
      {recipient
        ? <StaffAvatar staff={recipient} size={38} />
        : <span style={{
            width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
            background: T.rule, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', color: T.ink3, fontFamily: fonts.serif, fontSize: 16,
          }}>★</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: T.ink }}>
            {recipientName}
          </span>
          {cat && catTone && (
            <span style={{
              fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
              color: catTone.tone, background: catTone.dim,
              border: `1px solid ${catTone.tone}33`,
              padding: '1px 8px', borderRadius: 999,
            }}>{cat}</span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, whiteSpace: 'nowrap' }}>
            {timeAgo(kudos.createdAt, lang)}
          </span>
        </div>
        <div style={{
          fontFamily: fonts.sans, fontSize: 13.5, color: T.inkSoft, marginTop: 5, lineHeight: 1.5,
          wordBreak: 'break-word',
        }}>{kudos.message}</div>
        {kudos.givenByName && (
          <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3, marginTop: 6 }}>
            {lang === 'es' ? 'Por' : 'From'} {kudos.givenByName}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display: 'block', fontFamily: fonts.mono, fontSize: 10, fontWeight: 600,
      color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</label>
  );
}

