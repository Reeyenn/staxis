'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { ArrowLeft, CheckCircle2, Sparkles, AlertCircle } from 'lucide-react';

type AiMode = 'off' | 'auto' | 'always-on';

interface AiStatus {
  aiMode: AiMode;
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsExpectedToGraduate: number;
  currentMaeRatio: number | null;
  lastInferenceAt: string | null;
}

/**
 * /inventory/ai-helper — plain-English explainer for the AI Helper toggle.
 *
 * Reachable from the AI Helper chip in the inventory page header. Sections:
 *   1. "What is this?"      — 4 bullet sentences max
 *   2. "Where you are now"  — live status from /api/inventory/ai-status
 *   3. Timeline             — Day 1-30, 30-60, 60+ explained
 *   4. "What we recommend"  — dynamic based on current mode
 *   5. The toggle           — three pills with 1-line descriptions
 *   6. FAQ                  — 5 questions max
 *
 * Bilingual EN/ES via useLang().
 */
export default function AiHelperPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/signin');
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchWithAuth(`/api/inventory/ai-status?propertyId=${activePropertyId}`);
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setStatus(json.data);
      } catch (e) {
        if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
        setErrorMsg((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const setMode = async (mode: AiMode) => {
    if (!activePropertyId) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/inventory/ai-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, mode }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setStatus((s) => (s ? { ...s, aiMode: mode } : s));
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
      setErrorMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>Loading…</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 24px 64px' }}>
        {/* Back button */}
        <button
          onClick={() => router.push('/inventory')}
          style={{
            background: 'transparent',
            border: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            color: '#004b4b',
            fontSize: '14px',
            cursor: 'pointer',
            padding: '4px 0',
            marginBottom: '20px',
          }}
        >
          <ArrowLeft size={16} />
          {lang === 'es' ? 'Volver al inventario' : 'Back to inventory'}
        </button>

        {/* Title */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <Sparkles size={22} color="#004b4b" />
            <h1 style={{ fontSize: '26px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? 'Asistente AI de inventario' : 'Inventory AI Helper'}
            </h1>
          </div>
          <p style={{ fontSize: '14px', color: '#7a8a9e', margin: 0 }}>
            {lang === 'es'
              ? 'Cómo funciona, en qué punto estás, y cómo cambiarlo.'
              : 'How it works, where you are, and how to change it.'}
          </p>
        </div>

        {/* Section 1: What is this? */}
        <Section title={lang === 'es' ? '¿Qué es esto?' : 'What is this?'}>
          <ul style={{ paddingLeft: '20px', margin: 0, lineHeight: 1.6 }}>
            <li>
              {lang === 'es'
                ? 'Una IA observa cada conteo de inventario y aprende qué tan rápido se usa cada artículo en tu hotel.'
                : 'An AI watches every inventory count and learns how fast each item gets used at your hotel.'}
            </li>
            <li>
              {lang === 'es'
                ? 'Después de unas semanas, puede adivinar el conteo por ti — para que no tengas que contar cada estante.'
                : 'After a few weeks, it can guess the count for you — so you don’t have to count every shelf.'}
            </li>
            <li>
              {lang === 'es'
                ? 'Te avisa cuando algo se está acabando antes de tiempo (posible robo, entrega tardía, error de conteo).'
                : 'It alerts you when something is depleting faster than expected (possible theft, late delivery, count mistake).'}
            </li>
            <li>
              {lang === 'es'
                ? 'Tú siempre puedes corregir el conteo manualmente. La IA aprende de tus correcciones.'
                : 'You can always correct the count manually. The AI learns from your corrections.'}
            </li>
          </ul>
        </Section>

        {/* Section 2: Where you are now */}
        <Section title={lang === 'es' ? 'En qué punto estás' : 'Where you are right now'}>
          {loading ? (
            <Subtle>{lang === 'es' ? 'Cargando…' : 'Loading…'}</Subtle>
          ) : !status ? (
            <Subtle>{lang === 'es' ? 'No se pudieron cargar los datos.' : 'Couldn’t load status.'}</Subtle>
          ) : (
            <StatusBlock status={status} lang={lang} />
          )}
        </Section>

        {/* Section 3: Timeline */}
        <Section title={lang === 'es' ? 'Línea de tiempo' : 'Timeline'}>
          <Timeline status={status} lang={lang} />
        </Section>

        {/* Section 4: Recommendation */}
        {status && (
          <Section title={lang === 'es' ? 'Lo que recomendamos' : 'What we recommend'}>
            <Recommendation mode={status.aiMode} lang={lang} />
          </Section>
        )}

        {/* Section 5: Toggle */}
        <Section title={lang === 'es' ? 'Cambiar el modo' : 'Change the mode'}>
          {errorMsg && (
            <div style={{
              padding: '10px 12px',
              background: 'rgba(220,52,69,0.08)',
              border: '1px solid rgba(220,52,69,0.2)',
              borderRadius: '8px',
              color: '#dc3545',
              fontSize: '12px',
              marginBottom: '12px',
            }}>
              {errorMsg}
            </div>
          )}
          <ModeToggle
            mode={status?.aiMode ?? 'auto'}
            onChange={setMode}
            disabled={saving}
            lang={lang}
          />
        </Section>

        {/* Section 6: FAQ */}
        <Section title={lang === 'es' ? 'Preguntas frecuentes' : 'FAQ'}>
          <Faq lang={lang} />
        </Section>
      </div>
    </AppLayout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '32px' }}>
      <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#1b1c19', marginBottom: '12px' }}>
        {title}
      </h2>
      <div style={{ fontSize: '14px', color: '#454652', lineHeight: 1.5 }}>
        {children}
      </div>
    </section>
  );
}

function Subtle({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#7a8a9e', fontSize: '13px' }}>{children}</div>;
}

function StatusBlock({ status, lang }: { status: AiStatus; lang: 'en' | 'es' }) {
  const day = status.daysSinceFirstCount;
  const learned = status.itemsWithModel;
  const total = status.itemsTotal;
  const grad = status.itemsGraduated;
  const close = status.itemsExpectedToGraduate;

  const summary = lang === 'es'
    ? `Día ${day}. La IA ha aprendido ${learned} de tus ${total} artículos. ${grad} ya pueden auto-llenarse. Otros ${close} están cerca.`
    : `Day ${day}. The AI has learned ${learned} of your ${total} items. ${grad} are confident enough to auto-fill. Another ${close} are close.`;

  return (
    <div style={{
      background: '#f7fafb',
      border: '1px solid rgba(78,90,122,0.08)',
      borderRadius: '10px',
      padding: '16px',
    }}>
      <div style={{ marginBottom: '12px', fontWeight: 500 }}>{summary}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', fontSize: '13px' }}>
        <Stat
          label={lang === 'es' ? 'Modo actual' : 'Current mode'}
          value={modeLabel(status.aiMode, lang)}
          color={status.aiMode === 'auto' ? '#00a050' : status.aiMode === 'off' ? '#7a8a9e' : '#f0ad4e'}
        />
        <Stat
          label={lang === 'es' ? 'Última predicción' : 'Last prediction'}
          value={status.lastInferenceAt
            ? new Date(status.lastInferenceAt).toLocaleDateString()
            : (lang === 'es' ? 'Aún no' : 'Not yet')}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: color ?? '#1b1c19', marginTop: '2px' }}>
        {value}
      </div>
    </div>
  );
}

function Timeline({ status, lang }: { status: AiStatus | null; lang: 'en' | 'es' }) {
  const day = status?.daysSinceFirstCount ?? 0;
  const phases = [
    {
      range: lang === 'es' ? 'Día 1–30' : 'Day 1–30',
      desc: lang === 'es'
        ? 'La IA está aprendiendo. Usamos promedios de la industria mientras tanto.'
        : 'AI is learning. We use industry averages to start.',
      active: day < 30,
    },
    {
      range: lang === 'es' ? 'Día 30–60' : 'Day 30–60',
      desc: lang === 'es'
        ? 'Los artículos comunes se gradúan. La lista de reordenar es precisa.'
        : 'Common items graduate. Reorder list becomes accurate.',
      active: day >= 30 && day < 60,
    },
    {
      range: lang === 'es' ? 'Día 60+' : 'Day 60+',
      desc: lang === 'es'
        ? 'Auto-llenado activo en la mayoría de artículos. Precisión: ~±10%.'
        : 'Auto-fill active on most items. Accuracy ~±10%.',
      active: day >= 60,
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {phases.map((p) => (
        <div
          key={p.range}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
            padding: '12px 14px',
            background: p.active ? 'rgba(0,75,75,0.05)' : '#f7fafb',
            border: p.active ? '1px solid rgba(0,75,75,0.2)' : '1px solid rgba(78,90,122,0.08)',
            borderRadius: '10px',
          }}
        >
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: p.active ? '#004b4b' : '#cdd5dd',
            marginTop: '6px',
            flexShrink: 0,
          }} />
          <div>
            <div style={{ fontWeight: 600, color: '#1b1c19', marginBottom: '2px' }}>
              {p.range} {p.active && (lang === 'es' ? '— estás aquí' : '— you are here')}
            </div>
            <div style={{ fontSize: '13px', color: '#454652' }}>{p.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Recommendation({ mode, lang }: { mode: AiMode; lang: 'en' | 'es' }) {
  if (mode === 'auto') {
    return (
      <div style={{
        padding: '14px 16px',
        background: 'rgba(0,160,80,0.05)',
        border: '1px solid rgba(0,160,80,0.18)',
        borderRadius: '10px',
        color: '#00733a',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
      }}>
        <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
        <span>
          {lang === 'es'
            ? 'Estás en el modo recomendado. Auto-llenado se activará por sí solo a medida que la IA gane confianza en cada artículo.'
            : 'You are on the recommended setting. Auto-fill will switch on by itself as the AI gains confidence on each item.'}
        </span>
      </div>
    );
  }
  if (mode === 'off') {
    return (
      <div style={{
        padding: '14px 16px',
        background: 'rgba(122,138,158,0.06)',
        border: '1px solid rgba(122,138,158,0.18)',
        borderRadius: '10px',
        color: '#454652',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
      }}>
        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
        <span>
          {lang === 'es'
            ? 'Recomendamos volver a activarla. La IA no afecta tus conteos manuales y solo mejora la lista de reordenar y las alertas.'
            : 'We recommend turning it back on. The AI doesn’t change your manual counts — it just makes the reorder list and alerts smarter.'}
        </span>
      </div>
    );
  }
  return (
    <div style={{
      padding: '14px 16px',
      background: 'rgba(240,173,78,0.07)',
      border: '1px solid rgba(240,173,78,0.25)',
      borderRadius: '10px',
      color: '#a26d2a',
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
    }}>
      <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
      <span>
        {lang === 'es'
          ? 'Esta opción puede causar inexactitudes durante los primeros 30 días. Considera volver a "Auto" hasta que más artículos se gradúen.'
          : 'This setting may cause inaccuracies during the first 30 days. Consider switching to "Auto" until more items graduate.'}
      </span>
    </div>
  );
}

function ModeToggle({
  mode, onChange, disabled, lang,
}: {
  mode: AiMode;
  onChange: (m: AiMode) => void;
  disabled: boolean;
  lang: 'en' | 'es';
}) {
  const options: Array<{ id: AiMode; label: string; desc: string }> = [
    {
      id: 'off',
      label: lang === 'es' ? 'Desactivado' : 'Off',
      desc: lang === 'es' ? 'Sin IA. Lista de reordenar manual.' : 'No AI. Manual reorder list only.',
    },
    {
      id: 'auto',
      label: lang === 'es' ? 'Automático (recomendado)' : 'Auto (recommended)',
      desc: lang === 'es'
        ? 'IA invisible al inicio. Auto-llenado por artículo cuando la precisión lo permite.'
        : 'AI invisible at first. Auto-fills per item when accuracy is good enough.',
    },
    {
      id: 'always-on',
      label: lang === 'es' ? 'Siempre activado' : 'Always on',
      desc: lang === 'es'
        ? 'Auto-llenado en cualquier artículo con predicción, sin esperar la graduación.'
        : 'Auto-fills any item with a prediction, without waiting for graduation.',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {options.map((opt) => {
        const active = mode === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => !disabled && !active && onChange(opt.id)}
            disabled={disabled}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              background: active ? 'rgba(0,75,75,0.06)' : '#ffffff',
              border: active ? '2px solid #004b4b' : '1px solid rgba(78,90,122,0.18)',
              borderRadius: '12px',
              cursor: disabled || active ? 'default' : 'pointer',
              opacity: disabled && !active ? 0.6 : 1,
              transition: 'background 0.15s, border 0.15s',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: '4px',
            }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: active ? '#004b4b' : '#1b1c19' }}>
                {opt.label}
              </span>
              {active && <CheckCircle2 size={18} color="#004b4b" />}
            </div>
            <div style={{ fontSize: '13px', color: '#454652' }}>{opt.desc}</div>
          </button>
        );
      })}
    </div>
  );
}

function Faq({ lang }: { lang: 'en' | 'es' }) {
  const items = lang === 'es'
    ? [
        ['¿Me bloqueará la IA para corregir un número?', 'No. Siempre puedes escribir encima.'],
        ['¿Qué pasa si la IA se equivoca?', 'Lo corriges, y la IA aprende de tu corrección.'],
        ['¿Puedo ver lo que hace la IA?', 'Solo el dueño — Admin → ML → pestaña Inventario.'],
        ['¿Cuesta extra?', 'No.'],
        ['¿Qué datos usa?', 'Solo el historial de conteos de tu hotel. No huéspedes, no personal, no fotos.'],
      ]
    : [
        ['Will the AI ever lock me out of correcting a number?', 'No. You can always type over it.'],
        ['What happens if the AI is wrong?', 'You correct it; the AI learns from your correction.'],
        ['Can I see what the AI is doing?', 'Owner-only — Admin → ML → Inventory tab.'],
        ['Does this cost extra?', 'No.'],
        ['What data does it look at?', 'Only your hotel’s count history. Not guests, not staff, not photos.'],
      ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {items.map(([q, a]) => (
        <div
          key={q}
          style={{
            padding: '12px 14px',
            background: '#f7fafb',
            border: '1px solid rgba(78,90,122,0.08)',
            borderRadius: '10px',
          }}
        >
          <div style={{ fontWeight: 600, color: '#1b1c19', marginBottom: '4px' }}>{q}</div>
          <div style={{ fontSize: '13px', color: '#454652' }}>{a}</div>
        </div>
      ))}
    </div>
  );
}

function modeLabel(mode: AiMode, lang: 'en' | 'es'): string {
  if (lang === 'es') {
    return mode === 'off' ? 'Desactivado' : mode === 'auto' ? 'Automático' : 'Siempre activado';
  }
  return mode === 'off' ? 'Off' : mode === 'auto' ? 'Auto' : 'Always on';
}
