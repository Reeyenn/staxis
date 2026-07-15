'use client';

import React from 'react';
import Image from 'next/image';
import QRCode from 'qrcode';
import {
  CheckCircle2,
  Clock3,
  Copy,
  MailCheck,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { Modal } from '@/app/_components/ui/Modal';
import { fetchWithAuth } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import type {
  CreatePhonePairingResponse,
  PhonePairingStatus,
  PhonePairingStatusResponse,
} from '@/lib/phone-pairing-contract';

interface PhoneHandoffDialogProps {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

type ViewState = 'loading' | 'ready' | 'error';

const PAIRING_TTL_MS = 60_000;
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function pairingStatusCopy(status: PhonePairingStatus, expired: boolean): {
  title: string;
  detail: string;
  icon: React.ReactNode;
} {
  if (status === 'completed') {
    return {
      title: 'Your phone is connected',
      detail: 'Staxis is signed in and ready on your phone.',
      icon: <CheckCircle2 size={19} aria-hidden="true" />,
    };
  }
  if (expired || status === 'expired') {
    return {
      title: 'This QR code expired',
      detail: 'Create a new one when you are ready to scan.',
      icon: <Clock3 size={19} aria-hidden="true" />,
    };
  }
  if (status === 'verified') {
    return {
      title: 'Phone verified',
      detail: 'Finishing the secure sign-in now…',
      icon: <ShieldCheck size={19} aria-hidden="true" />,
    };
  }
  if (status === 'code_sent') {
    return {
      title: 'Code sent',
      detail: 'Finish entering the emailed code on your phone.',
      icon: <MailCheck size={19} aria-hidden="true" />,
    };
  }
  return {
    title: 'Waiting for your phone',
    detail: 'Open your camera and point it at the QR code.',
    icon: <Smartphone size={19} aria-hidden="true" />,
  };
}

export function PhoneHandoffDialog({ open, onClose, returnFocusRef }: PhoneHandoffDialogProps) {
  const titleId = React.useId();
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const requestGenerationRef = React.useRef(0);
  const [view, setView] = React.useState<ViewState>('loading');
  const [pairing, setPairing] = React.useState<CreatePhonePairingResponse | null>(null);
  const [activeExpiresAt, setActiveExpiresAt] = React.useState('');
  const [qrDataUrl, setQrDataUrl] = React.useState('');
  const [status, setStatus] = React.useState<PhonePairingStatus>('pending');
  const [error, setError] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  const createPairing = React.useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setView('loading');
    setError('');
    setCopied(false);
    setPairing(null);
    setActiveExpiresAt('');
    setQrDataUrl('');
    setStatus('pending');
    setNow(Date.now());

    try {
      const response = await fetchWithAuth('/api/auth/phone-pairing', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const result = await readEnvelope<CreatePhonePairingResponse>(
        response,
        'Could not create a secure phone sign-in. Try again.',
      );
      if (result.error || !result.data) {
        throw new Error(result.error ?? 'Could not create a secure phone sign-in. Try again.');
      }

      const dataUrl = await QRCode.toDataURL(result.data.pairUrl, {
        width: 296,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1F231C', light: '#FFFFFF' },
      });
      if (requestGenerationRef.current !== generation) return;
      setPairing(result.data);
      setActiveExpiresAt(result.data.expiresAt);
      setQrDataUrl(dataUrl);
      setView('ready');
    } catch (err) {
      if (requestGenerationRef.current !== generation) return;
      setError(err instanceof Error ? err.message : 'Could not create the QR code.');
      setView('error');
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      requestGenerationRef.current += 1;
      return;
    }
    void createPairing();
  }, [open, createPairing]);

  // Live countdown. A short interval keeps the radial/progress treatment
  // smooth while the visible seconds still update at human speed.
  React.useEffect(() => {
    if (!open || !pairing || view !== 'ready' || status === 'completed' || status === 'expired') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      // Keep the authenticated status poll alive at the boundary: a phone can
      // claim the QR in its final milliseconds, which replaces this expiry
      // with a fresh challenge expiry on the server.
    }, 250);
    return () => window.clearInterval(timer);
  }, [open, pairing, view, status]);

  // Desktop status poll is authenticated and scoped to the desktop account;
  // it never receives phone-session credentials or secret pairing tokens.
  React.useEffect(() => {
    if (
      !open ||
      !pairing ||
      view !== 'ready' ||
      status === 'completed' ||
      status === 'expired'
    ) return;
    let active = true;
    let running = false;

    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetchWithAuth(
          `/api/auth/phone-pairing/status?id=${encodeURIComponent(pairing.pairingId)}`,
          { method: 'GET', credentials: 'include', cache: 'no-store' },
        );
        const result = await readEnvelope<PhonePairingStatusResponse>(response);
        if (active && !result.error && result.data) {
          setStatus(result.data.status);
          setActiveExpiresAt(result.data.expiresAt);
        }
      } catch {
        // A transient network/auth refresh failure should leave the last
        // known status visible; the next authenticated poll retries.
      } finally {
        running = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, pairing, status, view]);

  // Focus trap + restoration supplements the shared Modal primitive, which
  // already handles Escape, the scrim, and body scroll locking.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = returnFocusRef?.current ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    const frame = window.requestAnimationFrame(() => {
      const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus();
    };
  }, [open, returnFocusRef]);

  const handleTrap = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const expiresAtMs = pairing
    ? new Date(activeExpiresAt || pairing.expiresAt).getTime()
    : 0;
  const remainingMs = pairing ? Math.max(0, expiresAtMs - now) : 0;
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const expired = Boolean(pairing && remainingMs <= 0 && status !== 'completed');
  const progress = Math.max(0, Math.min(100, (remainingMs / PAIRING_TTL_MS) * 100));
  const statusCopy = pairingStatusCopy(status, expired);

  const copyLink = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <PhoneHandoffStyles />
      <Modal
        open={open}
        onClose={onClose}
        portal
        animated={false}
        labelledBy={titleId}
        theme={{
          scrim: 'var(--phd-scrim)',
          scrimFilter: 'blur(4px)',
          bg: 'var(--phd-surface)',
          border: '1px solid var(--phd-border)',
          radius: '16px',
          maxWidth: '560px',
          padding: '0',
          shadow: 'var(--phd-shadow)',
          zIndex: 1200,
        }}
      >
        <div ref={bodyRef} className="phd" onKeyDown={handleTrap}>
          <div className="phd-head">
            <div>
              <div className="phd-eyebrow"><ShieldCheck size={13} aria-hidden="true" /> Secure phone handoff</div>
              <h2 id={titleId}>Open Staxis on your phone</h2>
              <p>Scan the QR code, then confirm with the code sent to your registered email.</p>
            </div>
            <button type="button" className="phd-iconbtn" onClick={onClose} aria-label="Close phone sign-in">
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          {view === 'loading' && (
            <div className="phd-loading" role="status" aria-live="polite">
              <div className="phd-spinner" aria-hidden="true" />
              <strong>Creating a secure QR code…</strong>
              <span>This only takes a moment.</span>
            </div>
          )}

          {view === 'error' && (
            <div className="phd-error" role="alert">
              <div className="phd-statusicon"><X size={20} aria-hidden="true" /></div>
              <strong>Couldn’t create the QR code</strong>
              <span>{error}</span>
              <button type="button" className="phd-primary" onClick={() => void createPairing()}>
                <RefreshCw size={17} aria-hidden="true" /> Try again
              </button>
            </div>
          )}

          {view === 'ready' && pairing && (
            <div className="phd-content">
              <div className={`phd-qrwrap${expired ? ' phd-qrwrap-expired' : ''}`}>
                {qrDataUrl && (
                  <Image
                    src={qrDataUrl}
                    alt="QR code to securely open Staxis on your phone"
                    width={296}
                    height={296}
                    unoptimized
                  />
                )}
                {expired && (
                  <div className="phd-expired-overlay">
                    <Clock3 size={25} aria-hidden="true" />
                    <strong>Expired</strong>
                  </div>
                )}
              </div>

              <div className="phd-side">
                <div className={`phd-state phd-state-${status === 'completed' ? 'success' : expired ? 'expired' : status}`} aria-live="polite">
                  <span className="phd-statusicon">{statusCopy.icon}</span>
                  <span>
                    <strong>{statusCopy.title}</strong>
                    <small>{statusCopy.detail}</small>
                  </span>
                </div>

                {status !== 'completed' && !expired && (
                  <div className="phd-timer">
                    <div className="phd-timerrow">
                      <span>{status === 'pending' ? 'QR expires in' : 'Sign-in expires in'}</span>
                      <strong>{`0:${String(secondsLeft).padStart(2, '0')}`}</strong>
                    </div>
                    <div
                      className="phd-progress"
                      role="progressbar"
                      aria-label="Time remaining before QR code expires"
                      aria-valuemin={0}
                      aria-valuemax={60}
                      aria-valuenow={secondsLeft}
                    >
                      <span style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

                <ol className="phd-steps">
                  <li><span>1</span>Open your phone camera</li>
                  <li><span>2</span>Scan this QR code</li>
                  <li><span>3</span>Enter the emailed code</li>
                </ol>

                <div className="phd-actions">
                  {expired ? (
                    <button type="button" className="phd-primary" onClick={() => void createPairing()}>
                      <RefreshCw size={17} aria-hidden="true" /> Create a new QR
                    </button>
                  ) : status === 'completed' ? (
                    <button type="button" className="phd-primary" onClick={onClose}>Done</button>
                  ) : status === 'pending' ? (
                    <button type="button" className="phd-secondary" onClick={() => void copyLink()}>
                      <Copy size={17} aria-hidden="true" /> {copied ? 'Link copied' : 'Copy phone link'}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          <div className="phd-foot">
            <ShieldCheck size={14} aria-hidden="true" />
            Scanning alone never signs anyone in. The emailed code is required.
          </div>
        </div>
      </Modal>
    </>
  );
}

function PhoneHandoffStyles() {
  return <style>{`
    :root {
      --phd-surface: #FFFFFF;
      --phd-surface-soft: #F5F7F4;
      --phd-text: #1F231C;
      --phd-muted: #5C625C;
      --phd-faint: #A6ABA6;
      --phd-border: rgba(31,35,28,.10);
      --phd-primary: #3E5C48;
      --phd-primary-hover: #304A39;
      --phd-primary-soft: rgba(92,122,96,.12);
      --phd-danger: #B85C3D;
      --phd-scrim: rgba(20,25,21,.38);
      --phd-shadow: 0 24px 64px -18px rgba(31,42,32,.38);
    }
    .phd { color:var(--phd-text); font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif; }
    .phd-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:24px 24px 20px; border-bottom:1px solid var(--phd-border); }
    .phd-head h2 { margin:5px 0 5px; font-size:22px; line-height:28px; letter-spacing:-.02em; font-weight:650; }
    .phd-head p { margin:0; max-width:440px; color:var(--phd-muted); font-size:14px; line-height:20px; }
    .phd-eyebrow { display:flex; align-items:center; gap:6px; color:var(--phd-primary); font:600 10px/16px var(--font-geist-mono),monospace; letter-spacing:.12em; text-transform:uppercase; }
    .phd-iconbtn { width:44px; height:44px; flex:0 0 44px; display:grid; place-items:center; color:var(--phd-muted); background:transparent; border:0; border-radius:12px; cursor:pointer; transition:background 150ms ease-out,color 150ms ease-out; }
    .phd-iconbtn:hover { background:var(--phd-primary-soft); color:var(--phd-text); }
    .phd-iconbtn:active { transform:scale(.98); }
    .phd-iconbtn:focus-visible,.phd-primary:focus-visible,.phd-secondary:focus-visible { outline:2px solid var(--phd-primary); outline-offset:2px; }
    .phd-content { display:grid; grid-template-columns:minmax(210px,248px) minmax(0,1fr); gap:24px; align-items:center; padding:24px; }
    .phd-qrwrap { position:relative; width:100%; aspect-ratio:1; padding:12px; border:1px solid var(--phd-border); border-radius:16px; background:#fff; box-shadow:0 4px 12px rgba(31,42,32,.06); overflow:hidden; }
    .phd-qrwrap img { width:100%; height:100%; display:block; }
    .phd-qrwrap-expired img { filter:blur(3px); opacity:.22; }
    .phd-expired-overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; color:var(--phd-danger); background:rgba(255,255,255,.72); }
    .phd-side { min-width:0; display:flex; flex-direction:column; gap:16px; }
    .phd-state { display:flex; align-items:flex-start; gap:10px; padding:12px; border-radius:12px; background:var(--phd-primary-soft); color:var(--phd-primary); }
    .phd-state-expired { background:rgba(184,92,61,.10); color:var(--phd-danger); }
    .phd-state-success { background:rgba(53,107,76,.12); color:#356B4C; }
    .phd-state strong,.phd-state small { display:block; }
    .phd-state strong { font-size:14px; line-height:20px; }
    .phd-state small { margin-top:2px; color:var(--phd-muted); font-size:12px; line-height:17px; }
    .phd-statusicon { width:24px; height:24px; flex:0 0 24px; display:grid; place-items:center; }
    .phd-timer { display:flex; flex-direction:column; gap:7px; }
    .phd-timerrow { display:flex; justify-content:space-between; align-items:center; color:var(--phd-muted); font-size:12px; }
    .phd-timerrow strong { color:var(--phd-text); font:600 12px/16px var(--font-geist-mono),monospace; }
    .phd-progress { height:4px; overflow:hidden; border-radius:999px; background:rgba(92,98,92,.12); }
    .phd-progress span { display:block; height:100%; border-radius:inherit; background:var(--phd-primary); transition:width 250ms cubic-bezier(.05,.7,.1,1); }
    .phd-steps { display:flex; flex-direction:column; gap:8px; list-style:none; margin:0; padding:0; color:var(--phd-muted); font-size:12.5px; line-height:18px; }
    .phd-steps li { display:flex; align-items:center; gap:9px; }
    .phd-steps li > span { width:22px; height:22px; flex:0 0 22px; display:grid; place-items:center; border-radius:50%; color:var(--phd-primary); background:var(--phd-primary-soft); font:600 10px/1 var(--font-geist-mono),monospace; }
    .phd-actions { display:flex; }
    .phd-primary,.phd-secondary { min-height:44px; min-width:44px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 20px; border-radius:10px; font:600 14px/20px inherit; cursor:pointer; transition:background 150ms ease-out,transform 150ms ease-out; }
    .phd-primary { border:0; color:#fff; background:var(--phd-primary); }
    .phd-primary:hover { background:var(--phd-primary-hover); }
    .phd-secondary { color:var(--phd-primary); background:transparent; border:1px solid rgba(62,92,72,.35); }
    .phd-secondary:hover { background:var(--phd-primary-soft); }
    .phd-primary:active,.phd-secondary:active { transform:scale(.98); }
    .phd-foot { display:flex; align-items:center; justify-content:center; gap:7px; padding:13px 20px; color:var(--phd-muted); background:var(--phd-surface-soft); border-top:1px solid var(--phd-border); font-size:11.5px; line-height:17px; text-align:center; }
    .phd-loading,.phd-error { min-height:340px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:40px 24px; text-align:center; }
    .phd-loading strong,.phd-error strong { margin-top:6px; font-size:16px; }
    .phd-loading span,.phd-error span { color:var(--phd-muted); font-size:13px; }
    .phd-error .phd-statusicon { color:var(--phd-danger); }
    .phd-error .phd-primary { margin-top:12px; }
    .phd-spinner { width:32px; height:32px; border:3px solid var(--phd-primary-soft); border-top-color:var(--phd-primary); border-radius:50%; animation:phd-spin .75s linear infinite; }
    @keyframes phd-spin { to { transform:rotate(360deg); } }
    @media (max-width:600px) {
      .phd-head { padding:20px 18px 16px; }
      .phd-head h2 { font-size:20px; line-height:26px; }
      .phd-content { grid-template-columns:1fr; gap:18px; padding:18px; }
      .phd-qrwrap { width:min(72vw,260px); margin:0 auto; }
      .phd-primary,.phd-secondary { width:100%; }
      .phd-foot { padding-inline:18px; }
    }
    html.dark {
        --phd-surface:#171A17;
        --phd-surface-soft:#202420;
        --phd-text:#F1F3EF;
        --phd-muted:#B8BEB7;
        --phd-faint:#858C85;
        --phd-border:rgba(238,244,237,.12);
        --phd-primary:#A9C5AF;
        --phd-primary-hover:#BCD4C1;
        --phd-primary-soft:rgba(169,197,175,.13);
        --phd-danger:#E7A58F;
        --phd-scrim:rgba(0,0,0,.58);
        --phd-shadow:0 24px 64px -18px rgba(0,0,0,.72);
    }
    html.dark .phd-primary { color:#172018; }
    html.dark .phd-qrwrap { border-color:rgba(255,255,255,.16); }
    html.dark .phd-expired-overlay { background:rgba(23,26,23,.8); }
    html.dark .phd-state-success { color:#B6D5BC; }
    @media (prefers-reduced-motion:reduce) {
      .phd-spinner { animation:none; }
      .phd-progress span,.phd-iconbtn,.phd-primary,.phd-secondary { transition:none; }
      .phd-iconbtn:active,.phd-primary:active,.phd-secondary:active { transform:none; }
    }
  `}</style>;
}
