'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/mfa-resume/[hotelId] — manual recovery for MFA-paused sessions.
 *
 * When the CUA session-driver hits an MFA prompt during login, it pauses
 * the hotel and flags property_sessions.status='paused_mfa'. This page
 * is where Reeyen unsticks it.
 *
 * Recovery flow (Phase 1, simple):
 *   1. Reeyen opens the PMS login URL in a fresh browser tab.
 *   2. Completes the MFA login manually.
 *   3. Clicks "Resume" here — flips status to 'starting' so the
 *      supervisor respawns the driver. Driver attempts login again.
 *      If trust-device was checked during the manual login, the new
 *      session inherits that and doesn't hit MFA again.
 *
 * Better long-term: a browser extension that captures storageState +
 * uploads it via this page. Deferred to Phase 4+.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { ChevronLeft, ShieldAlert, ExternalLink, RefreshCw } from 'lucide-react';

interface SessionRow {
  property_id: string;
  display_name: string;
  pms_family: string;
  status: string;
  paused_reason: string | null;
  current_browser_url: string | null;
}

export default function MfaResumePage() {
  const params = useParams<{ hotelId: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/admin/cua-sessions');
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setError(json.error ?? 'Failed to load sessions');
          setLoading(false);
          return;
        }
        const match = (json.data.sessions as SessionRow[]).find((s) => s.property_id === params.hotelId);
        setSession(match ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, params.hotelId]);

  const handleResume = async () => {
    if (!session) return;
    if (!confirm(`Resume ${session.display_name}? The session-driver will attempt login again with the current saved cookies.`)) return;
    setResuming(true);
    try {
      const res = await fetchWithAuth('/api/admin/cua-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: params.hotelId, action: 'resume_mfa' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(`Resume failed: ${json.error ?? 'unknown'}`);
        setResuming(false);
        return;
      }
      alert('Resume requested. The supervisor will respawn the driver within 30 seconds.');
      router.push('/admin/properties#system');
    } catch (err) {
      alert(`Resume failed: ${(err as Error).message}`);
      setResuming(false);
    }
  };

  if (authLoading) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;
  if (!user) return <AppLayout><div className="p-8">Not signed in</div></AppLayout>;

  return (
    <AppLayout>
      <div className="px-6 py-8 max-w-2xl mx-auto">
        <Link href="/admin/properties#system" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-4">
          <ChevronLeft className="h-4 w-4 mr-1" /> Sessions
        </Link>

        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="h-6 w-6 text-amber-600" />
          <h1 className="text-2xl font-semibold">MFA Resume</h1>
        </div>

        {loading && <div>Loading session…</div>}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !session && (
          <div className="px-4 py-6 bg-amber-50 border border-amber-200 rounded">
            No session found for hotel <code>{params.hotelId}</code>.
          </div>
        )}

        {session && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              <strong>{session.display_name}</strong> is paused waiting on a manual MFA login on{' '}
              <strong>{session.pms_family}</strong>.
            </p>

            {session.paused_reason && (
              <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 mb-4">
                {session.paused_reason}
              </div>
            )}

            <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
              <h2 className="font-semibold mb-3">Recovery steps</h2>
              <ol className="list-decimal pl-5 space-y-3 text-sm text-gray-700">
                <li>
                  Open the PMS login URL in a fresh browser tab and complete the MFA login yourself.{' '}
                  {session.current_browser_url && (
                    <a
                      href={session.current_browser_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 underline"
                    >
                      Open PMS <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </li>
                <li>
                  Check "remember this device" / "trust this browser" if the PMS offers it — that prevents MFA
                  re-prompts for ~30-90 days.
                </li>
                <li>
                  Click <strong>Resume</strong> below. The system will restart the session-driver, which will
                  retry login with the (now-valid) trust token.
                </li>
              </ol>
            </div>

            <button
              onClick={() => void handleResume()}
              disabled={resuming || session.status !== 'paused_mfa'}
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`h-4 w-4 ${resuming ? 'animate-spin' : ''}`} />
              {resuming ? 'Resuming…' : 'Resume session'}
            </button>

            {session.status !== 'paused_mfa' && (
              <p className="mt-3 text-xs text-gray-500">
                Status is <code>{session.status}</code>, not <code>paused_mfa</code>. No MFA recovery action is
                possible right now.
              </p>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
