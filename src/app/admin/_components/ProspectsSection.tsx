'use client';

/**
 * "Soon to be onboarded" — sales pipeline section that lives at the top
 * of the Onboarding tab. CRUD against /api/admin/prospects.
 *
 * Shows hotels Reeyen has talked to but who haven't signed up yet, with
 * a per-prospect launch checklist (PMS creds, staff list, GM trained,
 * launch date) so nothing falls through the cracks.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Trash2, Save, ChevronDown, ChevronRight as ChevronR } from 'lucide-react';

type Status = 'talking' | 'negotiating' | 'committed' | 'onboarded' | 'dropped';

interface Prospect {
  id: string;
  hotel_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  pms_type: string | null;
  expected_launch_date: string | null;
  status: Status;
  notes: string | null;
  checklist: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

const CHECKLIST_KEYS = [
  { key: 'pmsCredsCollected', label: 'PMS creds collected' },
  { key: 'staffListReady', label: 'Staff list ready' },
  { key: 'gmTrained', label: 'GM trained' },
  { key: 'launchDateConfirmed', label: 'Launch date confirmed' },
] as const;

const STATUS_OPTIONS: { value: Status; label: string; color: string }[] = [
  { value: 'talking',     label: 'Talking',     color: 'var(--text-muted)' },
  { value: 'negotiating', label: 'Negotiating', color: 'var(--amber)' },
  { value: 'committed',   label: 'Committed',   color: 'var(--green)' },
  { value: 'onboarded',   label: 'Onboarded',   color: 'var(--text-muted)' },
  { value: 'dropped',     label: 'Dropped',     color: 'var(--red)' },
];

export function ProspectsSection() {
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/prospects');
      const json = await res.json();
      if (json.ok) setProspects(json.data.prospects);
      else setError(json.error ?? 'Failed to load');
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetchWithAuth('/api/admin/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelName: newName.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setNewName('');
        setCreating(false);
        await load();
      } else {
        setError(json.error ?? 'Create failed');
      }
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  // Hide already-onboarded ones from the active pipeline view (they show
  // up in the Live hotels tab once they sign up). Dropped also hidden.
  const active = (prospects ?? []).filter((p) => p.status !== 'onboarded' && p.status !== 'dropped');

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div>
          <h2 style={{ fontSize: '15px', fontWeight: 600 }}>Soon to be onboarded</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Hotels you've talked to but haven't signed up yet. Track them here so nothing slips.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="btn btn-secondary"
            style={{ fontSize: '12px' }}
          >
            <Plus size={12} /> Add hotel
          </button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '8px 12px',
          background: 'var(--red-dim)',
          border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: '8px',
          color: 'var(--red)', fontSize: '12px',
          marginBottom: '8px',
        }}>{error}</div>
      )}

      {creating && (
        <div style={{
          padding: '12px 14px',
          background: 'var(--surface-primary)',
          border: '1px solid var(--amber)',
          borderRadius: '10px',
          marginBottom: '8px',
          display: 'flex', gap: '8px', alignItems: 'center',
        }}>
          <input
            autoFocus
            type="text"
            placeholder="Hotel name (e.g., Comfort Suites Beaumont)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
            className="input"
            style={{ flex: 1, fontSize: '13px' }}
          />
          <button onClick={create} className="btn btn-primary" style={{ fontSize: '12px' }}>
            <Save size={12} /> Save
          </button>
          <button onClick={() => { setCreating(false); setNewName(''); }} className="btn btn-secondary" style={{ fontSize: '12px' }}>
            Cancel
          </button>
        </div>
      )}

      {prospects === null ? (
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <div className="spinner" style={{ width: '18px', height: '18px', margin: '0 auto' }} />
        </div>
      ) : active.length === 0 ? (
        <div style={{
          padding: '20px',
          background: 'var(--surface-secondary)',
          border: '1px dashed var(--border)',
          borderRadius: '10px',
          textAlign: 'center',
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}>No prospects yet — add one when you start talking to a hotel.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {active.map((p) => <ProspectRow key={p.id} prospect={p} onChange={load} />)}
        </div>
      )}
    </section>
  );
}

function ProspectRow({ prospect, onChange }: { prospect: Prospect; onChange: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(prospect);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(prospect);

  const checklistDone = CHECKLIST_KEYS.filter((c) => draft.checklist?.[c.key]).length;
  const checklistTotal = CHECKLIST_KEYS.length;
  const statusColor = STATUS_OPTIONS.find((s) => s.value === prospect.status)?.color ?? 'var(--text-muted)';

  const save = async () => {
    setSaving(true);
    try {
      await fetchWithAuth(`/api/admin/prospects/${prospect.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelName: draft.hotel_name,
          contactName: draft.contact_name,
          contactEmail: draft.contact_email,
          contactPhone: draft.contact_phone,
          pmsType: draft.pms_type,
          expectedLaunchDate: draft.expected_launch_date,
          status: draft.status,
          notes: draft.notes,
          checklist: draft.checklist,
        }),
      });
      await onChange();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${prospect.hotel_name}"? Use status='Dropped' instead if you want to keep history.`)) return;
    await fetchWithAuth(`/api/admin/prospects/${prospect.id}`, { method: 'DELETE' });
    await onChange();
  };

  const toggleChecklistItem = (key: string) => {
    setDraft({ ...draft, checklist: { ...draft.checklist, [key]: !draft.checklist?.[key] } });
  };

  return (
    <div style={{
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      overflow: 'hidden',
    }}>
      <div
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronR size={14} color="var(--text-muted)" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>{prospect.hotel_name}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {prospect.contact_name ? `${prospect.contact_name} · ` : ''}
            {prospect.pms_type ?? 'PMS unknown'}
            {prospect.expected_launch_date ? ` · launch ${prospect.expected_launch_date}` : ''}
          </div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {checklistDone}/{checklistTotal} checklist
        </div>
        <span style={{
          padding: '3px 8px',
          fontSize: '11px',
          fontWeight: 600,
          color: statusColor,
          border: `1px solid ${statusColor}`,
          borderRadius: '999px',
          background: 'transparent',
          fontFamily: 'var(--font-mono)',
        }}>
          {prospect.status.toUpperCase()}
        </span>
      </div>

      {expanded && (
        <div style={{
          padding: '12px 14px',
          borderTop: '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10px',
        }}>
          <Field label="Hotel name" value={draft.hotel_name} onChange={(v) => setDraft({ ...draft, hotel_name: v })} />
          <Field label="Status" value={draft.status} options={STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => setDraft({ ...draft, status: v as Status })} />
          <Field label="Contact name" value={draft.contact_name ?? ''} onChange={(v) => setDraft({ ...draft, contact_name: v || null })} />
          <Field label="Contact email" value={draft.contact_email ?? ''} onChange={(v) => setDraft({ ...draft, contact_email: v || null })} />
          <Field label="Contact phone" value={draft.contact_phone ?? ''} onChange={(v) => setDraft({ ...draft, contact_phone: v || null })} />
          <Field label="PMS type" value={draft.pms_type ?? ''} onChange={(v) => setDraft({ ...draft, pms_type: v || null })} />
          <Field label="Expected launch" type="date" value={draft.expected_launch_date ?? ''} onChange={(v) => setDraft({ ...draft, expected_launch_date: v || null })} />
          <Field label="Notes" value={draft.notes ?? ''} multiline onChange={(v) => setDraft({ ...draft, notes: v || null })} />

          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Launch checklist
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
              {CHECKLIST_KEYS.map((c) => (
                <label key={c.key} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  background: draft.checklist?.[c.key] ? 'rgba(34,197,94,0.08)' : 'var(--surface-secondary)',
                  border: `1px solid ${draft.checklist?.[c.key] ? 'rgba(34,197,94,0.25)' : 'var(--border)'}`,
                  borderRadius: '8px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}>
                  <input type="checkbox"
                    checked={!!draft.checklist?.[c.key]}
                    onChange={() => toggleChecklistItem(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <button onClick={remove} className="btn btn-secondary" style={{ fontSize: '12px', color: 'var(--red)' }}>
              <Trash2 size={12} /> Delete
            </button>
            <button onClick={save} disabled={!dirty || saving} className="btn btn-primary" style={{ fontSize: '12px' }}>
              <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, options, type, multiline }: {
  label: string; value: string;
  onChange: (v: string) => void;
  options?: { value: string; label: string }[];
  type?: string;
  multiline?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      {options ? (
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: '13px' }}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : multiline ? (
        <textarea className="input" value={value} onChange={(e) => onChange(e.target.value)} rows={3} style={{ fontSize: '13px', resize: 'vertical' }} />
      ) : (
        <input className="input" type={type ?? 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: '13px' }} />
      )}
    </label>
  );
}
