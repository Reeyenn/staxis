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

import React, { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Copy, Check, X, KeyRound, AlertCircle } from 'lucide-react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Btn } from './_snow';

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

  const load = useCallback(async () => {
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
  }, [propertyId]);

  useEffect(() => { void load(); }, [load]);

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
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 18,
      padding: 20,
      fontFamily: FONT_SANS,
    }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        marginBottom: 14, gap: 12,
      }}>
        <div>
          <Caps>Codes</Caps>
          <h3 style={{
            fontFamily: FONT_SERIF, fontSize: 22, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
            lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <KeyRound size={16} color={T.caramelDeep} />
            Join <span style={{ fontStyle: 'italic' }}>codes</span>
          </h3>
        </div>
        <Btn variant="ghost" size="sm" onClick={mintStaffCode} disabled={minting}>
          <Plus size={12} />
          {minting ? 'Minting…' : 'Mint staff code'}
        </Btn>
      </div>

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', marginBottom: 12,
          background: T.warmDim, borderRadius: 10,
          border: `1px solid rgba(184,92,61,0.25)`,
          color: T.warm, fontSize: 12,
        }}>
          <AlertCircle size={12} />
          {error}
        </div>
      )}

      {loading && codes === null ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: T.ink2, fontSize: 12.5,
          fontStyle: 'italic', fontFamily: FONT_SERIF,
        }}>
          Loading codes…
        </div>
      ) : activeCodes.length === 0 ? (
        <div style={{
          padding: '24px 20px', textAlign: 'center',
          background: T.ruleSoft, border: `1px dashed ${T.rule}`, borderRadius: 14,
          color: T.ink2, fontSize: 12.5,
          fontStyle: 'italic', fontFamily: FONT_SERIF,
        }}>
          No active codes. Mint one to invite staff.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeCodes.map((c) => {
            const expired = new Date(c.expires_at).getTime() <= Date.now();
            const usedUp = c.used_count >= c.max_uses;
            return (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 14px',
                  background: T.ruleSoft,
                  border: `1px solid ${T.rule}`,
                  borderRadius: 12,
                  opacity: expired || usedUp ? 0.55 : 1,
                }}
              >
                <code style={{
                  fontFamily: FONT_MONO, fontSize: 13.5,
                  letterSpacing: '0.06em', fontWeight: 600, color: T.ink,
                }}>
                  {c.code}
                </code>
                <div style={{ flex: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, letterSpacing: '0.04em' }}>
                  {c.role ? `${c.role} · ` : 'staff-pickable · '}
                  {c.used_count}/{c.max_uses} used ·{' '}
                  {expired ? 'EXPIRED' : usedUp ? 'USED UP' : `expires ${formatExpiry(c.expires_at)}`}
                </div>
                <button
                  onClick={() => copy(c.code)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}
                  title="Copy code"
                >
                  {copied === c.code ? <Check size={12} color={T.sageDeep} /> : <Copy size={12} color={T.ink3} />}
                </button>
                <button
                  onClick={() => revoke(c.id)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}
                  title="Revoke"
                  disabled={revoking === c.id}
                >
                  <X size={12} color={T.warm} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: T.ink3, marginTop: 12, lineHeight: 1.5, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
        Staff codes accept up to 100 signups in 7 days. Recipients pick their own role
        (front_desk / housekeeping / maintenance) at signup. To mint an owner-only code,
        use the &ldquo;+ New&rdquo; hotel flow which always pairs a hotel with one owner code.
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
