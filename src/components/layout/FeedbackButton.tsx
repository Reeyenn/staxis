'use client';

/**
 * Floating feedback button. Lives at the bottom-right of every page so
 * GMs/staff can dash off "this is broken" / "I want X" without leaving
 * what they're doing.
 *
 * Hidden for admin users — Reeyen has the inbox in /admin, no need for
 * the floating button to clutter his view.
 */

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { MessageSquare, X, Send, CheckCircle2 } from 'lucide-react';

type Category = 'bug' | 'feature_request' | 'general' | 'complaint' | 'love';

const CATEGORIES: { value: Category; label: string; emoji: string }[] = [
  { value: 'bug',             label: 'Something broken',  emoji: '🐛' },
  { value: 'feature_request', label: 'Feature request',   emoji: '✨' },
  { value: 'general',         label: 'General comment',   emoji: '💬' },
  { value: 'complaint',       label: 'Complaint',         emoji: '😠' },
  { value: 'love',            label: 'Love note',         emoji: '❤️' },
];

export function FeedbackButton() {
  const { user } = useAuth();
  const { activeProperty } = useProperty();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('general');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Don't show for unauth users or admins.
  if (!user || user.role === 'admin') return null;

  const submit = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          category,
          propertyId: activeProperty?.id ?? null,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setSubmitted(true);
        setMessage('');
        setTimeout(() => {
          setOpen(false);
          setSubmitted(false);
          setCategory('general');
        }, 1500);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Send feedback"
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: '#364262',
            color: 'white',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(54, 66, 98, 0.3)',
            zIndex: 100,
          }}
        >
          <MessageSquare size={20} />
        </button>
      )}

      {open && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          width: '320px',
          maxWidth: 'calc(100vw - 40px)',
          background: '#ffffff',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          zIndex: 100,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px',
            background: '#364262',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <strong style={{ fontSize: '14px' }}>Tell Reeyen something</strong>
            <button
              onClick={() => { setOpen(false); setSubmitted(false); setMessage(''); }}
              aria-label="Close"
              style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', padding: '4px' }}
            >
              <X size={16} />
            </button>
          </div>

          {submitted ? (
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <CheckCircle2 size={32} color="var(--green)" style={{ marginBottom: '8px' }} />
              <p style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Sent — thanks!</p>
            </div>
          ) : (
            <div style={{ padding: '14px' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.5 }}>
                Anything broken, anything you want, anything you love. Goes straight to Reeyen.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' }}>
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setCategory(c.value)}
                    style={{
                      padding: '6px 10px',
                      fontSize: '11px',
                      border: `1px solid ${category === c.value ? '#364262' : 'var(--border)'}`,
                      background: category === c.value ? 'rgba(54,66,98,0.06)' : 'transparent',
                      color: category === c.value ? '#364262' : 'var(--text-muted)',
                      borderRadius: '999px',
                      cursor: 'pointer',
                      fontWeight: category === c.value ? 600 : 400,
                    }}
                  >
                    {c.emoji} {c.label}
                  </button>
                ))}
              </div>
              <textarea
                placeholder="What's on your mind?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                className="input"
                style={{ width: '100%', fontSize: '13px', resize: 'vertical' }}
              />
              <button
                onClick={submit}
                disabled={!message.trim() || submitting}
                className="btn btn-primary"
                style={{ marginTop: '10px', width: '100%', justifyContent: 'center', fontSize: '13px' }}
              >
                <Send size={14} /> {submitting ? 'Sending…' : 'Send'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
