'use client';

// ─── FloatingChatButton — global trigger for the agent chat panel ─────────
// Mounted in AppLayout so every page gets it. Shows a sage-circle button
// at the bottom-right (above the FeedbackButton). Clicking opens the
// ChatPanel. Hides when no user is signed in or no active property is
// selected — there's nothing to chat about then.

import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { ChatPanel } from './ChatPanel';

export function FloatingChatButton() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [open, setOpen] = useState(false);

  // When a walkthrough starts (Clicky-style cursor demo), the chat panel
  // minimizes so the cursor has the whole page to roam. The overlay
  // dispatches `walkthrough:start` from its runLoop entry point.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setOpen(false);
    window.addEventListener('walkthrough:start', handler);
    return () => window.removeEventListener('walkthrough:start', handler);
  }, []);

  if (!user || !activePropertyId) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open Staxis chat"
        title="Ask Staxis (chat)"
        style={{
          position: 'fixed',
          right: 'max(20px, env(safe-area-inset-right, 20px))',
          // Leave room for the FeedbackButton which sits at bottom-right too.
          bottom: 'calc(max(20px, env(safe-area-inset-bottom, 20px)) + 64px)',
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'var(--snow-ink, #1F231C)',
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(31, 35, 28, 0.18), 0 2px 6px rgba(31, 35, 28, 0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 60,
          transition: 'transform 0.18s ease, background 0.18s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--snow-sage-deep, #5C7A60)';
          e.currentTarget.style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--snow-ink, #1F231C)';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <MessageCircle size={22} strokeWidth={2.0} />
      </button>

      <ChatPanel
        open={open}
        onClose={() => setOpen(false)}
        propertyId={activePropertyId}
      />
    </>
  );
}
