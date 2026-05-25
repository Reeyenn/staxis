'use client';

// ─── VoiceIssueButton — mic for the housekeeper issue modal (feature #11) ──
//
// Renders one big mic button at the top of the existing "Report Issue" modal
// on the housekeeper page. The housekeeper taps it, speaks the issue in any
// of EN/ES/HT/TL/VI; ElevenLabs handles ASR + TTS, our voice-brain (in
// housekeeper_issue mode) extracts structured fields and fires the
// createMaintenanceWorkOrder tool which writes to staxis_voice_issues AND
// mirrors a short note onto rooms.issue_note for the room card.
//
// Why a separate button instead of bolting onto the existing typed-issue
// flow: the existing flow already works fine (textarea + submit); voice is
// an ADDITIONAL fast path. The user can do either — or both: tap mic, speak,
// edit the note in the textarea, then hit submit. The modal stays open so
// the housekeeper sees the captured note before committing.
//
// States the component renders:
//   IDLE        — "Tap to speak — describe the problem"
//   CONNECTING  — spinner + "Connecting…"
//   LISTENING   — pulsing mic + "Listening… speak in any language"
//   SPEAKING    — same pulse, "Tap to stop" — the agent is replying
//   PROCESSING  — "Got it — filing the ticket…"
//   SUCCESS     — "Ticket filed."
//   DENIED      — fall through to text entry: "Mic blocked. … or type."
//   CAPPED      — daily voice cap hit, type instead.
//   ERROR       — generic error.
//
// Permissions:
//   The mic permission is requested by the ElevenLabs SDK on session start.
//   When denied, we surface a clear "type instead" message — the text
//   textarea is still rendered behind us so the housekeeper can fall through
//   without re-opening the modal.

import { useEffect, useRef, useState } from 'react';
import { Mic, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useConversationalSession } from '@/components/agent/useConversationalSession';
import { t, type Language } from '@/lib/translations';

export interface VoiceIssueButtonProps {
  /** Property id (from the housekeeper page URL `?pid=`). When null, the
   *  button renders disabled — the page-level error UI handles the missing
   *  pid case. */
  propertyId: string | null;
  /** The room number the modal was opened from. Forwarded to the agent as
   *  a room hint so the housekeeper doesn't have to restate it. */
  roomNumber: string | null;
  /** Caller language (en | es). Drives the button-state labels. The agent
   *  itself accepts any of EN/ES/HT/TL/VI regardless of this. */
  lang: Language;
  /** Called after the agent confirms a ticket has been filed (best-effort —
   *  the parent can use this to refetch rooms so the new issue_note shows
   *  on the room card). */
  onTicketFiled: () => void;
}

type ButtonState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'success'
  | 'denied'
  | 'capped'
  | 'error';

export default function VoiceIssueButton(props: VoiceIssueButtonProps): React.JSX.Element {
  const { propertyId, roomNumber, lang, onTicketFiled } = props;

  // `active` flips on tap, drives the conversational session hook.
  const [active, setActive] = useState(false);
  const [uiState, setUiState] = useState<ButtonState>('idle');
  // The agent's most recent spoken confirmation, shown under the button so
  // the housekeeper has a visible echo of what was understood — useful when
  // the audio confirmation got cut off or they want to double-check before
  // submitting.
  const [lastAssistant, setLastAssistant] = useState('');

  // Was a tool call observed? The SDK doesn't expose tool_call events to
  // the browser directly, but our agent's confirmation message reliably
  // contains "ticket" (EN) / "ticket" (ES) / etc. We use that as a heuristic
  // and also fire onTicketFiled() once per session on any agent message —
  // the parent can dedupe / refetch idempotently.
  const ticketAnnouncedRef = useRef(false);

  const session = useConversationalSession({
    propertyId,
    active,
    mode: 'housekeeper_issue',
    currentRoomNumber: roomNumber,
  });

  // Mirror the hook's status into a single user-facing state. The hook's
  // `status` machine ('idle' | 'connecting' | 'listening' | 'thinking' |
  // 'speaking' | 'denied' | 'capped' | 'error') already covers most of
  // what we want; we just collapse 'thinking' into 'speaking' for the
  // button label since the housekeeper can't tell the difference.
  useEffect(() => {
    if (!active && uiState === 'success') return; // hold success until next tap
    switch (session.status) {
      case 'idle':       setUiState(active ? 'connecting' : 'idle'); break;
      case 'connecting': setUiState('connecting'); break;
      case 'listening':  setUiState('listening'); break;
      case 'thinking':
      case 'speaking':   setUiState('speaking'); break;
      case 'denied':     setUiState('denied'); break;
      case 'capped':     setUiState('capped'); break;
      case 'error':      setUiState('error'); break;
    }
  }, [session.status, active, uiState]);

  // Track the agent's spoken confirmation. The first non-empty agent
  // message after a session opens is the greeting; subsequent messages
  // are typically confirmations. We treat ANY agent message after the
  // first as evidence the tool fired and notify the parent. This is a
  // best-effort heuristic — the parent does an idempotent refetch.
  const agentMessageCountRef = useRef(0);
  useEffect(() => {
    if (!session.lastAssistant) return;
    setLastAssistant(session.lastAssistant);
    agentMessageCountRef.current += 1;
    if (agentMessageCountRef.current >= 2 && !ticketAnnouncedRef.current) {
      ticketAnnouncedRef.current = true;
      onTicketFiled();
    }
  }, [session.lastAssistant, onTicketFiled]);

  // Reset the per-session counters when the user opens a fresh session.
  useEffect(() => {
    if (active) {
      agentMessageCountRef.current = 0;
      ticketAnnouncedRef.current = false;
      setLastAssistant('');
    }
  }, [active]);

  // ── Tap handler ────────────────────────────────────────────────────────
  // Single button toggles open/close. If we're in a terminal state
  // (denied / capped / error / success), tapping the button starts a fresh
  // attempt.
  const handleTap = () => {
    if (!propertyId) return;
    if (active) {
      // Stop the active session. The hook's stop() releases the mic and
      // closes the WS. uiState flips to 'success' so the housekeeper sees
      // the confirmation before the button returns to idle on next tap.
      session.stop();
      setActive(false);
      if (ticketAnnouncedRef.current) {
        setUiState('success');
      } else {
        setUiState('idle');
      }
      return;
    }
    // Fresh attempt — reset terminal state and open the session.
    setUiState('connecting');
    setActive(true);
  };

  // ── Visuals ────────────────────────────────────────────────────────────
  const isTerminalError = uiState === 'denied' || uiState === 'capped' || uiState === 'error';
  const isOpen = uiState === 'listening' || uiState === 'speaking' || uiState === 'connecting';

  const buttonLabel = (() => {
    switch (uiState) {
      case 'idle':       return t('voiceIssueTapToSpeak', lang);
      case 'connecting': return t('voiceIssueConnecting', lang);
      case 'listening':  return t('voiceIssueListening', lang);
      case 'speaking':   return t('voiceIssueTapToStop', lang);
      case 'success':    return t('voiceIssueSuccess', lang);
      case 'denied':     return t('voiceIssueMicBlocked', lang);
      case 'capped':     return t('voiceIssueCapped', lang);
      case 'error':      return t('voiceIssueError', lang);
    }
  })();

  const bg = (() => {
    if (uiState === 'success') return 'var(--green-dim, #DCFCE7)';
    if (isTerminalError)        return 'var(--red-dim, #FEF2F2)';
    if (isOpen)                 return 'var(--navy-light, #2563EB)';
    return 'white';
  })();
  const fg = (() => {
    if (uiState === 'success') return 'var(--green, #006565)';
    if (isTerminalError)        return 'var(--red-dark, #991B1B)';
    if (isOpen)                 return 'white';
    return 'var(--text-primary, #0F172A)';
  })();
  const border = (() => {
    if (uiState === 'success') return 'var(--green-light, #86EFAC)';
    if (isTerminalError)        return 'var(--red-light, #FECACA)';
    if (isOpen)                 return 'var(--navy-light, #2563EB)';
    return 'var(--border-light, #E5E7EB)';
  })();

  return (
    <div style={{ marginBottom: '14px' }}>
      <button
        type="button"
        onClick={handleTap}
        disabled={!propertyId}
        aria-label={buttonLabel}
        style={{
          width: '100%',
          minHeight: '72px',
          padding: '14px 16px',
          borderRadius: '14px',
          background: bg,
          color: fg,
          border: `2px solid ${border}`,
          cursor: propertyId ? 'pointer' : 'not-allowed',
          fontSize: '15px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: '12px',
          textAlign: 'left',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
          transition: 'background 150ms ease, border-color 150ms ease',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '40px',
            height: '40px',
            flexShrink: 0,
            borderRadius: '50%',
            background: isOpen ? 'rgba(255,255,255,0.18)' : 'var(--bg-elevated, #F3F4F6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Animated pulse when listening; sub-second so it's lively but
            // not seizure-y on a low-refresh display.
            animation: uiState === 'listening' || uiState === 'speaking'
              ? 'voice-mic-pulse 1.4s ease-out infinite'
              : 'none',
          }}
        >
          {uiState === 'connecting' ? (
            <Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite' }} />
          ) : uiState === 'success' ? (
            <CheckCircle2 size={22} />
          ) : isTerminalError ? (
            <AlertTriangle size={22} />
          ) : (
            <Mic size={22} />
          )}
        </span>
        <span style={{ flex: 1, lineHeight: 1.35 }}>{buttonLabel}</span>
      </button>

      {/* Live transcript echo. Renders only when the agent has spoken
          something — gives the housekeeper a visible confirmation of what
          was understood. Truncated to keep the modal compact. */}
      {lastAssistant && (
        <p style={{
          marginTop: '8px',
          padding: '8px 12px',
          background: 'var(--bg-elevated, #F3F4F6)',
          borderRadius: '10px',
          fontSize: '13px',
          color: 'var(--text-secondary, #4B5563)',
          lineHeight: 1.45,
        }}>
          {lastAssistant.length > 160 ? lastAssistant.slice(0, 160) + '…' : lastAssistant}
        </p>
      )}

      {/* Hint that the textarea below is still available. Always shown
          (including in terminal-error states) so the housekeeper never feels
          stuck. */}
      <p style={{
        marginTop: '8px',
        fontSize: '12px',
        color: 'var(--text-muted, #9CA3AF)',
        textAlign: 'center',
      }}>
        {t('voiceIssueHint', lang)}
      </p>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes voice-mic-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(255,255,255,0.55); }
          80%  { box-shadow: 0 0 0 14px rgba(255,255,255,0); }
          100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
        }
      `}</style>
    </div>
  );
}
