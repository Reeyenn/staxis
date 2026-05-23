'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/property-sessions — per-hotel CUA session health.
 *
 * One row per property_sessions row. Shows: status, heartbeat freshness,
 * Claude spend today, paused-reason, and admin actions (resume MFA,
 * reset cost cap, stop, restart).
 *
 * Source: /api/admin/cua-sessions (joins property_sessions +
 * pms_knowledge_files + properties).
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  RefreshCw,
  ChevronLeft,
  StopCircle,
  Play,
  ExternalLink,
} from 'lucide-react';

interface SessionRow {
  property_id: string;
  display_name: string;
  pms_family: string;
  status: string;
  last_alive_at: string | null;
  last_successful_read_at: string | null;
  current_browser_url: string | null;
  daily_claude_cost_micros: number;
  daily_claude_cost_resets_at: string | null;
  paused_reason: string | null;
  paused_until: string | null;
  worker_machine_id: string | null;
  restart_count: number;
  read_failure_streak: number;
  notes: string | null;
  knowledge_file: { active: number | null; latest: number; status: string } | null;
}

const STATUS_STYLE: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  starting:                { color: 'text-blue-700 bg-blue-50',     icon: <Clock className="h-4 w-4" />,        label: 'Starting' },
  alive:                   { color: 'text-green-700 bg-green-50',   icon: <CheckCircle2 className="h-4 w-4" />, label: 'Alive' },
  paused_cost_cap:         { color: 'text-amber-700 bg-amber-50',   icon: <AlertCircle className="h-4 w-4" />,  label: 'Cost cap' },
  paused_mfa:              { color: 'text-amber-700 bg-amber-50',   icon: <ShieldAlert className="h-4 w-4" />,  label: 'MFA needed' },
  paused_circuit_breaker:  { color: 'text-red-700 bg-red-50',       icon: <AlertCircle className="h-4 w-4" />,  label: 'Circuit broken' },
  failed_restart:          { color: 'text-red-700 bg-red-50',       icon: <AlertCircle className="h-4 w-4" />,  label: 'Failed' },
  stopped:                 { color: 'text-gray-700 bg-gray-50',     icon: <StopCircle className="h-4 w-4" />,   label: 'Stopped' },
};

export default function PropertySessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/cua-sessions');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load CUA sessions');
        setLoading(false);
        return;
      }
      setRows(json.data.sessions);
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

  const handleAction = async (propertyId: string, action: string) => {
    if (!confirm(`Run "${action}" on ${propertyId}?`)) return;
    setActionLoading(`${propertyId}:${action}`);
    try {
      const res = await fetchWithAuth('/api/admin/cua-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, action }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(`Action failed: ${json.error ?? 'unknown'}`);
      } else {
        await load();
      }
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;
  if (!user) return <AppLayout><div className="p-8">Not signed in</div></AppLayout>;

  return (
    <AppLayout>
      <div className="px-6 py-8 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/admin" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-2">
              <ChevronLeft className="h-4 w-4 mr-1" /> Admin
            </Link>
            <h1 className="text-2xl font-semibold">CUA Sessions</h1>
            <p className="text-sm text-gray-600 mt-1">Per-hotel session-driver health, heartbeat, and cost.</p>
          </div>
          <button
            onClick={() => void load()}
            className="inline-flex items-center px-3 py-1.5 text-sm border border-gray-200 rounded hover:bg-gray-50"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && !rows && <div>Loading sessions…</div>}

        {rows && rows.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-500 border border-dashed border-gray-300 rounded">
            No CUA sessions yet. They appear here when a hotel enables CUA polling.
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="space-y-4">
            {rows.map((s) => {
              const style = STATUS_STYLE[s.status] ?? STATUS_STYLE.starting!;
              const heartbeatAge = s.last_alive_at ? Date.now() - new Date(s.last_alive_at).getTime() : null;
              const dollarsToday = (s.daily_claude_cost_micros / 1_000_000).toFixed(2);
              return (
                <div key={s.property_id} className="border border-gray-200 rounded-lg p-4 bg-white">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-semibold">{s.display_name}</h2>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${style.color}`}>
                          {style.icon} {style.label}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {s.pms_family} · {s.property_id}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.status === 'paused_mfa' && (
                        <Link
                          href={`/admin/mfa-resume/${s.property_id}`}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200"
                        >
                          <ShieldAlert className="h-3 w-3" /> Resolve MFA
                        </Link>
                      )}
                      {s.status === 'paused_cost_cap' && (
                        <button
                          onClick={() => void handleAction(s.property_id, 'reset_cost_cap')}
                          disabled={actionLoading === `${s.property_id}:reset_cost_cap`}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200"
                        >
                          <RefreshCw className="h-3 w-3" /> Reset cap
                        </button>
                      )}
                      {s.status !== 'stopped' && (
                        <button
                          onClick={() => void handleAction(s.property_id, 'stop')}
                          disabled={actionLoading === `${s.property_id}:stop`}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                        >
                          <StopCircle className="h-3 w-3" /> Stop
                        </button>
                      )}
                      {(s.status === 'stopped' || s.status === 'failed_restart') && (
                        <button
                          onClick={() => void handleAction(s.property_id, 'restart')}
                          disabled={actionLoading === `${s.property_id}:restart`}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-green-100 text-green-800 rounded hover:bg-green-200"
                        >
                          <Play className="h-3 w-3" /> Restart
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-gray-500">Heartbeat</div>
                      <div className={heartbeatAge && heartbeatAge > 5 * 60_000 ? 'text-red-700 font-medium' : 'text-gray-700'}>
                        {s.last_alive_at ? `${Math.floor((heartbeatAge ?? 0) / 1000)}s ago` : 'never'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Spend today</div>
                      <div className="text-gray-700">
                        ${dollarsToday} / $5.00
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Knowledge file</div>
                      <div className="text-gray-700">
                        {s.knowledge_file?.active != null ? `v${s.knowledge_file.active} active` : 'none active'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Restarts / failures</div>
                      <div className="text-gray-700">
                        {s.restart_count} restarts · {s.read_failure_streak} fail streak
                      </div>
                    </div>
                  </div>

                  {s.paused_reason && (
                    <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                      {s.paused_reason}
                    </div>
                  )}

                  {s.current_browser_url && (
                    <div className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> {s.current_browser_url}
                    </div>
                  )}

                  {s.notes && (
                    <div className="mt-2 text-xs text-gray-500">
                      {s.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
