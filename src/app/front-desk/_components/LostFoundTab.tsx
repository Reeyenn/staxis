'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Front-desk Lost & Found — the unified register.
//
// Shows BOTH app-logged items and PMS-synced items (read-only). Lets the desk
// log found items + guest lost reports, run AI auto-describe on photos, AI
// auto-match lost↔found, mark returned/shipped/disposed, text the guest, and
// see each found item's 90-day disposal countdown. Snow design system.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  T,
  FONT_SANS,
  FONT_SERIF,
  FONT_MONO,
  Modal,
  Field,
  TextInput,
  TextArea,
  ChipChoose,
} from '@/app/maintenance/_components/_mt-snow';
import {
  subscribeLostFound,
  fetchLostFoundRegister,
  logLostFoundItem,
  updateLostFoundItem,
  matchLostFound,
  describeFoundPhoto,
  autoMatchLost,
  notifyGuestLostFound,
  presignFoundPhoto,
  type LostFoundItem,
  type LostFoundCounts,
  type AutoMatchResult,
} from '@/lib/db/lost-and-found';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

type Lang = 'en' | 'es';
const tr = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

const CATEGORY_LABELS: Record<string, { en: string; es: string }> = {
  electronics: { en: 'Electronics', es: 'Electrónica' },
  clothing: { en: 'Clothing', es: 'Ropa' },
  jewelry: { en: 'Jewelry', es: 'Joyería' },
  documents: { en: 'Documents', es: 'Documentos' },
  bags: { en: 'Bags', es: 'Bolsos' },
  keys: { en: 'Keys', es: 'Llaves' },
  toiletries: { en: 'Toiletries', es: 'Artículos de aseo' },
  eyewear: { en: 'Eyewear', es: 'Gafas' },
  toys: { en: 'Toys', es: 'Juguetes' },
  money: { en: 'Money', es: 'Dinero' },
  other: { en: 'Other', es: 'Otro' },
};
const catLabel = (c: string | null, lang: Lang) =>
  c ? (CATEGORY_LABELS[c] ? CATEGORY_LABELS[c][lang] : c) : '';

function statusMeta(status: string, lang: Lang): { label: string; color: string } {
  switch (status) {
    case 'open':
      return { label: tr(lang, 'Open', 'Abierto'), color: T.ink };
    case 'matched':
      return { label: tr(lang, 'Matched', 'Emparejado'), color: T.caramel };
    case 'returned':
      return { label: tr(lang, 'Returned', 'Devuelto'), color: T.sageDeep };
    case 'shipped':
      return { label: tr(lang, 'Shipped', 'Enviado'), color: T.sageDeep };
    case 'claimed':
      return { label: tr(lang, 'Claimed', 'Reclamado'), color: T.sageDeep };
    case 'disposed':
      return { label: tr(lang, 'Disposed', 'Desechado'), color: T.ink3 };
    case 'expired':
      return { label: tr(lang, 'Expired', 'Vencido'), color: T.warm };
    default:
      return { label: status, color: T.ink2 };
  }
}

function fmtWhen(iso: string | null, lang: Lang): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return tr(lang, 'today', 'hoy');
  if (days === 1) return tr(lang, 'yesterday', 'ayer');
  if (days < 7) return tr(lang, `${days}d ago`, `hace ${days}d`);
  return new Date(ms).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Disposal countdown for an open found item. */
function disposalInfo(item: LostFoundItem, lang: Lang): { label: string; color: string } | null {
  if (item.type !== 'found' || item.status !== 'open' || !item.holdUntil) return null;
  const ms = Date.parse(item.holdUntil);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return { label: tr(lang, 'Past hold — dispose', 'Vencido — desechar'), color: T.warm };
  if (days <= 7)
    return { label: tr(lang, `Dispose in ${days}d`, `Desechar en ${days}d`), color: T.warm };
  if (days <= 14)
    return { label: tr(lang, `Hold ${days}d left`, `Quedan ${days}d`), color: T.caramel };
  return { label: tr(lang, `Hold ${days}d left`, `Quedan ${days}d`), color: T.ink3 };
}

// ── Client image helper: downscale to JPEG for AI describe + smaller upload ──
async function prepareImage(
  file: File,
): Promise<{ blob: Blob; ext: string; b64?: string; mime?: 'image/jpeg'; previewUrl: string }> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read'));
      fr.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode'));
      im.src = dataUrl;
    });
    const maxDim = 1280;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ctx');
    ctx.drawImage(img, 0, 0, width, height);
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.82);
    const b64 = jpegDataUrl.split(',')[1];
    const blob = await (await fetch(jpegDataUrl)).blob();
    return { blob, ext: 'jpg', b64, mime: 'image/jpeg', previewUrl: jpegDataUrl };
  } catch {
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
    return {
      blob: file,
      ext: /^(jpe?g|png|webp|heic|heif)$/.test(ext) ? ext : 'jpg',
      previewUrl: URL.createObjectURL(file),
    };
  }
}

type ViewFilter = 'unresolved' | 'found' | 'lost' | 'resolved' | 'all';

export function LostFoundTab({ pid, lang }: { pid: string; lang: Lang }) {
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [counts, setCounts] = useState<LostFoundCounts>({
    open: 0,
    awaitingReturn: 0,
    nearingDisposal: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewFilter>('unresolved');
  const [toast, setToast] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logType, setLogType] = useState<'found' | 'lost'>('found');

  const showToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const refetch = useCallback(async () => {
    const payload = await fetchLostFoundRegister(pid);
    setItems(payload.items);
    setCounts(payload.counts);
  }, [pid]);

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    const unsub = subscribeLostFound(pid, (payload) => {
      setItems(payload.items);
      setCounts(payload.counts);
      setLoading(false);
    });
    return unsub;
  }, [pid]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (view === 'found' && it.type !== 'found') return false;
      if (view === 'lost' && it.type !== 'lost') return false;
      if (view === 'unresolved' && !(it.status === 'open' || it.status === 'matched')) return false;
      if (view === 'resolved' && (it.status === 'open' || it.status === 'matched')) return false;
      if (!q) return true;
      const hay = [
        it.itemDescription,
        it.location,
        it.roomNumber,
        it.guestName,
        it.foundBy,
        catLabel(it.category, lang),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, view, search, lang]);

  // ── styles ──
  const wrap: React.CSSProperties = { padding: '24px 48px 120px', background: T.bg, minHeight: '70dvh' };
  const primaryBtn: React.CSSProperties = {
    padding: '10px 16px',
    borderRadius: 10,
    background: T.ink,
    color: T.bg,
    border: 'none',
    cursor: 'pointer',
    fontFamily: FONT_SANS,
    fontSize: 13.5,
    fontWeight: 600,
  };
  const ghostBtn: React.CSSProperties = {
    padding: '10px 16px',
    borderRadius: 10,
    background: 'transparent',
    color: T.ink,
    border: `1px solid ${T.rule}`,
    cursor: 'pointer',
    fontFamily: FONT_SANS,
    fontSize: 13.5,
    fontWeight: 600,
  };

  return (
    <div style={wrap}>
      {/* Header + counts */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, color: T.ink, margin: 0, letterSpacing: '-0.02em' }}>
            {tr(lang, 'Lost & Found', 'Objetos perdidos')}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: T.ink2, fontFamily: FONT_SANS }}>
            {tr(lang, 'Found items, guest reports, and returns — PMS and staff combined.', 'Objetos encontrados, reportes de huéspedes y devoluciones — del PMS y del personal.')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={primaryBtn} onClick={() => { setLogType('found'); setLogOpen(true); }}>
            + {tr(lang, 'Log found item', 'Registrar hallazgo')}
          </button>
          <button style={ghostBtn} onClick={() => { setLogType('lost'); setLogOpen(true); }}>
            + {tr(lang, 'Log lost report', 'Registrar pérdida')}
          </button>
        </div>
      </div>

      {/* Count chips */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { label: tr(lang, 'Open', 'Abiertos'), value: counts.open, color: T.ink },
          { label: tr(lang, 'Awaiting return', 'Por devolver'), value: counts.awaitingReturn, color: T.caramel },
          { label: tr(lang, 'Nearing disposal', 'Por desechar'), value: counts.nearingDisposal, color: T.warm },
        ].map((c) => (
          <div
            key={c.label}
            style={{
              flex: '1 1 160px',
              border: `1px solid ${T.rule}`,
              borderRadius: 14,
              padding: '14px 16px',
              background: T.paper,
            }}
          >
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.ink3 }}>
              {c.label}
            </div>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 30, fontWeight: 500, color: c.color, lineHeight: 1.1, marginTop: 6 }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      {/* Search + view filter */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tr(lang, 'Search description, room, guest…', 'Buscar descripción, habitación, huésped…')}
          style={{
            flex: '1 1 240px',
            height: 38,
            padding: '0 14px',
            borderRadius: 10,
            background: T.bg,
            border: `1px solid ${T.rule}`,
            fontFamily: FONT_SANS,
            fontSize: 14,
            color: T.ink,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['unresolved', 'found', 'lost', 'resolved', 'all'] as ViewFilter[]).map((v) => {
            const labels: Record<ViewFilter, string> = {
              unresolved: tr(lang, 'Active', 'Activos'),
              found: tr(lang, 'Found', 'Encontrados'),
              lost: tr(lang, 'Lost', 'Perdidos'),
              resolved: tr(lang, 'Resolved', 'Resueltos'),
              all: tr(lang, 'All', 'Todos'),
            };
            const active = view === v;
            return (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 9999,
                  border: `1px solid ${active ? T.ink : T.rule}`,
                  background: active ? T.ink : 'transparent',
                  color: active ? T.bg : T.ink2,
                  fontFamily: FONT_SANS,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {labels[v]}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: T.ink3, fontFamily: FONT_SANS, fontSize: 14 }}>
          {tr(lang, 'Loading…', 'Cargando…')}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '60px 16px', textAlign: 'center', border: `1px dashed ${T.rule}`, borderRadius: 14 }}>
          <div style={{ fontFamily: FONT_SERIF, fontSize: 20, color: T.ink2 }}>
            {tr(lang, 'Nothing here yet', 'Nada por aquí todavía')}
          </div>
          <div style={{ fontSize: 13, color: T.ink3, fontFamily: FONT_SANS, marginTop: 6 }}>
            {tr(lang, 'Log a found item or a guest lost report to get started.', 'Registra un hallazgo o un reporte de pérdida para empezar.')}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((it) => (
            <ItemCard
              key={`${it.source}:${it.id}`}
              item={it}
              lang={lang}
              pid={pid}
              allItems={items}
              onChanged={refetch}
              onToast={showToast}
            />
          ))}
        </div>
      )}

      {logOpen && (
        <LogModal
          pid={pid}
          lang={lang}
          initialType={logType}
          onClose={() => setLogOpen(false)}
          onLogged={() => {
            setLogOpen(false);
            void refetch();
            showToast(tr(lang, 'Logged.', 'Registrado.'));
          }}
          onToast={showToast}
        />
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1200,
            background: T.ink,
            color: T.bg,
            padding: '12px 20px',
            borderRadius: 9999,
            fontFamily: FONT_SANS,
            fontSize: 13.5,
            fontWeight: 600,
            boxShadow: '0 12px 32px rgba(31,35,28,0.25)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Item card ──────────────────────────────────────────────────────────────

function ItemCard({
  item,
  lang,
  pid,
  allItems,
  onChanged,
  onToast,
}: {
  item: LostFoundItem;
  lang: Lang;
  pid: string;
  allItems: LostFoundItem[];
  onChanged: () => Promise<void> | void;
  onToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<AutoMatchResult['matches'] | null>(null);
  const [matching, setMatching] = useState(false);
  const sm = statusMeta(item.status, lang);
  const disposal = disposalInfo(item, lang);
  const isFound = item.type === 'found';
  const editable = item.editable;

  const matchedItem = item.matchedItemId
    ? allItems.find((x) => x.source === 'app' && x.id === item.matchedItemId)
    : null;

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) {
        await onChanged();
        onToast(okMsg);
      } else {
        onToast(tr(lang, 'Action failed', 'La acción falló') + (res.error ? ` (${res.error})` : ''));
      }
    } finally {
      setBusy(false);
    }
  };

  const runAutoMatch = async () => {
    if (matching) return;
    setMatching(true);
    try {
      const res = await autoMatchLost(pid, item.id);
      if (res.ok && res.data) setMatches(res.data.matches);
      else onToast(tr(lang, 'Could not find matches', 'No se pudieron buscar coincidencias'));
    } finally {
      setMatching(false);
    }
  };

  const tag = (label: string, color: string, bg: string) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: 9999,
        background: bg,
        color,
        border: `1px solid ${color}33`,
        fontFamily: FONT_SANS,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );

  const smallBtn = (label: string, onClick: () => void, tone: string = T.ink): React.ReactNode => (
    <button
      disabled={busy}
      onClick={onClick}
      style={{
        padding: '6px 11px',
        borderRadius: 8,
        border: `1px solid ${tone}33`,
        background: `${tone}10`,
        color: tone,
        fontFamily: FONT_SANS,
        fontSize: 12,
        fontWeight: 600,
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 16, background: T.paper, padding: 16 }}>
      <div style={{ display: 'flex', gap: 14 }}>
        {/* Photo / placeholder */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 12,
            flexShrink: 0,
            background: T.bg,
            border: `1px solid ${T.rule}`,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.ink3,
            fontFamily: FONT_MONO,
            fontSize: 10,
          }}
        >
          {item.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{tr(lang, 'No photo', 'Sin foto')}</span>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            {isFound
              ? tag(tr(lang, 'FOUND', 'ENCONTRADO'), T.sageDeep, T.sageDim)
              : tag(tr(lang, 'LOST', 'PERDIDO'), T.warm, T.warmDim)}
            {tag(sm.label, sm.color, `${sm.color}14`)}
            {!editable && tag(tr(lang, 'From PMS', 'Del PMS'), T.purple, T.purpleDim)}
            {disposal && tag(disposal.label, disposal.color, `${disposal.color}14`)}
          </div>

          <div style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
            {item.itemDescription || tr(lang, '(no description)', '(sin descripción)')}
          </div>

          <div style={{ fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {item.category && <span>{catLabel(item.category, lang)}</span>}
            {(item.roomNumber || item.location) && (
              <span>📍 {item.roomNumber ? `${tr(lang, 'Room', 'Hab.')} ${item.roomNumber}` : item.location}</span>
            )}
            {item.occurredAt && <span>{isFound ? tr(lang, 'Found', 'Encontrado') : tr(lang, 'Lost', 'Perdido')} {fmtWhen(item.occurredAt, lang)}</span>}
            {item.foundBy && <span>{tr(lang, 'by', 'por')} {item.foundBy}</span>}
            {item.guestName && <span>👤 {item.guestName}</span>}
          </div>

          {matchedItem && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: T.caramelDeep, fontFamily: FONT_SANS }}>
              ↔ {tr(lang, 'Matched with', 'Emparejado con')}: {matchedItem.itemDescription}
            </div>
          )}

          {item.notes && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, fontStyle: 'italic' }}>
              {item.notes}
            </div>
          )}

          {/* Actions */}
          {editable && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              {isFound && (item.status === 'open' || item.status === 'matched') && (
                <>
                  {smallBtn(tr(lang, 'Returned', 'Devuelto'), () =>
                    act(() => updateLostFoundItem(pid, item.id, { status: 'returned' }), tr(lang, 'Marked returned', 'Marcado devuelto')), T.sageDeep)}
                  {smallBtn(tr(lang, 'Shipped', 'Enviado'), () =>
                    act(() => updateLostFoundItem(pid, item.id, { status: 'shipped' }), tr(lang, 'Marked shipped', 'Marcado enviado')), T.sageDeep)}
                  {smallBtn(tr(lang, 'Dispose', 'Desechar'), () =>
                    act(() => updateLostFoundItem(pid, item.id, { status: 'disposed' }), tr(lang, 'Marked disposed', 'Marcado desechado')), T.ink3)}
                  {(item.guestContact || matchedItem?.guestContact) &&
                    smallBtn('✉ ' + tr(lang, 'Notify guest', 'Avisar al huésped'), () =>
                      act(() => notifyGuestLostFound(pid, item.id), tr(lang, 'Guest texted', 'Huésped notificado')), T.caramelDeep)}
                </>
              )}
              {!isFound && item.status === 'open' && (
                <>
                  {smallBtn(matching ? tr(lang, 'Searching…', 'Buscando…') : '✨ ' + tr(lang, 'Find matches', 'Buscar coincidencias'), runAutoMatch, T.ink)}
                  {smallBtn(tr(lang, 'Close report', 'Cerrar reporte'), () =>
                    act(() => updateLostFoundItem(pid, item.id, { status: 'returned' }), tr(lang, 'Closed', 'Cerrado')), T.ink3)}
                </>
              )}
            </div>
          )}
          {!editable && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: T.ink3, fontFamily: FONT_SANS }}>
              {tr(lang, 'Managed in the PMS — read-only here.', 'Gestionado en el PMS — solo lectura aquí.')}
            </div>
          )}

          {/* Auto-match suggestions */}
          {matches && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.ink3, marginBottom: 8 }}>
                {tr(lang, 'Suggested matches', 'Coincidencias sugeridas')}
              </div>
              {matches.length === 0 ? (
                <div style={{ fontSize: 12.5, color: T.ink3, fontFamily: FONT_SANS }}>
                  {tr(lang, 'No likely matches among open found items.', 'No hay coincidencias probables entre los objetos encontrados.')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {matches.map((m) => (
                    <div
                      key={m.id}
                      style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 10px' }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: T.ink, fontFamily: FONT_SANS, fontWeight: 600 }}>
                          {m.item.itemDescription}
                          {m.aiConfidence && (
                            <span style={{ marginLeft: 8, fontSize: 11, color: m.aiConfidence === 'high' ? T.sageDeep : m.aiConfidence === 'medium' ? T.caramel : T.ink3 }}>
                              {tr(lang, m.aiConfidence + ' confidence', m.aiConfidence)}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 2 }}>
                          {(m.aiReason ? [m.aiReason] : m.reasons).slice(0, 3).join(' · ')}
                        </div>
                      </div>
                      {smallBtn(tr(lang, 'Match', 'Emparejar'), () =>
                        act(() => matchLostFound(pid, item.id, m.item.id), tr(lang, 'Matched', 'Emparejado')), T.sageDeep)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Log modal ────────────────────────────────────────────────────────────

function LogModal({
  pid,
  lang,
  initialType,
  onClose,
  onLogged,
  onToast,
}: {
  pid: string;
  lang: Lang;
  initialType: 'found' | 'lost';
  onClose: () => void;
  onLogged: () => void;
  onToast: (m: string) => void;
}) {
  const [type, setType] = useState<'found' | 'lost'>(initialType);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [location, setLocation] = useState('');
  const [room, setRoom] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestContact, setGuestContact] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const prepared = useRef<{ blob: Blob; ext: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = async (file: File | null) => {
    if (!file) {
      prepared.current = null;
      setPreview(null);
      return;
    }
    const p = await prepareImage(file);
    prepared.current = { blob: p.blob, ext: p.ext };
    setPreview(p.previewUrl);
    // AI auto-describe (found items only, and only when we have a JPEG).
    if (type === 'found' && p.b64 && p.mime) {
      setDescribing(true);
      try {
        const res = await describeFoundPhoto(pid, p.b64, p.mime);
        if (res.ok && res.data) {
          if (res.data.description && !description.trim()) setDescription(res.data.description);
          if (res.data.category) setCategory(res.data.category);
          onToast(tr(lang, 'AI filled the description', 'La IA completó la descripción'));
        }
      } catch {
        /* manual entry still works */
      } finally {
        setDescribing(false);
      }
    }
  };

  const submit = async () => {
    if (submitting) return;
    if (!description.trim()) {
      onToast(tr(lang, 'Add a description', 'Agrega una descripción'));
      return;
    }
    setSubmitting(true);
    try {
      // Upload photo first (if any) to get a path.
      let photoPath: string | null = null;
      if (prepared.current) {
        const scopeKey =
          typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}`;
        const pre = await presignFoundPhoto(pid, scopeKey, `photo.${prepared.current.ext}`);
        if (pre.ok && pre.data) {
          try {
            const up = await fetch(pre.data.signedUrl, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${pre.data.token}` },
              body: prepared.current.blob,
            });
            if (up.ok) photoPath = pre.data.path;
          } catch {
            /* photo is optional — log without it */
          }
        }
      }

      const res = await logLostFoundItem({
        pid,
        type,
        itemDescription: description.trim(),
        category,
        location: location.trim() || null,
        roomNumber: room.trim() || null,
        guestName: guestName.trim() || null,
        guestContact: guestContact.trim() || null,
        foundBy: type === 'found' ? tr(lang, 'Front desk', 'Recepción') : null,
        reportedBy: type === 'lost' ? tr(lang, 'Front desk', 'Recepción') : null,
        notes: notes.trim() || null,
        photoPath,
      });
      if (res.ok) onLogged();
      else onToast(tr(lang, 'Could not log item', 'No se pudo registrar') + (res.error ? ` (${res.error})` : ''));
    } finally {
      setSubmitting(false);
    }
  };

  const catOptions = LAF_CATEGORIES.map((c) => ({ value: c, label: catLabel(c, lang) }));

  return (
    <Modal
      open
      onClose={onClose}
      title={type === 'found' ? tr(lang, 'Log found item', 'Registrar hallazgo') : tr(lang, 'Log lost report', 'Registrar pérdida')}
      subtitle={tr(lang, 'Adds to the Lost & Found register', 'Se agrega al registro de objetos perdidos')}
      footer={
        <>
          <button
            onClick={onClose}
            style={{ padding: '9px 14px', borderRadius: 9, background: 'transparent', border: `1px solid ${T.rule}`, color: T.ink2, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {tr(lang, 'Cancel', 'Cancelar')}
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            style={{ padding: '9px 16px', borderRadius: 9, background: submitting ? T.ink3 : T.ink, border: 'none', color: T.bg, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, cursor: submitting ? 'default' : 'pointer' }}
          >
            {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Save', 'Guardar')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Type toggle */}
        <ChipChoose
          value={type}
          onChange={(v) => setType(v)}
          options={[
            { value: 'found', label: tr(lang, 'Found item', 'Objeto encontrado') },
            { value: 'lost', label: tr(lang, 'Guest lost report', 'Reporte de pérdida') },
          ]}
        />

        {/* Photo (found only) */}
        {type === 'found' && (
          <Field label={tr(lang, 'Photo', 'Foto')} hint={describing ? tr(lang, 'AI reading photo…', 'IA leyendo la foto…') : tr(lang, 'AI auto-fills the description', 'La IA completa la descripción')}>
            <button
              type="button"
              onClick={() => (preview ? (setPreview(null), (prepared.current = null)) : fileRef.current?.click())}
              style={{
                width: '100%',
                minHeight: 120,
                borderRadius: 12,
                border: `1px dashed ${preview ? T.sage : T.rule}`,
                background: T.bg,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                padding: 0,
              }}
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" style={{ width: '100%', maxHeight: 220, objectFit: 'contain' }} />
              ) : (
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  + {tr(lang, 'Tap to take or upload', 'Tomar o subir foto')}
                </span>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                void onPickFile(f);
                if (e.target) e.target.value = '';
              }}
            />
          </Field>
        )}

        <Field label={tr(lang, 'Description', 'Descripción')} required>
          <TextInput value={description} onChange={setDescription} placeholder={tr(lang, 'e.g. black North Face jacket, size M', 'p. ej. chaqueta negra North Face, talla M')} maxLength={500} />
        </Field>

        <Field label={tr(lang, 'Category', 'Categoría')}>
          <ChipChoose value={category} onChange={setCategory} options={catOptions} />
        </Field>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label={tr(lang, 'Room #', 'Habitación')} style={{ flex: '1 1 120px' }}>
            <TextInput value={room} onChange={setRoom} placeholder="214" maxLength={20} />
          </Field>
          <Field label={tr(lang, 'Area / location', 'Área / lugar')} style={{ flex: '1 1 160px' }}>
            <TextInput value={location} onChange={setLocation} placeholder={tr(lang, 'lobby, pool deck…', 'recepción, alberca…')} maxLength={200} />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label={tr(lang, 'Guest name', 'Nombre del huésped')} style={{ flex: '1 1 160px' }}>
            <TextInput value={guestName} onChange={setGuestName} placeholder={tr(lang, 'optional', 'opcional')} maxLength={120} />
          </Field>
          <Field
            label={tr(lang, 'Guest phone / email', 'Tel. / correo del huésped')}
            hint={tr(lang, 'phone enables SMS', 'el teléfono permite SMS')}
            style={{ flex: '1 1 180px' }}
          >
            <TextInput value={guestContact} onChange={setGuestContact} placeholder="+1 555 123 4567" maxLength={200} />
          </Field>
        </div>

        <Field label={tr(lang, 'Notes', 'Notas')}>
          <TextArea value={notes} onChange={setNotes} placeholder={tr(lang, 'anything else…', 'algo más…')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
