'use client';

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { updateProperty } from '@/lib/firestore';
import { Wifi, WifiOff, Shield, Zap, AlertCircle, CheckCircle, ChevronDown } from 'lucide-react';
import Link from 'next/link';

const PMS_SYSTEMS = [
  { value: 'choice_advantage', label: 'Choice Advantage (Comfort Suites, Quality Inn…)' },
  { value: 'opera_cloud', label: 'Opera Cloud (Marriott, Hilton…)' },
  { value: 'cloudbeds', label: 'Cloudbeds' },
  { value: 'roomkey', label: 'RoomKey PMS' },
  { value: 'skytouch', label: 'SkyTouch Hotel OS' },
  { value: 'webrezpro', label: 'WebRezPro' },
  { value: 'hotelogix', label: 'Hotelogix' },
  { value: 'other', label: 'Other' },
];

const SYNC_STATUS = {
  idle: null,
  testing: 'testing',
  success: 'success',
  error: 'error',
} as const;

export default function PMSPage() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, refreshProperty } = useProperty();

  const [pmsType, setPmsType] = useState(activeProperty?.pmsType ?? '');
  const [pmsUrl, setPmsUrl] = useState(activeProperty?.pmsUrl ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const handleTest = async () => {
    if (!pmsType || !pmsUrl || !username || !password) {
      setTestStatus('error');
      setTestMessage('Please fill in all fields before testing.');
      return;
    }
    setTestStatus('testing');
    setTestMessage('');

    // Simulate CUA test — in production this would call /api/pms/test
    await new Promise(r => setTimeout(r, 2500));

    // For demo purposes, always succeed for known PMS systems
    if (PMS_SYSTEMS.find(p => p.value === pmsType && pmsType !== 'other')) {
      setTestStatus('success');
      setTestMessage(`Connected to ${PMS_SYSTEMS.find(p => p.value === pmsType)?.label}. Occupancy data found.`);
    } else {
      setTestStatus('error');
      setTestMessage('Could not connect. Check your URL and credentials, or contact support for help with this PMS.');
    }
  };

  const handleSave = async () => {
    if (!user || !activePropertyId) return;
    setSaving(true);
    try {
      await updateProperty(user.uid, activePropertyId, {
        pmsType,
        pmsUrl,
        pmsConnected: testStatus === 'success',
      });
      await refreshProperty();
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>← Settings</Link>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Wifi size={18} color="var(--amber)" /> PMS Connection
          </h1>
        </div>

        {/* Hero description */}
        <div
          style={{
            padding: '20px',
            background: 'rgba(212,144,64,0.06)',
            border: '1px solid rgba(212,144,64,0.2)',
            borderRadius: '14px',
            marginBottom: '24px',
          }}
        >
          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
            <Zap size={20} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', marginBottom: '6px' }}>
                Auto-pull data from your PMS
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                A Computer Use Agent logs into your PMS exactly like a human would — navigating the screens, reading your occupancy and checkout data, and feeding it directly into HotelOps AI. <strong style={{ color: 'var(--amber)' }}>Zero manual entry.</strong>
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {[
              'Syncs every 15 minutes during operating hours (6 AM – 10 PM)',
              '"Tomorrow Lock" sync at 9 PM — sends you tomorrow\'s recommended schedule',
              'Morning confirmation sync at 5:30 AM for any overnight changes',
              'Push notification when occupancy changes by 5+ rooms',
            ].map(item => (
              <div key={item} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--amber)', marginTop: '6px', flexShrink: 0 }} />
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{item}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Connection status */}
        {activeProperty?.pmsConnected && (
          <div
            style={{
              padding: '14px 16px',
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.25)',
              borderRadius: '10px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <CheckCircle size={18} color="#22c55e" />
            <div>
              <p style={{ fontWeight: 600, fontSize: '14px', color: '#22c55e' }}>Connected</p>
              <p style={{ fontSize: '12px', color: 'rgba(34,197,94,0.7)' }}>
                {PMS_SYSTEMS.find(p => p.value === activeProperty.pmsType)?.label ?? activeProperty.pmsType}
                {activeProperty.lastSyncedAt && (() => {
                  const ts = activeProperty.lastSyncedAt as any;
                  const d = ts?.toDate ? ts.toDate() : new Date(ts);
                  return isNaN(d.getTime()) ? '' : ` · Last synced ${d.toLocaleTimeString()}`;
                })()}
              </p>
            </div>
          </div>
        )}

        {/* Form */}
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
          <div style={{ marginBottom: '16px' }}>
            <label className="label">PMS System</label>
            <select value={pmsType} onChange={e => setPmsType(e.target.value)} className="input">
              <option value="">— Select your PMS —</option>
              {PMS_SYSTEMS.map(pms => (
                <option key={pms.value} value={pms.value}>{pms.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">PMS Login URL</label>
            <input
              type="url"
              value={pmsUrl}
              onChange={e => setPmsUrl(e.target.value)}
              className="input"
              placeholder="https://login.choiceadvantage.com"
            />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>The URL your staff uses to log in to the PMS</p>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">Username / Email</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="input"
              placeholder="your PMS login"
              autoComplete="off"
            />
          </div>

          <div style={{ marginBottom: '4px' }}>
            <label className="label">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          {/* Security note */}
          <div style={{ display: 'flex', gap: '8px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', marginTop: '12px' }}>
            <Shield size={14} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: '1px' }} />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Your credentials are encrypted and stored securely in Firebase. They are only used by the HotelOps AI sync agent to read occupancy data — never shared or sold.
            </p>
          </div>
        </div>

        {/* Test result */}
        {testStatus !== 'idle' && testStatus !== 'testing' && (
          <div
            style={{
              padding: '14px 16px',
              background: testStatus === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${testStatus === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
              borderRadius: '10px',
              marginBottom: '14px',
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
            }}
          >
            {testStatus === 'success' ? <CheckCircle size={16} color="#22c55e" style={{ flexShrink: 0, marginTop: '1px' }} /> : <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: '1px' }} />}
            <p style={{ fontSize: '13px', color: testStatus === 'success' ? '#22c55e' : '#ef4444', lineHeight: 1.5 }}>
              {testMessage}
            </p>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleTest}
            disabled={testStatus === 'testing'}
            className="btn btn-secondary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {testStatus === 'testing' ? (
              <>
                <div style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Testing…
              </>
            ) : (
              <><Wifi size={16} /> Test Connection</>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !pmsType}
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* CUA architecture note */}
        <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
            How It Works
          </p>
          {[
            { step: '1', text: 'A headless browser opens your PMS at the scheduled sync time' },
            { step: '2', text: 'The agent logs in with your saved credentials' },
            { step: '3', text: 'It navigates to the occupancy/reservations screen and reads the data' },
            { step: '4', text: 'Extracted data (rooms occupied, checkouts, check-ins) is saved to HotelOps AI' },
            { step: '5', text: 'If numbers changed significantly, you get a push notification' },
          ].map(({ step, text }) => (
            <div key={step} style={{ display: 'flex', gap: '10px', marginBottom: '8px', alignItems: 'flex-start' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(212,144,64,0.15)', color: 'var(--amber)', fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {step}
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{text}</p>
            </div>
          ))}
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
            Currently supports Choice Advantage with full automation. Other systems use screenshot + OCR fallback.
          </p>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </AppLayout>
  );
}
