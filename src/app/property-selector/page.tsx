'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { Building2, LogOut } from 'lucide-react';

export default function PropertySelectorPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { properties, loading: propLoading, setActivePropertyId } = useProperty();
  const router = useRouter();

  // Redirect unauthenticated users to sign-in
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/signin');
    }
  }, [user, authLoading, router]);

  // Auto-select when exactly 1 property
  useEffect(() => {
    if (authLoading || propLoading || !user) return;
    if (properties.length === 1) {
      setActivePropertyId(properties[0].id);
      sessionStorage.setItem('hotelops-session-selected', '1');
      router.replace('/dashboard');
    }
  }, [authLoading, propLoading, user, properties, setActivePropertyId, router]);

  const handleSelect = (id: string) => {
    setActivePropertyId(id);
    sessionStorage.setItem('hotelops-session-selected', '1');
    router.replace('/dashboard');
  };

  const handleSignOut = async () => {
    sessionStorage.removeItem('hotelops-session-selected');
    await signOut();
  };

  const isLoading = authLoading || propLoading;

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)',
      }}>
        <div style={{
          width: '40px', height: '40px',
          border: '3px solid rgba(212,144,64,0.2)',
          borderTopColor: 'var(--amber)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>

        {/* Header */}
        <div style={{ marginBottom: '40px', textAlign: 'center' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '12px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#0A0A0A', fontFamily: 'var(--font-mono)' }}>H</span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '24px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '8px',
          }}>
            Select a Property
          </h1>
          {user && (
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              Signed in as {user.email}
            </p>
          )}
        </div>

        {/* Property list or empty state */}
        {properties.length === 0 ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '40px 24px',
            textAlign: 'center',
          }}>
            <Building2 size={32} color="var(--text-muted)" style={{ margin: '0 auto 16px' }} />
            <p style={{
              fontSize: '15px', fontWeight: 600,
              color: 'var(--text-primary)', marginBottom: '8px',
              fontFamily: 'var(--font-sans)',
            }}>
              No properties found
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Your account doesn't have access to any properties yet. Contact your administrator to get access.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {properties.map(p => (
              <button
                key={p.id}
                onClick={() => handleSelect(p.id)}
                style={{
                  width: '100%',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '18px 20px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                  textAlign: 'left',
                  transition: 'border-color 150ms, background 150ms',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--amber-border)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--amber-dim)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card)';
                }}
              >
                <div style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: 'var(--amber-dim)',
                  border: '1px solid var(--amber-border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Building2 size={18} color="var(--amber)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '15px', fontWeight: 600,
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-sans)',
                    marginBottom: '2px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {p.totalRooms} rooms
                  </div>
                </div>
                <div style={{
                  fontSize: '18px', color: 'var(--text-muted)', fontWeight: 300, flexShrink: 0,
                }}>
                  →
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Sign out */}
        <div style={{ marginTop: '32px', textAlign: 'center' }}>
          <button
            onClick={handleSignOut}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              padding: '8px 12px',
            }}
          >
            <LogOut size={13} />
            Sign out
          </button>
        </div>

      </div>
    </div>
  );
}
