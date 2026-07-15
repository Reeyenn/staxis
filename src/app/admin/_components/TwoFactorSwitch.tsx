'use client';

/**
 * Compact global 2FA master switch — reads/writes /api/admin/settings.
 * Sits inline in the admin Live-hotels controls row, to the left of the
 * hotel search box. OFF disables ALL human Staxis 2FA fleet-wide (signup,
 * new-device login, admin panel, phone handoff); the PMS/CUA robot MFA is
 * unaffected. Default/fail-safe is ON. A confirm dialog gates turning it OFF.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';

export function TwoFactorSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/admin/settings');
        const json = await res.json();
        if (alive && json?.data && typeof json.data.twoFactorEnabled === 'boolean') {
          setEnabled(json.data.twoFactorEnabled);
        } else if (alive) {
          setErr('load failed');
        }
      } catch {
        if (alive) setErr('load failed');
      }
    })();
    return () => { alive = false; };
  }, []);

  const apply = async (next: boolean) => {
    if (next === false) {
      const okConfirm = window.confirm(
        'Turn OFF two-factor for EVERY human login?\n\n'
        + 'Signup, password login on a new device, the admin panel, and phone handoff '
        + 'will all skip the security code until you turn this back on.\n\n'
        + 'The hotel PMS robot is unaffected.',
      );
      if (!okConfirm) return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ twoFactorEnabled: next }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok || !json?.data) {
        throw new Error(json?.error ?? `save failed (${res.status})`);
      }
      setEnabled(json.data.twoFactorEnabled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const on = enabled === true;
  const disabled = enabled === null || saving;

  const label = enabled === null ? '2FA' : on ? '2FA on' : '2FA off';
  const title = enabled === null
    ? 'Two-factor authentication'
    : on
      ? 'Two-factor is ON. Click to turn OFF for all human logins (not the PMS robot).'
      : 'Two-factor is OFF for all human logins. Click to turn back ON.';

  return (
    <div
      title={err ? `2FA setting: ${err}` : title}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        padding: '6px 10px 6px 12px', borderRadius: 999,
        border: `1px solid ${on ? 'rgba(255,255,255,0.14)' : 'rgba(224,120,91,0.5)'}`,
        background: 'rgba(255,255,255,0.04)',
      }}
    >
      <span style={{
        fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap',
        color: on ? 'rgba(255,255,255,0.82)' : 'var(--terracotta, #E0785B)',
        fontFamily: 'var(--sans)',
      }}>
        {err ? '2FA —' : label}
      </span>
      <button
        type="button"
        onClick={() => void apply(!on)}
        disabled={disabled}
        aria-pressed={on}
        aria-label={on ? 'Turn 2FA off' : 'Turn 2FA on'}
        style={{
          flexShrink: 0, width: 40, height: 23, borderRadius: 999, border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer', position: 'relative',
          background: on ? 'var(--forest, #2E6E4E)' : 'rgba(255,255,255,0.22)',
          opacity: disabled ? 0.55 : 1, transition: 'background .18s ease',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: on ? 20 : 3, width: 17, height: 17,
          borderRadius: '50%', background: '#fff',
          transition: 'left .18s ease', boxShadow: '0 1px 2px rgba(0,0,0,.35)',
        }} />
      </button>
    </div>
  );
}
