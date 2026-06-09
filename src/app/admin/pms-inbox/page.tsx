'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/pms-inbox — PMS Okta inbox viewer (migrations 0274 + 0275).
 *
 * Two views, both fed by /api/admin/pms-inbox (the only read path — the inbox
 * tables are service-role-only):
 *   - Auth codes: last N Okta 2FA codes the robot received, MASKED server-side
 *     (last 2 digits only; the full code never reaches the browser).
 *   - Full messages: the complete inbound emails per hotel, so the onboarding
 *     admin can click the Okta account-SETUP link ("set your password" / enroll
 *     MFA) right here. The raw email HTML is never rendered — the body is shown
 *     as escaped plain text and only scheme-validated http(s) links are clickable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { ChevronLeft, RefreshCw, ShieldCheck, CheckCircle2, Clock, Mail, ExternalLink } from 'lucide-react';

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

  if (authLoading) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;
  if (!user) return <AppLayout><div className="p-8">Not signed in</div></AppLayout>;

  // Group full messages by hotel inbox (emailTo is 1:1 with property).
  const byInbox = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = byInbox.get(m.emailTo) ?? [];
    list.push(m);
    byInbox.set(m.emailTo, list);
  }

  return (
    <AppLayout>
      <div className="px-6 py-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/admin" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-2">
              <ChevronLeft className="h-4 w-4 mr-1" /> Admin
            </Link>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-green-600" /> PMS Inbox
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              The hotel-login mailbox at <span className="font-mono">…@getstaxis.com</span>. Setup emails show
              below with clickable links; ongoing 2FA codes (masked) go to the robot.
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

        {/* ── Full messages (setup links) ─────────────────────────────────── */}
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
          <Mail className="h-5 w-5 text-blue-600" /> Account setup &amp; full messages
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          Click the link inside an Okta setup email to set the password / enroll MFA. Links are shown in full so
          you can verify the destination before clicking; the email&apos;s own formatting is stripped for safety.
        </p>

        {byInbox.size === 0 && !loading && !error ? (
          <div className="rounded border border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500 mb-10">
            No messages yet. The full Okta setup email appears here the moment it arrives.
          </div>
        ) : (
          <div className="space-y-6 mb-10">
            {[...byInbox.entries()].map(([inbox, msgs]) => (
              <div key={inbox} className="rounded border border-gray-200">
                <div className="bg-gray-50 px-4 py-2 text-xs font-mono text-gray-700 border-b border-gray-200">
                  {inbox}
                </div>
                <div className="divide-y divide-gray-100">
                  {msgs.map((m) => (
                    <div key={m.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-gray-900 break-words">
                            {m.subject || '(no subject)'}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            from {m.fromAddr || '—'}
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 whitespace-nowrap" title={m.receivedAt}>
                          {ago(m.receivedAt)}
                        </div>
                      </div>

                      {m.links.length > 0 && (
                        <div className="mt-2 rounded border border-blue-100 bg-blue-50 px-3 py-2">
                          <div className="text-xs font-medium text-blue-800 mb-1">
                            Links in this email
                          </div>
                          <ul className="space-y-1">
                            {m.links.map((lk, i) => (
                              <li key={i} className="text-xs">
                                <a
                                  href={lk.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-start gap-1 text-blue-700 underline break-all"
                                >
                                  <ExternalLink className="h-3 w-3 mt-0.5 shrink-0" />
                                  <span className="break-all">{lk.href}</span>
                                </a>
                                {lk.label && lk.label !== lk.href && (
                                  <span className="text-gray-500"> — {lk.label}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {m.bodyText && (
                        <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-700 bg-gray-50 rounded px-3 py-2 max-h-64 overflow-auto">
                          {m.bodyText}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Masked 2FA codes (robot path) ───────────────────────────────── */}
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
          <ShieldCheck className="h-5 w-5 text-green-600" /> 2FA codes (robot)
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          Okta login codes the robot received, masked — only the last 2 digits are shown, and the full code never
          leaves the server.
        </p>

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
