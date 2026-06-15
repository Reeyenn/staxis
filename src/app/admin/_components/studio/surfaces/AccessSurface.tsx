'use client';

/* ───────────────────────────────────────────────────────────────────────
   Admin Studio → Access surface.

   Per-hotel access control. Pick a hotel, then a grid of capabilities (rows,
   grouped) × the 5 hotel roles (columns). Every cell starts ON (everyone gets
   everything). Switch a cell OFF to restrict that capability for that role at
   THAT hotel — it writes an allowed=false override; switching back ON deletes
   it. Admin-only capabilities render as a locked "always you" row and can never
   be toggled. Capabilities whose per-hotel enforcement isn't live yet render as
   "manager default" (disabled) so a toggle is never shown that does nothing.

   All reads/writes go through /api/admin/access/* (admin-gated, service-role).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useLang } from '@/contexts/LanguageContext';
import { FONT_SANS, FONT_SERIF, FONT_MONO, Caps } from '../kit';

interface HotelLite { id: string; name: string | null }

interface CapMeta {
  key: string;
  adminOnly: boolean;
  live: boolean;
  group: string;
  label_en: string;
  label_es: string;
  desc_en: string;
  desc_es: string;
}
interface GroupMeta { key: string; label_en: string; label_es: string }
type OverrideMap = Record<string, Record<string, boolean>>;
interface Matrix {
  hotelRoles: string[];
  groups: GroupMeta[];
  capabilities: CapMeta[];
  overrides: OverrideMap;
}

const ROLE_COL_EN: Record<string, string> = {
  owner: 'Owner', general_manager: 'GM', front_desk: 'Front desk',
  housekeeping: 'Housekeeping', maintenance: 'Maintenance',
};
const ROLE_COL_ES: Record<string, string> = {
  owner: 'Dueño', general_manager: 'Gerente', front_desk: 'Recepción',
  housekeeping: 'Limpieza', maintenance: 'Mantenimiento',
};

export function AccessSurface() {
  const { lang } = useLang();
  const es = lang === 'es';
  const [hotels, setHotels] = useState<HotelLite[] | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  // Load the admin's hotels once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/admin/list-properties?pageSize=200&status=all');
        const json = await res.json();
        if (!alive) return;
        if (json.ok) {
          const list: HotelLite[] = (json.data.properties ?? []).map(
            (p: { id: string; name: string | null }) => ({ id: p.id, name: p.name }),
          );
          setHotels(list);
          setPid((cur) => cur ?? list[0]?.id ?? null);
        } else {
          setError(json.error || 'Could not load hotels');
        }
      } catch (e) {
        if (alive) setError(`Network error: ${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, []);

  const loadMatrix = useCallback(async (hotelId: string) => {
    setLoadingMatrix(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/admin/access/matrix?propertyId=${encodeURIComponent(hotelId)}`);
      const json = await res.json();
      if (json.ok) setMatrix(json.data as Matrix);
      else setError(json.error || 'Could not load access settings');
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoadingMatrix(false);
    }
  }, []);

  useEffect(() => { if (pid) void loadMatrix(pid); }, [pid, loadMatrix]);

  const isRestricted = (cap: string, role: string): boolean => matrix?.overrides?.[cap]?.[role] === false;

  async function setCell(cap: string, role: string, nextAllowed: boolean) {
    if (!pid || !matrix) return;
    const key = `${cap}:${role}`;
    // Optimistic local update.
    setMatrix((prev) => {
      if (!prev) return prev;
      const ov: OverrideMap = JSON.parse(JSON.stringify(prev.overrides ?? {}));
      if (nextAllowed) {
        if (ov[cap]) { delete ov[cap][role]; if (Object.keys(ov[cap]).length === 0) delete ov[cap]; }
      } else {
        ov[cap] = ov[cap] ?? {};
        ov[cap][role] = false;
      }
      return { ...prev, overrides: ov };
    });
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/access/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: pid, capability: cap, role, allowed: nextAllowed }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Save failed');
      setSavedKey(key);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1200);
    } catch (e) {
      setError(`Couldn't save — ${(e as Error).message}`);
      await loadMatrix(pid); // revert to server truth
    } finally {
      setSavingKey((k) => (k === key ? null : k));
    }
  }

  async function applyToAll() {
    if (!pid) return;
    setApplying(true);
    setApplyNote(null);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/access/apply-to-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: pid }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Apply failed');
      setApplyNote(es ? `Aplicado a ${json.data.hotelsUpdated} hotel(es).` : `Applied to ${json.data.hotelsUpdated} hotel(s).`);
      setTimeout(() => setApplyNote(null), 4000);
    } catch (e) {
      setError(`Couldn't apply — ${(e as Error).message}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', fontFamily: FONT_SANS, color: '#fff', maxWidth: 1180, margin: '0 auto' }}>
      {/* Title + hotel picker */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 6 }}>
        <div>
          <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 30, lineHeight: 1.1 }}>
            {es ? 'Acceso por hotel' : 'Per-hotel access'}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,.55)', marginTop: 6, maxWidth: 640 }}>
            {es
              ? 'Cada rol ve todo por defecto. Apaga lo que un rol NO debe ver en este hotel.'
              : 'Every role sees everything by default. Switch OFF what a role should NOT reach at this hotel.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Caps size={9} c="rgba(255,255,255,.5)">{es ? 'Hotel' : 'Hotel'}</Caps>
          <select
            value={pid ?? ''}
            onChange={(e) => setPid(e.target.value)}
            disabled={!hotels}
            style={{
              background: 'rgba(255,255,255,.07)', color: '#fff', border: '1px solid rgba(255,255,255,.18)',
              borderRadius: 10, padding: '8px 12px', fontFamily: FONT_SANS, fontSize: 14, minWidth: 220, cursor: 'pointer',
            }}
          >
            {(hotels ?? []).map((h) => (
              <option key={h.id} value={h.id} style={{ color: '#111' }}>{h.name || h.id.slice(0, 8)}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)', borderRadius: 12, color: 'var(--terracotta)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {loadingMatrix || !matrix ? (
        <div style={{ padding: '70px 0', textAlign: 'center', color: 'rgba(255,255,255,.5)', fontFamily: FONT_MONO, fontSize: 13 }}>
          {es ? 'Cargando…' : 'Loading…'}
        </div>
      ) : (
        <>
          {/* Grid */}
          <div style={{ marginTop: 20, border: '1px solid rgba(255,255,255,.10)', borderRadius: 16, overflow: 'hidden' }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: `minmax(220px, 1.6fr) repeat(${matrix.hotelRoles.length}, 1fr)`, background: 'rgba(255,255,255,.04)', borderBottom: '1px solid rgba(255,255,255,.10)' }}>
              <div style={{ padding: '12px 16px' }}><Caps size={9} c="rgba(255,255,255,.5)">{es ? 'Capacidad' : 'Capability'}</Caps></div>
              {matrix.hotelRoles.map((r) => (
                <div key={r} style={{ padding: '12px 8px', textAlign: 'center' }}>
                  <Caps size={9} c="rgba(255,255,255,.6)">{(es ? ROLE_COL_ES : ROLE_COL_EN)[r] ?? r}</Caps>
                </div>
              ))}
            </div>

            {matrix.groups.map((g) => {
              const caps = matrix.capabilities.filter((c) => c.group === g.key);
              if (caps.length === 0) return null;
              return (
                <div key={g.key}>
                  <div style={{ padding: '9px 16px', background: 'rgba(255,255,255,.02)', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
                    <Caps size={9} c="var(--gold)">{es ? g.label_es : g.label_en}</Caps>
                  </div>
                  {caps.map((c) => (
                    <CapRow
                      key={c.key}
                      cap={c}
                      es={es}
                      roles={matrix.hotelRoles}
                      isRestricted={isRestricted}
                      savingKey={savingKey}
                      savedKey={savedKey}
                      onToggle={setCell}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          {/* Apply-to-all */}
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <button
              onClick={() => void applyToAll()}
              disabled={applying || !pid}
              style={{
                background: 'rgba(255,255,255,.08)', color: '#fff', border: '1px solid rgba(255,255,255,.2)',
                borderRadius: 10, padding: '9px 16px', fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                cursor: applying ? 'default' : 'pointer', opacity: applying ? 0.6 : 1,
              }}
            >
              {applying ? (es ? 'Aplicando…' : 'Applying…') : (es ? 'Aplicar esta configuración a todos los hoteles' : "Apply this hotel's setup to all hotels")}
            </button>
            {applyNote && <span style={{ fontSize: 13, color: 'var(--forest)' }}>{applyNote}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function CapRow({
  cap, es, roles, isRestricted, savingKey, savedKey, onToggle,
}: {
  cap: CapMeta;
  es: boolean;
  roles: string[];
  isRestricted: (cap: string, role: string) => boolean;
  savingKey: string | null;
  savedKey: string | null;
  onToggle: (cap: string, role: string, nextAllowed: boolean) => void;
}) {
  const label = es ? cap.label_es : cap.label_en;
  const desc = es ? cap.desc_es : cap.desc_en;

  // Admin-only: a single locked row spanning all role columns.
  if (cap.adminOnly) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `minmax(220px, 1.6fr) 1fr`, borderBottom: '1px solid rgba(255,255,255,.06)', background: 'rgba(255,255,255,.015)' }}>
        <CapLabel label={label} desc={desc} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', color: 'rgba(255,255,255,.45)', fontSize: 12 }}>
          <Lock size={13} />
          {es ? 'Solo administrador — siempre tú' : 'Admin only — always you'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `minmax(220px, 1.6fr) repeat(${roles.length}, 1fr)`, borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'stretch' }}>
      <CapLabel label={label} desc={desc} pending={!cap.live} es={es} />
      {roles.map((role) => {
        const key = `${cap.key}:${role}`;
        const restricted = isRestricted(cap.key, role);
        const allowed = !restricted;
        const saving = savingKey === key;
        const saved = savedKey === key;
        return (
          <div key={role} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 8px' }}>
            <Toggle
              allowed={allowed}
              disabled={!cap.live || saving}
              saving={saving}
              saved={saved}
              onClick={() => onToggle(cap.key, role, restricted /* next = allow if currently restricted */)}
              title={
                !cap.live
                  ? (es ? 'Predeterminado para gerentes' : 'Manager default')
                  : allowed
                    ? (es ? 'Permitido — clic para restringir' : 'Allowed — click to restrict')
                    : (es ? 'Restringido — clic para permitir' : 'Restricted — click to allow')
              }
            />
          </div>
        );
      })}
    </div>
  );
}

function CapLabel({ label, desc, pending, es }: { label: string; desc: string; pending?: boolean; es?: boolean }) {
  return (
    <div style={{ padding: '11px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
        {label}
        {pending && (
          <span style={{ fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,.4)', border: '1px solid rgba(255,255,255,.18)', borderRadius: 5, padding: '1px 5px' }}>
            {es ? 'Predet. gerente' : 'Manager default'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.45)', marginTop: 2 }}>{desc}</div>
    </div>
  );
}

function Toggle({ allowed, disabled, saving, saved, onClick, title }: {
  allowed: boolean; disabled?: boolean; saving?: boolean; saved?: boolean; onClick: () => void; title: string;
}) {
  const base: React.CSSProperties = {
    width: 38, height: 22, borderRadius: 999, position: 'relative', cursor: disabled ? 'default' : 'pointer',
    border: '1px solid', transition: 'background .15s, border-color .15s, opacity .15s',
    display: 'inline-flex', alignItems: 'center', padding: 2,
  };
  const on: React.CSSProperties = { background: 'var(--forest)', borderColor: 'var(--forest)' };
  const off: React.CSSProperties = { background: 'rgba(255,255,255,.10)', borderColor: 'rgba(255,255,255,.22)' };
  const knob: React.CSSProperties = {
    width: 16, height: 16, borderRadius: '50%', background: '#fff',
    transform: allowed ? 'translateX(16px)' : 'translateX(0)', transition: 'transform .15s',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-pressed={allowed}
      disabled={disabled}
      style={{ ...base, ...(allowed ? on : off), opacity: disabled ? 0.4 : (saving ? 0.7 : 1) }}
    >
      <span style={knob}>{saved && allowed ? <Check size={10} color="var(--forest)" /> : null}</span>
    </button>
  );
}
