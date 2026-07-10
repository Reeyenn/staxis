'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Shared scaffold for the two front-desk registers (Packages, Lost & Found).
//
// The tabs are near-clones — same snow-styled header/count-chips/search/pills/
// list/card/modal chrome, differing only in fields and accent colors. Every
// primitive here is parameterized so each tab keeps its exact current look.
// Data still flows through the tab's own db module (30s poll + visibility
// refetch live in src/lib/db/packages.ts / lost-and-found.ts — untouched).
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { T, FONT_SANS, FONT_SERIF, FONT_MONO, Field } from '@/app/maintenance/_components/_mt-snow';
import { useToast, ToastHost, type ToastItem } from '@/app/_components/ui/toast';

export type Lang = 'en' | 'es';
export const tr = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

export function fmtWhen(iso: string | null, lang: Lang): string {
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

// ── Client image helper: downscale to JPEG for the AI call + smaller upload ──

export interface PreparedImage {
  blob: Blob;
  ext: string;
  b64?: string;
  mime?: 'image/jpeg';
  previewUrl: string;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
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

/** Photo draft held by a log/add modal: preview + prepared blob for upload. */
export function usePhotoDraft(): {
  preview: string | null;
  prepared: { current: { blob: Blob; ext: string } | null };
  pick: (file: File | null) => Promise<PreparedImage | null>;
  clear: () => void;
} {
  const [preview, setPreview] = useState<string | null>(null);
  const prepared = useRef<{ blob: Blob; ext: string } | null>(null);
  const pick = useCallback(async (file: File | null): Promise<PreparedImage | null> => {
    if (!file) {
      prepared.current = null;
      setPreview(null);
      return null;
    }
    const p = await prepareImage(file);
    prepared.current = { blob: p.blob, ext: p.ext };
    setPreview(p.previewUrl);
    return p;
  }, []);
  const clear = useCallback(() => {
    setPreview(null);
    prepared.current = null;
  }, []);
  return { preview, prepared, pick, clear };
}

/**
 * Upload the prepared photo through the register's presign route. Optional —
 * a failed upload still logs the record (returns null, caller saves without).
 */
export async function uploadPreparedPhoto(
  presign: (
    pid: string,
    scopeKey: string,
    filename: string,
  ) => Promise<{ ok: boolean; data?: { path: string; signedUrl: string; token: string }; error?: string }>,
  pid: string,
  filenameBase: string,
  prepared: { blob: Blob; ext: string },
): Promise<string | null> {
  const scopeKey =
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}`;
  const pre = await presign(pid, scopeKey, `${filenameBase}.${prepared.ext}`);
  let photoPath: string | null = null;
  if (pre.ok && pre.data) {
    try {
      const up = await fetch(pre.data.signedUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${pre.data.token}` },
        body: prepared.blob,
      });
      if (up.ok) photoPath = pre.data.path;
    } catch {
      /* photo is optional — log without it */
    }
  }
  return photoPath;
}

// ── Feed: initial load via the db module's subscribe (poll + visibility) ──

export function useRegisterFeed<I, C>(
  pid: string,
  subscribe: (pid: string, onData: (payload: { items: I[]; counts: C }) => void) => () => void,
  fetchRegister: (pid: string) => Promise<{ items: I[]; counts: C }>,
  initialCounts: C,
): { items: I[]; counts: C; loading: boolean; refetch: () => Promise<void> } {
  const [items, setItems] = useState<I[]>([]);
  const [counts, setCounts] = useState<C>(initialCounts);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const payload = await fetchRegister(pid);
    setItems(payload.items);
    setCounts(payload.counts);
  }, [pid, fetchRegister]);

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    return subscribe(pid, (payload) => {
      setItems(payload.items);
      setCounts(payload.counts);
      setLoading(false);
    });
  }, [pid, subscribe]);

  return { items, counts, loading, refetch };
}

// ── Toast (F7): bottom-center T.ink pill, 2.6s — both registers' exact look ──

export function useRegisterToast(): { toasts: ToastItem[]; showToast: (m: string) => void } {
  const { toasts, show } = useToast({ durationMs: 2600, max: 1 });
  const showToast = useCallback((m: string) => { show(m); }, [show]);
  return { toasts, showToast };
}

export function RegisterToastHost({ toasts }: { toasts: ToastItem[] }): React.ReactElement | null {
  return (
    <ToastHost
      toasts={toasts}
      position="bottom"
      offset="24px"
      zIndex={1200}
      toastStyle={{
        background: T.ink,
        color: T.bg,
        padding: '12px 20px',
        borderRadius: 9999,
        fontFamily: FONT_SANS,
        fontSize: 13.5,
        fontWeight: 600,
        boxShadow: '0 12px 32px rgba(31,35,28,0.25)',
      }}
    />
  );
}

// ── Action runner: busy-guarded call + refetch + toast (card actions) ──

export function useActRunner(
  lang: Lang,
  onChanged: () => Promise<void> | void,
  onToast: (m: string) => void,
): { busy: boolean; act: (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => Promise<void> } {
  const [busy, setBusy] = useState(false);
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
  return { busy, act };
}

// ── Page chrome ─────────────────────────────────────────────────────────────

export const REGISTER_WRAP: React.CSSProperties = {
  padding: '24px 48px 120px',
  background: T.bg,
  minHeight: '70dvh',
};

export const REGISTER_PRIMARY_BTN: React.CSSProperties = {
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

export const REGISTER_GHOST_BTN: React.CSSProperties = {
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

export function RegisterHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
      <div>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, color: T.ink, margin: 0, letterSpacing: '-0.02em' }}>
          {title}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13.5, color: T.ink2, fontFamily: FONT_SANS }}>
          {subtitle}
        </p>
      </div>
      {actions}
    </div>
  );
}

export function CountChips({
  chips,
}: {
  chips: { label: string; value: number; color: string }[];
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
      {chips.map((c) => (
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
  );
}

export function SearchFilterBar<V extends string>({
  search,
  onSearch,
  placeholder,
  views,
  view,
  onView,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder: string;
  views: { key: V; label: string }[];
  view: V;
  onView: (v: V) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={placeholder}
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
        {views.map((v) => {
          const active = view === v.key;
          return (
            <button
              key={v.key}
              onClick={() => onView(v.key)}
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
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RegisterList({
  loading,
  lang,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: {
  loading: boolean;
  lang: Lang;
  isEmpty: boolean;
  emptyTitle: string;
  emptyHint: string;
  children: React.ReactNode;
}): React.ReactElement {
  if (loading) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center', color: T.ink3, fontFamily: FONT_SANS, fontSize: 14 }}>
        {tr(lang, 'Loading…', 'Cargando…')}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div style={{ padding: '60px 16px', textAlign: 'center', border: `1px dashed ${T.rule}`, borderRadius: 14 }}>
        <div style={{ fontFamily: FONT_SERIF, fontSize: 20, color: T.ink2 }}>{emptyTitle}</div>
        <div style={{ fontSize: 13, color: T.ink3, fontFamily: FONT_SANS, marginTop: 6 }}>{emptyHint}</div>
      </div>
    );
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>;
}

// ── Card primitives ─────────────────────────────────────────────────────────

/** Card shell: 72×72 photo (or placeholder) beside a flexible body. */
export function RegisterCardShell({
  photoUrl,
  placeholder,
  placeholderFontSize,
  children,
}: {
  photoUrl: string | null | undefined;
  placeholder: React.ReactNode;
  placeholderFontSize: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 16, background: T.paper, padding: 16 }}>
      <div style={{ display: 'flex', gap: 14 }}>
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
            fontSize: placeholderFontSize,
          }}
        >
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            placeholder
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}

export function Tag({
  color,
  bg,
  children,
}: {
  color: string;
  bg: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
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
      {children}
    </span>
  );
}

export function SmallBtn({
  busy,
  onClick,
  tone = T.ink,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  tone?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
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
      {children}
    </button>
  );
}

// ── Modal pieces ────────────────────────────────────────────────────────────

/** Dashed tap-to-photo field with hidden capture input; preview taps clear. */
export function PhotoPickerField({
  label,
  hint,
  placeholder,
  preview,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  placeholder: React.ReactNode;
  preview: string | null;
  onPick: (file: File | null) => void;
  onClear: () => void;
}): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Field label={label} hint={hint}>
      <button
        type="button"
        onClick={() => (preview ? onClear() : fileRef.current?.click())}
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
            {placeholder}
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
          onPick(f);
          if (e.target) e.target.value = '';
        }}
      />
    </Field>
  );
}

/** Cancel / Save footer shared by both log modals. */
export function SaveCancelFooter({
  lang,
  submitting,
  onCancel,
  onSubmit,
}: {
  lang: Lang;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <>
      <button
        onClick={onCancel}
        style={{ padding: '9px 14px', borderRadius: 9, background: 'transparent', border: `1px solid ${T.rule}`, color: T.ink2, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
      >
        {tr(lang, 'Cancel', 'Cancelar')}
      </button>
      <button
        onClick={onSubmit}
        disabled={submitting}
        style={{ padding: '9px 16px', borderRadius: 9, background: submitting ? T.ink3 : T.ink, border: 'none', color: T.bg, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, cursor: submitting ? 'default' : 'pointer' }}
      >
        {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Save', 'Guardar')}
      </button>
    </>
  );
}
