'use client';

// ─── AiActivityButton — manager-only "AI activity" review pop-up ─────────────
//
// A small, unobtrusive corner button on the authenticated app shell. Tapping it
// opens a CENTERED overlay (portal, above everything) listing every action the
// AI actually did on the active property — approved & done, denied, expired, or
// failed — newest first, grouped by day. Manager-tier only (admin / owner /
// general_manager, via canManageTeam); hidden for everyone else and for admins
// with no active property.
//
// Reads GET /api/agent/activity through fetchWithAuth (the table is deny-all
// RLS; the route uses supabaseAdmin + a manager check). Paginates 50 at a time
// via a "Load more" button. Bilingual (useLang). Snow design tokens + the shared
// staxis-fade-in / staxis-pop-in keyframes, matching ApprovalOverlay's card
// language so the two AI surfaces feel like one system.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Check, Ban, Clock, AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { canManageTeam } from '@/lib/roles';
import { groupByDay, ACTIVITY_PAGE_SIZE, type ActivityItem, type ActivityOutcome } from '@/lib/agent/activity-view';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
  warm:     'var(--snow-warm, #B85C3D)',
};
const FONT_SANS = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";
const PAGE_SIZE = ACTIVITY_PAGE_SIZE;

// ── Outcome → bilingual label + color role (matches existing status badges) ──
interface OutcomeStyle {
  en: string;
  es: string;
  fg: string;
  bg: string;
  Icon: typeof Check;
}
const OUTCOME: Record<ActivityOutcome, OutcomeStyle> = {
  done:    { en: 'Approved & done', es: 'Aprobado y hecho', fg: C.sageDeep, bg: 'rgba(92, 122, 96, 0.12)', Icon: Check },
  denied:  { en: 'Denied',          es: 'Rechazado',        fg: C.ink3,     bg: C.ruleSoft,                Icon: Ban },
  expired: { en: 'Expired',         es: 'Expiró',           fg: C.ink3,     bg: C.ruleSoft,                Icon: Clock },
  failed:  { en: 'Failed',          es: 'Falló',            fg: C.warm,     bg: 'rgba(184, 92, 61, 0.10)', Icon: AlertTriangle },
  pending: { en: 'Pending',         es: 'Pendiente',        fg: C.ink2,     bg: C.ruleSoft,                Icon: Clock },
};

export function AiActivityButton({ placement = 'floating' }: { placement?: 'floating' | 'inline' }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Manager-tier only, and only with an active property to scope the feed to.
  const canSee = !!user && canManageTeam(user.role) && !!activePropertyId;

  return (
    <>
      {canSee && !open && (
        <button
          onClick={() => setOpen(true)}
          aria-label={es ? 'Actividad de la IA' : 'AI activity'}
          title={es ? 'Actividad de la IA' : 'AI activity'}
          style={{
            position: placement === 'floating' ? 'fixed' : 'relative',
            // Sits ABOVE the bottom-center Ask bar (~46px tall, bottom:22px +
            // safe-area) and clear of the feedback FAB (48px, bottom:20px), so
            // it never overlaps either on phone or desktop.
            bottom: placement === 'floating'
              ? 'calc(84px + var(--staff-bottom-nav-height, 0px) + env(safe-area-inset-bottom, 0px))'
              : 'auto',
            right: placement === 'floating' ? '20px' : 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            minHeight: '44px',
            padding: placement === 'floating' ? '8px 13px' : '8px 12px',
            borderRadius: '12px',
            background: C.bg,
            color: C.ink2,
            border: `1px solid ${C.rule}`,
            cursor: 'pointer',
            fontFamily: FONT_SANS,
            fontSize: '12.5px',
            fontWeight: 600,
            boxShadow: placement === 'floating' ? '0 6px 18px -8px rgba(20, 30, 20, 0.28)' : 'none',
            zIndex: placement === 'floating' ? 90 : 'auto',
          }}
        >
          <Sparkles size={14} strokeWidth={2.2} color={C.sageDeep} />
          <span>{es ? 'Actividad de la IA' : 'AI activity'}</span>
        </button>
      )}

      {mounted && open && activePropertyId && createPortal(
        <ActivityOverlay
          propertyId={activePropertyId}
          onClose={() => setOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}

// ─── The centered review overlay ────────────────────────────────────────────
function ActivityOverlay({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const { lang } = useLang();
  const es = lang === 'es';
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards a stale-property response landing after a fast close/reopen.
  const reqSeq = useRef(0);

  const load = useCallback(async (offset: number) => {
    const seq = ++reqSeq.current;
    if (offset === 0) { setLoading(true); setError(null); }
    else setLoadingMore(true);
    try {
      const res = await fetchWithAuth(
        `/api/agent/activity?pid=${encodeURIComponent(propertyId)}&limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const json = await res.json().catch(() => null);
      if (seq !== reqSeq.current) return; // superseded
      if (!res.ok || !json?.ok) {
        setError(es ? 'No se pudo cargar la actividad.' : 'Could not load activity.');
        return;
      }
      const page = json.data as { items: ActivityItem[]; hasMore: boolean };
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
      setHasMore(page.hasMore);
    } catch {
      if (seq === reqSeq.current) {
        setError(es ? 'No se pudo cargar la actividad.' : 'Could not load activity.');
      }
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [propertyId, es]);

  useEffect(() => { void load(0); }, [load]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = groupByDay(items, lang);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        background: 'rgba(20, 24, 20, 0.42)',
        backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
        animation: 'staxis-fade-in 0.18s ease-out',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={es ? 'Actividad de la IA' : 'AI activity'}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 94vw)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.bg,
          border: `1px solid ${C.rule}`,
          borderRadius: 18,
          boxShadow: '0 24px 60px -20px rgba(20, 30, 20, 0.35), 0 4px 12px -6px rgba(20, 30, 20, 0.2)',
          fontFamily: FONT_SANS,
          animation: 'staxis-pop-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 18px', borderBottom: `1px solid ${C.rule}`,
        }}>
          <Sparkles size={17} strokeWidth={2.2} color={C.sageDeep} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>
              {es ? 'Actividad de la IA' : 'AI activity'}
            </div>
            <div style={{ fontSize: 12, color: C.ink3, marginTop: 1 }}>
              {es ? 'Lo que el asistente hizo en esta propiedad' : 'What the assistant did on this property'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={es ? 'Cerrar' : 'Close'}
            style={{
              background: 'transparent', border: 'none', color: C.ink3,
              cursor: 'pointer', display: 'flex', padding: 4, borderRadius: 8,
            }}
          >
            <X size={18} strokeWidth={2.2} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 18px' }}>
          {loading ? (
            <Centered><Loader2 size={22} className="staxis-spin" color={C.ink3} /></Centered>
          ) : error ? (
            <Centered>
              <div style={{ textAlign: 'center', color: C.ink2, fontSize: 13.5 }}>
                {error}
                <div style={{ marginTop: 10 }}>
                  <button style={retryBtn} onClick={() => void load(0)}>
                    {es ? 'Reintentar' : 'Try again'}
                  </button>
                </div>
              </div>
            </Centered>
          ) : items.length === 0 ? (
            <Centered>
              <div style={{ textAlign: 'center', color: C.ink3, fontSize: 13.5, lineHeight: 1.5 }}>
                {es
                  ? 'Todavía no hay actividad de la IA en esta propiedad.'
                  : 'No AI activity on this property yet.'}
              </div>
            </Centered>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.key} style={{ marginTop: 14 }}>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: C.ink3, marginBottom: 8,
                    position: 'sticky', top: 0, background: C.bg, paddingTop: 2, paddingBottom: 2,
                  }}>
                    {g.label}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {g.items.map((it) => <Row key={it.id} item={it} es={es} />)}
                  </div>
                </div>
              ))}

              {hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                  <button
                    style={loadMoreBtn}
                    disabled={loadingMore}
                    onClick={() => void load(items.length)}
                  >
                    {loadingMore
                      ? (es ? 'Cargando…' : 'Loading…')
                      : (es ? 'Cargar más' : 'Load more')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── One activity row ───────────────────────────────────────────────────────
function Row({ item, es }: { item: ActivityItem; es: boolean }) {
  const style = OUTCOME[item.outcome];
  const summary = es ? (item.summary.es || item.summary.en) : (item.summary.en || item.summary.es);
  const Icon = style.Icon;
  return (
    <div style={{
      border: `1px solid ${C.rule}`, borderRadius: 12, padding: '11px 13px',
      background: C.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, lineHeight: 1.45, color: C.ink, wordBreak: 'break-word' }}>
            {summary}
          </div>
          <div style={{ fontSize: 11.5, color: C.ink3, marginTop: 4 }}>
            {formatTime(item.createdAt, es)}
            {item.who ? <> · {es ? 'pedido por' : 'asked by'} {item.who}</> : null}
          </div>
        </div>
        <span style={{
          flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 8px', borderRadius: 999,
          background: style.bg, color: style.fg,
          fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          <Icon size={11} strokeWidth={2.6} />
          {es ? style.es : style.en}
        </span>
      </div>
      {item.outcome === 'failed' && item.error && (
        <div style={{
          marginTop: 8, fontSize: 12, color: C.warm, lineHeight: 1.4,
          background: 'rgba(184, 92, 61, 0.07)', border: '1px solid rgba(184, 92, 61, 0.18)',
          borderRadius: 8, padding: '6px 9px', wordBreak: 'break-word',
        }}>
          {item.error}
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {children}
    </div>
  );
}

// ─── Time formatting ────────────────────────────────────────────────────────
function formatTime(iso: string, es: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(es ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' });
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const loadMoreBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: '8px 16px', borderRadius: 10, fontFamily: FONT_SANS,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: C.ruleSoft, color: C.ink2, border: `1px solid ${C.rule}`,
};
const retryBtn: React.CSSProperties = { ...loadMoreBtn };
