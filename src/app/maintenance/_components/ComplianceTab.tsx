'use client';

// Maintenance → Compliance tab (feature #19, manager/GM desktop surface).
//
// Today's required readings + PM checks, done/overdue status, out-of-range
// flags, the inspector-ready export, the "Send compliance link" button, and
// one-line AI setup. Reads/writes go through /api/compliance/* (service role)
// via src/lib/db/compliance.ts — never the browser supabase client.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { Btn, Pill, Caps } from '@/app/housekeeping/_components/_snow';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Modal, Field, TextInput, TextArea, ChipChoose,
} from './_mt-snow';
import {
  fetchComplianceOverview,
  fetchComplianceReport,
  logManagerReading,
  logManagerPmCheck,
  runComplianceSetup,
  loadComplianceTemplate,
  fetchComplianceTemplates,
  sendEngineerLinks,
  managerVisionReading,
} from '@/lib/db/compliance';
import type { ComplianceOverview, ReadingTypeStatus, PmTaskStatus, ComplianceReport } from '@/lib/compliance/types';

const tr = (lang: string, en: string, es: string) => (lang === 'es' ? es : en);

function statusColor(pct: number): string {
  if (pct >= 70) return T.sageDeep;
  if (pct >= 30) return T.caramel;
  return T.warm;
}

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

export function ComplianceTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const pid = activePropertyId;

  const [overview, setOverview] = useState<ComplianceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(async () => {
    if (!pid) return;
    const o = await fetchComplianceOverview(pid);
    setOverview(o);
    setLoading(false);
  }, [pid]);

  useEffect(() => {
    if (!user || !pid) return;
    void load();
    const iv = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(iv);
  }, [user, pid, load]);

  // Modals
  const [logTarget, setLogTarget] = useState<ReadingTypeStatus | null>(null);
  const [pmTarget, setPmTarget] = useState<PmTaskStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [sending, setSending] = useState(false);

  if (!pid) return null;

  const isEmpty = !loading && overview && overview.readingsTotal === 0 && overview.pmTotal === 0;
  const pct = overview?.readingsCompletePct ?? 0;
  const overdue = overview?.pmOverdueCount ?? 0;

  const handleSendLinks = async () => {
    setSending(true);
    try {
      const r = await sendEngineerLinks(pid, window.location.origin);
      if (r.ok && r.data) {
        flash(tr(lang, `Sent ${r.data.sent} compliance link(s) to maintenance.`, `Se enviaron ${r.data.sent} enlace(s) a mantenimiento.`)
          + (r.data.sent === 0 ? tr(lang, ' (No active maintenance staff with a phone.)', ' (Sin personal de mantenimiento con teléfono.)') : ''));
      } else {
        flash(r.error || tr(lang, 'Send failed', 'Error al enviar'));
      }
    } finally {
      setSending(false);
    }
  };

  const handleExport = async () => {
    const rep = await fetchComplianceReport(pid);
    if (rep) setReport(rep);
    else flash(tr(lang, 'Could not load report', 'No se pudo cargar el informe'));
  };

  return (
    <div style={{ padding: '24px 48px 64px', fontFamily: FONT_SANS, color: T.ink, background: T.bg, minHeight: '60dvh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <Caps c={T.ink3}>{tr(lang, 'Engineering Compliance', 'Cumplimiento de Ingeniería')}</Caps>
          <h2 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 0', fontStyle: 'italic', color: T.ink }}>
            {tr(lang, "Today's readings & safety checks", 'Lecturas y revisiones de hoy')}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="md" onClick={() => setSetupOpen(true)}>{tr(lang, 'AI setup', 'Config IA')}</Btn>
          <Btn variant="ghost" size="md" onClick={handleExport}>{tr(lang, 'Export audit pack', 'Exportar auditoría')}</Btn>
          <Btn variant="sage" size="md" onClick={handleSendLinks} disabled={sending}>
            {sending ? tr(lang, 'Sending…', 'Enviando…') : tr(lang, 'Send compliance link', 'Enviar enlace')}
          </Btn>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: T.ink3 }}>
          <div className="animate-spin" style={{ width: 26, height: 26, border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%', margin: '0 auto' }} />
        </div>
      ) : isEmpty ? (
        <EmptySetup lang={lang} onSetup={() => setSetupOpen(true)} />
      ) : overview ? (
        <>
          {/* Status strip */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
            <StatCard
              label={tr(lang, 'Readings today', 'Lecturas hoy')}
              value={`${pct}%`}
              sub={`${overview.readingsDone}/${overview.readingsTotal} ${tr(lang, 'logged', 'registradas')}`}
              color={statusColor(pct)}
            />
            <StatCard
              label={tr(lang, 'Overdue checks', 'Revisiones vencidas')}
              value={String(overdue)}
              sub={`${tr(lang, 'of', 'de')} ${overview.pmTotal} ${tr(lang, 'life-safety', 'seguridad')}`}
              color={overdue === 0 ? T.sageDeep : overdue >= 3 ? T.warm : T.caramel}
            />
          </div>

          {/* Readings */}
          <SectionTitle>{tr(lang, 'Readings', 'Lecturas')}</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
            {overview.readings.length === 0 && <Muted>{tr(lang, 'No readings configured.', 'Sin lecturas configuradas.')}</Muted>}
            {overview.readings.map((r) => (
              <ReadingRow key={r.type.id} r={r} lang={lang} onLog={() => setLogTarget(r)} />
            ))}
          </div>

          {/* PM checks */}
          <SectionTitle>{tr(lang, 'Life-safety checks', 'Revisiones de seguridad')}</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overview.pmTasks.length === 0 && <Muted>{tr(lang, 'No checks configured.', 'Sin revisiones configuradas.')}</Muted>}
            {overview.pmTasks.map((p) => (
              <PmRow key={p.task.id} p={p} lang={lang} onCheck={() => setPmTarget(p)} />
            ))}
          </div>
        </>
      ) : (
        <Muted>{tr(lang, 'Could not load compliance data.', 'No se pudieron cargar los datos.')}</Muted>
      )}

      {/* Modals */}
      {logTarget && (
        <LogReadingModal
          pid={pid} lang={lang} target={logTarget}
          onClose={() => setLogTarget(null)}
          onSaved={(msg) => { setLogTarget(null); flash(msg); void load(); }}
        />
      )}
      {pmTarget && (
        <LogPmModal
          pid={pid} lang={lang} target={pmTarget}
          onClose={() => setPmTarget(null)}
          onSaved={(msg) => { setPmTarget(null); flash(msg); void load(); }}
        />
      )}
      {setupOpen && (
        <SetupModal
          pid={pid} lang={lang}
          onClose={() => setSetupOpen(false)}
          onDone={(msg) => { setSetupOpen(false); flash(msg); void load(); }}
        />
      )}
      {report && <ReportModal report={report} lang={lang} onClose={() => setReport(null)} />}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: T.ink, color: T.bg, padding: '12px 20px', borderRadius: 12,
          fontFamily: FONT_SANS, fontSize: 13.5, zIndex: 2000, maxWidth: '90vw',
          boxShadow: '0 12px 32px rgba(31,35,28,0.24)',
        }}>{toast}</div>
      )}
    </div>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: 10 }}><Caps c={T.ink2}>{children}</Caps></div>;
}
function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: T.ink3, fontSize: 13.5, padding: '12px 2px' }}>{children}</div>;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 200, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: '14px 18px' }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.ink3 }}>{label}</div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 34, fontWeight: 500, color, letterSpacing: '-0.03em', lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: 12, color: T.ink3 }}>{sub}</span>
      </div>
    </div>
  );
}

function ReadingRow({ r, lang, onLog }: { r: ReadingTypeStatus; lang: string; onLog: () => void }) {
  const latest = r.latest;
  let pill: React.ReactNode;
  if (r.latestOutOfRange) pill = <Pill tone="warm">{tr(lang, 'Out of range', 'Fuera de rango')}</Pill>;
  else if (r.doneThisPeriod) pill = <Pill tone="sage">{tr(lang, 'Logged', 'Registrada')}</Pill>;
  else pill = <Pill tone="caramel">{tr(lang, 'Due', 'Pendiente')}</Pill>;
  const range = (r.type.minValue !== null || r.type.maxValue !== null)
    ? `${r.type.minValue ?? '–'}–${r.type.maxValue ?? '–'}${r.type.unit}` : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{r.type.name}</div>
        <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>
          {r.periodLabel}{range ? ` · ${tr(lang, 'safe', 'seguro')} ${range}` : ''}
          {latest && latest.value !== null ? ` · ${tr(lang, 'last', 'últ.')} ${latest.value}${latest.unit}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {pill}
        <Btn variant="paper" size="sm" onClick={onLog}>{tr(lang, 'Log', 'Registrar')}</Btn>
      </div>
    </div>
  );
}

function PmRow({ p, lang, onCheck }: { p: PmTaskStatus; lang: string; onCheck: () => void }) {
  let pill: React.ReactNode;
  if (p.overdue) pill = <Pill tone="warm">{tr(lang, 'Overdue', 'Vencida')}</Pill>;
  else if (p.doneThisPeriod) pill = <Pill tone="sage">{tr(lang, 'Done', 'Hecho')}</Pill>;
  else pill = <Pill tone="caramel">{tr(lang, 'Due', 'Pendiente')}</Pill>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{p.task.name}</div>
        <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>
          {p.task.unitCount} {tr(lang, 'units', 'unidades')} · {p.periodLabel}
          {p.latest ? ` · ${tr(lang, 'last', 'últ.')} ${new Date(p.latest.checkedAt).toLocaleDateString()}` : ` · ${tr(lang, 'never checked', 'nunca revisado')}`}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {pill}
        <Btn variant="paper" size="sm" onClick={onCheck}>{tr(lang, 'Check off', 'Marcar')}</Btn>
      </div>
    </div>
  );
}

function EmptySetup({ lang, onSetup }: { lang: string; onSetup: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', background: T.paper, border: `1px dashed ${T.rule}`, borderRadius: 18 }}>
      <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22, color: T.ink, marginBottom: 8 }}>
        {tr(lang, 'No compliance schedule yet', 'Aún no hay programa de cumplimiento')}
      </div>
      <div style={{ fontSize: 13.5, color: T.ink2, maxWidth: 460, margin: '0 auto 18px' }}>
        {tr(lang,
          'Set up pool chemistry, meters, boiler, area temperatures and life-safety checks in one tap — AI detects your brand and pre-loads the required logs.',
          'Configura química de piscina, medidores, caldera, temperaturas y revisiones de seguridad en un toque — la IA detecta tu marca.')}
      </div>
      <Btn variant="sage" size="lg" onClick={onSetup}>{tr(lang, 'Set up with AI', 'Configurar con IA')}</Btn>
    </div>
  );
}

// ─── Log reading modal (with snap-to-log) ────────────────────────────────────

function LogReadingModal({ pid, lang, target, onClose, onSaved }: {
  pid: string; lang: string; target: ReadingTypeStatus; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPhoto = async (file: File | null) => {
    if (!file) return;
    setScanBusy(true); setScanNote(null);
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const r = await managerVisionReading({ pid, readingTypeId: target.type.id, imageBase64: base64, mediaType });
      if (r.ok && r.data && r.data.value !== null) {
        setValue(String(r.data.value));
        setScanNote(tr(lang, `Read ${r.data.value}${target.type.unit} (${r.data.confidence} confidence)`, `Leído ${r.data.value}${target.type.unit}`));
      } else {
        setScanNote(tr(lang, 'Could not read the photo — enter the value manually.', 'No se pudo leer la foto — ingresa el valor.'));
      }
    } catch {
      setScanNote(tr(lang, 'Scan failed — enter manually.', 'Escaneo falló — ingresa manualmente.'));
    } finally {
      setScanBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    const num = value.trim() === '' ? null : Number(value);
    if (num !== null && !Number.isFinite(num)) return;
    setBusy(true);
    try {
      const r = await logManagerReading({ pid, readingTypeId: target.type.id, value: num, note: note || undefined });
      if (r.ok) {
        onSaved(r.data?.outOfRange
          ? tr(lang, `Logged — ⚠️ out of range, work order created`, `Registrado — ⚠️ fuera de rango, orden creada`)
          : tr(lang, 'Reading logged', 'Lectura registrada'));
      } else { setBusy(false); }
    } catch { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={target.type.name} subtitle={tr(lang, `Log a reading (${target.type.unit || 'value'})`, `Registrar lectura`)}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{tr(lang, 'Cancel', 'Cancelar')}</Btn>
        <Btn variant="primary" onClick={save} disabled={busy || value.trim() === ''}>{busy ? '…' : tr(lang, 'Save', 'Guardar')}</Btn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={tr(lang, 'Value', 'Valor')} hint={target.type.unit}>
          <TextInput value={value} onChange={setValue} type="number" placeholder="0" inputMode="decimal" />
        </Field>
        <div>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={scanBusy} style={{
            width: '100%', padding: '10px', borderRadius: 10, cursor: 'pointer',
            background: T.sageDim, color: T.sageDeep, border: `1px solid rgba(104,131,114,0.3)`,
            fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
          }}>
            {scanBusy ? tr(lang, 'Reading photo…', 'Leyendo foto…') : tr(lang, '📷 Snap-to-log (read from photo)', '📷 Leer desde foto')}
          </button>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
            onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} />
          {scanNote && <div style={{ marginTop: 6, fontSize: 12, color: T.ink2 }}>{scanNote}</div>}
        </div>
        <Field label={tr(lang, 'Note (optional)', 'Nota (opcional)')}>
          <TextInput value={note} onChange={setNote} placeholder={tr(lang, 'e.g. after backwash', 'p. ej. tras retrolavado')} />
        </Field>
      </div>
    </Modal>
  );
}

// ─── PM check modal ──────────────────────────────────────────────────────────

function LogPmModal({ pid, lang, target, onClose, onSaved }: {
  pid: string; lang: string; target: PmTaskStatus; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [status, setStatus] = useState<'pass' | 'fail'>('pass');
  const [units, setUnits] = useState(String(target.task.unitCount));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await logManagerPmCheck({ pid, pmTaskId: target.task.id, status, unitsChecked: units.trim() === '' ? undefined : Number(units), note: note || undefined });
      if (r.ok) {
        onSaved(status === 'fail'
          ? tr(lang, 'Recorded FAIL — work order created', 'FALLA registrada — orden creada')
          : tr(lang, 'Check recorded', 'Revisión registrada'));
      } else { setBusy(false); }
    } catch { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={target.task.name} subtitle={tr(lang, `Check off ${target.periodLabel}`, `Marcar ${target.periodLabel}`)}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{tr(lang, 'Cancel', 'Cancelar')}</Btn>
        <Btn variant="primary" onClick={save} disabled={busy}>{busy ? '…' : tr(lang, 'Save', 'Guardar')}</Btn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={tr(lang, 'Result', 'Resultado')}>
          <ChipChoose<'pass' | 'fail'>
            options={[{ value: 'pass', label: tr(lang, 'Pass', 'Aprobado') }, { value: 'fail', label: tr(lang, 'Fail', 'Falla') }]}
            value={status} onChange={setStatus}
          />
        </Field>
        <Field label={tr(lang, 'Units checked', 'Unidades revisadas')} hint={`/ ${target.task.unitCount}`}>
          <TextInput value={units} onChange={setUnits} type="number" inputMode="numeric" />
        </Field>
        <Field label={tr(lang, 'Note (optional)', 'Nota (opcional)')}>
          <TextArea value={note} onChange={setNote} rows={2} placeholder={tr(lang, 'e.g. unit 4 tag expired', 'p. ej. etiqueta 4 vencida')} />
        </Field>
      </div>
    </Modal>
  );
}

// ─── Setup modal (AI one-line + brand template) ──────────────────────────────

function SetupModal({ pid, lang, onClose, onDone }: {
  pid: string; lang: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Array<{ key: string; label: string; readingCount: number; pmCount: number }>>([]);

  useEffect(() => { void fetchComplianceTemplates().then(setTemplates); }, []);

  const runAI = async () => {
    setBusy(true);
    try {
      const r = await runComplianceSetup(pid, text || undefined);
      if (r.ok && r.data) onDone(tr(lang, `Set up ${r.data.readingsCreated} readings + ${r.data.pmCreated} checks (${r.data.detectedBrand}).`, `Configurado: ${r.data.readingsCreated} lecturas + ${r.data.pmCreated} revisiones.`));
      else { setBusy(false); }
    } catch { setBusy(false); }
  };

  const applyTemplate = async (key: string) => {
    setBusy(true);
    try {
      const r = await loadComplianceTemplate(pid, key);
      if (r.ok && r.data) onDone(tr(lang, `Loaded ${r.data.readingsCreated} readings + ${r.data.pmCreated} checks.`, `Cargado: ${r.data.readingsCreated} lecturas + ${r.data.pmCreated} revisiones.`));
      else { setBusy(false); }
    } catch { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={tr(lang, 'AI compliance setup', 'Configuración con IA')}
      subtitle={tr(lang, 'Describe your property — AI builds the schedule', 'Describe tu propiedad — la IA crea el programa')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={tr(lang, 'One-line setup', 'Configuración en una línea')} hint={tr(lang, 'optional', 'opcional')}>
          <TextArea value={text} onChange={setText} rows={3}
            placeholder={tr(lang, 'e.g. we have 15 fire extinguishers, 18 emergency lights, a pool, and 3 walk-in fridges', 'p. ej. tenemos 15 extintores, 18 luces de emergencia, una piscina y 3 refrigeradores')} />
        </Field>
        <Btn variant="sage" size="lg" onClick={runAI} disabled={busy}>
          {busy ? tr(lang, 'Setting up…', 'Configurando…') : tr(lang, 'Detect brand & set up', 'Detectar marca y configurar')}
        </Btn>
        <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 14 }}>
          <Caps c={T.ink3}>{tr(lang, 'Or load a brand template', 'O cargar una plantilla')}</Caps>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {templates.map((t) => (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
                <span style={{ color: T.ink2 }}>{t.label} <span style={{ color: T.ink3 }}>· {t.readingCount}+{t.pmCount}</span></span>
                <Btn variant="paper" size="sm" onClick={() => applyTemplate(t.key)} disabled={busy}>{tr(lang, 'Load', 'Cargar')}</Btn>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Inspector report modal ──────────────────────────────────────────────────

function ReportModal({ report, lang, onClose }: { report: ComplianceReport; lang: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} width={720}
      title={tr(lang, 'Compliance audit pack', 'Paquete de auditoría')}
      subtitle={`${report.fromDate} → ${report.toDate}`}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{tr(lang, 'Close', 'Cerrar')}</Btn>
        <Btn variant="primary" onClick={() => window.print()}>{tr(lang, 'Print / Save PDF', 'Imprimir / PDF')}</Btn>
      </>}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <Pill tone="ink">{report.totals.readingCount} {tr(lang, 'readings', 'lecturas')}</Pill>
        <Pill tone={report.totals.outOfRangeCount > 0 ? 'warm' : 'sage'}>{report.totals.outOfRangeCount} {tr(lang, 'out of range', 'fuera de rango')}</Pill>
        <Pill tone="ink">{report.totals.pmCheckCount} {tr(lang, 'checks', 'revisiones')}</Pill>
        <Pill tone={report.totals.pmFailCount > 0 ? 'warm' : 'sage'}>{report.totals.pmFailCount} {tr(lang, 'fails', 'fallas')}</Pill>
      </div>
      {report.truncated && (
        <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 10, background: T.warmDim, color: T.warm, fontSize: 12.5, fontFamily: FONT_SANS }}>
          {tr(lang, '⚠ This range has too many entries to show in full — narrow the dates for a complete pack.', '⚠ Demasiados registros — reduce el rango para un paquete completo.')}
        </div>
      )}
      {[...report.readings, ...report.pmChecks].length === 0 && <Muted>{tr(lang, 'No entries in this range.', 'Sin registros en este rango.')}</Muted>}
      {[...report.readings, ...report.pmChecks].map((row, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink, marginBottom: 4 }}>{row.name} <span style={{ color: T.ink3, fontWeight: 400 }}>· {row.entries.length}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {row.entries.slice(0, 60).map((e, j) => (
              <div key={j} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: e.status === 'OUT OF RANGE' || e.status === 'fail' ? T.warm : T.ink2, fontFamily: FONT_MONO, borderBottom: `1px dotted ${T.rule}`, padding: '2px 0' }}>
                <span>{new Date(e.when).toLocaleString()}</span>
                <span>{e.value}</span>
                <span>{e.by}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}
