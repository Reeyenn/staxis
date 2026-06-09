'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/pms-inbox — PMS Okta inbox viewer (migrations 0274 + 0275).
 *
 * Two views, both fed by /api/admin/pms-inbox (the only read path — the inbox
 * tables are service-role-only):
 *   - Full messages: the complete inbound emails per hotel, so the onboarding
 *     admin can click the Okta account-SETUP link ("set your password" / enroll
 *     MFA) right here. The raw email HTML is never rendered — the body is shown
 *     as escaped plain text and only scheme-validated http(s) links are clickable.
 *   - Auth codes: last N Okta 2FA codes the robot received, MASKED server-side
 *     (last 2 digits only; the full code never reaches the browser).
 *
 * Styling: dark "studio" admin look (var(--ink) canvas + dim() white-alpha
 * cards + gold/forest accents), wrapped in .admin-studio so the studio CSS
 * vars (--ink/--gold/--forest/--serif/--mono) resolve.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { ChevronLeft, RefreshCw, ShieldCheck, Mail, ExternalLink } from 'lucide-react';
import { FONT_SERIF, FONT_MONO, Caps, Pill, Btn } from '@/app/admin/_components/studio/kit';

const dim = (a: number) => `rgba(255,255,255,${a})`;

interface CodeRow {
  id: string;
  propertyId: string;
  emailTo: string;
  source: string;
  codeMasked: string;
  sender: string | null;
  subject: string | null;
  receivedAt: string;
  consumedAt: string | null;
}

interface LinkItem {
  href: string;
  label: string;
}

interface MessageRow {
  id: string;
  propertyId: string;
  emailTo: string;
  fromAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  links: LinkItem[];
  receivedAt: string;
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function DarkPage({ children }: { children: React.ReactNode }) {
  return (
    <AppLayout>
      <div
        className="admin-studio"
        style={{
          background: 'var(--ink)',
          color: '#fff',
          // Full-bleed below the 64px global nav, matching the studio canvas.
          marginLeft: 'calc(50% - 50vw)',
          marginRight: 'calc(50% - 50vw)',
          minHeight: 'calc(100vh - 64px)',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 70% at 100% 0%, rgba(60,156,104,.12), transparent 55%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 1080, margin: '0 auto', padding: '24px 28px 56px' }}>
          {children}
        </div>
      </div>
    </AppLayout>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: '24px 16px', textAlign: 'center', border: `1px dashed ${dim(.16)}`, borderRadius: 12, color: dim(.42), fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13.5 }}>
      {text}
    </div>
  );
}

function SectionHead({ eyebrow, eyebrowColor, icon, title, sub }: { eyebrow: string; eyebrowColor: string; icon: React.ReactNode; title: React.ReactNode; sub: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Caps style={{ color: eyebrowColor }}>{eyebrow}</Caps>
      <h2 style={{ fontFamily: FONT_SERIF, fontSize: 22, fontWeight: 400, letterSpacing: '-0.01em', margin: '3px 0 5px', color: '#fff', display: 'flex', alignItems: 'center', gap: 9 }}>
        {icon} {title}
      </h2>
      <p style={{ fontSize: 12.5, color: dim(.5), margin: 0, lineHeight: 1.55, maxWidth: 640 }}>{sub}</p>
    </div>
  );
}

export default function PmsInboxPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/pms-inbox');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Request failed (${res.status})`);
        setLoading(false);
        return;
      }
      setRows(json.data.codes as CodeRow[]);
      setMessages((json.data.messages as MessageRow[]) ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [user, load]);

  if (authLoading) return <DarkPage><div style={{ color: dim(.6), padding: 40, fontFamily: FONT_SERIF, fontStyle: 'italic' }}>Loading…</div></DarkPage>;
  if (!user) return <DarkPage><div style={{ color: dim(.6), padding: 40 }}>Not signed in</div></DarkPage>;

  // Group full messages by hotel inbox (emailTo is 1:1 with property).
  const byInbox = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = byInbox.get(m.emailTo) ?? [];
    list.push(m);
    byInbox.set(m.emailTo, list);
  }

  return (
    <DarkPage>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <Link href="/admin" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: dim(.5), textDecoration: 'none', marginBottom: 14 }}>
        <ChevronLeft size={14} /> Admin
      </Link>

      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
        <div>
          <Caps style={{ color: dim(.5) }}>Onboarding · Auth inbox</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', display: 'flex', alignItems: 'center', gap: 11 }}>
            <ShieldCheck size={26} style={{ color: 'var(--forest)' }} /> The hotel <span style={{ fontStyle: 'italic' }}>login mailbox</span>
          </h1>
          <p style={{ fontSize: 13.5, color: dim(.55), margin: '9px 0 0', maxWidth: 640, lineHeight: 1.55 }}>
            Each hotel&apos;s robot signs in as <span style={{ fontFamily: FONT_MONO, color: dim(.8) }}>…@getstaxis.com</span>. Finish setup by clicking the Okta link below — after that the robot reads its own 2FA codes. Nothing here ever leaves Staxis.
          </p>
        </div>
        <Btn variant="ghost" size="lg" onClick={() => void load()} style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>
          <RefreshCw size={14} style={{ marginRight: 6 }} className={loading ? 'animate-spin' : undefined} /> Refresh
        </Btn>
      </header>

      {error && (
        <div style={{ marginBottom: 22, borderRadius: 12, border: '1px solid rgba(194,86,46,.42)', background: 'rgba(194,86,46,.10)', padding: '11px 14px', fontSize: 13, color: '#f0b8a6' }}>
          {error}
        </div>
      )}

      {/* ── Step 1: human setup (the clickable Okta link) ────────────────── */}
      <SectionHead
        eyebrow="Step 1 · Your action"
        eyebrowColor="var(--gold)"
        icon={<Mail size={19} style={{ color: 'var(--gold)' }} />}
        title="Set up the login"
        sub="Click the Okta link to set the password & turn on email 2FA. The full URL is shown so you can verify the destination first; the email's own formatting is stripped for safety."
      />

      {byInbox.size === 0 && !loading && !error ? (
        <Empty text="No setup emails yet — the Okta email lands here the moment it's sent." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 38 }}>
          {[...byInbox.entries()].map(([inbox, msgs]) => (
            <div key={inbox} style={{ background: dim(.04), border: `1px solid ${dim(.12)}`, borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ padding: '9px 16px', borderBottom: `1px solid ${dim(.08)}`, fontFamily: FONT_MONO, fontSize: 11.5, color: dim(.6), letterSpacing: '.03em', background: dim(.03) }}>
                {inbox}
              </div>
              {msgs.map((m, idx) => (
                <div key={m.id} style={{ padding: '15px 16px', borderTop: idx ? `1px solid ${dim(.07)}` : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', wordBreak: 'break-word' }}>{m.subject || '(no subject)'}</div>
                      <div style={{ fontSize: 11.5, color: dim(.45), marginTop: 2 }}>from {m.fromAddr || '—'}</div>
                    </div>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dim(.4), whiteSpace: 'nowrap' }} title={m.receivedAt}>{ago(m.receivedAt)}</span>
                  </div>

                  {m.links.length > 0 && (
                    <div style={{ marginTop: 12, borderRadius: 11, border: '1px solid rgba(208,158,79,.30)', background: 'rgba(208,158,79,.07)', padding: '12px 14px' }}>
                      <Caps style={{ color: 'var(--gold)', display: 'block', marginBottom: 9 }}>Click to continue</Caps>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                        {m.links.map((lk, i) => (
                          <a key={i} href={lk.href} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textDecoration: 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--gold)', fontSize: 13.5, fontWeight: 600 }}>
                              <ExternalLink size={13} /> {lk.label && lk.label !== lk.href ? lk.label : 'Open link'}
                            </div>
                            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dim(.45), marginLeft: 20, wordBreak: 'break-all' }}>{lk.href}</div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.bodyText && (
                    <details style={{ marginTop: 11 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, color: dim(.5), userSelect: 'none' }}>Show full email</summary>
                      <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: FONT_MONO, fontSize: 11.5, color: dim(.58), background: dim(.03), border: `1px solid ${dim(.08)}`, borderRadius: 10, padding: '10px 12px', maxHeight: 280, overflow: 'auto' }}>{m.bodyText}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ── Step 2: robot-read 2FA codes (masked) ────────────────────────── */}
      <SectionHead
        eyebrow="Step 2 · Automatic"
        eyebrowColor="var(--forest)"
        icon={<ShieldCheck size={19} style={{ color: 'var(--forest)' }} />}
        title="2FA codes the robot caught"
        sub="Okta login codes the robot received — masked to the last 2 digits. The full code never leaves the server; the robot uses it to log itself in."
      />

      {rows.length === 0 && !loading && !error ? (
        <Empty text="No codes yet — they appear the moment the robot triggers an Okta login." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 14, background: dim(.04), border: `1px solid ${dim(.1)}`, borderRadius: 11, padding: '10px 14px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: dim(.55) }}>{r.emailTo}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '.1em' }}>{r.codeMasked}</span>
              <span style={{ fontSize: 11.5, color: dim(.4) }}>{r.sender ?? '—'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dim(.4), marginLeft: 'auto' }} title={r.receivedAt}>{ago(r.receivedAt)}</span>
              {r.consumedAt ? <Pill tone="forest">Used</Pill> : <Pill tone="gold">Unused</Pill>}
            </div>
          ))}
        </div>
      )}
    </DarkPage>
  );
}
