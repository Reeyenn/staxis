'use client';

// Engineer mobile page — the maintenance worker's surface for logging
// compliance readings + life-safety checks from their phone (feature #19).
//
// Reached via SMS magic-link: /engineer/{staffId}?pid={propertyId}&code={code}
// (built by buildEngineerLink, sent by /api/send-engineer-links).
//
// RLS bug class: this is a PUBLIC page. It reads/writes ONLY through
// /api/engineer/* (supabaseAdmin + pid+staffId capability check) — never the
// browser supabase client. Mirrors the laundry page (bootstrap fetch + poll).

export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Btn, Pill, Caps } from '@/app/housekeeping/_components/_snow';
import {
  engineerBootstrap,
  engineerLogReading,
  engineerLogPmCheck,
  engineerVisionReading,
  engineerVoiceLog,
  engineerSaveLanguage,
  type EngineerBootstrap,
} from '@/lib/db/compliance';
import type { ReadingTypeStatus, PmTaskStatus } from '@/lib/compliance/types';

type Lang = 'en' | 'es';
const tr = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

function fileToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({ base64: comma >= 0 ? result.slice(comma + 1) : result, mediaType: file.type || 'image/jpeg' });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Minimal Web Speech API shim (Android Chrome supports it; degrades to the
// phone-keyboard mic via the text box when absent).
interface SR {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start: () => void; stop: () => void;
}
function getSRClass(): (new () => SR) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export default function EngineerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: staffId } = React.use(params);
  const searchParams = useSearchParams();
  const pid = searchParams.get('pid');

  const [data, setData] = useState<EngineerBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<Lang>('en');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Consume the magic-link code (single-use) and strip it from the URL. The
  // page itself authorizes every call via the pid+staffId capability check, so
  // it works even if this best-effort consume fails.
  useEffect(() => {
    const code = searchParams.get('code');
    if (code && pid) {
      void fetch('/api/housekeeper/exchange-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, pid, staffId }),
      }).catch(() => {});
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.toString());
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!pid || !staffId) return;
    const d = await engineerBootstrap(pid, staffId);
    setData(d);
    if (d && (d.staff.language === 'es' || d.staff.language === 'en')) setLang(d.staff.language as Lang);
    setLoading(false);
  }, [pid, staffId]);

  useEffect(() => {
    if (!pid || !staffId) { setLoading(false); return; }
    void load();
    const iv = setInterval(() => { void load(); }, 45_000);
    return () => clearInterval(iv);
  }, [pid, staffId, load]);

  const toggleLang = async (next: Lang) => {
    setLang(next);
    if (pid && staffId) { try { await engineerSaveLanguage(pid, staffId, next); } catch { /* best-effort */ } }
  };

  // ── Guards ────────────────────────────────────────────────────────────
  if (!pid || !staffId) {
    return (
      <Centered>
        <AlertTriangle size={32} color={T.warm} />
        <p style={{ fontSize: 16, fontWeight: 600, color: T.ink, marginTop: 12 }}>{tr(lang, 'Incomplete link', 'Enlace incompleto')}</p>
        <p style={{ fontSize: 14, color: T.ink2, marginTop: 4, textAlign: 'center' }}>{tr(lang, 'Please open the link from your text message again.', 'Abre el enlace de tu mensaje de nuevo.')}</p>
      </Centered>
    );
  }
  if (loading) {
    return (
      <Centered>
        <div style={{ width: 30, height: 30, border: `3px solid ${T.rule}`, borderTopColor: T.sageDeep, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Centered>
    );
  }
  if (!data) {
    return (
      <Centered>
        <AlertTriangle size={32} color={T.warm} />
        <p style={{ fontSize: 15, color: T.ink2, marginTop: 12, textAlign: 'center' }}>{tr(lang, "Couldn't load your checklist. Pull to refresh or reopen the link.", 'No se pudo cargar. Recarga o reabre el enlace.')}</p>
      </Centered>
    );
  }

  const o = data.overview;
  const firstName = (data.staff.name || '').split(' ')[0] || tr(lang, 'there', 'hola');
  const pct = o.readingsCompletePct;
  const pctColor = pct >= 70 ? T.sageDeep : pct >= 30 ? T.caramelDeep : T.warm;

  return (
    <div style={{ minHeight: '100dvh', background: T.bg, fontFamily: FONT_SANS, color: T.ink, paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: T.bg, borderBottom: `1px solid ${T.rule}`, padding: '16px 18px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <Caps c={T.ink3}>{tr(lang, 'Compliance', 'Cumplimiento')}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 24, color: T.ink, marginTop: 2 }}>
              {tr(lang, `Hi ${firstName}`, `Hola ${firstName}`)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['en', 'es'] as Lang[]).map((l) => (
              <button key={l} onClick={() => toggleLang(l)} style={{
                padding: '6px 10px', borderRadius: 999, cursor: 'pointer',
                fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                background: lang === l ? T.ink : 'transparent', color: lang === l ? T.bg : T.ink2,
                border: `1px solid ${lang === l ? T.ink : T.rule}`,
              }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 30, color: pctColor, letterSpacing: '-0.03em' }}>{pct}%</span>
          <span style={{ fontSize: 13, color: T.ink2 }}>{tr(lang, `readings done · ${o.pmOverdueCount} checks overdue`, `lecturas hechas · ${o.pmOverdueCount} revisiones vencidas`)}</span>
        </div>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '16px 14px 0' }}>
        {/* Voice logging */}
        <VoicePanel pid={pid} staffId={staffId} lang={lang} onLogged={(msg) => { flash(msg); void load(); }} />

        {/* Readings */}
        <SectionLabel>{tr(lang, 'Readings due', 'Lecturas pendientes')}</SectionLabel>
        {o.readings.length === 0 && <Empty lang={lang} />}
        {o.readings.map((r) => (
          <ReadingCard key={r.type.id} pid={pid} staffId={staffId} r={r} lang={lang}
            onSaved={(msg) => { flash(msg); void load(); }} />
        ))}

        {/* Checks */}
        <SectionLabel>{tr(lang, 'Safety checks', 'Revisiones de seguridad')}</SectionLabel>
        {o.pmTasks.length === 0 && <Empty lang={lang} />}
        {o.pmTasks.map((p) => (
          <PmCard key={p.task.id} pid={pid} staffId={staffId} p={p} lang={lang}
            onSaved={(msg) => { flash(msg); void load(); }} />
        ))}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)',
          background: T.ink, color: T.bg, padding: '12px 18px', borderRadius: 12,
          fontSize: 13.5, zIndex: 2000, maxWidth: '92vw', textAlign: 'center',
          boxShadow: '0 10px 28px rgba(31,35,28,0.26)',
        }}>{toast}</div>
      )}
    </div>
  );
}

// ─── Shared layout bits ──────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: T.bg, fontFamily: FONT_SANS }}>
      {children}
    </div>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: '22px 2px 8px' }}><Caps c={T.ink2}>{children}</Caps></div>;
}
function Empty({ lang }: { lang: Lang }) {
  return <div style={{ color: T.ink3, fontSize: 13.5, padding: '10px 2px' }}>{tr(lang, 'Nothing assigned right now.', 'Nada asignado ahora.')}</div>;
}

// ─── Reading card (tap to log; snap-to-log) ──────────────────────────────────

function ReadingCard({ pid, staffId, r, lang, onSaved }: {
  pid: string; staffId: string; r: ReadingTypeStatus; lang: Lang; onSaved: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  let pill: React.ReactNode;
  if (r.latestOutOfRange) pill = <Pill tone="warm">{tr(lang, 'Out of range', 'Fuera de rango')}</Pill>;
  else if (r.doneThisPeriod) pill = <Pill tone="sage">{tr(lang, 'Done', 'Hecho')}</Pill>;
  else pill = <Pill tone="caramel">{tr(lang, 'Due', 'Pendiente')}</Pill>;

  const onPhoto = async (file: File | null) => {
    if (!file) return;
    setScanBusy(true); setScanNote(null);
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const res = await engineerVisionReading({ pid, staffId, readingTypeId: r.type.id, imageBase64: base64, mediaType });
      if (res.ok && res.data && res.data.value !== null) {
        setValue(String(res.data.value));
        setScanNote(tr(lang, `Read ${res.data.value}${r.type.unit}`, `Leído ${res.data.value}${r.type.unit}`));
      } else {
        setScanNote(tr(lang, 'Could not read — enter manually.', 'No se pudo leer — ingresa manual.'));
      }
    } catch {
      setScanNote(tr(lang, 'Scan failed.', 'Escaneo falló.'));
    } finally {
      setScanBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    const num = value.trim() === '' ? null : Number(value);
    if (num === null || !Number.isFinite(num)) return;
    setBusy(true);
    try {
      const res = await engineerLogReading({ pid, staffId, readingTypeId: r.type.id, value: num, source: 'manual' });
      if (res.ok) {
        setOpen(false); setValue(''); setScanNote(null);
        onSaved(res.data?.outOfRange
          ? tr(lang, `Logged — out of range, manager alerted`, `Registrado — fuera de rango, gerente avisado`)
          : tr(lang, 'Logged ✓', 'Registrado ✓'));
      } else setBusy(false);
    } catch { setBusy(false); }
  };

  const range = (r.type.minValue !== null || r.type.maxValue !== null)
    ? `${r.type.minValue ?? '–'}–${r.type.maxValue ?? '–'}${r.type.unit}` : null;

  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, marginBottom: 8, overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: T.ink }}>{r.type.name}</span>
          <span style={{ display: 'block', fontSize: 12, color: T.ink3, marginTop: 2 }}>
            {r.periodLabel}{range ? ` · ${tr(lang, 'safe', 'seguro')} ${range}` : ''}
          </span>
        </span>
        {pill}
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={value} onChange={(e) => setValue(e.target.value)} type="number" inputMode="decimal"
              placeholder={r.type.unit || '0'} style={{
                flex: 1, height: 48, padding: '0 14px', borderRadius: 12, border: `1px solid ${T.rule}`,
                background: T.bg, fontFamily: FONT_SANS, fontSize: 18, color: T.ink, outline: 'none', boxSizing: 'border-box',
              }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={scanBusy} aria-label="snap" style={{
              height: 48, width: 56, borderRadius: 12, cursor: 'pointer', fontSize: 20,
              background: T.sageDim, color: T.sageDeep, border: `1px solid rgba(104,131,114,0.3)`,
            }}>{scanBusy ? '…' : '📷'}</button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} />
          </div>
          {scanNote && <div style={{ fontSize: 12, color: T.ink2 }}>{scanNote}</div>}
          <Btn variant="sage" size="lg" onClick={save} disabled={busy || value.trim() === ''} style={{ width: '100%', justifyContent: 'center', height: 48 }}>
            {busy ? '…' : tr(lang, 'Save reading', 'Guardar lectura')}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ─── PM check card (pass / fail) ─────────────────────────────────────────────

function PmCard({ pid, staffId, p, lang, onSaved }: {
  pid: string; staffId: string; p: PmTaskStatus; lang: Lang; onSaved: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  let pill: React.ReactNode;
  if (p.overdue) pill = <Pill tone="warm">{tr(lang, 'Overdue', 'Vencida')}</Pill>;
  else if (p.doneThisPeriod) pill = <Pill tone="sage">{tr(lang, 'Done', 'Hecho')}</Pill>;
  else pill = <Pill tone="caramel">{tr(lang, 'Due', 'Pendiente')}</Pill>;

  const submit = async (status: 'pass' | 'fail') => {
    setBusy(true);
    try {
      const res = await engineerLogPmCheck({ pid, staffId, pmTaskId: p.task.id, status, unitsChecked: p.task.unitCount });
      if (res.ok) {
        onSaved(status === 'fail'
          ? tr(lang, 'Marked failed — manager alerted', 'Marcado falla — gerente avisado')
          : tr(lang, 'Checked off ✓', 'Marcado ✓'));
      } else setBusy(false);
    } catch { setBusy(false); }
  };

  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, marginBottom: 8, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>{p.task.name}</div>
          <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>{p.task.unitCount} {tr(lang, 'units', 'unidades')} · {p.periodLabel}</div>
        </div>
        {pill}
      </div>
      {(!p.doneThisPeriod || override) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn variant="sage" size="lg" onClick={() => submit('pass')} disabled={busy} style={{ flex: 1, justifyContent: 'center', height: 46 }}>
            {tr(lang, 'All good ✓', 'Todo bien ✓')}
          </Btn>
          <Btn variant="paper" size="lg" onClick={() => submit('fail')} disabled={busy} style={{ flex: 1, justifyContent: 'center', height: 46, color: T.warm, borderColor: 'rgba(184,92,61,0.4)' }}>
            {tr(lang, 'Problem', 'Problema')}
          </Btn>
        </div>
      )}
      {p.doneThisPeriod && !override && (
        <button onClick={() => setOverride(true)} style={{ marginTop: 10, background: 'transparent', border: 'none', cursor: 'pointer', color: T.ink3, fontFamily: FONT_SANS, fontSize: 12.5, textDecoration: 'underline', padding: 0 }}>
          {tr(lang, 'Re-check / fix this', 'Volver a revisar')}
        </button>
      )}
    </div>
  );
}

// ─── Voice panel (hands-free reading logging) ────────────────────────────────

function VoicePanel({ pid, staffId, lang, onLogged }: {
  pid: string; staffId: string; lang: Lang; onLogged: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const srRef = useRef<SR | null>(null);
  const supported = typeof window !== 'undefined' && !!getSRClass();

  const startListening = () => {
    const SRClass = getSRClass();
    if (!SRClass) return;
    try {
      const sr = new SRClass();
      sr.lang = lang === 'es' ? 'es-US' : 'en-US';
      sr.continuous = false;
      sr.interimResults = false;
      sr.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript + ' ';
        setText((prev) => (prev ? prev + ' ' : '') + t.trim());
      };
      sr.onend = () => setListening(false);
      sr.onerror = () => setListening(false);
      srRef.current = sr;
      setListening(true);
      sr.start();
    } catch { setListening(false); }
  };
  const stopListening = () => { try { srRef.current?.stop(); } catch { /* ignore */ } setListening(false); };

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await engineerVoiceLog({ pid, staffId, text, idempotencyKey: `${Date.now()}` });
      if (res.ok && res.data) {
        const n = res.data.logged.length;
        const oor = res.data.logged.filter((l) => l.outOfRange).length;
        setText(''); setOpen(false);
        onLogged(n === 0
          ? tr(lang, "Didn't catch a reading — try again or type it.", 'No se entendió — intenta de nuevo.')
          : tr(lang, `Logged ${n} reading${n === 1 ? '' : 's'}${oor ? ` · ${oor} out of range` : ''} ✓`, `${n} lectura(s) registradas${oor ? ` · ${oor} fuera de rango` : ''} ✓`));
      } else setBusy(false);
    } catch { setBusy(false); }
  };

  return (
    <div style={{ background: T.sageDim, border: `1px solid rgba(104,131,114,0.25)`, borderRadius: 14, padding: '14px 16px', marginBottom: 6 }}>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: T.sageDeep, fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600 }}>
          🎙️ {tr(lang, 'Log readings by voice', 'Registrar por voz')}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, color: T.ink2 }}>
            {tr(lang, 'Say e.g. "pool pH 7.4, chlorine 3, alkalinity 90". Then Log.', 'Di p. ej. "piscina pH 7.4, cloro 3, alcalinidad 90". Luego Registrar.')}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
            placeholder={tr(lang, 'Speak or type readings…', 'Habla o escribe lecturas…')}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.rule}`, background: T.bg, fontFamily: FONT_SANS, fontSize: 15, color: T.ink, outline: 'none', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            {supported && (
              <Btn variant={listening ? 'primary' : 'paper'} size="lg" onClick={listening ? stopListening : startListening} style={{ justifyContent: 'center', height: 46 }}>
                {listening ? tr(lang, '● Listening… stop', '● Escuchando… parar') : tr(lang, '🎙️ Speak', '🎙️ Hablar')}
              </Btn>
            )}
            <Btn variant="sage" size="lg" onClick={submit} disabled={busy || !text.trim()} style={{ flex: 1, justifyContent: 'center', height: 46 }}>
              {busy ? '…' : tr(lang, 'Log', 'Registrar')}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
