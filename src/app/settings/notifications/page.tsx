'use client';


export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { ChevronLeft, Bell, Mail, MessageSquare, Plus, X, Save } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useCan } from '@/lib/capabilities/useCan';

interface Preferences {
  propertyId: string;
  deliveryTimeLocal: string;
  channels: { email: boolean; sms: boolean };
  ccEmails: string[];
  pausedUntil: string | null;
  weeklyEnabled: boolean;
}

const DELIVERY_OPTIONS = ['16:00', '18:00', '20:00', '22:00'];

export default function NotificationsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { properties } = useProperty();
  const { lang } = useLang();
  const can = useCan();

  // Gated by per-hotel manage_notifications (default: every role; admin can
  // switch a role OFF per hotel from the Access tab).
  useEffect(() => {
    if (user && !can('manage_notifications')) router.replace('/settings');
  }, [user, can, router]);

  const [propertyId, setPropertyId] = useState<string>('');
  useEffect(() => {
    if (!propertyId && properties.length > 0) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [newCc, setNewCc] = useState('');

  const load = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchWithAuth(`/api/settings/notifications?propertyId=${propertyId}`);
      const body = await res.json() as { ok?: boolean; data?: { preferences: Preferences }; error?: string };
      if (!res.ok || !body.ok || !body.data) {
        setError(body.error || (lang === 'es' ? 'No se pudieron cargar las preferencias' : 'Failed to load preferences'));
        return;
      }
      setPrefs(body.data.preferences);
    } catch (err) {
      // A network throw used to escape as an unhandled rejection — the page
      // rendered blank (prefs null) with no error at all.
      console.error('[notifications:settings] load failed', err);
      setError(lang === 'es' ? 'No se pudieron cargar las preferencias — revisa tu conexión' : 'Failed to load preferences — check your connection');
    } finally {
      setLoading(false);
    }
  }, [propertyId, lang]);

  useEffect(() => { void load(); }, [load]);

  /** Returns true only when the server confirmed the save. */
  const save = async (next: Partial<Preferences>): Promise<boolean> => {
    if (!prefs || !propertyId) return false;
    setSaving(true);
    setError('');
    try {
      const res = await fetchWithAuth('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, ...next }),
      });
      const body = await res.json() as { ok?: boolean; data?: { preferences: Preferences }; error?: string };
      if (!res.ok || !body.ok || !body.data) {
        setError(body.error || (lang === 'es' ? 'No se pudo guardar' : 'Failed to save'));
        return false;
      }
      setPrefs(body.data.preferences);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
      return true;
    } catch (err) {
      // A network throw used to escape silently — toggles/pause buttons did
      // nothing with zero feedback.
      console.error('[notifications:settings] save failed', err);
      setError(lang === 'es' ? 'No se pudo guardar — revisa tu conexión e intenta de nuevo' : 'Failed to save — check your connection and try again');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAddCc = async () => {
    if (!prefs) return;
    const trim = newCc.trim().toLowerCase();
    if (!trim) return;
    if (prefs.ccEmails.includes(trim)) {
      setError(lang === 'es' ? 'Ese correo ya está en la lista' : 'That email is already in the list');
      return;
    }
    const nextList = [...prefs.ccEmails, trim];
    // Clear the input only AFTER the save succeeds — a failed save used to
    // throw away what the manager typed.
    const ok = await save({ ccEmails: nextList });
    if (ok) setNewCc('');
  };

  const handleRemoveCc = async (cc: string) => {
    if (!prefs) return;
    await save({ ccEmails: prefs.ccEmails.filter(x => x !== cc) });
  };

  const togglePauseFor = async (days: number | null) => {
    if (!prefs) return;
    if (days === null) {
      await save({ pausedUntil: null });
      return;
    }
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    await save({ pausedUntil: until });
  };

  if (!user || !can('manage_notifications')) return null;

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: 720 }}>
        <div>
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', padding: '0 0 12px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {lang === 'es' ? 'Configuración' : 'Settings'}
          </button>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '17px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={15} color="var(--navy)" />
            {lang === 'es' ? 'Notificaciones' : 'Notifications'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: 4 }}>
            {lang === 'es'
              ? 'Cuándo y cómo quieres recibir el reporte diario y semanal de limpieza.'
              : 'When and how you want to receive the daily and weekly housekeeping report.'}
          </p>
        </div>

        {properties.length > 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>{lang === 'es' ? 'Hotel' : 'Hotel'}</label>
            <select value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ ...inputStyle, height: 42 }}>
              {properties.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        )}

        {loading && (
          <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
            <div className="spinner" style={{ width: 28, height: 28 }} />
          </div>
        )}

        {error && (
          <p style={{ fontSize: 13, color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            {error}
          </p>
        )}

        {prefs && !loading && (
          <>
            {/* Delivery time */}
            <Card title={lang === 'es' ? 'Hora de envío' : 'Delivery time'} subtitle={lang === 'es' ? 'El reporte llega a esta hora cada día, en la hora local del hotel.' : 'The report arrives at this time every day, in your hotel\'s local time.'}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {DELIVERY_OPTIONS.map(opt => {
                  const isActive = prefs.deliveryTimeLocal === opt;
                  const label = formatTimeLabel(opt, lang);
                  return (
                    <button
                      key={opt}
                      onClick={() => save({ deliveryTimeLocal: opt })}
                      disabled={saving}
                      style={pillStyle(isActive)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Channels */}
            <Card title={lang === 'es' ? 'Canales' : 'Channels'} subtitle={lang === 'es' ? 'Cómo quieres recibirlo.' : 'How you want to receive it.'}>
              <ChannelToggle
                icon={<Mail size={16} />}
                label={lang === 'es' ? 'Correo' : 'Email'}
                active={prefs.channels.email}
                onChange={(next) => save({ channels: { ...prefs.channels, email: next } })}
              />
              <ChannelToggle
                icon={<MessageSquare size={16} />}
                label={lang === 'es' ? 'SMS con enlace' : 'SMS link'}
                hint={lang === 'es' ? 'Recibirás un mensaje con un enlace al reporte.' : 'You\'ll get a text with a link to the report.'}
                active={prefs.channels.sms}
                onChange={(next) => save({ channels: { ...prefs.channels, sms: next } })}
              />
            </Card>

            {/* CC list */}
            <Card title={lang === 'es' ? 'Compartir con otros' : 'CC recipients'} subtitle={lang === 'es' ? 'Agrega correos extra para enviar el mismo reporte.' : 'Add extra email addresses to also receive the report.'}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  type="email"
                  value={newCc}
                  placeholder={lang === 'es' ? 'correo@ejemplo.com' : 'name@example.com'}
                  onChange={e => setNewCc(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleAddCc(); }}
                  style={inputStyle}
                />
                <button onClick={handleAddCc} disabled={saving || !newCc.trim()} style={primaryBtnStyle(saving || !newCc.trim())}>
                  <Plus size={14} />
                </button>
              </div>
              {prefs.ccEmails.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {prefs.ccEmails.map(cc => (
                    <div key={cc} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', padding: '8px 10px',
                    }}>
                      <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{cc}</span>
                      <button onClick={() => handleRemoveCc(cc)} disabled={saving} style={iconBtnStyle}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {lang === 'es' ? 'Sin correos extra todavía.' : 'No extra recipients yet.'}
                </p>
              )}
            </Card>

            {/* Pause */}
            <Card title={lang === 'es' ? 'Pausar entregas' : 'Pause delivery'} subtitle={lang === 'es' ? 'Útil para vacaciones — no llegará nada durante este tiempo.' : 'Useful for vacations — you won\'t get anything during this window.'}>
              {prefs.pausedUntil ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                    {lang === 'es'
                      ? `Pausado hasta ${new Date(prefs.pausedUntil).toLocaleDateString()}`
                      : `Paused until ${new Date(prefs.pausedUntil).toLocaleDateString()}`}
                  </p>
                  <button onClick={() => togglePauseFor(null)} disabled={saving} style={ghostBtnStyle}>
                    {lang === 'es' ? 'Reanudar ahora' : 'Resume now'}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => togglePauseFor(3)} disabled={saving} style={ghostBtnStyle}>
                    {lang === 'es' ? '3 días' : '3 days'}
                  </button>
                  <button onClick={() => togglePauseFor(7)} disabled={saving} style={ghostBtnStyle}>
                    {lang === 'es' ? '1 semana' : '1 week'}
                  </button>
                  <button onClick={() => togglePauseFor(14)} disabled={saving} style={ghostBtnStyle}>
                    {lang === 'es' ? '2 semanas' : '2 weeks'}
                  </button>
                </div>
              )}
            </Card>

            {/* Weekly toggle */}
            <Card title={lang === 'es' ? 'Reporte semanal' : 'Weekly report'} subtitle={lang === 'es' ? 'Cada domingo recibirás un resumen de la semana con análisis automático.' : 'Every Sunday you\'ll get a week-at-a-glance summary with auto-generated insight.'}>
              <ChannelToggle
                icon={<Bell size={16} />}
                label={lang === 'es' ? 'Recibir el domingo' : 'Receive on Sundays'}
                active={prefs.weeklyEnabled}
                onChange={(next) => save({ weeklyEnabled: next })}
              />
            </Card>

            {savedFlash && (
              <div style={{
                position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
                background: '#22c55e', color: '#fff', padding: '10px 18px', borderRadius: 999,
                fontWeight: 600, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8,
                boxShadow: '0 12px 32px -6px rgba(34,197,94,0.45)', zIndex: 9999,
              }}>
                <Save size={16} />
                {lang === 'es' ? 'Guardado' : 'Saved'}
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div>
        <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function ChannelToggle({ icon, label, hint, active, onChange }: { icon: React.ReactNode; label: string; hint?: string; active: boolean; onChange: (next: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-muted)' }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{hint}</div>}
        </div>
      </div>
      <button
        onClick={() => onChange(!active)}
        aria-pressed={active}
        style={{
          width: 44, height: 26, borderRadius: 13,
          background: active ? '#22c55e' : 'rgba(100,116,139,0.3)',
          border: 'none', cursor: 'pointer', padding: 0, position: 'relative', transition: 'background 160ms',
        }}
      >
        <span style={{
          display: 'inline-block', width: 22, height: 22, borderRadius: 11, background: '#fff',
          position: 'absolute', top: 2, left: active ? 20 : 2, transition: 'left 160ms',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  );
}

function formatTimeLabel(hhmm: string, lang: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const minStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  return lang === 'es' ? `${h12}${minStr}${ampm === 'AM' ? 'am' : 'pm'}` : `${h12}${minStr} ${ampm}`;
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
  color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
};

const inputStyle: React.CSSProperties = {
  flex: 1, height: 42, borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  padding: '0 12px', color: 'var(--text-primary)', fontSize: 14,
  fontFamily: 'var(--font-sans)', outline: 'none', width: '100%',
};

function pillStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 80, height: 38, padding: '0 14px',
    borderRadius: 'var(--radius-md)',
    background: active ? 'var(--amber-dim)' : 'var(--bg-card)',
    border: `1px solid ${active ? 'var(--amber-border)' : 'var(--border)'}`,
    color: active ? 'var(--amber)' : 'var(--text-secondary)',
    fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };
}

const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 'var(--radius-sm)',
  background: 'transparent', border: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: 'var(--text-muted)',
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 42, height: 42, borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#fff', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };
}

const ghostBtnStyle: React.CSSProperties = {
  height: 38, padding: '0 14px', borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
};
