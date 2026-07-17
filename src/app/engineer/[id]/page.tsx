'use client';

// Engineer mobile page — the maintenance worker's surface for logging
// compliance readings + life-safety checks from their phone (feature #19).
//
// Reached via SMS magic-link: /engineer/{staffId}?pid={propertyId}&code={code}
// (built by buildEngineerLink; SMS delivery was retired 2026-07 — links are handed out manually until a new delivery method ships).
//
// RLS bug class: this is a PUBLIC page. It reads/writes ONLY through
// /api/engineer/* (supabaseAdmin + pid+staffId capability check) — never the
// browser supabase client. Mirrors the laundry page (bootstrap fetch + poll).
//
// i18n: all UI strings go through the shared translation system (`t()` from
// src/lib/translations) and follow the worker's saved account language across
// the FULL housekeeper locale set (en/es/ht/tl/vi) via the LanguageSwitcher —
// like the housekeeper + laundry pages. Dynamic DB content (reading-type names,
// units, anomaly reasons, period labels) stays as-is.

export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { T, FONT_SANS, FONT_SERIF, Btn, Pill, Caps } from '@/app/housekeeping/_components/_snow';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { t, SUPPORTED_LOCALES, type HousekeeperLocale } from '@/lib/translations';
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
  const [lang, setLang] = useState<HousekeeperLocale>('en');
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
    // Follow the worker's saved account language across the full locale set
    // (en/es/ht/tl/vi). The bootstrap returns the raw staff.language; narrow it
    // defensively so a stale/unknown value falls back to EN.
    if (d && d.staff.language && (SUPPORTED_LOCALES as readonly string[]).includes(d.staff.language)) {
      setLang(d.staff.language as HousekeeperLocale);
    }
    setLoading(false);
  }, [pid, staffId]);

  useEffect(() => {
    if (!pid || !staffId) { setLoading(false); return; }
    void load();
    const iv = setInterval(() => { void load(); }, 45_000);
    return () => clearInterval(iv);
  }, [pid, staffId, load]);

  const toggleLang = async (next: HousekeeperLocale) => {
    setLang(next);
    if (pid && staffId) { try { await engineerSaveLanguage(pid, staffId, next); } catch { /* best-effort */ } }
  };

  // ── Guards ────────────────────────────────────────────────────────────
  if (!pid || !staffId) {
    return (
      <Centered>
        <AlertTriangle size={32} color={T.warm} />
        <p style={{ fontSize: 16, fontWeight: 600, color: T.ink, marginTop: 12 }}>{t('cxIncompleteLink', lang)}</p>
        <p style={{ fontSize: 14, color: T.ink2, marginTop: 4, textAlign: 'center' }}>{t('cxIncompleteLinkHelp', lang)}</p>
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
        <p style={{ fontSize: 15, color: T.ink2, marginTop: 12, textAlign: 'center' }}>{t('engCouldntLoad', lang)}</p>
      </Centered>
    );
  }

  const o = data.overview;
  const firstName = (data.staff.name || '').split(' ')[0] || t('engThere', lang);
  const pct = o.readingsCompletePct;
  const pctColor = pct >= 70 ? T.sageDeep : pct >= 30 ? T.caramelDeep : T.warm;

  return (
    <div style={{ minHeight: '100dvh', background: T.bg, fontFamily: FONT_SANS, color: T.ink, paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: T.bg, borderBottom: `1px solid ${T.rule}`, padding: '16px 18px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <Caps c={T.ink3}>{t('engCompliance', lang)}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 24, color: T.ink, marginTop: 2 }}>
              {`${t('engHi', lang)} ${firstName}`}
            </div>
          </div>
          <LanguageSwitcher variant="light" current={lang} onChange={(next) => toggleLang(next)} />
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 30, color: pctColor, letterSpacing: '-0.03em' }}>{pct}%</span>
          <span style={{ fontSize: 13, color: T.ink2 }}>{`${t('engReadingsDoneLabel', lang)} · ${o.pmOverdueCount} ${t('engChecksOverdueLabel', lang)}`}</span>
        </div>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '16px 14px 0' }}>
        {/* Voice logging */}
        <VoicePanel pid={pid} staffId={staffId} lang={lang} onLogged={(msg) => { flash(msg); void load(); }} />

        {/* Readings */}
        <SectionLabel>{t('engReadingsDue', lang)}</SectionLabel>
        {o.readings.length === 0 && <Empty lang={lang} />}
        {o.readings.map((r) => (
          <ReadingCard key={r.type.id} pid={pid} staffId={staffId} r={r} lang={lang}
            onSaved={(msg) => { flash(msg); void load(); }} />
        ))}

        {/* Checks */}
        <SectionLabel>{t('engSafetyChecks', lang)}</SectionLabel>
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
function Empty({ lang }: { lang: HousekeeperLocale }) {
  return <div style={{ color: T.ink3, fontSize: 13.5, padding: '10px 2px' }}>{t('engNothingAssigned', lang)}</div>;
}

// ─── Reading card (tap to log; snap-to-log) ──────────────────────────────────

function ReadingCard({ pid, staffId, r, lang, onSaved }: {
  pid: string; staffId: string; r: ReadingTypeStatus; lang: HousekeeperLocale; onSaved: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  let pill: React.ReactNode;
  if (r.anomaly) pill = <Pill tone="warm">⚠️ {t('engAnomaly', lang)}</Pill>;
  else if (r.latestOutOfRange) pill = <Pill tone="warm">{t('engOutOfRange', lang)}</Pill>;
  else if (r.learning) pill = <Pill tone="neutral">{t('engLearning', lang)}</Pill>;
  else if (r.doneThisPeriod) pill = <Pill tone="sage">{t('engDone', lang)}</Pill>;
  else pill = <Pill tone="caramel">{t('engDue', lang)}</Pill>;

  const onPhoto = async (file: File | null) => {
    if (!file) return;
    setScanBusy(true); setScanNote(null);
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const res = await engineerVisionReading({ pid, staffId, readingTypeId: r.type.id, imageBase64: base64, mediaType });
      if (res.ok && res.data && res.data.value !== null) {
        setValue(String(res.data.value));
        setScanNote(`${t('engReadPrefix', lang)} ${res.data.value}${r.type.unit}`);
      } else {
        setScanNote(t('engCouldNotReadManual', lang));
      }
    } catch {
      setScanNote(t('engScanFailed', lang));
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
          ? t('engLoggedOutOfRange', lang)
          : t('engLogged', lang));
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
            {r.periodLabel}{range ? ` · ${t('engSafe', lang)} ${range}` : ''}
          </span>
          {r.anomaly && (
            <span style={{ display: 'block', fontSize: 12, color: T.warm, marginTop: 3, lineHeight: 1.35 }}>
              ⚠️ {lang === 'es' && r.anomaly.reasonEs ? r.anomaly.reasonEs : r.anomaly.reason}
            </span>
          )}
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
            {busy ? '…' : t('engSaveReading', lang)}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ─── PM check card (pass / fail) ─────────────────────────────────────────────

function PmCard({ pid, staffId, p, lang, onSaved }: {
  pid: string; staffId: string; p: PmTaskStatus; lang: HousekeeperLocale; onSaved: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  let pill: React.ReactNode;
  if (p.overdue) pill = <Pill tone="warm">{t('engOverdue', lang)}</Pill>;
  else if (p.doneThisPeriod) pill = <Pill tone="sage">{t('engDone', lang)}</Pill>;
  else pill = <Pill tone="caramel">{t('engDue', lang)}</Pill>;

  const submit = async (status: 'pass' | 'fail') => {
    setBusy(true);
    try {
      const res = await engineerLogPmCheck({ pid, staffId, pmTaskId: p.task.id, status, unitsChecked: p.task.unitCount });
      if (res.ok) {
        onSaved(status === 'fail'
          ? t('engMarkedFailedAlerted', lang)
          : t('engCheckedOff', lang));
      } else setBusy(false);
    } catch { setBusy(false); }
  };

  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, marginBottom: 8, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>{p.task.name}</div>
          <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>{p.task.unitCount} {t('engUnits', lang)} · {p.periodLabel}</div>
        </div>
        {pill}
      </div>
      {(!p.doneThisPeriod || override) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn variant="sage" size="lg" onClick={() => submit('pass')} disabled={busy} style={{ flex: 1, justifyContent: 'center', height: 46 }}>
            {t('engAllGood', lang)}
          </Btn>
          <Btn variant="paper" size="lg" onClick={() => submit('fail')} disabled={busy} style={{ flex: 1, justifyContent: 'center', height: 46, color: T.warm, borderColor: 'rgba(184,92,61,0.4)' }}>
            {t('engProblem', lang)}
          </Btn>
        </div>
      )}
      {p.doneThisPeriod && !override && (
        <button onClick={() => setOverride(true)} style={{ marginTop: 10, background: 'transparent', border: 'none', cursor: 'pointer', color: T.ink3, fontFamily: FONT_SANS, fontSize: 12.5, textDecoration: 'underline', padding: 0 }}>
          {t('engRecheck', lang)}
        </button>
      )}
    </div>
  );
}

// ─── Voice panel (hands-free reading logging) ────────────────────────────────

function VoicePanel({ pid, staffId, lang, onLogged }: {
  pid: string; staffId: string; lang: HousekeeperLocale; onLogged: (msg: string) => void;
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
      // Web Speech has no reliable ht/tl/vi models — fall back to en-US STT for
      // those (the textarea still lets the worker type). es → es-US.
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
          ? t('engVoiceNotCaught', lang)
          : `${t('engLoggedWord', lang)}: ${n} ${t(n === 1 ? 'engReadingWord' : 'engReadingsWord', lang)}${oor ? ` · ${oor} ${t('engOutOfRangeLower', lang)}` : ''} ✓`);
      } else setBusy(false);
    } catch { setBusy(false); }
  };

  return (
    <div style={{ background: T.sageDim, border: `1px solid rgba(104,131,114,0.25)`, borderRadius: 14, padding: '14px 16px', marginBottom: 6 }}>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: T.sageDeep, fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600 }}>
          🎙️ {t('engLogByVoice', lang)}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, color: T.ink2 }}>
            {t('engVoiceHint', lang)}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
            placeholder={t('engSpeakOrType', lang)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.rule}`, background: T.bg, fontFamily: FONT_SANS, fontSize: 15, color: T.ink, outline: 'none', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            {supported && (
              <Btn variant={listening ? 'primary' : 'paper'} size="lg" onClick={listening ? stopListening : startListening} style={{ justifyContent: 'center', height: 46 }}>
                {listening ? t('engListeningStop', lang) : t('engSpeak', lang)}
              </Btn>
            )}
            <Btn variant="sage" size="lg" onClick={submit} disabled={busy || !text.trim()} style={{ flex: 1, justifyContent: 'center', height: 46 }}>
              {busy ? '…' : t('engLog', lang)}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
