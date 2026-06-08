'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/pms-inbox — last N Okta 2FA codes the robot received (MASKED).
 *
 * A pilot/debug viewer for the auth-code inbox (migration 0274). Confirms the
 * Cloudflare Email Routing → /api/pms-inbox/inbound → pms_auth_codes pipeline
 * is delivering codes. Codes are masked SERVER-SIDE (last 2 digits only) by
 * /api/admin/pms-inbox — the full code never reaches the browser.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { ChevronLeft, RefreshCw, ShieldCheck, CheckCircle2, Clock } from 'lucide-react';

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

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function PmsInboxPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<CodeRow[]>([]);
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

  if (authLoading) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;
  if (!user) return <AppLayout><div className="p-8">Not signed in</div></AppLayout>;

  return (
    <AppLayout>
      <div className="px-6 py-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/admin" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-2">
              <ChevronLeft className="h-4 w-4 mr-1" /> Admin
            </Link>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-green-600" /> PMS Auth-Code Inbox
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Okta 2FA codes the robot received, for its unattended PMS login. Codes are masked — only the
              last 2 digits are shown, and the full code never leaves the server.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="inline-flex items-center px-3 py-1.5 text-sm border border-gray-200 rounded hover:bg-gray-50"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {rows.length === 0 && !loading && !error ? (
          <div className="rounded border border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
            No codes received yet. They appear here the moment the robot triggers an Okta login.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Inbox</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Sender</th>
                  <th className="px-4 py-2">Received</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs">{r.emailTo}</td>
                    <td className="px-4 py-2">{r.source}</td>
                    <td className="px-4 py-2 font-mono">{r.codeMasked}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{r.sender ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600" title={r.receivedAt}>{ago(r.receivedAt)}</td>
                    <td className="px-4 py-2">
                      {r.consumedAt ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <CheckCircle2 className="h-4 w-4" /> Used
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-700">
                          <Clock className="h-4 w-4" /> Unused
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
