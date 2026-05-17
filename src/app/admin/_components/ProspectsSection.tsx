'use client';

/**
 * "Soon to be onboarded" — sales pipeline section that lives at the top
 * of the Onboarding tab (Snow design). CRUD against /api/admin/prospects.
 *
 * Shows hotels Reeyen has talked to but who haven't signed up yet, with
 * a per-prospect launch checklist (PMS creds, staff list, GM trained,
 * launch date) so nothing falls through the cracks.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Trash2, Save, ChevronDown, ChevronRight as ChevronR } from 'lucide-react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Btn, Pill,
  type PillTone,
} from './_snow';

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

const STATUS_OPTIONS: { value: Status; label: string; tone: PillTone }[] = [
  { value: 'talking',     label: 'Talking',     tone: 'neutral' },
  { value: 'negotiating', label: 'Negotiating', tone: 'caramel' },
  { value: 'committed',   label: 'Committed',   tone: 'sage' },
  { value: 'onboarded',   label: 'Onboarded',   tone: 'neutral' },
  { value: 'dropped',     label: 'Dropped',     tone: 'warm' },
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

  const active = (prospects ?? []).filter((p) => p.status !== 'onboarded' && p.status !== 'dropped');

  return (
    <section style={{ minWidth: 0, fontFamily: FONT_SANS }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 12, marginBottom: 4,
      }}>
        <div>
          <Caps>Pipeline</Caps>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
            lineHeight: 1.15,
          }}>
            Sales <span style={{ fontStyle: 'italic' }}>pipeline</span>
          </h2>
        </div>
        {!creating && (
          <Btn variant="ghost" size="sm" onClick={() => setCreating(true)}>
            <Plus size={12} /> Add hotel
          </Btn>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px',
          background: T.warmDim,
          border: `1px solid rgba(184,92,61,0.25)`,
          borderRadius: 12,
          color: T.warm, fontSize: 12,
          marginTop: 8,
        }}>{error}</div>
      )}

      {creating && (
        <Card padding="12px 14px" style={{
          marginTop: 8,
          border: `1px solid ${T.caramelDeep}`,
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <input
            autoFocus
            type="text"
            placeholder="Hotel name (e.g., Comfort Suites Beaumont)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
            style={{
              flex: 1, fontSize: 13, padding: '8px 12px',
              border: `1px solid ${T.rule}`, borderRadius: 999, outline: 'none',
              fontFamily: FONT_SANS, background: T.paper, color: T.ink,
            }}
          />
          <Btn variant="primary" size="sm" onClick={create}>
            <Save size={12} /> Save
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => { setCreating(false); setNewName(''); }}>
            Cancel
          </Btn>
        </Card>
      )}

      {prospects === null ? (
        <div style={{ padding: 20, textAlign: 'center', marginTop: 8 }}>
          <div className="spinner" style={{ width: 18, height: 18, margin: '0 auto' }} />
        </div>
      ) : active.length === 0 ? (
        <div style={{
          marginTop: 8,
          padding: '24px 20px',
          background: T.ruleSoft,
          border: `1px dashed ${T.rule}`,
          borderRadius: 14,
          textAlign: 'center',
          fontSize: 12.5,
          color: T.ink2,
          fontStyle: 'italic',
          fontFamily: FONT_SERIF,
        }}>No prospects yet — add one when you start talking to a hotel.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
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
  const statusOpt = STATUS_OPTIONS.find((s) => s.value === prospect.status);

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
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      <div
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} color={T.ink3} /> : <ChevronR size={14} color={T.ink3} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
            {prospect.hotel_name}
          </div>
          <div style={{ fontSize: 11, color: T.ink2, marginTop: 2 }}>
            {prospect.contact_name ? `${prospect.contact_name} · ` : ''}
            {prospect.pms_type ?? 'PMS unknown'}
            {prospect.expected_launch_date ? ` · launch ${prospect.expected_launch_date}` : ''}
          </div>
        </div>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
          letterSpacing: '0.04em',
        }}>
          {checklistDone}/{checklistTotal}
        </span>
        <Pill tone={statusOpt?.tone ?? 'neutral'}>
          {prospect.status.toUpperCase()}
        </Pill>
      </div>

      {expanded && (
        <div style={{
          padding: '14px 16px',
          borderTop: `1px solid ${T.rule}`,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
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
            <Caps>Launch checklist</Caps>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginTop: 6 }}>
              {CHECKLIST_KEYS.map((c) => (
                <label key={c.key} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: draft.checklist?.[c.key] ? T.sageDim : T.ruleSoft,
                  border: `1px solid ${draft.checklist?.[c.key] ? 'rgba(104,131,114,0.30)' : T.rule}`,
                  borderRadius: 999,
                  fontSize: 12.5,
                  color: draft.checklist?.[c.key] ? T.sageDeep : T.ink2,
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

          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <Btn variant="ghost" size="sm" onClick={remove} style={{ color: T.warm, borderColor: 'rgba(184,92,61,0.25)' }}>
              <Trash2 size={12} /> Delete
            </Btn>
            <Btn variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
              <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Btn>
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
  const inputStyle: React.CSSProperties = {
    fontSize: 13, padding: '8px 12px',
    border: `1px solid ${T.rule}`, borderRadius: 10, outline: 'none',
    fontFamily: FONT_SANS, background: T.paper, color: T.ink,
    width: '100%', boxSizing: 'border-box',
  };
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Caps>{label}</Caps>
      {options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3}
          style={{ ...inputStyle, resize: 'vertical', borderRadius: 12 }} />
      ) : (
        <input type={type ?? 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      )}
    </label>
  );
}
