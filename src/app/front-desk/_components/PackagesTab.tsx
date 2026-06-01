'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Front-desk Packages — incoming guest-delivery log.
//
// Log parcels held behind the desk (Amazon/FedEx/UPS), optionally text the
// guest, and mark them picked up. AI touch: snap the shipping label → Claude
// Vision pre-fills guest name / room / carrier / tracking (scan only; the clerk
// confirms before saving). Snow design system. Visible to ALL front-desk staff
// (same access level as the Rooms tab — not management-gated like Lost & Found).
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
  subscribePackages,
  fetchPackages,
  createPackage,
  markPackagePickedUp,
  deletePackage,
  scanPackageLabel,
  notifyPackageGuest,
  presignPackagePhoto,
  type PackageRow,
  type PackageCounts,
} from '@/lib/db/packages';
import { PACKAGE_CARRIERS } from '@/lib/packages/types';

type Lang = 'en' | 'es';
const tr = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

const carrierLabel = (c: string | null, lang: Lang): string => {
  if (!c) return '';
  if (c === 'Other') return tr(lang, 'Other', 'Otro');
  return c; // brand names are the same in both languages
};

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

// ── Client image helper: downscale to JPEG for AI scan + smaller upload ──
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

type ViewFilter = 'held' | 'picked_up' | 'all';

export function PackagesTab({ pid, lang }: { pid: string; lang: Lang }) {
  const [items, setItems] = useState<PackageRow[]>([]);
  const [counts, setCounts] = useState<PackageCounts>({ held: 0, pickedUp: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewFilter>('held');
  const [toast, setToast] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const showToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const refetch = useCallback(async () => {
    const payload = await fetchPackages(pid);
    setItems(payload.items);
    setCounts(payload.counts);
  }, [pid]);

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    const unsub = subscribePackages(pid, (payload) => {
      setItems(payload.items);
      setCounts(payload.counts);
      setLoading(false);
    });
    return unsub;
  }, [pid]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (view === 'held' && it.status !== 'held') return false;
      if (view === 'picked_up' && it.status !== 'picked_up') return false;
      if (!q) return true;
      const hay = [it.guestName, it.roomNumber, it.carrier, it.trackingNumber, it.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, view, search]);

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

  return (
    <div style={wrap}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, color: T.ink, margin: 0, letterSpacing: '-0.02em' }}>
            {tr(lang, 'Packages', 'Paquetes')}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: T.ink2, fontFamily: FONT_SANS }}>
            {tr(
              lang,
              'Parcels held at the front desk for guests — log, notify, and hand off.',
              'Paquetes guardados en recepción para huéspedes — registra, avisa y entrega.',
            )}
          </p>
        </div>
        <button style={primaryBtn} onClick={() => setAddOpen(true)}>
          + {tr(lang, 'Add package', 'Registrar paquete')}
        </button>
      </div>

      {/* Count chips */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { label: tr(lang, 'Held', 'En espera'), value: counts.held, color: T.ink },
          { label: tr(lang, 'Picked up', 'Entregados'), value: counts.pickedUp, color: T.sageDeep },
        ].map((c) => (
          <div
            key={c.label}
            style={{ flex: '1 1 160px', border: `1px solid ${T.rule}`, borderRadius: 14, padding: '14px 16px', background: T.paper }}
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
          placeholder={tr(lang, 'Search guest, room, tracking…', 'Buscar huésped, habitación, rastreo…')}
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
          {(['held', 'picked_up', 'all'] as ViewFilter[]).map((v) => {
            const labels: Record<ViewFilter, string> = {
              held: tr(lang, 'Held', 'En espera'),
              picked_up: tr(lang, 'Picked up', 'Entregados'),
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
            {view === 'picked_up'
              ? tr(lang, 'No packages picked up yet', 'Aún no hay paquetes entregados')
              : tr(lang, 'No packages held', 'No hay paquetes en espera')}
          </div>
          <div style={{ fontSize: 13, color: T.ink3, fontFamily: FONT_SANS, marginTop: 6 }}>
            {tr(lang, 'Tap “Add package” to log an arrival.', 'Toca “Registrar paquete” para registrar una llegada.')}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((it) => (
            <PackageCard key={it.id} pkg={it} lang={lang} pid={pid} onChanged={refetch} onToast={showToast} />
          ))}
        </div>
      )}

      {addOpen && (
        <AddPackageModal
          pid={pid}
          lang={lang}
          onClose={() => setAddOpen(false)}
          onLogged={() => {
            setAddOpen(false);
            void refetch();
            showToast(tr(lang, 'Package logged.', 'Paquete registrado.'));
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

// ─── Package card ─────────────────────────────────────────────────────────────

function PackageCard({
  pkg,
  lang,
  pid,
  onChanged,
  onToast,
}: {
  pkg: PackageRow;
  lang: Lang;
  pid: string;
  onChanged: () => Promise<void> | void;
  onToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const isHeld = pkg.status === 'held';

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
            fontSize: 18,
          }}
        >
          {pkg.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pkg.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span aria-hidden>📦</span>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            {isHeld
              ? tag(tr(lang, 'HELD', 'EN ESPERA'), T.caramel, `${T.caramel}14`)
              : tag(tr(lang, 'PICKED UP', 'ENTREGADO'), T.sageDeep, `${T.sageDeep}14`)}
            {pkg.carrier && tag(carrierLabel(pkg.carrier, lang), T.ink2, `${T.ink2}10`)}
            {pkg.guestNotifiedAt && isHeld && tag('✓ ' + tr(lang, 'Notified', 'Avisado'), T.sageDeep, `${T.sageDeep}12`)}
          </div>

          <div style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
            {pkg.guestName}
          </div>

          <div style={{ fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {pkg.roomNumber && <span>📍 {tr(lang, 'Room', 'Hab.')} {pkg.roomNumber}</span>}
            <span>
              {isHeld ? tr(lang, 'Arrived', 'Llegó') : tr(lang, 'Picked up', 'Entregado')}{' '}
              {fmtWhen(isHeld ? pkg.loggedAt : pkg.pickedUpAt, lang)}
            </span>
            {pkg.trackingNumber && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>#{pkg.trackingNumber}</span>
            )}
          </div>

          {pkg.notes && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, fontStyle: 'italic' }}>
              {pkg.notes}
            </div>
          )}

          {/* Actions */}
          {isHeld && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              {smallBtn('✓ ' + tr(lang, 'Picked up', 'Entregado'), () =>
                act(() => markPackagePickedUp(pid, pkg.id), tr(lang, 'Marked picked up', 'Marcado entregado')), T.sageDeep)}
              {pkg.hasGuestPhone &&
                smallBtn('✉ ' + tr(lang, 'Notify guest', 'Avisar al huésped'), () =>
                  act(() => notifyPackageGuest(pid, pkg.id), tr(lang, 'Guest texted', 'Huésped notificado')), T.caramelDeep)}
              {confirmDel
                ? smallBtn(tr(lang, 'Confirm delete?', '¿Eliminar?'), () => {
                    setConfirmDel(false);
                    void act(() => deletePackage(pid, pkg.id), tr(lang, 'Deleted', 'Eliminado'));
                  }, T.warm)
                : smallBtn(tr(lang, 'Delete', 'Eliminar'), () => {
                    setConfirmDel(true);
                    setTimeout(() => setConfirmDel(false), 4000);
                  }, T.ink3)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add modal ────────────────────────────────────────────────────────────

const CARRIER_OPTIONS = (lang: Lang) => [
  { value: '', label: tr(lang, 'Unknown', 'Desconocido') },
  ...PACKAGE_CARRIERS.map((c) => ({ value: c, label: carrierLabel(c, lang) })),
];

function AddPackageModal({
  pid,
  lang,
  onClose,
  onLogged,
  onToast,
}: {
  pid: string;
  lang: Lang;
  onClose: () => void;
  onLogged: () => void;
  onToast: (m: string) => void;
}) {
  const [guestName, setGuestName] = useState('');
  const [room, setRoom] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [aiFilled, setAiFilled] = useState(false);
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
    // AI scan the label (only when we produced a JPEG to send).
    if (p.b64 && p.mime) {
      setScanning(true);
      try {
        const res = await scanPackageLabel(pid, p.b64, p.mime);
        if (res.ok && res.data) {
          const d = res.data;
          let any = false;
          if (d.guestName && !guestName.trim()) { setGuestName(d.guestName); any = true; }
          if (d.roomNumber && !room.trim()) { setRoom(d.roomNumber); any = true; }
          if (d.carrier && !carrier) { setCarrier(d.carrier); any = true; }
          if (d.trackingNumber && !tracking.trim()) { setTracking(d.trackingNumber); any = true; }
          if (any) {
            setAiFilled(true);
            onToast(tr(lang, 'AI filled the details — check them', 'La IA completó los datos — revísalos'));
          } else {
            onToast(tr(lang, 'Couldn’t read the label — enter it manually', 'No se pudo leer la etiqueta — ingrésalo manualmente'));
          }
        } else {
          onToast(tr(lang, 'Couldn’t read the label — enter it manually', 'No se pudo leer la etiqueta — ingrésalo manualmente'));
        }
      } catch {
        onToast(tr(lang, 'Scan failed — enter it manually', 'Escaneo falló — ingrésalo manualmente'));
      } finally {
        setScanning(false);
      }
    }
  };

  const submit = async () => {
    if (submitting) return;
    if (!guestName.trim()) {
      onToast(tr(lang, 'Add the guest name', 'Agrega el nombre del huésped'));
      return;
    }
    setSubmitting(true);
    try {
      // Upload the label photo first (if any) to get a stored path. Optional —
      // a failed upload still logs the package.
      let photoPath: string | null = null;
      if (prepared.current) {
        const scopeKey =
          typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}`;
        const pre = await presignPackagePhoto(pid, scopeKey, `label.${prepared.current.ext}`);
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

      const res = await createPackage({
        pid,
        guestName: guestName.trim(),
        roomNumber: room.trim() || null,
        carrier: carrier || null,
        trackingNumber: tracking.trim() || null,
        guestPhone: guestPhone.trim() || null,
        notes: notes.trim() || null,
        photoPath,
      });
      if (res.ok) onLogged();
      else onToast(tr(lang, 'Could not log package', 'No se pudo registrar') + (res.error ? ` (${res.error})` : ''));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr(lang, 'Add package', 'Registrar paquete')}
      subtitle={tr(lang, 'Held at the front desk for a guest', 'Guardado en recepción para un huésped')}
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
        {/* Scan label */}
        <Field
          label={tr(lang, 'Shipping label', 'Etiqueta de envío')}
          hint={scanning ? tr(lang, 'AI reading label…', 'IA leyendo etiqueta…') : tr(lang, 'AI auto-fills the details', 'La IA completa los datos')}
        >
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
                📷 {tr(lang, 'Scan label — tap to take or upload', 'Escanear etiqueta — tomar o subir')}
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

        {aiFilled && (
          <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.sageDeep, marginTop: -8 }}>
            ✨ {tr(lang, 'AI filled the details — please check them before saving.', 'La IA completó los datos — revísalos antes de guardar.')}
          </div>
        )}

        <Field label={tr(lang, 'Guest name', 'Nombre del huésped')} required>
          <TextInput value={guestName} onChange={setGuestName} placeholder={tr(lang, 'e.g. Jordan Smith', 'p. ej. Jordan Smith')} maxLength={120} />
        </Field>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label={tr(lang, 'Room #', 'Habitación')} style={{ flex: '1 1 120px' }}>
            <TextInput value={room} onChange={setRoom} placeholder="214" maxLength={20} />
          </Field>
          <Field label={tr(lang, 'Tracking #', 'Rastreo')} style={{ flex: '1 1 180px' }}>
            <TextInput value={tracking} onChange={setTracking} placeholder={tr(lang, 'optional', 'opcional')} maxLength={40} />
          </Field>
        </div>

        <Field label={tr(lang, 'Carrier', 'Transportista')}>
          <ChipChoose value={carrier} onChange={setCarrier} options={CARRIER_OPTIONS(lang)} />
        </Field>

        <Field
          label={tr(lang, 'Guest phone', 'Tel. del huésped')}
          hint={tr(lang, 'enables “Notify guest” SMS', 'permite avisar por SMS')}
        >
          <TextInput value={guestPhone} onChange={setGuestPhone} placeholder="+1 555 123 4567" maxLength={20} />
        </Field>

        <Field label={tr(lang, 'Notes', 'Notas')}>
          <TextArea value={notes} onChange={setNotes} placeholder={tr(lang, 'anything else…', 'algo más…')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
