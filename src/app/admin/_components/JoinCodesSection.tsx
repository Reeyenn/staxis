'use client';

/**
 * Phase M1.2 (2026-05-14) — Join codes section on /admin/properties/[id].
 *
 * Lets the admin (Reeyen) mint, view, and revoke join codes for any
 * hotel without leaving the per-property triage view. Uses the existing
 * /api/auth/join-codes endpoints (GET / POST / DELETE) — `canManageHotel`
 * already grants admins blanket access regardless of property_access.
 *
 * Two code types in this UI:
 *   - "owner" codes (single-use, role baked in) — minted by the
 *     create-hotel modal; rare to mint another after that.
 *   - staff codes (role chosen by recipient at signup, max_uses=100)
 *     — minted via the "Mint staff code" button here. Owners typically
 *     do this themselves in their settings, but admins need a way to
 *     mint one when supporting a hotel.
 *
 * The existing /api/auth/join-codes POST always mints a staff-style
 * code (role=null, max_uses=100). To mint another owner code we'd need
 * a separate endpoint — out of scope for v1; admin can re-create the
 * hotel or mint via SQL if needed (rare).
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Copy, Check, X, KeyRound, AlertCircle } from 'lucide-react';

interface JoinCodeRow {
  id: string;
  code: string;
  role: string | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  created_at: string;
  revoked_at: string | null;
}

interface Props {
  propertyId: string;
}

export function JoinCodesSection({ propertyId }: Props) {
  const [codes, setCodes] = useState<JoinCodeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/auth/join-codes?hotelId=${propertyId}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Failed to load (status ${res.status})`);
        setCodes([]);
        return;
      }
      setCodes((json.data?.codes ?? []) as JoinCodeRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setCodes([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [propertyId]);

  const mintStaffCode = async () => {
    setMinting(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotelId: propertyId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Failed to mint (status ${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this code? Anyone holding it will get an error on signup.')) return;
    setRevoking(id);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/auth/join-codes?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Failed to revoke (status ${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRevoking(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  const activeCodes = (codes ?? []).filter((c) => !c.revoked_at);

  return (
    <section style={{
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '12px',
      padding: '16px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '12px',
      }}>
        <h3 style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '14px', fontWeight: 700,
        }}>
          <KeyRound size={14} color="var(--amber)" />
          Join codes
        </h3>
        <button
          onClick={mintStaffCode}
          className="btn btn-secondary"
          style={{ padding: '4px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
          disabled={minting}
        >
          <Plus size={12} />
          {minting ? 'Minting…' : 'Mint staff code'}
        </button>
      </div>

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '8px 10px', marginBottom: '10px',
          background: 'var(--red-dim, rgba(239,68,68,0.1))', borderRadius: '6px',
          color: 'var(--red)', fontSize: '12px',
        }}>
          <AlertCircle size={12} />
          {error}
        </div>
      )}

      {loading && codes === null ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          Loading codes…
        </div>
      ) : activeCodes.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          No active codes. Mint one to invite staff.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {activeCodes.map((c) => {
            const expired = new Date(c.expires_at).getTime() <= Date.now();
            const usedUp = c.used_count >= c.max_uses;
            return (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '10px 12px',
                  background: 'var(--surface-secondary, var(--bg))',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  opacity: expired || usedUp ? 0.55 : 1,
                }}
              >
                <code style={{
                  fontFamily: 'var(--font-mono)', fontSize: '13px',
                  letterSpacing: '0.05em', fontWeight: 600,
                }}>
                  {c.code}
                </code>
                <div style={{ flex: 1, minWidth: 0, fontSize: '11px', color: 'var(--text-muted)' }}>
                  {c.role ? `${c.role} · ` : 'staff-pickable · '}
                  {c.used_count}/{c.max_uses} used ·{' '}
                  {expired ? 'EXPIRED' : usedUp ? 'USED UP' : `expires ${formatExpiry(c.expires_at)}`}
                </div>
                <button
                  onClick={() => copy(c.code)}
                  className="btn btn-ghost"
                  style={{ padding: '4px' }}
                  title="Copy code"
                >
                  {copied === c.code ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
                </button>
                <button
                  onClick={() => revoke(c.id)}
                  className="btn btn-ghost"
                  style={{ padding: '4px' }}
                  title="Revoke"
                  disabled={revoking === c.id}
                >
                  <X size={12} color="var(--red)" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px', lineHeight: 1.4 }}>
        Staff codes accept up to 100 signups in 7 days. Recipients pick their own role
        (front_desk / housekeeping / maintenance) at signup. To mint an owner-only code,
        use the "+ New" hotel flow which always pairs a hotel with one owner code.
      </p>
    </section>
  );
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}
